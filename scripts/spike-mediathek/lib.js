'use strict';
// Gemeinsame Helfer fuer den Mediathek-Spike (kein Produktivcode).
const UA = 'StreamingHub/1.0';
async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, json, text, headers: Object.fromEntries(r.headers) };
}
async function getText(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(25000) });
  return { status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers), url: r.url };
}
// HLS-Master parsen: Varianten, EXT-X-MEDIA (AUDIO/SUBTITLES) mit Attributen.
function parseAttrs(s) {
  const out = {}; const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g; let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}
function parseMaster(text, base) {
  const lines = text.split(/\r?\n/); const media = []; const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-MEDIA:')) media.push(parseAttrs(l.slice(13)));
    else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(l.slice(18)); a.URI = lines[i + 1]; variants.push(a);
    }
  }
  const abs = (u) => (u ? new URL(u, base).href : u);
  media.forEach((m) => { if (m.URI) m.URI = abs(m.URI); });
  variants.forEach((v) => { v.URI = abs(v.URI); });
  return { media, variants };
}
module.exports = { getJson, getText, parseMaster, UA };
