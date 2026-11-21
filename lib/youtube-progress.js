// Wiedergabefortschritt je YouTube-Video (Regeln 1:1 wie YouTubeProgress im Apple-Repo, iPad).
// Reine Funktionen ohne Electron und DOM. Datei youtube-progress.json: reines Array [{ id, position, duration, updated, done? }],
// Sekunden (Double), updated = Sekunden seit 1970. `done: true` = Marke „zu Ende gesehen“ (position 0), gilt für alle Leser als nicht vorhanden;
// unbekannte Zusatzfelder bleiben erhalten.

'use strict';

const { isVideoId } = require('./youtube-url.js');

const MAX_ENTRIES = 200;
/** Marken `done: true` (zu Ende gesehen, für den Abgleich): höchstens so viele, höchstens so lange. */
const MAX_DONE_MARKS = 100;
const DONE_RETENTION_SECONDS = 30 * 24 * 3600;
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
  if (!entry || entry.done === true || !isNum(entry.position) || entry.position < MIN_SECONDS) return 0;
  const duration = isNum(entry.duration) ? entry.duration : 0;
  return isFinished(entry.position, duration) ? 0 : entry.position;
}

/** Ziel-Zeit im Player: gemerkte Position, höchstens Dauer − 11 s; ohne endliche Dauer unverändert. */
function clampResume(position, duration) {
  if (!isNum(position) || position < MIN_SECONDS) return 0;
  return isNum(duration) && duration > 0 ? Math.min(position, Math.max(duration - RESUME_TAIL_SECONDS, 0)) : position;
}

/** Neueste `limit` Einträge nach `updated` (bei Gleichstand der spätere), Reihenfolge der Liste bleibt erhalten. */
function newest(list, limit) {
  if (list.length <= limit) return list;
  const keep = new Set(
    list
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.updated - a.entry.updated || b.index - a.index)
      .slice(0, limit)
      .map(item => item.entry)
  );
  return list.filter(entry => keep.has(entry));
}

/**
 * Begrenzt die Liste: höchstens MAX_ENTRIES lebende Einträge und MAX_DONE_MARKS Marken (done), Marken nur bei
 * `now - updated < DONE_RETENTION_SECONDS` (ohne `now` bleibt die Frist unbeachtet). Kürzen ist nie eine Löschung (siehe lib/sync-merge.js).
 */
function trimmed(list, now) {
  const marks = newest(list.filter(e => e.done === true && (!isNum(now) || now - e.updated < DONE_RETENTION_SECONDS)), MAX_DONE_MARKS);
  const live = newest(list.filter(e => e.done !== true), MAX_ENTRIES);
  const keep = new Set([...marks, ...live]);
  return list.length === keep.size ? list : list.filter(entry => keep.has(entry));
}

/**
 * Liste nach einer Meldung: Ende ersetzt den Eintrag durch eine Marke `done: true` (position 0, updated = now),
 * ein Anfang unter MIN_SECONDS ändert nichts, sonst wird aktualisiert (belebt auch eine Marke wieder; Zusatzfelder bleiben).
 */
function recording(list, id, position, duration, now) {
  if (!isVideoId(id) || !isNum(position) || position < 0) return list;
  const dur = isNum(duration) && duration > 0 ? duration : 0;
  if (position < MIN_SECONDS) return list;
  const old = list.find(entry => entry.id === id);
  if (old && old.done === true && isFinished(position, dur)) return list; // Marke steht schon, Wiederholungen am Ende schreiben nichts
  const rest = list.filter(entry => entry.id !== id);
  const extras = { ...old };
  delete extras.done;
  const next = isFinished(position, dur)
    ? { ...extras, id, position: 0, duration: dur, updated: now, done: true }
    : { ...extras, id, position, duration: dur, updated: now };
  return trimmed([...rest, next], now);
}

/**
 * Gespeicherte Daten → gültige Einträge (unlesbar → leer, ungültige IDs/Werte verworfen, unbekannte Felder und `done: true`
 * bleiben erhalten, begrenzt wie `trimmed`). Mit `now` entfallen Marken ab 30 Tagen.
 */
function normalizeEntries(raw, now) {
  if (!Array.isArray(raw)) return [];
  const valid = raw
    .filter(e => e && typeof e === 'object' && isVideoId(e.id) && isNum(e.position) && e.position >= 0 && isNum(e.duration) && isNum(e.updated))
    .map(e => {
      const { done, ...rest } = e;
      return done === true ? { ...rest, done: true } : rest;
    });
  return trimmed(valid, now);
}

function sameEntries(a, b) {
  return a.length === b.length && a.every((e, i) => JSON.stringify(sortedKeys(e)) === JSON.stringify(sortedKeys(b[i])));
}

function sortedKeys(entry) {
  return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
}

module.exports = { MAX_ENTRIES, MAX_DONE_MARKS, DONE_RETENTION_SECONDS, TAIL_SECONDS, MIN_SECONDS, RESUME_TAIL_SECONDS, isFinished, resumePosition, clampResume, trimmed, recording, normalizeEntries, sameEntries };
