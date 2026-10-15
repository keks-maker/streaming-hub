'use strict';

const { remoteHttpUrl, text, radioStreamUrlError, radioLogoUrlError, radioHomepageUrlError, podcastFeedUrlError } = require('./input-validation.js');
const { normalizeState } = require('./podcast/podcast-state.js');
const { normalizePodcastSettings } = require('./podcast/podcast-settings.js');
const { sanitizeOverrides } = require('./podcast/podcast-overrides.js');
const { podcastIdFromFeedUrl } = require('./podcast/podcast-ids.js');
const { normalizeRadioSettings } = require('./radio/radio-settings.js');

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 1000;
const MAX_COLLECTION_ENTRIES = 5000;
const MAX_RADIO_STATIONS = 20000;
const MAX_PODCAST_SUBSCRIPTIONS = 1000;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Radio (optional, abwärtskompatibel): Quellen mit Sendern; Stream-URLs dürfen LAN-Adressen enthalten.
function validateRadioSources(radioSources) {
  if (!Array.isArray(radioSources) || radioSources.length > MAX_COLLECTION_ENTRIES) {
    return 'Backup enthält ungültige Radio-Quellen';
  }
  let total = 0;
  for (const source of radioSources) {
    if (!isPlainObject(source) || typeof source.id !== 'string' || typeof source.name !== 'string') {
      return 'Backup enthält eine ungültige Radio-Quelle';
    }
    text(source.id, 'Radio-Quellen-ID', 200);
    text(source.name, 'Radio-Quellenname', 200);
    if (source.stations !== undefined && !Array.isArray(source.stations)) return 'Backup enthält ungültige Radiosender';
    for (const station of source.stations || []) {
      total += 1;
      if (total > MAX_RADIO_STATIONS) return 'Backup enthält zu viele Radiosender';
      if (!isPlainObject(station) || typeof station.id !== 'string' || typeof station.name !== 'string') {
        return 'Backup enthält einen ungültigen Radiosender';
      }
      text(station.id, 'Sender-ID', 500);
      text(station.name, 'Sendername', 200);
      const urlError = radioStreamUrlError(station.streamUrl);
      if (urlError) return `Backup enthält einen ungültigen Radiosender: ${urlError}`;
      if (station.logo !== undefined && station.logo !== null && station.logo !== '') {
        const logoError = radioLogoUrlError(station.logo);
        if (logoError) return `Backup enthält einen ungültigen Radiosender: ${logoError}`;
      }
      if (source.type === 'user' && station.homepage !== undefined && station.homepage !== null && station.homepage !== '') {
        const homepageError = radioHomepageUrlError(station.homepage);
        if (homepageError) return `Backup enthält einen ungültigen Radiosender: ${homepageError}`;
      }
    }
    if (source.favorites !== undefined && !Array.isArray(source.favorites)) return 'Backup enthält ungültige Radio-Favoriten';
  }
  return null;
}

// Podcasts (optional, abwärtskompatibel): Abos mit Reihenfolge und Overrides; der Hörstatus wird über normalizeState bereinigt.
function validatePodcasts(podcasts) {
  if (!isPlainObject(podcasts) || !Array.isArray(podcasts.subscriptions) || podcasts.subscriptions.length > MAX_PODCAST_SUBSCRIPTIONS) {
    return 'Backup enthält ungültige Podcast-Abos';
  }
  const ids = new Set();
  for (const sub of podcasts.subscriptions) {
    if (!isPlainObject(sub) || typeof sub.id !== 'string' || typeof sub.title !== 'string') return 'Backup enthält ein ungültiges Podcast-Abo';
    text(sub.id, 'Podcast-ID', 200);
    text(sub.title, 'Podcast-Titel', 300);
    const urlError = podcastFeedUrlError(sub.feedUrl);
    if (urlError) return `Backup enthält ein ungültiges Podcast-Abo: ${urlError}`;
    if (sub.cover !== undefined && sub.cover !== null && sub.cover !== '' && podcastFeedUrlError(sub.cover)) return 'Backup enthält ein ungültiges Podcast-Abo: Cover-URL ist ungültig';
    if (sub.id !== podcastIdFromFeedUrl(sub.feedUrl)) return 'Backup enthält ein Podcast-Abo mit unpassender ID';
    if (ids.has(sub.id)) return 'Backup enthält doppelte Podcast-Abos';
    ids.add(sub.id);
  }
  if (podcasts.subscriptionRank !== undefined && (!Array.isArray(podcasts.subscriptionRank) || podcasts.subscriptionRank.length > MAX_PODCAST_SUBSCRIPTIONS)) return 'Backup enthält eine ungültige Podcast-Reihenfolge';
  if (podcasts.overrides !== undefined && !isPlainObject(podcasts.overrides)) return 'Backup enthält ungültige Podcast-Anpassungen';
  return null;
}

