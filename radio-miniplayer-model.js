// Radio-Mini-Player (R2): Modell der Leiste unten im Hauptfenster. Reine Funktionen ohne DOM und ohne IPC;
// die Ansicht (radio-miniplayer-view.js) setzt alle Texte per textContent.
// Eingabe: öffentlicher Zustand aus radio:state (status, station, nowPlaying, volume, error, reconnecting).

'use strict';

const { nowPlayingText, safeLogoUrl } = require('./radio-dashboard-model.js');

const STATUS_TEXT = {
  loading: 'Verbinde …',
  paused: 'Pausiert',
  error: 'Stream nicht erreichbar',
};

/** Sichtbar, solange Radio nicht idle ist und kein Vollbild (Webview/Player) aktiv ist. */
function isMiniPlayerVisible(state, { suppressed = false } = {}) {
  return Boolean(state && state.status && state.status !== 'idle' && state.station) && !suppressed;
}

/** Zweite Zeile: Titel/Interpret beim Spielen, sonst Statustext; Fehlertext des Controllers hat Vorrang bei 'error'. */
function subtitleOf(state) {
  if (state.status === 'playing') return nowPlayingText(state.nowPlaying) || state.station.genre || 'Live';
  if (state.status === 'loading') return state.reconnecting ? 'Verbindung wird neu aufgebaut …' : STATUS_TEXT.loading;
  if (state.status === 'error') return state.error || STATUS_TEXT.error;
  return STATUS_TEXT[state.status] || '';
}

/**
 * Primäre Aktion der Play/Pause-Taste:
 * playing → 'pause' · loading → 'stop' (Verbinden abbrechen) · paused → 'resume' · error → 'play' (erneut versuchen).
 */
function playPauseAction(status) {
  if (status === 'playing') return 'pause';
  if (status === 'loading') return 'stop';
  if (status === 'paused') return 'resume';
  return 'play';
}

const PLAY_PAUSE_LABEL = {
  pause: 'Pause',
  stop: 'Verbinden abbrechen',
  resume: 'Wiedergabe fortsetzen',
  play: 'Erneut versuchen',
};

/** Bildschirmleser-Text bei Statuswechsel (aria-live, höflich): nur Sender und Status, nicht jeder Titel. */
function liveMessage(state) {
  if (!state || !state.station || state.status === 'idle') return '';
  const name = state.station.name;
  switch (state.status) {
    case 'loading':
      return state.reconnecting ? `${name}: Verbindung wird neu aufgebaut` : `${name}: Verbinde`;
    case 'playing':
      return `${name}: spielt`;
    case 'paused':
      return `${name}: pausiert`;
    case 'error':
      return `${name}: Stream nicht erreichbar`;
    default:
      return '';
  }
}

/**
 * Modell der Leiste.
 * Eingabe: state (radio:state), { favoriteCount, suppressed }
 * Ausgabe: { visible, name, subtitle, logo, initial, status, action, playPauseLabel, canStep, volume, volumePercent, live }
 */
function miniPlayerModel(state, { favoriteCount = 0, suppressed = false } = {}) {
  const visible = isMiniPlayerVisible(state, { suppressed });
  if (!visible) {
    return {
      visible: false,
      name: '',
      subtitle: '',
      logo: null,
      initial: '',
      status: 'idle',
      action: 'play',
      playPauseLabel: PLAY_PAUSE_LABEL.play,
      canStep: false,
      volume: 0,
      volumePercent: 0,
      live: '',
    };
  }
  const action = playPauseAction(state.status);
  const volume = Number.isFinite(state.volume) ? Math.min(1, Math.max(0, state.volume)) : 0;
  return {
    visible: true,
    name: state.station.name,
    subtitle: subtitleOf(state),
    logo: safeLogoUrl(state.station.logo),
    initial: (state.station.name || '?').trim().slice(0, 1).toUpperCase() || '?',
    status: state.status,
    action,
    playPauseLabel: PLAY_PAUSE_LABEL[action],
    // Vorheriger/Nächster Favorit: nur sinnvoll mit mindestens einem Favoriten (bei einem läuft derselbe Sender neu an)
    canStep: Number.isFinite(favoriteCount) && favoriteCount > 1,
    volume,
    volumePercent: Math.round(volume * 100),
    live: liveMessage(state),
  };
}

module.exports = { isMiniPlayerVisible, subtitleOf, playPauseAction, liveMessage, miniPlayerModel, PLAY_PAUSE_LABEL };
