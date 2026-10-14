'use strict';

// Zustandsautomat für Radio (rein, ohne Electron): Status idle|loading|playing|paused|error, Lautstärke,
// Now Playing, Favoriten-Navigation (next/prev mit Umlauf) und Wiederverbindungsplan (max. 3 Versuche mit Backoff).
// Der RadioController hält den Zustand im Main und wendet nur diese Funktionen an (Single Source of Truth).

const STATUSES = ['idle', 'loading', 'playing', 'paused', 'error'];
const MAX_RECONNECTS = 3;
const BACKOFF_MS = [1000, 3000, 8000];
const DEFAULT_VOLUME = 0.8;

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, Math.round(number * 100) / 100));
}

function createState({ volume = DEFAULT_VOLUME, station = null } = {}) {
  return {
    status: 'idle',
    station,
    volume: clampVolume(volume),
    nowPlaying: null,
    error: null,
    attempt: 0,
    reconnecting: false,
  };
}

/**
 * Wendet eine Aktion an und liefert den neuen Zustand (Eingabe bleibt unverändert). Ungültige Übergänge
 * (z. B. pause im Zustand idle) ändern nichts und liefern denselben Zustand zurück.
 *
 * Aktionen: select {station} · playing · pause · resume · stop · volume {value} · now-playing {nowPlaying}
 *           reconnecting {attempt} · fail {message}
 */
function reduce(state, action) {
  switch (action && action.type) {
    case 'select':
      if (!action.station) return state;
      return { ...state, status: 'loading', station: action.station, nowPlaying: null, error: null, attempt: 0, reconnecting: false };
    case 'playing':
      if (state.status !== 'loading' && state.status !== 'playing') return state;
      return { ...state, status: 'playing', error: null, attempt: 0, reconnecting: false };
    case 'pause':
      if (state.status !== 'playing') return state;
      return { ...state, status: 'paused' };
    case 'resume':
      // Live-Stream: nach der Pause neu verbinden (kein veralteter Puffer)
      if (state.status !== 'paused') return state;
      return { ...state, status: 'loading', nowPlaying: null };
    case 'stop':
      if (state.status === 'idle') return state;
      return { ...state, status: 'idle', nowPlaying: null, error: null, attempt: 0, reconnecting: false };
    case 'volume':
      return { ...state, volume: clampVolume(action.value) };
    case 'now-playing':
      if (state.status === 'idle' || state.status === 'error') return state;
      return { ...state, nowPlaying: action.nowPlaying || null };
    case 'reconnecting':
      if (state.status !== 'loading' && state.status !== 'playing') return state;
      return { ...state, status: 'loading', attempt: action.attempt, reconnecting: true };
    case 'fail':
      if (state.status === 'idle') return state;
      return { ...state, status: 'error', nowPlaying: null, error: String(action.message || 'Stream nicht erreichbar'), reconnecting: false };
    default:
      return state;
  }
}

/** Nächster Wiederverbindungsversuch: { retry, attempt, delayMs }. Nur aus loading/playing mit Sender. */
function planReconnect(state) {
  if (!state.station || (state.status !== 'loading' && state.status !== 'playing')) {
    return { retry: false, attempt: state.attempt, delayMs: 0 };
  }
  const attempt = state.attempt + 1;
  if (attempt > MAX_RECONNECTS) return { retry: false, attempt: state.attempt, delayMs: 0 };
  return { retry: true, attempt, delayMs: BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] };
}

function sameKey(a, b) {
  return Boolean(a && b) && a.sourceId === b.sourceId && a.id === b.id;
}

/**
 * Nächster/vorheriger Favorit in der Liste ([{ sourceId, id }]) mit Umlauf. Ist der aktuelle Sender
 * kein Favorit (oder keiner aktiv), liefert next den ersten und prev den letzten Eintrag.
 */
function favoriteNeighbor(list, current, delta) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length || (delta !== 1 && delta !== -1)) return null;
  const index = items.findIndex(entry => sameKey(entry, current));
  if (index === -1) return delta === 1 ? items[0] : items[items.length - 1];
  return items[(index + delta + items.length) % items.length];
}

/** Zustand für die Oberfläche/IPC: nur serialisierbare Felder, Sender auf Anzeigefelder reduziert. */
function publicState(state) {
  const station = state.station;
  return {
    status: state.status,
    station: station
      ? {
          sourceId: station.sourceId,
          id: station.id,
          name: station.name,
          logo: station.logo || null,
          genre: station.genre || null,
        }
      : null,
    volume: state.volume,
    nowPlaying: state.nowPlaying ? { ...state.nowPlaying } : null,
    error: state.error,
    attempt: state.attempt,
    reconnecting: state.reconnecting,
  };
}

module.exports = {
  STATUSES,
  MAX_RECONNECTS,
  BACKOFF_MS,
  DEFAULT_VOLUME,
  clampVolume,
  createState,
  reduce,
  planReconnect,
  favoriteNeighbor,
  publicState,
};
