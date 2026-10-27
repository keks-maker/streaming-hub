// Ton-Konflikt des YouTube-Videos mit den übrigen Wiedergaben (Konzept Mini-Player): reine Entscheidungen ohne DOM und IPC.
// Das Video stoppt, sobald eine andere Wiedergabe startet; umgekehrt pausieren Radio und Podcast beim Videostart
// (Einstellung pauseOnTv, Regel wie bei Streamingdiensten: radio-tv-conflict-model.js).

'use strict';

// Quellen, die das YouTube-Video beenden, wenn sie starten
const STOPPING_SOURCES = Object.freeze(['service', 'livetv', 'recording', 'mediathek', 'radio', 'podcast', 'dashboard-preview']);

/**
 * Muss ein laufendes YouTube-Video stoppen, wenn `source` startet?
 * source 'radio' | 'podcast' zählt erst bei state loading/playing (Pausieren/Beenden lässt das Video in Ruhe);
 * Bild-Quellen zählen sofort. `service` ist ein anderer Streamingdienst als YouTube (YouTube selbst nie).
 */
function shouldStopVideo({ source, sourceState = null, videoActive }) {
  if (!videoActive || !STOPPING_SOURCES.includes(source)) return false;
  if (source === 'radio' || source === 'podcast') {
    const status = sourceState && sourceState.status;
    return status === 'loading' || status === 'playing';
  }
  return true;
}

/** Hat die Quelle gerade zu spielen begonnen (Wechsel nach loading/playing)? Wiederholte Meldungen im selben Zustand zählen nicht. */
function startedPlayback(previousStatus, state) {
  const running = status => status === 'loading' || status === 'playing';
  return running(state && state.status) && !running(previousStatus);
}

module.exports = { STOPPING_SOURCES, shouldStopVideo, startedPlayback };
