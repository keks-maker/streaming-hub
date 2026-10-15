'use strict';

// Kapitel-Lader im Main-Prozess: lädt die JSON-Chapters einer Episode (podcast:chapters url=…). Die Adresse stammt aus einem
// fremden Feed und gilt daher als nicht vertrauenswürdig: Ziel-IP-Filter (lib/net-safety.js: Vorab-Prüfung je Hop und an die
// geprüfte IP gebundene Verbindung), nur http/https, höchstens 3 Weiterleitungen, 10 s, 1 MB. Ergebnisse liegen im Speicher
// (Erfolge 6 h, höchstens 100 Einträge; Fehler 60 s). Fehlermeldungen enthalten nie die Adresse.

const { fetchFeed } = require('./podcast-fetch.js');
const { parseChaptersJson, MAX_JSON_CHARS } = require('./chapters.js');
const { createSafeLookup, assertPublicUrl } = require('../net-safety.js');

const CHAPTERS_TIMEOUT_MS = 10000;
const SUCCESS_TTL_MS = 6 * 3600 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 100;
const ACCEPT = 'application/json, application/json+chapters;q=0.9, */*;q=0.5';

/** options: fetch (Standard: fetchFeed), allowLoopback (nur isolierte Testläufe), lookup, guardUrl, now. load(url) -> { ok, chapters } | { ok: false, error } */
function createChaptersLoader({ fetch = fetchFeed, allowLoopback = false, lookup = createSafeLookup({ allowLoopback }), guardUrl = url => assertPublicUrl(url, { allowLoopback }), now = Date.now, timeoutMs = CHAPTERS_TIMEOUT_MS } = {}) {
  const cache = new Map(); // URL -> { at, result }
  const running = new Map();

  async function download(url) {
    try {
      const response = await fetch(url, { accept: ACCEPT, lookup, guardUrl, timeoutMs, maxBytes: MAX_JSON_CHARS, maxRedirects: 3 });
      if (response.status !== 'ok') return { ok: false, error: 'Kapitel nicht abrufbar' };
      return { ok: true, chapters: parseChaptersJson(response.text) };
    } catch (error) {
      const message = error && typeof error.message === 'string' && error.message.startsWith('Kapitel-Datei') ? error.message : 'Kapitel nicht abrufbar';
      return { ok: false, error: message };
    }
  }

  async function load(url) {
    const hit = cache.get(url);
    if (hit) {
      if (now() - hit.at < (hit.result.ok ? SUCCESS_TTL_MS : ERROR_TTL_MS)) {
        cache.delete(url); // LRU: ans Ende
        cache.set(url, hit);
        return hit.result;
      }
      cache.delete(url);
    }
    if (running.has(url)) return running.get(url);
    const promise = download(url)
      .then(result => {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(url, { at: now(), result });
        return result;
      })
      .finally(() => running.delete(url));
    running.set(url, promise);
    return promise;
  }

  return { load };
}

module.exports = { createChaptersLoader, CHAPTERS_TIMEOUT_MS };
