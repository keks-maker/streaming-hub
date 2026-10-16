'use strict';

// Logo-Suche für Radiosender (geteilt von scripts/enrich-radio-logos.js und der Eigene-Sender-Einstellung):
// Kette Homepage-Icon (apple-touch-icon / link rel=icon / Standardpfade) -> Google-Favicon-Dienst
// (https://www.google.com/s2/favicons?domain=<host>&sz=128, der Standard-Globus wird per Hash erkannt).
// Jeder Link wird auf eine echte Bild-Antwort geprüft (Content-Type image/*, Dateikopf, Größenlimit); in Produktion
// zählen nur https-Adressen. Logos werden nur verlinkt. Netzwerk ist injizierbar (net.get).
// Bewusst KEINE Domain-Heuristik aus der Stream-URL: CDN-Hosts (z. B. streamabc.net) lieferten falsche Logos.

const crypto = require('node:crypto');
const { fetchFollow, readLimited, withDeadline } = require('./radio-http.js');

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const MIN_GOOD = 48; // Kantenlänge, ab der ein Homepage-Icon als gut gilt
const MIN_WEAK = 32; // darunter wird ein Icon nur als letzter Ausweg genommen, ganz kleine gar nicht
const GOOGLE_SIZE = 128;
const PLACEHOLDER_DOMAIN = 'logo-pruefung-gibt-es-nicht-4711.de';

// ---------- Bild-Erkennung (Dateikopf) ----------

/** { type, width, height } aus den ersten Bytes; width/height null bei SVG; null, wenn kein bekanntes Bildformat. */
function imageInfo(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('latin1') === 'GIF') {
    return { type: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) return { type: 'jpeg', width: null, height: null };
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return { type: 'jpeg', width: null, height: null };
  }
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buffer.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X' && buffer.length >= 30) return { type: 'webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && buffer.length >= 30) return { type: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { type: 'webp', width: null, height: null };
  }
  if (buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1 && buffer.length >= 22) {
    const count = buffer.readUInt16LE(4);
    let best = 0;
    for (let i = 0; i < count && 6 + i * 16 + 2 <= buffer.length; i += 1) {
      const w = buffer[6 + i * 16] || 256;
      const h = buffer[7 + i * 16] || 256;
      best = Math.max(best, Math.min(w, h));
    }
    return { type: 'ico', width: best, height: best };
  }
  const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { type: 'svg', width: null, height: null };
  return null;
}

/** Kleinste Kantenlänge oder null (SVG/unbekannt). */
function minEdge(info) {
  return info && info.width && info.height ? Math.min(info.width, info.height) : null;
}

// ---------- Prüfungen ----------

/** https-Adresse (http wird hochgestuft; mit allowHttp, nur für Testläufe, bleibt http erhalten); null bei anderem Schema oder Zugangsdaten. */
function toHttps(value, base, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(value || '').trim(), base);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' && !allowHttp) url.protocol = 'https:';
  if ((url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) || url.username || url.password) return null;
  return url.toString();
}

/**
 * Prüft, ob url (https) ein echtes Bild liefert. Liefert { ok, info, hash, url } (url = geprüfte Adresse);
 * sonst { ok: false, reason }. Die Endadresse nach Weiterleitungen muss ebenfalls https sein.
 */
