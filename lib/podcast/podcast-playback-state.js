'use strict';

// Zustandsautomat der Podcast-Wiedergabe (rein, ohne Electron; Konzept §2/§12). Getrennt von radio-state.js: Eine Episode
// ist eine endliche Datei mit Position, Dauer, Geschwindigkeit und ohne Wiederverbindung.
// Status: idle | loading | playing | paused | ended | error. Der PodcastController hält den Zustand im Main
// (Single Source of Truth) und wendet nur diese Funktionen an.

const MIN_RATE = 0.75;
const MAX_RATE = 2;
const DEFAULT_RATE = 1;
const DEFAULT_VOLUME = 0.8;
const END_MARGIN_SECONDS = 15; // Position näher am Ende: erneut von vorn beginnen
const MAX_SECONDS = 48 * 3600;

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, Math.round(number * 100) / 100));
}

/** Geschwindigkeit auf 0,75–2 begrenzt, in 0,05-Schritten; ungültige Eingaben ergeben 1. */
function clampRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_RATE;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(number * 20) / 20));
}

function cleanSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(MAX_SECONDS, number) : 0;
}

function createState({ volume = DEFAULT_VOLUME, rate = DEFAULT_RATE } = {}) {
  return { status: 'idle', episode: null, position: 0, duration: 0, rate: clampRate(rate), volume: clampVolume(volume), error: null };
}

function clampPosition(position, duration) {
  const pos = cleanSeconds(position);
  return duration > 0 ? Math.min(pos, duration) : pos;
}

/**
 * Startposition einer Episode. listen = gespeicherter Hörzustand { position, duration, played }.
 * Von vorn bei „gehört“, ohne Position oder wenn das Ende nahe ist (letzte 15 s); sonst die gespeicherte Position.
 */
function resumePosition(listen, duration = 0) {
  if (!listen || listen.played === true) return 0;
  const position = cleanSeconds(listen.position);
  if (position <= 0) return 0;
  const total = cleanSeconds(duration) || cleanSeconds(listen.duration);
  if (total > 0 && position >= total - END_MARGIN_SECONDS) return 0;
  return position;
}

/** Zielposition eines Sprungs (delta in Sekunden, negativ = zurück) innerhalb [0, Dauer]. */
function skipTarget(state, delta) {
  return clampPosition(state.position + (Number.isFinite(delta) ? delta : 0), state.duration);
}

/**
 * Wendet eine Aktion an und liefert den neuen Zustand (Eingabe bleibt unverändert). Ungültige Übergänge ändern nichts
 * und liefern denselben Zustand zurück.
 *
 * Aktionen: select {episode, position, duration} · playing · pause · resume · stop · ended · fail {message}
 *           time {position, duration?} · seek {position} · rate {value} · volume {value}
 */
function reduce(state, action) {
  const active = state.status === 'loading' || state.status === 'playing' || state.status === 'paused';
  switch (action && action.type) {
    case 'select': {
      if (!action.episode) return state;
      const duration = cleanSeconds(action.duration || action.episode.duration);
      return { ...state, status: 'loading', episode: action.episode, position: clampPosition(action.position, duration), duration, error: null };
    }
    case 'playing':
      if (state.status !== 'loading' && state.status !== 'playing') return state;
      return state.status === 'playing' && state.error === null ? state : { ...state, status: 'playing', error: null };
    case 'pause':
      if (state.status !== 'playing' && state.status !== 'loading') return state;
      return { ...state, status: 'paused' };
    case 'resume':
      if (state.status !== 'paused') return state;
      return { ...state, status: 'loading' };
    case 'stop':
      if (state.status === 'idle') return state;
      return { ...state, status: 'idle', episode: null, position: 0, duration: 0, error: null };
    case 'ended':
      if (!active) return state;
      return { ...state, status: 'ended', position: state.duration > 0 ? state.duration : state.position, error: null };
    case 'fail':
      if (state.status === 'idle') return state;
      return { ...state, status: 'error', error: String(action.message || 'Wiedergabe nicht möglich') };
    case 'time': {
      if (!active) return state;
      const reported = cleanSeconds(action.duration);
      const duration = reported > 0 ? reported : state.duration; // Dauer aus dem <audio>-Element, falls der Feed keine lieferte
      const position = clampPosition(action.position, duration);
      if (position === state.position && duration === state.duration) return state;
      return { ...state, position, duration };
    }
    case 'seek':
      if (!active) return state;
      return { ...state, position: clampPosition(action.position, state.duration) };
    case 'rate': {
      const rate = clampRate(action.value);
      return rate === state.rate ? state : { ...state, rate };
    }
    case 'volume': {
      const volume = clampVolume(action.value);
      return volume === state.volume ? state : { ...state, volume };
    }
    default:
      return state;
  }
}

/** Öffentlicher Zustand für Renderer/IPC (flache Kopie, Sekunden auf eine Nachkommastelle). */
function publicState(state) {
  const round = value => Math.round(value * 10) / 10;
  return {
    status: state.status,
    episode: state.episode ? { ...state.episode } : null,
    position: round(state.position),
    duration: round(state.duration),
    rate: state.rate,
    volume: state.volume,
    error: state.error,
  };
}

module.exports = {
  MIN_RATE,
  MAX_RATE,
  DEFAULT_RATE,
  DEFAULT_VOLUME,
  END_MARGIN_SECONDS,
  MAX_SECONDS,
  clampRate,
  clampVolume,
  createState,
  resumePosition,
  skipTarget,
  reduce,
  publicState,
};
