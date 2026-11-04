// „Aktuell angezeigte Sendung aufnehmen“: Auswertung der Sendungsangaben aus tv.html (Titel, Start, Ende der
// Sendung an der Wiedergabeposition). tv.html ist eine Webseite; der Renderer prüft die Werte, bevor er sie in den
// Aufnahme-Request übernimmt, und fällt bei Unplausiblem auf die Live-Werte zurück. Reine Funktion.

'use strict';

const MAX_TITLE_LENGTH = 300;
const MAX_SHOW_MS = 12 * 3600 * 1000; // längste plausible Sendung
const MAX_SKEW_MS = 24 * 3600 * 1000; // Sendungsende liegt höchstens so weit von „jetzt“ entfernt
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function validTitle(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || t.length > MAX_TITLE_LENGTH || CONTROL_CHARS.test(t)) return null;
  return t;
}

function validMs(value, nowMs) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value - nowMs) > MAX_SKEW_MS) return null;
  return Math.floor(value);
}

/**
 * payload: { epgTitleOverride, epgStartMsOverride, epgEndMsOverride, untilEpgEnd } aus tv.html.
 * live: { epgTitle, epgStopMs } — Werte der Uhrzeit-Sendung (bisheriges Verhalten).
 * Rückgabe: { epgTitle, epgStopMs, rangeDurationSec }
 *  - Sendung läuft noch (Ende in der Zukunft): epgStopMs = Ende, rangeDurationSec null (Autostopp wie bisher).
 *  - Sendung beendet und Start bekannt: rangeDurationSec = Sendungsdauer (Aufnahme aus dem DVR-Fenster,
 *    Ende per Länge statt per Uhr), epgStopMs null.
 *  - Ohne gültige Angaben: Live-Werte.
 */
function resolveShowOverride(payload, live, nowMs = Date.now()) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const liveInfo = live || {};
  const result = {
    epgTitle: liveInfo.epgTitle || null,
    epgStopMs: Number.isFinite(liveInfo.epgStopMs) ? liveInfo.epgStopMs : null,
    rangeDurationSec: null,
  };
  const title = validTitle(p.epgTitleOverride);
  if (title) result.epgTitle = title;

  if (!p.untilEpgEnd) return result;
  const endMs = validMs(p.epgEndMsOverride, nowMs);
  if (endMs === null) return result;
  if (endMs > nowMs) {
    result.epgStopMs = endMs;
    return result;
  }
  const startMs = validMs(p.epgStartMsOverride, nowMs);
  if (startMs === null || startMs >= endMs || endMs - startMs > MAX_SHOW_MS) return result;
  result.epgStopMs = null;
  result.rangeDurationSec = Math.ceil((endMs - startMs) / 1000);
  return result;
}

module.exports = { resolveShowOverride, MAX_TITLE_LENGTH, MAX_SHOW_MS };