async function checkImage(url, net, { allowHttp = false } = {}) {
  let reply;
  try {
    reply = await net.get(url, { maxBytes: MAX_IMAGE_BYTES });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (reply.status !== 200) return { ok: false, reason: `HTTP ${reply.status}` };
  if (reply.truncated) return { ok: false, reason: 'zu groß' };
  if (!/^image\//i.test(String(reply.contentType || ''))) return { ok: false, reason: 'kein Bild-Content-Type' };
  if (reply.finalUrl && !(allowHttp ? /^https?:/i : /^https:/i).test(reply.finalUrl)) return { ok: false, reason: 'Weiterleitung auf http' };
  const info = imageInfo(reply.buffer);
  if (!info) return { ok: false, reason: 'Dateikopf ist kein Bild' };
  return { ok: true, info, hash: crypto.createHash('sha256').update(reply.buffer).digest('hex'), url };
}

function hostOf(homepage) {
  try {
    const url = new URL(String(homepage || '').trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function googleFaviconUrl(host) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${GOOGLE_SIZE}`;
}

/** Icon-Kandidaten aus dem HTML: apple-touch-icon zuerst, dann rel=icon (jeweils größte zuerst), dann Standardpfade. */
function iconCandidates(html, pageUrl, { allowHttp = false } = {}) {
  const found = [];
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const attr = name => {
      const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
      return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
    };
    const rel = attr('rel').toLowerCase();
    const href = attr('href');
    if (!href || !/(^|\s)(apple-touch-icon(-precomposed)?|icon|shortcut)(\s|$)/.test(rel)) continue;
    const resolved = toHttps(href.replace(/&amp;/g, '&'), pageUrl, { allowHttp });
    if (!resolved) continue;
    const sizes = attr('sizes').toLowerCase();
    const size = sizes === 'any' || /svg/i.test(attr('type')) ? 512 : Math.max(0, ...(sizes.match(/\d+/g) || []).map(Number));
    found.push({ url: resolved, apple: rel.includes('apple-touch-icon'), size });
  }
  found.sort((a, b) => Number(b.apple) - Number(a.apple) || b.size - a.size);
  const origin = allowHttp ? new URL(pageUrl).origin : new URL(pageUrl).origin.replace(/^http:/, 'https:');
  const defaults = [`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`];
  return [...new Set([...found.map(entry => entry.url), ...defaults])];
}

/**
 * Icon der Homepage. httpFallback: die Seite selbst darf zusätzlich über http geladen werden (nur das HTML wird gelesen,
 * Icon-Links bleiben https). Liefert { good, weak } (Adressen oder null).
 */
async function homepageIcon(homepage, net, { maxCandidates = 5, allowHttp = false, httpFallback = true } = {}) {
  const attempts = [toHttps(homepage, undefined, { allowHttp }), httpFallback || allowHttp ? String(homepage) : null].filter(Boolean);
  let page = null;
  for (const url of [...new Set(attempts)]) {
    try {
      const reply = await net.get(url, { maxBytes: MAX_HTML_BYTES });
      if (reply.status === 200) {
        page = { html: reply.buffer.toString('utf8'), url: reply.finalUrl || url };
        break;
      }
    } catch {
      // nächster Versuch
    }
  }
  const base = page ? page.url : toHttps(homepage, undefined, { allowHttp });
  if (!base) return { good: null, weak: null };
  let weak = null;
  for (const candidate of iconCandidates(page ? page.html : '', base, { allowHttp }).slice(0, maxCandidates)) {
    const result = await checkImage(candidate, net, { allowHttp });
    if (!result.ok) continue;
    const edge = minEdge(result.info);
    if (edge === null || edge >= MIN_GOOD) return { good: result.url, weak };
    if (edge >= MIN_WEAK && (!weak || edge > weak.edge)) weak = { url: result.url, edge };
  }
  return { good: null, weak: weak && weak.url };
}
/** Hash des Google-Standard-Globus (Abruf für eine nicht existierende Domain); null, wenn nicht ermittelbar. */
async function googlePlaceholderHash(net) {
  const result = await checkImage(googleFaviconUrl(PLACEHOLDER_DOMAIN), net);
  if (result.ok) return result.hash;
  // Google antwortet für unbekannte Domains teils mit 404 + Globus-Bild: Hash trotzdem aus der Antwort bilden
  try {
    const reply = await net.get(googleFaviconUrl(PLACEHOLDER_DOMAIN), { maxBytes: MAX_IMAGE_BYTES });
    if (/^image\//i.test(String(reply.contentType || '')) && imageInfo(reply.buffer)) return crypto.createHash('sha256').update(reply.buffer).digest('hex');
  } catch {
    // nicht ermittelbar
  }
  return null;
}

// ---------- Suche ----------

/**
 * Sucht ein Logo für eine Homepage: Homepage-Icon, sonst Google-Favicon (nur mit bekanntem Platzhalter-Hash des
 * Globus), sonst ein schwaches Homepage-Icon. placeholder: Hash des Google-Globus oder null (Google aus).
 * Liefert { logo, source: 'homepage'|'google'|null }. stop(): optionaler Abbruch zwischen den Schritten.
 */
async function findLogo({ homepage, net, placeholder = null, allowHttp = false, httpFallback = true, stop = () => false }) {
  let weak = null;
  if (homepage) {
    const icon = await homepageIcon(homepage, net, { allowHttp, httpFallback });
    if (icon.good) return { logo: icon.good, source: 'homepage' };
    weak = icon.weak;
  }
  const host = hostOf(homepage);
  if (host && placeholder && !stop()) {
    const url = googleFaviconUrl(host);
    const result = await checkImage(url, net);
    if (result.ok && result.hash !== placeholder && (minEdge(result.info) === null || minEdge(result.info) >= MIN_WEAK)) {
      return { logo: url, source: 'google' };
    }
  }
  if (weak) return { logo: weak, source: 'homepage' };
  return { logo: null, source: null };
}

/**
 * Suche mit zur Laufzeit einmalig ermitteltem (und gemerktem) Globus-Hash. Kann der Hash nicht ermittelt werden,
 * bleibt der Google-Fallback aus. options: net (Pflicht), allowHttp (nur Testläufe), httpFallback, deadlineMs.
 */
function createLogoFinder({ net, allowHttp = false, httpFallback = false, deadlineMs = 25000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let placeholderPromise = null;
  const placeholder = () => {
    if (!placeholderPromise) placeholderPromise = googlePlaceholderHash(net).catch(() => null);
    return placeholderPromise;
  };
  return {
    placeholderHash: placeholder,
    find: async homepage => {
      let expired = false;
      let timer;
      const limit = new Promise((_, reject) => {
        timer = setTimer(() => {
          expired = true;
          reject(new Error(`Zeitüberschreitung nach ${deadlineMs} ms`));
        }, deadlineMs);
      });
      const work = placeholder().then(hash => findLogo({ homepage, net, placeholder: hash, allowHttp, httpFallback, stop: () => expired }));
      work.catch(() => {}); // nach dem Limit auslaufende Arbeit erzeugt keine unbehandelte Ablehnung
      try {
        return await Promise.race([work, limit]);
      } finally {
        clearTimer(timer);
      }
    },
  };
}

// ---------- echtes Netzwerk ----------

/**
 * Echtes Netzwerk (node:http über radio-http.js) mit Zeitlimit pro Abruf. get(url, { maxBytes, guardUrl, lookup }):
 * guardUrl (je Hop) und lookup (Adress-Pinning) sind optional; ohne sie bleibt das Verhalten unverändert (Radio/Podcast).
 * fetchImpl: injizierbarer Transport (Tests).
 */
function createNet({ timeoutMs = 8000, fetchImpl } = {}) {
  return {
    get(url, { maxBytes = MAX_IMAGE_BYTES, guardUrl, lookup } = {}) {
      return withDeadline(timeoutMs, async signal => {
        const { response, finalUrl } = await fetchFollow(url, { signal, ...(fetchImpl ? { fetchImpl } : {}), ...(guardUrl ? { guardUrl } : {}), ...(lookup ? { lookup } : {}), headers: { Accept: 'image/*,text/html;q=0.9,*/*;q=0.5' } });
        const { buffer, truncated } = await readLimited(response, maxBytes);
        return { status: response.status, contentType: response.headers.get('content-type') || '', finalUrl, buffer, truncated };
      });
    },
  };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MIN_GOOD,
  MIN_WEAK,
  imageInfo,
  minEdge,
  toHttps,
  checkImage,
  hostOf,
  googleFaviconUrl,
  iconCandidates,
  homepageIcon,
  googlePlaceholderHash,
  findLogo,
  createLogoFinder,
  createNet,
};
