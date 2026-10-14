#!/usr/bin/env node
'use strict';

// Ergänzt in radiosources.json die Sender-Logos (nur das Feld `logo`; IDs, Stream-URLs, Reihenfolge bleiben).
// Es werden nur Links gesetzt, keine Bilddateien ins Repo kopiert. Reihenfolge je Sender ohne (brauchbares) Logo:
//   (a) Favicon aus dem radio-browser-Verzeichnis (https; http wird auf https hochgestuft und geprüft),
//   (b) Icon der Sender-Homepage (apple-touch-icon / link rel=icon / Standardpfade), nur https,
//   (c) Google-Favicon-Dienst für den Homepage-Host (https://www.google.com/s2/favicons?domain=<host>&sz=128),
//       nur wenn ein echtes Bild kommt (der Standard-Globus wird per Hash eines Abrufs für eine nicht existierende Domain erkannt).
// Jeder gesetzte Link wird auf eine echte Bild-Antwort geprüft (Content-Type image/*, Dateikopf, Größenlimit).
// Bestehende Logos werden erneut geprüft; kaputte werden ersetzt oder entfernt (Platzhalter im Client).
// Netzwerk ist injizierbar (net.get); Tests laufen offline mit Fixtures.
//
// Aufruf: node scripts/enrich-radio-logos.js [--file radiosources.json] [--concurrency 6] [--timeout 8000]
//                                            [--report report.json] [--dry-run]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchFollow, readLimited, withDeadline, USER_AGENT } = require('../lib/radio/radio-http.js');
const { resolveApiServers, createApiClient, fetchByUuids } = require('../lib/radio/radio-browser.js');

const SOURCE_ID = 'deutsche-radiosender';
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

