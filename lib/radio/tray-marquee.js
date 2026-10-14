'use strict';

// Lauftext für den Text neben dem Tray-Symbol (macOS-Menüleiste). Rein und ohne Electron: aus dem vollständigen Text und
// einem Schritt-Index entsteht das sichtbare Fenster. Geschnitten wird nach Graphemen (Flaggen, Emoji mit Hautton oder
// ZWJ-Folgen, kombinierende Zeichen bleiben ganz). Passt der Text in das Fenster, bleibt er statisch.
//
// Ablauf eines Durchlaufs: Pause am Anfang, dann ein Zeichen pro Schritt, Pause am Ende, danach Neustart am Anfang.
// Bewusst kein Umlauf mit Trenner: Der Sender steht am Anfang und dient als Ortungsanker; mit Pausen und hartem
// Neustart erkennt man in einer Schmalzeile immer, wo der Text beginnt und endet (ein endloses Band hat keinen Anfang).

const TRAY_WINDOW_WIDTH = 28; // Zeichen (Grapheme), wie die frühere harte Kürzung (Menüleiste ist knapp, Notch)
const MARQUEE_STEP_MS = 400; // Takt: 2,5 Schritte pro Sekunde (höchstens 2,5 setTitle-Aufrufe/s)
const MARQUEE_START_PAUSE_MS = 2000;
const MARQUEE_END_PAUSE_MS = 1500;
// Schrift während des Laufens: in der Proportionalschrift schwankt die Breite des Menüleisteneintrags je Fenster (gemessen
// 219–247 px bei 28 Zeichen), die Einträge links davon rutschen mit. 'monospaced' hält sie konstant (280 px).
// Umstellen auf die normale Systemschrift: null (dann springt die Breite wieder).
const MARQUEE_FONT_TYPE = 'monospaced';

let segmenter = null;
function getSegmenter() {
  if (segmenter === null) segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : false;
  return segmenter;
}

/** Text als Liste von Graphemen (Fallback ohne Intl.Segmenter: Code-Points). */
function graphemes(text) {
  const value = typeof text === 'string' ? text : '';
  const seg = getSegmenter();
  return seg ? Array.from(seg.segment(value), part => part.segment) : Array.from(value);
}

function stepsFor(ms, stepMs) {
  return Math.max(1, Math.ceil(ms / stepMs)); // mindestens ein Schritt: erstes und letztes Fenster sind immer sichtbar
}

function normalize(options) {
  const width = Math.max(1, Math.floor(Number(options.width) || TRAY_WINDOW_WIDTH));
  const stepMs = Number(options.stepMs) > 0 ? Number(options.stepMs) : MARQUEE_STEP_MS;
  const startPause = stepsFor(options.startPauseMs === undefined ? MARQUEE_START_PAUSE_MS : Number(options.startPauseMs) || 0, stepMs);
  const endPause = stepsFor(options.endPauseMs === undefined ? MARQUEE_END_PAUSE_MS : Number(options.endPauseMs) || 0, stepMs);
  return { width, startPause, endPause };
}

/**
 * Sichtbares Fenster zum Schritt `step` (0, 1, 2 …; läuft über das Ende hinaus zyklisch weiter).
 * Rückgabe: { text, scrolling, cycleSteps }. Ohne Scrollen (Text passt) ist text der unveränderte Text, cycleSteps 0;
 * mit Scrollen hat text immer genau `width` Grapheme, die Breite springt also nicht von Schritt zu Schritt.
 */
function marqueeWindow(text, step = 0, options = {}) {
  const parts = graphemes(text);
  const { width, startPause, endPause } = normalize(options);
  if (parts.length <= width) return { text: parts.join(''), scrolling: false, cycleSteps: 0 };
  const maxOffset = parts.length - width;
  // startPause Schritte Anfang (Versatz 0), dann Versatz 1 … maxOffset; das letzte Fenster steht endPause Schritte
  const cycleSteps = startPause + maxOffset - 1 + endPause;
  const index = ((Math.floor(Number(step)) || 0) % cycleSteps + cycleSteps) % cycleSteps;
  const offset = Math.min(Math.max(0, index - startPause + 1), maxOffset);
  return { text: parts.slice(offset, offset + width).join(''), scrolling: true, cycleSteps };
}

/** Passt der Text nicht in das Fenster? */
function needsMarquee(text, options = {}) {
  return graphemes(text).length > normalize(options).width;
}

/** Auf `width` Grapheme gekürzt (Auslassung „…“ am Ende, kein halbes Emoji); passt der Text, unverändert. */
function clipGraphemes(text, width = TRAY_WINDOW_WIDTH) {
  const parts = graphemes(text);
  const limit = Math.max(2, Math.floor(Number(width) || TRAY_WINDOW_WIDTH));
  return parts.length > limit ? `${parts.slice(0, limit - 1).join('').trimEnd()}…` : parts.join('');
}

module.exports = {
  TRAY_WINDOW_WIDTH,
  MARQUEE_STEP_MS,
  MARQUEE_START_PAUSE_MS,
  MARQUEE_END_PAUSE_MS,
  MARQUEE_FONT_TYPE,
  graphemes,
  marqueeWindow,
  needsMarquee,
  clipGraphemes,
};