function validateBackup(data) {
  if (!isPlainObject(data)) return { ok: false, error: 'Backup muss ein Objekt sein' };
  if (!Array.isArray(data.services) || (!Array.isArray(data.tvSources) && !Array.isArray(data.tvsources))) {
    return { ok: false, error: 'Backup benötigt services und tvsources als Arrays' };
  }
  const tvsources = data.tvSources || data.tvsources;
  if (data.services.length > MAX_COLLECTION_ENTRIES || tvsources.length > MAX_COLLECTION_ENTRIES) {
    return { ok: false, error: 'Backup enthält zu viele Einträge' };
  }
  if (data.history !== undefined && (!Array.isArray(data.history) || data.history.length > MAX_HISTORY_ENTRIES)) {
    return { ok: false, error: 'Backup enthält einen ungültigen Verlauf' };
  }
  try {
    for (const service of data.services) {
      if (!isPlainObject(service) || typeof service.id !== 'string' || typeof service.name !== 'string') {
        return { ok: false, error: 'Backup enthält einen ungültigen Dienst' };
      }
      text(service.id, 'Dienst-ID', 200);
      text(service.name, 'Dienstname', 200);
      remoteHttpUrl(service.url, 'Dienst-URL');
    }
    for (const source of tvsources) {
      if (!isPlainObject(source) || typeof source.id !== 'string' || typeof source.name !== 'string') {
        return { ok: false, error: 'Backup enthält eine ungültige TV-Quelle' };
      }
      text(source.id, 'Quellen-ID', 200);
      text(source.name, 'Quellenname', 200);
      if (source.type === 'file') text(source.url, 'M3U-Dateipfad', 4096);
      else remoteHttpUrl(source.url, 'M3U-URL');
      if (source.epgUrl !== undefined && source.epgUrl !== null && source.epgUrl !== '') {
        remoteHttpUrl(source.epgUrl, 'EPG-URL');
      }
    }
    const radioSources = data.radioSources !== undefined ? data.radioSources : data.radiosources;
    if (radioSources !== undefined) {
      const radioError = validateRadioSources(radioSources);
      if (radioError) return { ok: false, error: radioError };
    }
    if (data.podcasts !== undefined) {
      const podcastError = validatePodcasts(data.podcasts);
      if (podcastError) return { ok: false, error: podcastError };
    }
    if (data.podcastState !== undefined && !isPlainObject(data.podcastState)) return { ok: false, error: 'Backup enthält einen ungültigen Podcast-Hörstatus' };
  } catch (error) {
    return { ok: false, error: `Backup enthält ungültige URL-Daten: ${error.message}` };
  }
  const value = { ...data, tvsources, history: data.history || [] };
  // Radio ist optional (ältere Sicherungen haben es nicht): kanonisch als radioSources, Einstellungen normalisiert
  const radioSources = data.radioSources !== undefined ? data.radioSources : data.radiosources;
  delete value.radiosources;
  if (radioSources !== undefined) value.radioSources = radioSources;
  if (data.radioSettings !== undefined) value.radioSettings = normalizeRadioSettings(data.radioSettings);
  // Podcasts sind optional (ältere Sicherungen haben sie nicht); der Hörstatus enthält nie Feed-Validatoren
  if (data.podcasts !== undefined) value.podcasts = { ...data.podcasts, overrides: sanitizeOverrides(data.podcasts.overrides) };
  if (data.podcastState !== undefined) value.podcastState = { version: 1, episodes: normalizeState(data.podcastState).episodes };
  if (data.podcastSettings !== undefined) value.podcastSettings = normalizePodcastSettings(data.podcastSettings); // ältere Sicherungen haben sie nicht
  return { ok: true, value };
}

function parseBackup(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BACKUP_BYTES) {
    throw new Error('Backup ist zu groß');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Backup ist kein gültiges JSON: ${error.message}`);
  }
  const result = validateBackup(data);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

module.exports = { MAX_BACKUP_BYTES, parseBackup, validateBackup };