function toHttps(value, base) {
  let url;
  try {
    url = new URL(String(value || '').trim(), base);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.toString();
}

/**
 * Prüft, ob url (https) ein echtes Bild liefert. Liefert { ok, info, hash, url } (url = geprüfte Adresse);
 * sonst { ok: false, reason }. Die Endadresse nach Weiterleitungen muss ebenfalls https sein.
 */
async function checkImage(url, net) {
  let reply;
  try {
    reply = await net.get(url, { maxBytes: MAX_IMAGE_BYTES });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (reply.status !== 200) return { ok: false, reason: `HTTP ${reply.status}` };
  if (reply.truncated) return { ok: false, reason: 'zu groß' };
  if (!/^image\//i.test(String(reply.contentType || ''))) return { ok: false, reason: 'kein Bild-Content-Type' };
  if (reply.finalUrl && !/^https:/i.test(reply.finalUrl)) return { ok: false, reason: 'Weiterleitung auf http' };
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
function iconCandidates(html, pageUrl) {
  const found = [];
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const attr = name => {
      const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
      return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
    };
    const rel = attr('rel').toLowerCase();
    const href = attr('href');
    if (!href || !/(^|\s)(apple-touch-icon(-precomposed)?|icon|shortcut)(\s|$)/.test(rel)) continue;
    const resolved = toHttps(href.replace(/&amp;/g, '&'), pageUrl);
    if (!resolved) continue;
    const sizes = attr('sizes').toLowerCase();
    const size = sizes === 'any' || /svg/i.test(attr('type')) ? 512 : Math.max(0, ...(sizes.match(/\d+/g) || []).map(Number));
    found.push({ url: resolved, apple: rel.includes('apple-touch-icon'), size });
  }
  found.sort((a, b) => Number(b.apple) - Number(a.apple) || b.size - a.size);
  const origin = new URL(pageUrl).origin.replace(/^http:/, 'https:');
  const defaults = [`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`];
  return [...new Set([...found.map(entry => entry.url), ...defaults])];
}

async function homepageIcon(homepage, net, { maxCandidates = 5 } = {}) {
  const attempts = [toHttps(homepage), String(homepage)].filter(Boolean);
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
  const base = page ? page.url : toHttps(homepage);
  if (!base) return { good: null, weak: null };
  let weak = null;
  for (const candidate of iconCandidates(page ? page.html : '', base).slice(0, maxCandidates)) {
    const result = await checkImage(candidate, net);
    if (!result.ok) continue;
    const edge = minEdge(result.info);
    if (edge === null || edge >= MIN_GOOD) return { good: result.url, weak };
    if (edge >= MIN_WEAK && (!weak || edge > weak.edge)) weak = { url: result.url, edge };
  }
  return { good: null, weak: weak && weak.url };
}

// ---------- Anreicherung ----------

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
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

/**
 * stations: Senderliste (wird nicht verändert); rawByUuid: Map stationuuid -> Verzeichniseintrag (favicon, homepage).
 * Liefert { stations, report } mit report = { total, before, after, bySource, brokenExisting, noLogo }.
 */
async function enrichLogos({ stations, rawByUuid = new Map(), net, concurrency = 6, log = () => {} }) {
  const placeholder = await googlePlaceholderHash(net);
  if (!placeholder) log('Google-Standard-Platzhalter nicht ermittelbar: Google-Fallback deaktiviert');
  const bySource = { bestehend: 0, verzeichnis: 0, 'https-upgrade': 0, homepage: 0, google: 0 };
  const report = { total: stations.length, before: stations.filter(s => s.logo).length, bySource, brokenExisting: [], noLogo: [] };

  const results = await mapLimited(stations, concurrency, async station => {
    const raw = rawByUuid.get(station.rbUuid) || {};
    const homepage = station.homepage || raw.homepage || null;
    if (station.logo) {
      let keep = await checkImage(station.logo, net);
      if (!keep.ok) keep = await checkImage(station.logo, net); // ein Wiederholversuch gegen kurzzeitige Ausfälle
      if (keep.ok) return { station, logo: station.logo, source: 'bestehend' };
      report.brokenExisting.push(station.id);
    }
    // (a) Verzeichnis-Favicon
    const favicon = String(raw.favicon || '').trim();
    if (favicon) {
      const https = toHttps(favicon);
      if (https) {
        const result = await checkImage(https, net);
        if (result.ok) return { station, logo: result.url, source: /^https:/i.test(favicon) ? 'verzeichnis' : 'https-upgrade' };
      }
    }
    // (b) Homepage-Icon
    let weak = null;
    if (homepage) {
      const icon = await homepageIcon(homepage, net);
      if (icon.good) return { station, logo: icon.good, source: 'homepage' };
      weak = icon.weak;
    }
    // (c) Google-Favicon-Dienst (nur mit bekannter Homepage und erkanntem Platzhalter)
    const host = hostOf(homepage);
    if (host && placeholder) {
      const url = googleFaviconUrl(host);
      const result = await checkImage(url, net);
      if (result.ok && result.hash !== placeholder && (minEdge(result.info) === null || minEdge(result.info) >= MIN_WEAK)) {
        return { station, logo: url, source: 'google' };
      }
    }
    if (weak) return { station, logo: weak, source: 'homepage' };
    return { station, logo: null, source: null };
  });

  const out = results.map(({ station, logo, source }) => {
    const next = { ...station };
    if (logo) next.logo = logo;
    else delete next.logo;
    if (source) bySource[source] = (bySource[source] || 0) + 1;
    else report.noLogo.push(station.id);
    return next;
  });
  report.after = out.filter(s => s.logo).length;
  return { stations: out, report };
}

// ---------- echtes Netzwerk ----------

function createNet({ timeoutMs = 8000 } = {}) {
  return {
    get(url, { maxBytes = MAX_IMAGE_BYTES } = {}) {
      return withDeadline(timeoutMs, async signal => {
        const { response, finalUrl } = await fetchFollow(url, { signal, headers: { Accept: 'image/*,text/html;q=0.9,*/*;q=0.5' } });
        const { buffer, truncated } = await readLimited(response, maxBytes);
        return { status: response.status, contentType: response.headers.get('content-type') || '', finalUrl, buffer, truncated };
      });
    },
  };
}

function parseArgs(argv) {
  const options = { file: path.join(__dirname, '..', 'radiosources.json'), concurrency: 6, timeout: 8000, report: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--file') options.file = path.resolve(argv[++i]);
    else if (arg === '--report') options.report = path.resolve(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--timeout') options.timeout = Number(argv[++i]);
    else throw new Error(`Unbekannte Option: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sources = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  const source = sources.find(entry => entry && entry.id === SOURCE_ID);
  if (!source) throw new Error(`Quelle ${SOURCE_ID} nicht gefunden`);
  const servers = await resolveApiServers();
  const api = createApiClient({ servers });
  console.log(`radio-browser-Server: ${servers.join(', ')} (User-Agent: ${USER_AGENT})`);
  const raw = await fetchByUuids(api, source.stations.map(s => s.rbUuid).filter(Boolean));
  const rawByUuid = new Map(raw.map(entry => [entry.stationuuid, entry]));
  const { stations, report } = await enrichLogos({
    stations: source.stations,
    rawByUuid,
    net: createNet({ timeoutMs: options.timeout }),
    concurrency: options.concurrency,
    log: message => console.log(message),
  });
  console.log(JSON.stringify({ ...report, noLogo: report.noLogo.length }, null, 2));
  if (options.report) fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  if (options.dryRun) return;
  const next = sources.map(entry => (entry === source ? { ...source, stations } : entry));
  fs.writeFileSync(options.file, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Geschrieben: ${options.file}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { imageInfo, minEdge, toHttps, checkImage, iconCandidates, homepageIcon, googleFaviconUrl, googlePlaceholderHash, enrichLogos, createNet, parseArgs, main };
