// YouTube-Playlist des Mini-Players: Warteschlange kommender Videos. Reine Funktionen ohne I/O.
// Einträge { id, title }: id ist eine YouTube-Video-ID, title Text (Steuerzeichen entfernt, begrenzt).
// Die Liste enthält nur, was noch kommt: Beim Start eines Eintrags (Videoende, Klick) wird er entnommen.

'use strict';

const { isVideoId } = require('./youtube-url.js');

const MAX_ENTRIES = 200;
const MAX_TITLE_LENGTH = 200;

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

/** Roher Eintrag → { id, title } oder null (keine gültige Video-ID). Nur diese zwei Felder bleiben erhalten. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isVideoId(raw.id)) return null;
  return { id: raw.id, title: cleanTitle(raw.title) };
}

/** Beliebige Daten (Datei, IPC) → gültige Liste: ungültige Einträge und Doppelte entfallen, höchstens MAX_ENTRIES. */
function normalizePlaylist(raw) {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set();
  const list = [];
  for (const item of source) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    list.push(entry);
    if (list.length >= MAX_ENTRIES) break;
  }
  return list;
}

/** Hinten anhängen. Schon vorhandene oder ungültige Einträge und eine volle Liste ändern nichts. */
function addEntry(list, raw) {
  const entry = normalizeEntry(raw);
  if (!entry || list.length >= MAX_ENTRIES || list.some(item => item.id === entry.id)) return list;
  return [...list, entry];
}

/** „Als Nächstes abspielen“: an den Anfang; war das Video schon in der Liste, rückt es nach vorn. */
function addNext(list, raw) {
  const entry = normalizeEntry(raw);
  if (!entry) return list;
  const rest = list.filter(item => item.id !== entry.id);
  if (rest.length >= MAX_ENTRIES) return list;
  return [entry, ...rest];
}

function removeEntry(list, id) {
  return list.some(item => item.id === id) ? list.filter(item => item.id !== id) : list;
}

/** Verschiebt `id` an die Stelle von `targetId` (Ziehen und Ablegen auf eine Zeile). */
function moveToTarget(list, id, targetId) {
  const from = list.findIndex(item => item.id === id);
  const to = list.findIndex(item => item.id === targetId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Verschiebt um `delta` Plätze (Tastatur: ▲▼), an den Rändern begrenzt. */
function moveBy(list, id, delta) {
  const from = list.findIndex(item => item.id === id);
  if (from < 0 || !Number.isInteger(delta) || delta === 0) return list;
  const to = Math.min(list.length - 1, Math.max(0, from + delta));
  if (to === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Nächster Eintrag am Videoende: { next, rest } (next null bei leerer Liste). */
function takeFirst(list) {
  return list.length ? { next: list[0], rest: list.slice(1) } : { next: null, rest: list };
}

/** Eintrag zum Abspielen per Klick: { next, rest } ohne diesen Eintrag (Rest behält seine Reihenfolge). */
function takeEntry(list, id) {
  const entry = list.find(item => item.id === id);
  return entry ? { next: entry, rest: list.filter(item => item.id !== id) } : { next: null, rest: list };
}

/** Zeigt den Titel nach: nur wenn der Eintrag schon vorhanden ist und noch keinen Titel hat. */
function withTitle(list, id, title) {
  const clean = cleanTitle(title);
  if (!clean) return list;
  const index = list.findIndex(item => item.id === id && !item.title);
  if (index < 0) return list;
  const next = [...list];
  next[index] = { id, title: clean };
  return next;
}

module.exports = {
  MAX_ENTRIES,
  MAX_TITLE_LENGTH,
  cleanTitle,
  normalizeEntry,
  normalizePlaylist,
  addEntry,
  addNext,
  removeEntry,
  moveToTarget,
  moveBy,
  takeFirst,
  takeEntry,
  withTitle,
};
