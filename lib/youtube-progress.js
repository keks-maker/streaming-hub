// Wiedergabefortschritt je YouTube-Video (Regeln 1:1 wie YouTubeProgress im Apple-Repo, iPad).
// Reine Funktionen ohne Electron und DOM. Datei youtube-progress.json: reines Array [{ id, position, duration, updated }],
// Sekunden (Double), updated = Sekunden seit 1970.

'use strict';

const { isVideoId } = require('./youtube-url.js');

const MAX_ENTRIES = 200;
/** Innerhalb dieser letzten Sekunden zählt ein Video als gesehen: erneutes Öffnen beginnt von vorn. */
const TAIL_SECONDS = 10;
/** Kürzere Anfänge werden nicht gemerkt. */
const MIN_SECONDS = 3;
/** Fortsetzen höchstens bis Dauer minus diese Sekunden. */
const RESUME_TAIL_SECONDS = 11;

const isNum = value => typeof value === 'number' && Number.isFinite(value);

function isFinished(position, duration) {
  return duration > 0 && position >= duration - TAIL_SECONDS;
}

/** Startposition beim erneuten Öffnen (0 = von vorn). */
function resumePosition(entry) {
  if (!entry || !isNum(entry.position) || entry.position < MIN_SECONDS) return 0;
  const duration = isNum(entry.duration) ? entry.duration : 0;
  return isFinished(entry.position, duration) ? 0 : entry.position;
}

/** Ziel-Zeit im Player: gemerkte Position, höchstens Dauer − 11 s; ohne endliche Dauer unverändert. */
function clampResume(position, duration) {
  if (!isNum(position) || position < MIN_SECONDS) return 0;
  return isNum(duration) && duration > 0 ? Math.min(position, Math.max(duration - RESUME_TAIL_SECONDS, 0)) : position;
}

/**
 * Liste nach einer Meldung: Ende entfernt den Eintrag, ein Anfang unter MIN_SECONDS ändert nichts,
 * sonst wird aktualisiert; über MAX_ENTRIES fallen die ältesten (nach `updated`) heraus.
 */
function recording(list, id, position, duration, now) {
  if (!isVideoId(id) || !isNum(position) || position < 0) return list;
  const dur = isNum(duration) && duration > 0 ? duration : 0;
  if (position < MIN_SECONDS) return list;
  let next = list.filter(entry => entry.id !== id);
  if (!isFinished(position, dur)) next.push({ id, position, duration: dur, updated: now });
  if (next.length > MAX_ENTRIES) {
    next = next
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => a.entry.updated - b.entry.updated || a.index - b.index)
      .slice(-MAX_ENTRIES)
      .map(item => item.entry);
  }
  return next;
}

/** Gespeicherte Daten → gültige Einträge (unlesbar → leer, ungültige IDs/Werte verworfen, höchstens MAX_ENTRIES, die letzten). */
function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = raw
    .filter(e => e && typeof e === 'object' && isVideoId(e.id) && isNum(e.position) && e.position >= 0 && isNum(e.duration) && isNum(e.updated))
    .map(e => ({ id: e.id, position: e.position, duration: e.duration, updated: e.updated }));
  return valid.slice(-MAX_ENTRIES);
}

function sameEntries(a, b) {
  return a.length === b.length && a.every((e, i) => e.id === b[i].id && e.position === b[i].position && e.duration === b[i].duration && e.updated === b[i].updated);
}

module.exports = { MAX_ENTRIES, TAIL_SECONDS, MIN_SECONDS, RESUME_TAIL_SECONDS, isFinished, resumePosition, clampResume, recording, normalizeEntries, sameEntries };
