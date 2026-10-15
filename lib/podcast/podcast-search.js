'use strict';

// Podcast-Suche über die iTunes Search API (Konzept §9.2, §12.1): nur der Suchbegriff geht an den Dienst.
// limit <= 25, Eingabe-Normalisierung (Unicode NFC, Leerraum, Länge), Ergebnis-Cache 24 h, lokale Ratenbremse
// (Apple nennt ca. 20 Anfragen/min) und HTTP 429 als eigener Fehlercode. Umlaute werden serverseitig nicht
// normalisiert ("Küche"/"Kuche"/"Kueche" liefern verschiedene Treffer): bei 0 Treffern wird einmal mit der
// anderen Schreibweise (Umlaut <-> ae/oe/ue) wiederholt. Netzwerk und Zeit sind injizierbar.

const { URLSearchParams } = require('node:url');
const { nodeFetch, fetchFollow, readLimited, discardBody, withDeadline } = require('../radio/radio-http.js');
const { podcastFeedUrlError } = require('../input-validation.js');
const { podcastIdFromFeedUrl } = require('./podcast-ids.js');
const { cleanText } = require('./feed-parser.js');

const SEARCH_URL = 'https://itunes.apple.com/search';
const MAX_LIMIT = 25;
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 100;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 18; // unter Apples ca. 20/min
const SEARCH_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class SearchError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Eingabe -> Suchbegriff: NFC, Steuerzeichen/Mehrfach-Leerraum weg, gekürzt. Liefert '' bei zu kurzer Eingabe. */
function normalizeTerm(input) {
  if (typeof input !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  const term = input.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH).trim();
  return term.length >= MIN_TERM_LENGTH ? term : '';
}

/** Cache-Schlüssel: kleingeschrieben (Groß-/Kleinschreibung ändert Apples Treffer nicht). */
function cacheKey(term) {
  return term.toLocaleLowerCase('de-DE');
}

const TO_DIGRAPH = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue' };

/** Andere Schreibweise: Umlaute -> ae/oe/ue, sonst ae/oe/ue -> Umlaut; null, wenn es keine gibt. */
function alternativeSpelling(term) {
  if (/[äöüÄÖÜ]/.test(term)) return term.replace(/[äöüÄÖÜ]/g, ch => TO_DIGRAPH[ch]);
  const umlauted = term.replace(/ae|oe|ue/gi, match => {
    const lower = { ae: 'ä', oe: 'ö', ue: 'ü' }[match.toLowerCase()];
    return match[0] === match[0].toUpperCase() ? lower.toUpperCase() : lower;
  });
  return umlauted === term ? null : umlauted;
}

function mapResult(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.feedUrl !== 'string') return null;
  const feedUrl = raw.feedUrl.trim();
  if (podcastFeedUrlError(feedUrl)) return null;
  let id;
  try {
    id = podcastIdFromFeedUrl(feedUrl);
  } catch {
    return null;
  }
  const cover = [raw.artworkUrl600, raw.artworkUrl100, raw.artworkUrl60].find(url => typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 2048) || null;
  return {
    id,
    feedUrl,
    title: cleanText(raw.collectionName || raw.trackName, 300),
    author: cleanText(raw.artistName, 200),
    cover,
    genre: cleanText(raw.primaryGenreName, 100),
  };
}

function parseResults(json, limit) {
  const seen = new Set();
  const results = [];
  for (const raw of Array.isArray(json && json.results) ? json.results : []) {
    const mapped = mapResult(raw);
    if (!mapped || !mapped.title || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    results.push(mapped);
    if (results.length >= limit) break;
  }
  return results;
}

/** options: fetchImpl (nodeFetch-kompatibel), now (() => ms), timeoutMs. search(term, { limit }) -> { results, cached }. Wirft SearchError. */
function createPodcastSearch({ fetchImpl = nodeFetch, now = () => Date.now(), timeoutMs = SEARCH_TIMEOUT_MS, country = 'DE' } = {}) {
  const cache = new Map(); // key -> { at, results }
  const requestTimes = [];

  function ratePermits() {
    const current = now();
    while (requestTimes.length && current - requestTimes[0] >= RATE_WINDOW_MS) requestTimes.shift();
    return requestTimes.length < RATE_MAX_REQUESTS;
  }

  async function request(term, limit) {
    if (!ratePermits()) throw new SearchError('Zu viele Suchanfragen – bitte später erneut versuchen', 'rate-limited');
    requestTimes.push(now());
    const url = `${SEARCH_URL}?${new URLSearchParams({ term, media: 'podcast', entity: 'podcast', country, limit: String(limit) })}`;
    let outcome;
    try {
      outcome = await withDeadline(timeoutMs, async signal => {
        const { response } = await fetchFollow(url, { fetchImpl, signal, maxRedirects: 2, headers: { Accept: 'application/json' } });
        if (response.status < 200 || response.status >= 300) {
          await discardBody(response);
          return { status: response.status };
        }
        const { buffer, truncated } = await readLimited(response, MAX_RESPONSE_BYTES);
        return { status: response.status, buffer, truncated };
      });
    } catch (error) {
      throw new SearchError(error.message || 'Suche fehlgeschlagen', 'network');
    }
    if (outcome.status === 429 || outcome.status === 403) throw new SearchError('Zu viele Suchanfragen – bitte später erneut versuchen', 'rate-limited');
    if (outcome.status < 200 || outcome.status >= 300) throw new SearchError(`Suchdienst antwortete mit HTTP ${outcome.status}`, 'http');
    if (outcome.truncated) throw new SearchError('Antwort des Suchdienstes ist zu groß', 'http');
    try {
      return JSON.parse(outcome.buffer.toString('utf8'));
    } catch {
      throw new SearchError('Antwort des Suchdienstes ist ungültig', 'http');
    }
  }

  async function search(input, { limit = MAX_LIMIT } = {}) {
    const term = normalizeTerm(input);
    if (!term) throw new SearchError(`Suchbegriff muss mindestens ${MIN_TERM_LENGTH} Zeichen haben`, 'invalid');
    const count = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || MAX_LIMIT));
    const key = `${cacheKey(term)}|${count}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return { results: hit.results, cached: true };

    let results = parseResults(await request(term, count), count);
    const alternative = results.length === 0 ? alternativeSpelling(term) : null;
    if (alternative) results = parseResults(await request(alternative, count), count);
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), results });
    return { results, cached: false };
  }

  return { search };
}

module.exports = { createPodcastSearch, normalizeTerm, alternativeSpelling, parseResults, SearchError, MAX_LIMIT, CACHE_TTL_MS };
