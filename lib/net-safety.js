'use strict';

// Ziel-Filter gegen SSRF für Abrufe, deren Adresse aus nicht vertrauenswürdiger Quelle stammt (Podcast-Cover).
// isBlockedAddress: private, Loopback, Link-Local, ULA, CGNAT, Metadaten, unspezifizierte und eingebettete IPv4-Adressen.
// createSafeLookup: dns.lookup-kompatibel; löst auf, lehnt gesperrte Adressen ab und liefert die geprüfte IP, an die node:http
// die Verbindung direkt bindet (kein erneutes Auflösen, damit kein DNS-Rebinding zwischen Prüfung und Verbindung).
// allowLoopback (nur isolierte E2E-Testläufe mit lokalem Ersatzserver) erlaubt ausschließlich 127/8 und ::1.
// assertPublicUrl: Vorab-Prüfung je Hop (Hostname-Literal oder Auflösung) für Transporte ohne lookup-Option.

const dns = require('node:dns');
const net = require('node:net');

function ipv4Octets(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every(n => n >= 0 && n <= 255) ? octets : null;
}

function isBlockedIpv4([a, b]) {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // Link-Local, Cloud-Metadaten
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF
    (a === 198 && (b === 18 || b === 19)) || // Benchmark
    a >= 224 // Multicast, reserviert, Broadcast
  );
}

/** Zerlegt eine IPv6-Adresse in 8 16-Bit-Gruppen (auch mit eingebettetem IPv4-Ende); null bei ungültiger Form. */
function ipv6Groups(address) {
  let text = address.split('%')[0].toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = ipv4Octets(tail[1]);
    if (!o) return null;
    text = `${text.slice(0, -tail[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest];
  const groups = all.map(part => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN));
  return groups.length === 8 && groups.every(n => Number.isInteger(n)) ? groups : null;
}

function isBlockedIpv6(address) {
  const g = ipv6Groups(address);
  if (!g) return true;
  const embedded = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every(n => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (IPv4-kompatibel), ::, ::1
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true;
    return isBlockedIpv4(embedded(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(n => n === 0)) return isBlockedIpv4(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedIpv4(embedded(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local
  if ((g[0] & 0xff00) === 0xff00) return true; // Multicast
  return false;
}

/** true, wenn die IP-Adresse (Text) nicht öffentlich ist oder nicht lesbar. */
function isBlockedAddress(address, { allowLoopback = false } = {}) {
  if (allowLoopback && /^(127\.\d+\.\d+\.\d+|\[?::1\]?)$/.test(String(address || ''))) return false; // nur isolierte Testläufe
  const text = String(address || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(text);
  if (family === 4) return isBlockedIpv4(ipv4Octets(text));
  if (family === 6) return isBlockedIpv6(text);
  return true;
}

function blockedError() {
  return Object.assign(new Error('Adresse nicht erlaubt'), { code: 'ESSRF' });
}

/** dns.lookup-kompatibel (für http.request({ lookup })): liefert nur geprüfte öffentliche Adressen. */
function createSafeLookup({ lookupImpl = dns.lookup, allowLoopback = false } = {}) {
  return function safeLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    lookupImpl(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return cb(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      const safe = list.filter(entry => !isBlockedAddress(entry.address, { allowLoopback }));
      if (!safe.length || safe.length !== list.length) return cb(blockedError());
      if (opts.all) return cb(null, safe);
      return cb(null, safe[0].address, safe[0].family);
    });
  };
}

/** Vorab-Prüfung einer URL: Hostname-Literal oder Auflösung (resolve(host) -> [{ address }]) muss öffentlich sein. */
async function assertPublicUrl(url, { resolve = host => dns.promises.lookup(host, { all: true }), allowLoopback = false } = {}) {
  const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host, { allowLoopback })) throw blockedError();
    return;
  }
  if (!allowLoopback && (host === 'localhost' || host.endsWith('.localhost'))) throw blockedError();
  const addresses = await resolve(host);
  if (!addresses || !addresses.length || addresses.some(entry => isBlockedAddress(entry.address, { allowLoopback }))) throw blockedError();
}

module.exports = { isBlockedAddress, createSafeLookup, assertPublicUrl };
