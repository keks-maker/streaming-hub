'use strict';

// Einstellungen → Radio → Eigene Sender (R3): reines Modell (kein DOM, kein IPC): Liste, Formularprüfung mit
// denselben Regeln wie der Main (lib/input-validation.js), Genre-Vorschläge und Klartext für „Stream prüfen“.

const { ensureCustomSource, CUSTOM_SOURCE_ID } = require('./lib/radio/radio-sources-logic.js');
const { radioStreamUrlError, radioLogoUrlError } = require('./lib/input-validation.js');

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
    .map(({ station }) => ({ id: station.id, name: station.name || station.id, streamUrl: station.streamUrl || '', logo: station.logo || '', genre: station.genre || '' }));
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
  if (genre.length > GENRE_MAX) errors.genre = `Genre ist zu lang (max. ${GENRE_MAX} Zeichen)`;
  return { errors, value: { name, streamUrl, logo, genre } };
}

/** Eingabe für radio:add-custom (leere optionale Felder werden weggelassen). */
function toAddInput(value) {
  const input = { name: value.name, streamUrl: value.streamUrl };
  if (value.logo) input.logo = value.logo;
  if (value.genre) input.genre = value.genre;
  return input;
}

/** Patch für radio:update-custom: nur geänderte Felder, leeres Logo/Genre entfernt das Feld (leerer String). */
function toUpdatePatch(value, current) {
  const patch = {};
  for (const field of ['name', 'streamUrl', 'logo', 'genre']) {
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

module.exports = { DEFAULT_GENRES, customStations, genreSuggestions, validateStationForm, toAddInput, toUpdatePatch, probeResultText };
