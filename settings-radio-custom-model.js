'use strict';

// Einstellungen → Radio → Eigene Sender (R3): reines Modell (kein DOM, kein IPC): Liste, Formularprüfung mit
// denselben Regeln wie der Main (lib/input-validation.js), Genre-Vorschläge und Klartext für „Stream prüfen“.

const { ensureCustomSource, CUSTOM_SOURCE_ID } = require('./lib/radio/radio-sources-logic.js');
const { radioStreamUrlError, radioLogoUrlError, radioHomepageUrlError } = require('./lib/input-validation.js');

const NAME_MAX = 200;
const GENRE_MAX = 100;
const DEFAULT_GENRES = ['Pop', 'Rock', 'Klassik', 'Jazz', 'Electronic', 'Schlager', 'Nachrichten', 'Hörspiel', 'Country', 'HipHop'];

/** Eigene Sender (Reihenfolge der Quelle) mit effektiven Feldern. */
function customStations(sources) {
  const source = ensureCustomSource(sources).find(s => s.id === CUSTOM_SOURCE_ID);
  const stations = Array.isArray(source.stations) ? source.stations : [];
  const order = Array.isArray(source.sortOrder) ? source.sortOrder : [];
  const pos = id => (order.indexOf(id) === -1 ? Number.MAX_SAFE_INTEGER : order.indexOf(id));
  return stations
    .map((station, index) => ({ station, index }))
    .sort((a, b) => pos(a.station.id) - pos(b.station.id) || a.index - b.index)
    .map(({ station }) => ({ id: station.id, name: station.name || station.id, streamUrl: station.streamUrl || '', logo: station.logo || '', genre: station.genre || '', homepage: station.homepage || '' }));
}

/** Genre-Vorschläge: Genres aller Sender und gängige Standards, alphabetisch ohne Doppelte. */
function genreSuggestions(sources) {
  const found = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const station of (source && source.stations) || []) if (station && station.genre) found.push(station.genre);
  }
  return [...new Set([...DEFAULT_GENRES, ...found])].sort((a, b) => a.localeCompare(b, 'de'));
}

/** Prüft die Formularfelder; liefert { errors, value } mit bereinigten Werten (value nur ohne Fehler sinnvoll). */
function validateStationForm(form) {
  const errors = {};
  const name = String(form.name || '').trim();
  const streamUrl = String(form.streamUrl || '').trim();
  const logo = String(form.logo || '').trim();
  const genre = String(form.genre || '').trim();
  const homepage = String(form.homepage || '').trim();
  if (!name) errors.name = 'Bitte einen Namen eingeben';
  else if (name.length > NAME_MAX) errors.name = `Name ist zu lang (max. ${NAME_MAX} Zeichen)`;
  if (!streamUrl) errors.streamUrl = 'Bitte eine Stream-URL eingeben';
  else {
    const message = radioStreamUrlError(streamUrl);
    if (message) errors.streamUrl = message;
  }
  if (logo) {
    const message = radioLogoUrlError(logo);
    if (message) errors.logo = message;
  }
  if (homepage) {
    const message = radioHomepageUrlError(homepage);
    if (message) errors.homepage = message;
  }
  if (genre.length > GENRE_MAX) errors.genre = `Genre ist zu lang (max. ${GENRE_MAX} Zeichen)`;
  return { errors, value: { name, streamUrl, logo, genre, homepage } };
}

/** Eingabe für radio:add-custom (leere optionale Felder werden weggelassen). */
function toAddInput(value) {
  const input = { name: value.name, streamUrl: value.streamUrl };
  if (value.logo) input.logo = value.logo;
  if (value.genre) input.genre = value.genre;
  if (value.homepage) input.homepage = value.homepage;
  return input;
}

/** Patch für radio:update-custom: nur geänderte Felder, leeres Logo/Genre/Webseite entfernt das Feld (leerer String). */
function toUpdatePatch(value, current) {
  const patch = {};
  for (const field of ['name', 'streamUrl', 'logo', 'genre', 'homepage']) {
    if (value[field] !== (current[field] || '')) patch[field] = value[field];
  }
  return patch;
}

const FORMATS = [
  [/mpeg|mp3/, 'MP3'],
  [/aacp|aac|mp4a/, 'AAC'],
  [/opus/, 'Opus'],
  [/ogg|vorbis/, 'Ogg Vorbis'],
  [/flac/, 'FLAC'],
];

function formatName(result) {
  if (result.kind === 'hls') return 'HLS (Segment-Stream)';
  const type = String(result.contentType || '').toLowerCase();
  const hit = FORMATS.find(([pattern]) => pattern.test(type));
  if (hit) return hit[1];
  return type ? type.replace(/^(audio|video|application)\//, '').toUpperCase() : 'unbekanntes Audioformat';
}

/** Ergebnis von radio:probe als { ok, text } in Klartext. */
function probeResultText(result) {
  if (!result || typeof result !== 'object') return { ok: false, text: 'Nicht erreichbar: keine Antwort' };
  if (!result.ok) return { ok: false, text: `Nicht erreichbar: ${result.error || 'Stream nicht erreichbar'}` };
  const parts = ['Erreichbar', `Format: ${formatName(result)}`];
  if (result.bitrate) parts.push(`${result.bitrate} kbit/s`);
  if (result.icyName) parts.push(`Sender meldet „${result.icyName}“`);
  if (Array.isArray(result.via) && result.via.length) parts.push(`über Playlist (${result.via.join(', ')})`);
  return { ok: true, text: parts.join(' · ') };
}

const SOURCE_NAMES = { homepage: 'Webseite', google: 'Google' };
const NO_HOMEPAGE_TEXT = 'Webseite eintragen, um ein Logo zu finden';

/** Webseite aus der Stream-Prüfung (icy-url) übernehmen, aber nur in ein leeres Feld. Liefert den neuen Feldwert. */
function prefillHomepage(current, probeResult) {
  const value = String(current || '').trim();
  if (value) return current;
  const found = probeResult && probeResult.ok && typeof probeResult.homepage === 'string' ? probeResult.homepage : '';
  return found && !radioHomepageUrlError(found) ? found : '';
}

/**
 * Darf die Logo-Suche das Logo-Feld füllen? Nur wenn es leer ist oder noch den zuletzt automatisch eingetragenen Wert
 * enthält (ein vom Nutzer eingetragenes oder geändertes Logo wird nie überschrieben).
 */
function canFillLogo(logoValue, autoFilled) {
  const value = String(logoValue || '').trim();
  return !value || (Boolean(autoFilled) && value === autoFilled);
}

/** Ergebnis von radio:find-logo als { ok, found, text } (Statuszeile). */
function logoResultText(result) {
  if (!result || typeof result !== 'object') return { ok: false, found: false, text: 'Logo-Suche fehlgeschlagen: keine Antwort' };
  if (!result.ok) return { ok: false, found: false, text: `Logo-Suche fehlgeschlagen: ${result.error || 'unbekannter Fehler'}` };
  if (result.logo) return { ok: true, found: true, text: `Logo gefunden (Quelle: ${SOURCE_NAMES[result.source] || 'Webseite'})` };
  if (result.reason === 'no-homepage') return { ok: true, found: false, text: NO_HOMEPAGE_TEXT };
  return { ok: true, found: false, text: 'Kein Logo gefunden' };
}

module.exports = { NO_HOMEPAGE_TEXT, prefillHomepage, canFillLogo, logoResultText, DEFAULT_GENRES, customStations, genreSuggestions, validateStationForm, toAddInput, toUpdatePatch, probeResultText };
