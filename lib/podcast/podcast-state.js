'use strict';

// Hörzustand und Feed-Metadaten (Konzept §4), rein funktional ohne Dateizugriff. Datei podcast-state.json:
//   { version: 1,
//     episodes: { "<podcastId>|<episodeId>": { position, duration, played, updatedAt } },   // Sekunden, ISO-Zeit
//     feeds:    { "<podcastId>": { lastChecked, etag, lastModified, lastError, lastErrorAt } } }
// Alle Funktionen liefern einen neuen Zustand (Eingabe bleibt unverändert) und akzeptieren beschädigte Dateien.
// Auto-„gehört“ ab 95 %; Hörzustände älter als 12 Monate, die nicht mehr im Feed stehen, werden aufgeräumt.

const PLAYED_THRESHOLD = 0.95;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;
const MAX_ID_LENGTH = 500;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']); // nie als Objekt-Schlüssel aus JSON übernehmen

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function episodeKey(podcastId, episodeId) {
  return `${podcastId}|${episodeId}`;
}

function splitKey(key) {
  const index = key.indexOf('|'); // Abo-IDs sind Hex ohne "|": der erste Trenner trennt
  return index <= 0 ? null : { podcastId: key.slice(0, index), episodeId: key.slice(index + 1) };
}

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const duration = seconds(raw.duration);
  return { position: seconds(raw.position), duration: duration || null, played: raw.played === true, updatedAt: validTime(raw.updatedAt) };
}

function normalizeFeedMeta(raw) {
  if (!isPlainObject(raw)) return null;
  const str = value => (typeof value === 'string' && value && value.length <= 1000 ? value : null);
  return { lastChecked: validTime(raw.lastChecked), etag: str(raw.etag), lastModified: str(raw.lastModified), lastError: str(raw.lastError), lastErrorAt: validTime(raw.lastErrorAt) };
}

function createState() {
  return { version: 1, episodes: {}, feeds: {} };
}

function normalizeState(raw) {
  const state = createState();
  if (!isPlainObject(raw)) return state;
  if (isPlainObject(raw.episodes)) {
    for (const [key, value] of Object.entries(raw.episodes)) {
      if (Object.keys(state.episodes).length >= MAX_ENTRIES) break;
      const entry = key.length <= MAX_ID_LENGTH * 2 && splitKey(key) ? normalizeEntry(value) : null;
      if (entry) state.episodes[key] = entry;
    }
  }
  if (isPlainObject(raw.feeds)) {
    for (const [id, value] of Object.entries(raw.feeds)) {
      const meta = id.length <= MAX_ID_LENGTH && !UNSAFE_KEYS.has(id) ? normalizeFeedMeta(value) : null;
      if (meta) state.feeds[id] = meta;
    }
  }
  return state;
}

const EMPTY_ENTRY = Object.freeze({ position: 0, duration: null, played: false, updatedAt: null });

function getEpisodeState(state, podcastId, episodeId) {
  return (state && state.episodes && state.episodes[episodeKey(podcastId, episodeId)]) || { ...EMPTY_ENTRY };
}

function withEntry(state, podcastId, episodeId, entry) {
  return { ...state, episodes: { ...state.episodes, [episodeKey(podcastId, episodeId)]: entry } };
}

/**
 * Speichert die Position. duration (Sekunden) ist optional; bekannte Dauer bleibt erhalten. Erreicht die Position
 * 95 % der Dauer, gilt die Episode als gehört (Position wird auf 0 gesetzt, damit ein erneutes Abspielen von vorn startet).
 */
function savePosition(state, podcastId, episodeId, { position, duration } = {}, now = new Date()) {
  const previous = getEpisodeState(state, podcastId, episodeId);
  const total = seconds(duration) || previous.duration || null;
  const pos = seconds(position);
  const finished = Boolean(total) && pos >= total * PLAYED_THRESHOLD;
  const played = previous.played || finished;
  return withEntry(state, podcastId, episodeId, {
    position: finished ? 0 : pos,
    duration: total,
    played,
    updatedAt: new Date(now).toISOString(),
  });
}

/** „Gehört“ manuell setzen/zurücknehmen; in beiden Fällen startet die Wiedergabe wieder von vorn. */
function setPlayed(state, podcastId, episodeId, played, now = new Date()) {
  const previous = getEpisodeState(state, podcastId, episodeId);
  return withEntry(state, podcastId, episodeId, { position: 0, duration: previous.duration, played: played === true, updatedAt: new Date(now).toISOString() });
}

function setFeedMeta(state, podcastId, patch) {
  const previous = state.feeds[podcastId] || { lastChecked: null, etag: null, lastModified: null, lastError: null, lastErrorAt: null };
  return { ...state, feeds: { ...state.feeds, [podcastId]: { ...previous, ...patch } } };
}

function removeFeedMeta(state, podcastId) {
  if (!state.feeds[podcastId]) return state;
  const feeds = { ...state.feeds };
  delete feeds[podcastId];
  return { ...state, feeds };
}

/**
 * Räumt auf: Einträge, die älter als 12 Monate sind UND deren Episode nicht mehr im Feed-Cache steht, entfallen;
 * ebenso Feed-Metadaten ohne Abo. isKnownEpisode(podcastId, episodeId) -> boolean, hasSubscription(podcastId) -> boolean.
 */
function pruneState(state, { now = new Date(), isKnownEpisode = () => false, hasSubscription = () => true } = {}) {
  const limit = new Date(now).getTime() - RETENTION_MS;
  const episodes = {};
  for (const [key, entry] of Object.entries(state.episodes)) {
    const parts = splitKey(key);
    const updated = entry.updatedAt ? Date.parse(entry.updatedAt) : 0;
    if (parts && updated < limit && !isKnownEpisode(parts.podcastId, parts.episodeId)) continue;
    episodes[key] = entry;
  }
  const feeds = {};
  for (const [id, meta] of Object.entries(state.feeds)) if (hasSubscription(id)) feeds[id] = meta;
  const changed = Object.keys(episodes).length !== Object.keys(state.episodes).length || Object.keys(feeds).length !== Object.keys(state.feeds).length;
  return changed ? { ...state, episodes, feeds } : state;
}

/** Überträgt Zustände auf neue Abo-IDs (idMap: alte -> neue ID), z. B. nach geänderter Katalog-Feed-URL. */
function migrateIds(state, idMap) {
  if (!idMap || !Object.keys(idMap).length) return state;
  const episodes = {};
  for (const [key, entry] of Object.entries(state.episodes)) {
    const parts = splitKey(key);
    const target = parts && idMap[parts.podcastId] ? episodeKey(idMap[parts.podcastId], parts.episodeId) : key;
    const existing = episodes[target];
    if (!existing || (entry.updatedAt || '') > (existing.updatedAt || '')) episodes[target] = entry;
  }
  const feeds = {};
  for (const [id, meta] of Object.entries(state.feeds)) {
    if (idMap[id]) feeds[idMap[id]] = { ...meta, etag: null, lastModified: null }; // Validatoren gelten nur für die alte Adresse
    else if (!feeds[id]) feeds[id] = meta;
  }
  return { ...state, episodes, feeds };
}

module.exports = {
  PLAYED_THRESHOLD,
  RETENTION_MS,
  createState,
  normalizeState,
  episodeKey,
  getEpisodeState,
  savePosition,
  setPlayed,
  setFeedMeta,
  removeFeedMeta,
  pruneState,
  migrateIds,
};
