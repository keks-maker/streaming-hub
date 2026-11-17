// fetch-Ersatz für Downloads fremder URLs (EPG-Bilder): prüft die AUFGELÖSTE IP beim Verbindungsaufbau (lookup im
// http/https-Agent) und lehnt lokale, private, Link-Local-, ULA-, unspezifizierte und IPv4-gemappte Adressen ab. Die
// geprüfte Adresse ist die verbundene, das deckt DNS-Rebinding und Namen wie 127.0.0.1.nip.io ab. Redirects folgt der
// Aufrufer selbst (jeder Hop läuft erneut durch diese Prüfung).

'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { Readable } = require('stream');

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(addr, prefix, 'ipv6');

/** true, wenn die IP lokal/privat/reserviert ist (auch ::ffff:a.b.c.d und ::a.b.c.d). Unlesbares gilt als gesperrt. */
function isBlockedAddress(ip) {
  let addr = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1];
  else {
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      addr = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  const family = net.isIP(addr);
  if (!family) return true;
  return blocked.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : options || {};
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
    if (!list.length || list.some(a => isBlockedAddress(a.address))) return cb(new Error('Ziel ist lokal oder privat'));
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

/** fetch-kompatibel (nur GET, redirect immer „manual“). allowLocal nur für isolierte Testläufe. */
function createSafeFetch({ allowLocal = false } = {}) {
  return function safeFetch(url, { signal } = {}) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (err) {
        return reject(err);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(new Error('Nur http/https'));
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (!allowLocal && net.isIP(host) && isBlockedAddress(host)) return reject(new Error('Ziel ist lokal oder privat'));
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(
        parsed,
        { method: 'GET', headers: { 'accept-encoding': 'identity', accept: 'image/*' }, lookup: allowLocal ? undefined : guardedLookup, signal },
        res => {
          const noBody = [101, 204, 205, 304].includes(res.statusCode);
          const headers = new globalThis.Headers();
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
          if (noBody) res.resume();
          resolve(new Response(noBody ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  };
}

module.exports = { createSafeFetch, isBlockedAddress, guardedLookup };
