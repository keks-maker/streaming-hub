// Schedule-Slip (Etappe 2b; Konzept §3.4): reine Logik ohne I/O und Uhr.
//
// Sendezeiten im EPG verschieben sich kurzfristig (Sport überzieht, Programm
// rutscht). 10 min vor `epgStart − Vorlauf` lädt der Scheduler das EPG der Quelle
// gezielt neu und gleicht den Eintrag mit dem frischen Cache ab:
//
//   Wiedererkennung: dieselbe Sendung = gleicher (normalisierter) Titel auf dem
//   Kanal, Beginn höchstens `searchMs` (3 h) neben dem alten Beginn; bei mehreren
//   Treffern gewinnt der zeitlich nächste. Sendungen, deren Titel sich geändert hat
//   oder die um mehr als 3 h verschoben wurden, gelten als „nicht mehr im EPG“.
//
//   Ergebnis: 'unchanged' | 'moved' (neue Zeiten, vor UND zurück) | 'removed'
//   (Eintrag bleibt, es wird nur gewarnt — nie automatisch gelöscht).

'use strict';

const { parseIsoWithOffset } = require('./schedule-logic.js');

const SLIP_SEARCH_MS = 3 * 60 * 60 * 1000;
const SLIP_TOLERANCE_MS = 1000;

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function normalizeTitle(value) {
  return String(value == null ? '' : value)
    .replace(CONTROL_CHARS, ' ')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) // der Eintrag trägt den auf 300 Zeichen gekürzten Titel
    .toLowerCase();
}

/** Suchfenster für epgRange: alter Beginn/Ende ± searchMs. */
function slipSearchRange(entry, searchMs = SLIP_SEARCH_MS) {
  const start = parseIsoWithOffset(entry.epgStart);
  const stop = parseIsoWithOffset(entry.epgStop);
  return { fromMs: start - searchMs, toMs: stop + searchMs };
}

/**
 * Findet die Sendung des Eintrags in den frischen EPG-Slots {start, stop, title}.
 * Rückgabe: Slot | null.
 */
function findProgramme(entry, slots, searchMs = SLIP_SEARCH_MS) {
  const oldStart = parseIsoWithOffset(entry.epgStart);
  const wanted = normalizeTitle(entry.title);
  let best = null;
  for (const slot of slots || []) {
    if (!slot || !Number.isFinite(slot.start) || !Number.isFinite(slot.stop) || !(slot.stop > slot.start)) continue;
    if (normalizeTitle(slot.title) !== wanted) continue;
    const dist = Math.abs(slot.start - oldStart);
    if (dist > searchMs) continue;
    if (!best || dist < best.dist) best = { slot, dist };
  }
  return best ? best.slot : null;
}

/**
 * Bewertung: { kind: 'unchanged' } | { kind: 'moved', startMs, stopMs,
 * startDeltaMs, stopDeltaMs } | { kind: 'removed' }.
 */
function evaluateSlip(entry, slots, { searchMs = SLIP_SEARCH_MS } = {}) {
  const slot = findProgramme(entry, slots, searchMs);
  if (!slot) return { kind: 'removed' };
  const oldStart = parseIsoWithOffset(entry.epgStart);
  const oldStop = parseIsoWithOffset(entry.epgStop);
  const startDeltaMs = slot.start - oldStart;
  const stopDeltaMs = slot.stop - oldStop;
  if (Math.abs(startDeltaMs) < SLIP_TOLERANCE_MS && Math.abs(stopDeltaMs) < SLIP_TOLERANCE_MS) return { kind: 'unchanged' };
  return { kind: 'moved', startMs: slot.start, stopMs: slot.stop, startDeltaMs, stopDeltaMs };
}

/**
 * Fälligkeit der Slip-Prüfung: Fenster [rawStart − leadMs, rawStart) mit
 * rawStart = epgStart − Vorlauf. Einmal pro Eintrag/Fenster: bereits geprüft
 * (lastSlipCheck ≥ Fensteröffnung) → nicht fällig. Nach einer Verschiebung nach
 * hinten öffnet sich das Fenster später und prüft erneut; die Prüfung läuft nie
 * mehr, wenn der Start erreicht ist.
 */
function slipWindow(entry, leadMs) {
  const epgStartMs = parseIsoWithOffset(entry.epgStart);
  const rawStartMs = epgStartMs - Math.max(0, entry.bufferBeforeSec || 0) * 1000;
  return { rawStartMs, opensAtMs: rawStartMs - leadMs };
}

function isSlipDue(entry, nowMs, leadMs) {
  if (!entry || entry.state !== 'scheduled' || entry.merged === true) return false;
  const { rawStartMs, opensAtMs } = slipWindow(entry, leadMs);
  if (!Number.isFinite(rawStartMs)) return false;
  if (nowMs < opensAtMs || nowMs >= rawStartMs) return false;
  if (entry.lastSlipCheck) {
    const last = Date.parse(entry.lastSlipCheck);
    if (Number.isFinite(last) && last >= opensAtMs) return false;
  }
  return true;
}

module.exports = {
  SLIP_SEARCH_MS,
  normalizeTitle,
  slipSearchRange,
  findProgramme,
  evaluateSlip,
  slipWindow,
  isSlipDue,
};
