'use strict';

// Lauftext für den Text neben dem Tray-Symbol (macOS-Menüleiste). Rein und ohne Electron: aus dem vollständigen Text und
// einem Schritt-Index entsteht das sichtbare Fenster. Geschnitten wird nach Graphemen (Flaggen, Emoji mit Hautton oder
// ZWJ-Folgen, kombinierende Zeichen bleiben ganz). Passt der Text in das Fenster, bleibt er statisch.
//
// Ablauf eines Durchlaufs: Pause am Anfang, dann ein Zeichen pro Schritt, Pause am Ende, danach Neustart am Anfang.
// Bewusst kein Umlauf mit Trenner: Der Sender steht am Anfang und dient als Ortungsanker; mit Pausen und hartem
// Neustart erkennt man in einer Schmalzeile immer, wo der Text beginnt und endet (ein endloses Band hat keinen Anfang).

const TRAY_WINDOW_WIDTH = 28; // Zeichen (Grapheme), wie die frühere harte Kürzung (Menüleiste ist knapp, Notch)
const MARQUEE_STEP_MS = 150; // Takt der Schrittweise-Variante (ruckelt systembedingt: macOS verschiebt setTitle nur um ganze Zeichen)
const MARQUEE_START_PAUSE_MS = 2000;
const MARQUEE_END_PAUSE_MS = 1500;
// Schrift während des Laufens: in der Proportionalschrift schwankt die Breite des Menüleisteneintrags je Fenster (gemessen
// 219–247 px bei 28 Zeichen), die Einträge links davon rutschen mit. 'monospaced' hält sie konstant (280 px).
// Umstellen auf die normale Systemschrift: null (dann springt die Breite wieder).
const MARQUEE_FONT_TYPE = 'monospaced';

// Pixelweiser Lauf (Modus „smooth“): reine Zeit-zu-Versatz-Rechnung in logischen Pixeln (pt). Der Versatz folgt der Uhr,
// nicht einem Zähler: bei einem ausgelassenen Frame springt das Bild nicht zurück, es holt auf.
const PIXEL_WINDOW_WIDTH = 240; // sichtbare Textbreite in pt (Menüleiste ist knapp, Notch)
const PIXEL_SPEED = 32; // pt pro Sekunde
const PIXEL_FPS = 30; // Obergrenze der Bildrate; ein Frame nur, wenn sich der Versatz ändert
const PIXEL_FADE_WIDTH = 8; // weicher Rand links/rechts in pt, solange dort Text abgeschnitten wird

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

/**
 * Pixelversatz des Textbildes zum Zeitpunkt `elapsedMs` seit Start (Pause, Lauf, Pause, dann Neustart).
 * Rückgabe: { scrolling, offset, maxOffset, cycleMs }; offset ist eine ganze Zahl 0 … maxOffset (pt).
 * Passt der Text (textWidth <= windowWidth), ist scrolling false und offset 0.
 */
function pixelMarqueeOffset(elapsedMs, textWidth, options = {}) {
  const windowWidth = Number(options.windowWidth) > 0 ? Number(options.windowWidth) : PIXEL_WINDOW_WIDTH;
  const speed = Number(options.speed) > 0 ? Number(options.speed) : PIXEL_SPEED;
  const startPause = options.startPauseMs === undefined ? MARQUEE_START_PAUSE_MS : Math.max(0, Number(options.startPauseMs) || 0);
  const endPause = options.endPauseMs === undefined ? MARQUEE_END_PAUSE_MS : Math.max(0, Number(options.endPauseMs) || 0);
  const width = Math.ceil(Number(textWidth) || 0);
  if (width <= windowWidth) return { scrolling: false, offset: 0, maxOffset: 0, cycleMs: 0 };
  const maxOffset = width - windowWidth;
  const travelMs = (maxOffset / speed) * 1000;
  const cycleMs = startPause + travelMs + endPause;
  const t = ((Number(elapsedMs) || 0) % cycleMs + cycleMs) % cycleMs;
  const offset = Math.min(maxOffset, Math.max(0, Math.floor(((t - startPause) / 1000) * speed)));
  return { scrolling: true, offset, maxOffset, cycleMs };
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
  PIXEL_WINDOW_WIDTH,
  PIXEL_SPEED,
  PIXEL_FPS,
  PIXEL_FADE_WIDTH,
  pixelMarqueeOffset,
  graphemes,
  marqueeWindow,
  needsMarquee,
  clipGraphemes,
};
