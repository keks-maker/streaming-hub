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

// ───────── Podcast (P2) ─────────
// Eingabe: öffentlicher Zustand aus podcast:state (status idle|loading|playing|paused|ended|error, episode, position,
// duration, rate, volume, error). Bei Radio bleibt alles oben unverändert.

const PODCAST_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SKIP_BACK_SECONDS = 15;
const SKIP_FORWARD_SECONDS = 30;
const SEEK_KEY_SECONDS = 5;

const PODCAST_STATUS_TEXT = {
  loading: 'Lädt …',
  paused: 'Pausiert',
  ended: 'Beendet',
  error: 'Wiedergabe nicht möglich',
};

const PODCAST_PLAY_PAUSE_LABEL = {
  pause: 'Pause',
  resume: 'Wiedergabe fortsetzen',
  replay: 'Erneut abspielen',
  retry: 'Erneut versuchen',
};

/** Covers nur über https ohne Zugangsdaten (Content-Security-Policy der Oberfläche). */
function safeCoverUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Zeit als m:ss bzw. h:mm:ss (Sekunden, ungültig → 0:00). */
function formatClock(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function isPodcastMiniPlayerVisible(state, { suppressed = false } = {}) {
  return Boolean(state && state.status && state.status !== 'idle' && state.episode) && !suppressed;
}

/** Primäre Aktion: playing/loading → pause · paused → resume · ended → replay · error → retry. */
function podcastPlayPauseAction(status) {
  if (status === 'playing' || status === 'loading') return 'pause';
  if (status === 'paused') return 'resume';
  if (status === 'ended') return 'replay';
  return 'retry';
}

function podcastSubtitle(state) {
  const title = state.episode.title || '';
  if (state.status === 'playing') return title;
  if (state.status === 'error') return state.error || PODCAST_STATUS_TEXT.error;
  const status = PODCAST_STATUS_TEXT[state.status] || '';
  return status && title ? `${status} – ${title}` : status || title;
}

/** aria-live-Text bei Statuswechsel: Sendung/Episode und Status, keine Positionsänderungen. */
function podcastLiveMessage(state) {
  if (!state || !state.episode || state.status === 'idle') return '';
  const name = state.episode.show || state.episode.title || 'Podcast';
  switch (state.status) {
    case 'loading':
      return `${name}: lädt`;
    case 'playing':
      return `${name}: spielt`;
    case 'paused':
      return `${name}: pausiert`;
    case 'ended':
      return `${name}: Episode beendet`;
    case 'error':
      return `${name}: Wiedergabe nicht möglich`;
    default:
      return '';
  }
}

/**
 * Modell der Leiste bei Podcast.
 * Ausgabe: { visible, mode:'podcast', name (Sendung), subtitle (Episode/Status), cover, initial, status, action, playPauseLabel,
 *            position, duration, canSeek, seekMax, seekValue, valueText, positionText, durationText, rate, rates,
 *            skipBack, skipForward, volume, volumePercent, live }
 */
function podcastMiniPlayerModel(state, { suppressed = false } = {}) {
  if (!isPodcastMiniPlayerVisible(state, { suppressed })) {
    return { visible: false, mode: 'podcast', status: 'idle', name: '', subtitle: '', cover: null, initial: '', action: 'retry', playPauseLabel: PODCAST_PLAY_PAUSE_LABEL.retry, position: 0, duration: 0, canSeek: false, seekMax: 0, seekValue: 0, valueText: '', positionText: '0:00', durationText: '0:00', rate: 1, rates: PODCAST_RATES, skipBack: SKIP_BACK_SECONDS, skipForward: SKIP_FORWARD_SECONDS, volume: 0, volumePercent: 0, live: '' };
  }
  const duration = Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0;
  const rawPosition = Number.isFinite(state.position) && state.position > 0 ? state.position : 0;
  const position = duration > 0 ? Math.min(rawPosition, duration) : rawPosition;
  const action = podcastPlayPauseAction(state.status);
  const volume = Number.isFinite(state.volume) ? Math.min(1, Math.max(0, state.volume)) : 0;
  const show = state.episode.show || state.episode.title || 'Podcast';
  return {
    visible: true,
    mode: 'podcast',
    name: show,
    subtitle: podcastSubtitle(state),
    cover: safeCoverUrl(state.episode.cover),
    initial: show.trim().slice(0, 1).toUpperCase() || '?',
    status: state.status,
    action,
    playPauseLabel: PODCAST_PLAY_PAUSE_LABEL[action],
    position,
    duration,
    canSeek: duration > 0 && state.status !== 'error',
    seekMax: Math.floor(duration),
    seekValue: Math.floor(position),
    valueText: duration > 0 ? `${formatClock(position)} von ${formatClock(duration)}` : formatClock(position),
    positionText: formatClock(position),
    durationText: duration > 0 ? formatClock(duration) : '–:–',
    rate: PODCAST_RATES.includes(state.rate) ? state.rate : 1,
    rates: PODCAST_RATES,
    skipBack: SKIP_BACK_SECONDS,
    skipForward: SKIP_FORWARD_SECONDS,
    volume,
    volumePercent: Math.round(volume * 100),
    live: podcastLiveMessage(state),
  };
}

/** Beschriftung einer Geschwindigkeit ("1×", "1,25×"). */
function rateLabel(rate) {
  return `${String(rate).replace('.', ',')}×`;
}

module.exports = {
  isMiniPlayerVisible,
  subtitleOf,
  playPauseAction,
  liveMessage,
  miniPlayerModel,
  PLAY_PAUSE_LABEL,
  PODCAST_RATES,
  SKIP_BACK_SECONDS,
  SKIP_FORWARD_SECONDS,
  SEEK_KEY_SECONDS,
  isPodcastMiniPlayerVisible,
  podcastPlayPauseAction,
  podcastMiniPlayerModel,
  podcastLiveMessage,
  safeCoverUrl,
  formatClock,
  rateLabel,
};
