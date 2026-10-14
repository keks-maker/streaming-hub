// Radio-Dashboard (R2): Modell der Favoriten-Kacheln. Reine Funktionen ohne DOM und ohne IPC — die Ansicht
// (radio-dashboard-view.js) rendert das Ergebnis ausschließlich per textContent.
// Eingabe: Quellen aus radio:get-sources und der öffentliche Zustand aus radio:state.

'use strict';

const { favoriteStations, favoriteKeys, findStation } = require('./lib/radio/radio-sources-logic.js');

// Vorschlag für „Beliebte Sender hinzufügen“ (Quelle „Deutsche Radiosender“); nur vorhandene Sender werden gesetzt
const POPULAR_SOURCE_ID = 'deutsche-radiosender';
const POPULAR_STATION_IDS = [
  '1live',
  'wdr2-rheinland',
  'swr3',
  'antenne-bayern',
  'rock-antenne',
  'deutschlandfunk',
  'dlf-nova',
  '80s80s',
];
const MIN_POPULAR = 5;

const MSG_EMPTY = 'Noch keine Favoriten. Füge beliebte Sender hinzu oder wähle eigene in der Senderverwaltung.';
const MSG_EMPTY_HINT =
  'In der Senderverwaltung lassen sich Sender suchen, eigene Streams hinzufügen und Favoriten ordnen.';

/** „n Favoriten“ (Singular „1 Favorit“) für die Statuszeile. */
function favoriteCountText(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${n} ${n === 1 ? 'Favorit' : 'Favoriten'}`;
}

/** Anzahl der Favoriten in den Quellen (für die Schrittsteuerung im Mini-Player). */
function favoriteCountOf(sources) {
  return favoriteKeys(Array.isArray(sources) ? sources : []).length;
}

/** Logo-URL nur als http(s) ohne Zugangsdaten; sonst null (Platzhalter). */
function safeLogoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password)
      return parsed.toString();
  } catch {
    /* ungültige URL → Platzhalter */
  }
  return null;
}

function isCurrent(state, station) {
  const current = state && state.station;
  return Boolean(current && station) && current.sourceId === station.sourceId && current.id === station.id;
}

/** Interpret – Titel (oder nur Titel); leer ohne Metadaten. */
function nowPlayingText(nowPlaying) {
  if (!nowPlaying || typeof nowPlaying !== 'object') return '';
  const title = typeof nowPlaying.title === 'string' ? nowPlaying.title.trim() : '';
  const artist = typeof nowPlaying.artist === 'string' ? nowPlaying.artist.trim() : '';
  if (artist && title) return `${artist} – ${title}`;
  return title || artist;
}

/**
 * Kachelzustand: 'idle' (nicht aktiv) | 'loading' | 'playing' | 'paused' | 'error'.
 * Nur der aktuell gewählte Sender hat einen anderen Zustand als 'idle'.
 */
function tileStateOf(state, station) {
  if (!isCurrent(state, station)) return 'idle';
  const status = state.status;
  return status === 'loading' || status === 'playing' || status === 'paused' || status === 'error' ? status : 'idle';
}

/**
 * Klickaktion einer Kachel (Klick = Play, erneut = Pause):
 * idle/error → 'play' (bei Fehler erneuter Versuch) · loading → 'stop' (Verbinden abbrechen)
 * playing → 'pause' · paused → 'resume'.
 */
function tileAction(tileState) {
  if (tileState === 'playing') return 'pause';
  if (tileState === 'paused') return 'resume';
  if (tileState === 'loading') return 'stop';
  return 'play';
}

/** Untere Zeile der Kachel: Genre, bei aktiver Kachel Status bzw. laufender Titel. */
function tileMeta(tileState, station, state) {
  const genre = station.genre || 'Radio';
  if (tileState === 'idle') return genre;
  if (tileState === 'loading') return state.reconnecting ? 'Verbindung wird neu aufgebaut …' : 'Verbinde …';
  if (tileState === 'paused') return 'Pausiert';
  if (tileState === 'error') return state.error ? `Fehler: ${state.error}` : 'Stream nicht erreichbar';
  return nowPlayingText(state.nowPlaying) || genre;
}

const ACTION_LABEL = { play: 'abspielen', pause: 'pausieren', resume: 'fortsetzen', stop: 'Verbinden abbrechen' };

/** Kachel für einen Sender: Anzeigefelder, Zustand und Klickaktion. */
function tileModel(station, state) {
  const tileState = tileStateOf(state, station);
  const action = tileAction(tileState);
  const meta = tileMeta(tileState, station, state || {});
  return {
    sourceId: station.sourceId,
    id: station.id,
    key: { sourceId: station.sourceId, stationId: station.id },
    name: station.name,
    genre: station.genre || '',
    logo: safeLogoUrl(station.logo),
    initial: (station.name || '?').trim().slice(0, 1).toUpperCase() || '?',
    state: tileState,
    active: tileState !== 'idle',
    action,
    meta,
    ariaLabel: `${station.name}${tileState === 'idle' ? '' : `, ${meta}`} – ${ACTION_LABEL[action]}`,
  };
}

/**
 * Modell des Radio-Dashboards.
 * Ausgabe: { count, countText, empty, tiles, emptyMessage, emptyHint, popular }
 *   popular: Anzahl der per „Beliebte Sender hinzufügen“ setzbaren Sender (0 = Button ausblenden)
 */
function radioDashboardModel({ sources, state } = {}) {
  const stations = favoriteStations(Array.isArray(sources) ? sources : []);
  const tiles = stations.map(station => tileModel(station, state));
  return {
    count: tiles.length,
    countText: favoriteCountText(tiles.length),
    empty: tiles.length === 0,
    tiles,
    emptyMessage: MSG_EMPTY,
    emptyHint: MSG_EMPTY_HINT,
    popular: tiles.length === 0 ? popularFavoriteKeys(sources).length : 0,
  };
}

/**
 * Standardfavoriten (5–8) aus den vorhandenen Quellen als [{ sourceId, stationId }] für radio:set-favorite.
 * Fehlen Vorschlagssender, wird mit den ersten Sendern der gebündelten Quelle aufgefüllt; unter 5 Treffern → [].
 */
function popularFavoriteKeys(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const keys = [];
  const add = (sourceId, stationId) => {
    if (
      keys.length < POPULAR_STATION_IDS.length &&
      !keys.some(k => k.sourceId === sourceId && k.stationId === stationId) &&
      findStation(list, { sourceId, stationId })
    ) {
      keys.push({ sourceId, stationId });
    }
  };
  POPULAR_STATION_IDS.forEach(id => add(POPULAR_SOURCE_ID, id));
  if (keys.length < MIN_POPULAR) {
    const source = list.find(s => s && s.id === POPULAR_SOURCE_ID);
    for (const station of (source && source.stations) || []) {
      if (keys.length >= MIN_POPULAR) break;
      if (station && typeof station.id === 'string') add(POPULAR_SOURCE_ID, station.id);
    }
  }
  return keys.length >= MIN_POPULAR ? keys : [];
}

module.exports = {
  POPULAR_SOURCE_ID,
  POPULAR_STATION_IDS,
  MSG_EMPTY,
  MSG_EMPTY_HINT,
  favoriteCountText,
  favoriteCountOf,
  safeLogoUrl,
  nowPlayingText,
  tileStateOf,
  tileAction,
  tileModel,
  radioDashboardModel,
  popularFavoriteKeys,
};
