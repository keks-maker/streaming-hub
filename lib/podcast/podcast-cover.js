'use strict';

// Cover-Lader im Main-Prozess (Konzept §6): Cover mit http-Adresse darf die CSP des Renderers (img-src https:) nicht
// laden und der Renderer ruft Fremdadressen nicht selbst ab. Der Main lädt das Bild (nur http/https, Redirect-Prüfung,
// Zeitlimit, Größenlimit, Dateikopf muss ein Bild sein) und liefert eine data:-URL. Ergebnisse liegen in einem kleinen
// Speicher-Cache (LRU). Fehler liefern { ok: false } ohne Adresse in der Meldung und werden nur 60 s gemerkt. SSRF-Schutz: Allowlist (cover-allowlist.js, im IPC-Handler) und
// Ziel-IP-Filter (lib/net-safety.js: Vorab-Prüfung je Hop und an die geprüfte IP gebundene Verbindung). Netzwerk ist injizierbar.

const { nodeFetch, fetchFollow, readLimited, discardBody, withDeadline } = require('../radio/radio-http.js');
const { imageInfo } = require('../radio/radio-logo-finder.js');
const { radioLogoUrlError } = require('../input-validation.js');
const { createSafeLookup, assertPublicUrl } = require('../net-safety.js');

const MAX_COVER_BYTES = 768 * 1024;
const COVER_TIMEOUT_MS = 8000;
const MAX_ENTRIES = 80;
const ERROR_TTL_MS = 60 * 1000;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function createCoverLoader({ fetchImpl = nodeFetch, timeoutMs = COVER_TIMEOUT_MS, maxBytes = MAX_COVER_BYTES, maxEntries = MAX_ENTRIES, allowLoopback = false, lookup = createSafeLookup({ allowLoopback }), guardUrl = url => assertPublicUrl(url, { allowLoopback }), now = Date.now } = {}) {
  const cache = new Map(); // URL -> { ok: true, dataUrl } (nur Erfolge, LRU)
  const failures = new Map(); // URL -> Zeitpunkt des Fehlschlags (nur kurz gemerkt)
  const running = new Map();

  async function download(url) {
    return withDeadline(timeoutMs, async signal => {
      const { response } = await fetchFollow(url, { fetchImpl, signal, maxRedirects: 3, lookup, guardUrl, headers: { Accept: 'image/*' } });
      if (response.status < 200 || response.status >= 300) {
        await discardBody(response);
        return { ok: false };
      }
      const { buffer, truncated } = await readLimited(response, maxBytes);
      if (truncated) return { ok: false };
      const info = imageInfo(buffer);
      const mime = info && MIME[info.type];
      if (!mime) return { ok: false };
      return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
    });
  }

  function remember(url, result) {
    if (!result.ok) {
      if (failures.size >= maxEntries) failures.delete(failures.keys().next().value);
      failures.set(url, now());
      return;
    }
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(url, result);
  }

  async function load(url) {
    if (radioLogoUrlError(url)) return { ok: false };
    const failedAt = failures.get(url);
    if (failedAt !== undefined) {
      if (now() - failedAt < ERROR_TTL_MS) return { ok: false };
      failures.delete(url);
    }
    const hit = cache.get(url);
    if (hit) {
      cache.delete(url); // LRU: ans Ende
      cache.set(url, hit);
      return hit;
    }
    if (running.has(url)) return running.get(url);
    const promise = download(url)
      .catch(() => ({ ok: false }))
      .then(result => {
        remember(url, result);
        return result;
      })
      .finally(() => running.delete(url));
    running.set(url, promise);
    return promise;
  }

  return { load };
}

module.exports = { createCoverLoader, MAX_COVER_BYTES };
