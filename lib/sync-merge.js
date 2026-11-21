// Abgleich-Regel D10 (iCloud): reine Funktion merge(local, remote, now) → { merged, toUpload }.
// Sprachneutrale Regel samt Testvektoren: tests/fixtures/sync/ (Herkunft dort in der README); Swift-Gegenstück SyncMerge.swift.
// Record = { name, kind, modified, deleted?, fields }. Last-Writer-Wins je name, Tiebreak in festen Stufen,
// Löschmarken ab 30 Tagen entfallen (nur lokal, nie auf dem Server), unbekannte Felder bleiben unverändert erhalten.

'use strict';

const TOMBSTONE_RETENTION_SECONDS = 30 * 24 * 3600;

/** Felder der Stufe 4 je Art, in Vergleichsreihenfolge: [Feld, 'num' | 'text']. Nicht genannte Felder werden nie verglichen. */
const TIEBREAK_FIELDS = {
  Progress: [['position', 'num'], ['duration', 'num']],
  Queue: [['items', 'text']],
  Recent: [['title', 'text'], ['channel', 'text'], ['duration', 'text'], ['channelID', 'text']],
  MList: [['name', 'text'], ['color', 'text'], ['symbol', 'text'], ['order', 'text']],
  MEntry: [['title', 'text'], ['channel', 'text'], ['order', 'text'], ['thumbnailURL', 'text'], ['duration', 'text'], ['channelID', 'text'], ['channelAvatarURL', 'text']],
};

const textField = (record, key) => {
  const value = record.fields ? record.fields[key] : undefined;
  return typeof value === 'string' ? value : '';
};
const numField = (record, key) => {
  const value = record.fields ? record.fields[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/** > 0: a gewinnt, < 0: b gewinnt, 0: vollständiger Gleichstand. JS-`<` vergleicht UTF-16-Codeunits. */
function compareRecords(a, b) {
  if (a.modified !== b.modified) return a.modified > b.modified ? 1 : -1;
  const deletedA = a.deleted === true;
  const deletedB = b.deleted === true;
  if (deletedA !== deletedB) return deletedA ? 1 : -1;
  const idA = textField(a, 'id');
  const idB = textField(b, 'id');
  if (idA !== idB) return idA > idB ? 1 : -1;
  for (const [key, type] of TIEBREAK_FIELDS[a.kind] || []) {
    const x = type === 'num' ? numField(a, key) : textField(a, key);
    const y = type === 'num' ? numField(b, key) : textField(b, key);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Dubletten einer Seite je name zu einem Record; bei Gleichstand gewinnt der spätere Listeneintrag. */
function reduceSide(list) {
  const byName = new Map();
  for (const record of list) {
    const existing = byName.get(record.name);
    byName.set(record.name, existing && compareRecords(existing, record) > 0 ? existing : record);
  }
  return byName;
}

/** Strukturgleich, Objektschlüssel ohne Reihenfolge. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
}

const sameRecord = (a, b) =>
  a.name === b.name && a.kind === b.kind && a.modified === b.modified && (a.deleted === true) === (b.deleted === true) && sameValue(a.fields || {}, b.fields || {});

const byNameOrder = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function merge(local, remote, now) {
  const localByName = reduceSide(local);
  const remoteByName = reduceSide(remote);
  const names = [...new Set([...localByName.keys(), ...remoteByName.keys()])];
  const merged = [];
  const toUpload = [];
  for (const name of names) {
    const a = localByName.get(name);
    const b = remoteByName.get(name);
    // Vollständiger Gleichstand lokal gegen remote: der Remote-Stand gewinnt.
    const winner = a && b ? (compareRecords(a, b) > 0 ? a : b) : a || b;
    const livingCounterpart = [a, b].some(record => record && record.deleted !== true);
    if (winner.deleted === true && !livingCounterpart && now - winner.modified >= TOMBSTONE_RETENTION_SECONDS) continue;
    merged.push(winner);
    if (!b || !sameRecord(winner, b)) toUpload.push(winner);
  }
  return { merged: merged.sort(byNameOrder), toUpload: toUpload.sort(byNameOrder) };
}

module.exports = { merge, compareRecords, TOMBSTONE_RETENTION_SECONDS };
