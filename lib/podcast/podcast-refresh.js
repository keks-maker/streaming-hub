'use strict';

// Feed-Aktualisierung (Konzept §2/§12): bedingte Requests (ETag/If-Modified-Since, 304), höchstens 4 Feeds parallel,
// Fehlerzustand pro Abo statt Gesamtabbruch, Feeds ohne Validatoren höchstens alle 60 Minuten (außer manuell erzwungen).
// Netzwerk (fetch) und Zeit sind injizierbar. Fehlermeldungen/Logs enthalten nie die Feed-URL.

const { fetchFeed } = require('./podcast-fetch.js');
const { parseFeed } = require('./feed-parser.js');

const DEFAULT_CONCURRENCY = 4;
const NO_VALIDATOR_INTERVAL_MS = 60 * 60 * 1000;
// Ein Timer-Lauf stempelt wenige Millisekunden nach seinem Tick; ohne Toleranz würde jeder zweite Lauf als „zu früh“ übersprungen.
const INTERVAL_TOLERANCE_MS = 30 * 1000;

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * options: library (PodcastLibrary), fetch (Standard: fetchFeed), now (() => Date), concurrency, logger,
 * noValidatorIntervalMs (Zahl oder () => Zahl: Mindestabstand für Feeds ohne ETag/Last-Modified; Standard 60 min, folgt dem Prüfintervall).
 * refreshOne(id, { force }) -> { id, status: 'updated'|'not-modified'|'skipped'|'error', newEpisodes?, error? }
 * refreshAll({ force }) -> { results, updated, unchanged, skipped, failed }
 */
function createPodcastRefresher({ library, fetch = fetchFeed, now = () => new Date(), concurrency = DEFAULT_CONCURRENCY, logger = null, noValidatorIntervalMs = NO_VALIDATOR_INTERVAL_MS }) {
  const minInterval = () => {
    const value = typeof noValidatorIntervalMs === 'function' ? noValidatorIntervalMs() : noValidatorIntervalMs;
    return Number.isFinite(value) && value > 0 ? value : NO_VALIDATOR_INTERVAL_MS;
  };
  const running = new Map(); // id -> Promise: gleichzeitige Aktualisierung desselben Abos nur einmal

  async function run(subscription, { force }) {
    const id = subscription.id;
    const meta = library.getFeedMeta(id);
    const hasValidators = Boolean(meta.etag || meta.lastModified);
    const checkedAt = meta.lastChecked ? Date.parse(meta.lastChecked) : NaN;
    if (!force && !hasValidators && Number.isFinite(checkedAt) && !meta.lastError && now().getTime() - checkedAt < minInterval() - INTERVAL_TOLERANCE_MS) {
      return { id, status: 'skipped' };
    }
    const stamp = new Date(now()).toISOString();
    try {
      const response = await fetch(subscription.feedUrl, { validators: { etag: meta.etag, lastModified: meta.lastModified } });
      if (response.status === 'not-modified') {
        library.setFeedMeta(id, { lastChecked: stamp, lastError: null, lastErrorAt: null, etag: response.etag || meta.etag, lastModified: response.lastModified || meta.lastModified });
        return { id, status: 'not-modified' };
      }
      const parsed = parseFeed(response.text);
      const previous = new Set(library.getCachedFeed(id).episodes.map(episode => episode.id));
      const newEpisodes = previous.size ? parsed.episodes.filter(episode => !previous.has(episode.id)).length : 0;
      library.setEpisodes(id, { episodes: parsed.episodes, channel: parsed.channel });
      library.fillFromChannel(id, parsed.channel);
      library.setFeedMeta(id, { lastChecked: stamp, lastError: null, lastErrorAt: null, etag: response.etag, lastModified: response.lastModified });
      return { id, status: 'updated', newEpisodes, episodeCount: parsed.episodes.length };
    } catch (error) {
      const message = (error && error.message) || 'Feed nicht abrufbar';
      library.setFeedMeta(id, { lastChecked: stamp, lastError: message, lastErrorAt: stamp });
      if (logger) logger.warn(`Podcast-Feed ${id} nicht aktualisiert:`, message);
      return { id, status: 'error', error: message };
    }
  }

  function refreshOne(id, { force = false } = {}) {
    const subscription = library.getSubscription(id);
    if (!subscription) return Promise.resolve({ id, status: 'error', error: 'Abo nicht gefunden' });
    if (running.has(id)) return running.get(id);
    const promise = run(subscription, { force }).finally(() => running.delete(id));
    running.set(id, promise);
    return promise;
  }

  async function refreshAll({ force = false } = {}) {
    const subscriptions = library.getSubscriptions();
    const results = await mapLimited(subscriptions, concurrency, subscription => refreshOne(subscription.id, { force }));
    const count = status => results.filter(result => result.status === status).length;
    return { results, updated: count('updated'), unchanged: count('not-modified'), skipped: count('skipped'), failed: count('error') };
  }

  return { refreshOne, refreshAll };
}

module.exports = { createPodcastRefresher, NO_VALIDATOR_INTERVAL_MS, INTERVAL_TOLERANCE_MS, DEFAULT_CONCURRENCY };
