// UI-Modell der Planung (Etappe 2a; Konzept §3.7): reine Funktionen ohne DOM,
// damit Zukunfts-Regel, Texte und Sortierung ohne Electron testbar sind.
// Der Renderer rendert ausschließlich per textContent (EPG-Text ist fremder Text).

'use strict';

const { parseIsoWithOffset, formatIsoWithOffset } = require('./schedule-logic.js');

const MSG_RUNNING =
  'Diese Sendung läuft bereits und kann nicht mehr geplant werden. ' +
  'Zum Aufnehmen der laufenden Sendung nutze den Aufnahme-Button im Player.';
const MSG_PAST = 'Diese Sendung ist bereits vorbei und kann nicht aufgenommen werden.';
const MSG_NO_EPG = 'Für diesen Sender liegt kein planbares EPG im Cache vor.';
const MSG_INVALID_TIME = 'Die Sendezeit dieser Sendung ist ungültig und kann nicht geplant werden.';

/**
 * Zukunfts-Regel (nur epgStart > jetzt ist planbar). Die Meldung ersetzt den
 * Dialog (es öffnet sich keiner). Grenzfall: Start in weniger als dem
 * Vorlaufpuffer bleibt planbar (state 'future').
 */
function classifyProgramme(startMs, stopMs, nowMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) {
    return { state: 'invalid', message: MSG_INVALID_TIME };
  }
  if (startMs > nowMs) return { state: 'future', message: null };
  if (stopMs > nowMs) return { state: 'running', message: MSG_RUNNING };
  return { state: 'past', message: MSG_PAST };
}

/** ISO-8601 mit dem Offset, der zum Zeitpunkt selbst gilt (Sommerzeit-korrekt). */
function toScheduleIso(ms) {
  const offsetMin = -new Date(ms).getTimezoneOffset();
  return formatIsoWithOffset(ms, offsetMin);
}

/** Entfernt das Electron-Präfix "Error invoking remote method '…': Error: " einer IPC-Fehlermeldung. */
function ipcErrorMessage(err) {
  const raw = err && err.message ? String(err.message) : String(err || 'Unbekannter Fehler');
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^[A-Za-z]*Error:\s*/, '');
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

/** „Mo 05.10. 20:15–20:45“ */
function formatSlotRange(startMs, stopMs) {
  return `${dayLabel(startMs)} ${clock(startMs)}–${clock(stopMs)}`;
}

function minutesText(sec) {
  const min = sec / 60;
  return Number.isInteger(min) ? `${min}` : min.toFixed(1).replace('.', ',');
}

function formatEntryTimes(entry) {
  const start = parseIsoWithOffset(entry.epgStart);
  const stop = parseIsoWithOffset(entry.epgStop);
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return '';
  return formatSlotRange(start, stop);
}

function formatBuffers(entry) {
  return `Puffer −${minutesText(entry.bufferBeforeSec || 0)}/+${minutesText(entry.bufferAfterSec || 0)} Min.`;
}

/** Lesbarer Status eines Planungseintrags (inkl. Spätstart-/Fehlermeldung aus `note`). */
function scheduleStatusText(entry) {
  const note = entry.note ? ` — ${entry.note}` : '';
  switch (entry.state) {
    case 'scheduled':
      return entry.allowOverLimit ? 'Geplant (Parallel-Limit-Überschreitung bestätigt)' : 'Geplant';
    case 'recording':
      return `Läuft${note}`;
    case 'done':
      return `Aufgenommen${note}`;
    case 'missed':
      return entry.note || 'Verpasst';
    case 'failed':
      return entry.note || 'Fehlgeschlagen';
    case 'cancelled':
      return 'Abgesagt';
    default:
      return String(entry.state || '');
  }
}

/** Anstehend (scheduled/recording, nach Start) und Verlauf (abgeschlossen, neueste zuerst). */
function splitScheduleEntries(entries, { historyLimit = 20 } = {}) {
  const startOf = e => parseIsoWithOffset(e.epgStart);
  const upcoming = entries.filter(e => e.state === 'scheduled' || e.state === 'recording').sort((a, b) => startOf(a) - startOf(b));
  const history = entries
    .filter(e => e.state !== 'scheduled' && e.state !== 'recording')
    .sort((a, b) => startOf(b) - startOf(a))
    .slice(0, historyLimit);
  return { upcoming, history };
}

/** Text der Konflikt-Inline-Warnung im Planungsdialog (Parallel-Limit). */
function describeConflict(conflict) {
  if (!conflict || !conflict.exceeds) return '';
  const others = (conflict.overlapping || []).map(o => o.label).filter(Boolean);
  const list = others.length ? ` Betroffen: ${others.join('; ')}.` : '';
  return (
    `In diesem Zeitraum laufen bis zu ${conflict.maxConcurrent} Aufnahmen gleichzeitig ` +
    `(erlaubt sind ${conflict.limit}).${list} Weitere Aufnahmen belasten Netzwerk und Festplatte.`
  );
}

/** Text zur Mittelpunkt-Regel bzw. „eine durchgehende Aufnahme“ im Planungsdialog. */
function describeAdjacency(adjacency) {
  if (!adjacency) return '';
  const where = adjacency.position === 'before' ? 'direkt vorher' : 'direkt danach';
  const mid = clock(parseIsoWithOffset(adjacency.midpointIso));
  const first = minutesText(adjacency.firstAfterSec);
  const second = minutesText(adjacency.secondBeforeSec);
  let text =
    `Auf demselben Sender ist „${adjacency.title}“ ${where} geplant. Die Puffer überlappen: ` +
    `Die Aufnahmen wechseln um ${mid} (Nachlauf der ersten ${first} Min., Vorlauf der zweiten ${second} Min.).`;
  if (adjacency.canMerge && adjacency.merged) {
    const start = parseIsoWithOffset(adjacency.merged.epgStart);
    const stop = parseIsoWithOffset(adjacency.merged.epgStop);
    text += ` Alternative „Eine durchgehende Aufnahme“: ${adjacency.merged.title}, ${formatSlotRange(start, stop)} (eine Datei).`;
  }
  return text;
}

/** Kürzt auf höchstens `max` Zeichen (mit „…“ innerhalb der Grenze), trimmt. */
function clampText(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

module.exports = {
  clampText,
  MSG_RUNNING,
  MSG_PAST,
  MSG_NO_EPG,
  MSG_INVALID_TIME,
  classifyProgramme,
  toScheduleIso,
  ipcErrorMessage,
  formatSlotRange,
  formatEntryTimes,
  formatBuffers,
  scheduleStatusText,
  splitScheduleEntries,
  describeConflict,
  describeAdjacency,
};
