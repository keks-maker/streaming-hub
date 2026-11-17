// „Jetzt & Gleich“ des Programmführers (Etappe 3.5, M7) — rein und DOM-frei.
//
// Je Sender: laufende Sendung, nächste, übernächste. Die Daten kommen schlank aus epg:range-many
// (Fenster jetzt … +12 h); die Zuordnung wird aus den geladenen Sendungen berechnet und kann ohne
// neuen Abruf fortgeschrieben werden (30-s-Takt: Wechsel der laufenden Sendung, Fortschritt).
// Zeilen mit fester Höhe → Virtualisierung (438 Kanäle ohne großen DOM).

'use strict';

const viewModel = require('./epg-view-model.js');
const settings = require('./lib/epg-view-settings.js');
const genreFilter = require('./epg-genre-filter-model.js');

const WINDOW_MS = 12 * 60 * 60 * 1000;
/** Nach dieser Zeit werden die Sendungen des Fensters neu abgerufen (das Fenster ist dann aufgebraucht). */
const RELOAD_AFTER_MS = 60 * 60 * 1000;
/** Zeilenhöhe: breit = eine Zeile mit drei Zellen; schmal (< 900 px) = Sender und drei Zellen untereinander. */
const ROW_HEIGHT_WIDE = 84;
const ROW_HEIGHT_NARROW = 250;

/** Schmales Layout bei Fensterbreite unter der Schwelle der Startansicht „Automatisch“ (900 px). */
function isNarrow(widthPx) {
  return typeof widthPx === 'number' && Number.isFinite(widthPx) && widthPx < settings.AUTO_LIST_MIN_WIDTH;
}

function rowHeight(narrow) {
  return narrow ? ROW_HEIGHT_NARROW : ROW_HEIGHT_WIDE;
}

/** Abruffenster für epg:range-many: von jetzt (laufende Sendung überlappt) bis jetzt + 12 h. */
function windowFor(nowMs) {
  return { fromMs: nowMs, toMs: nowMs + WINDOW_MS };
}

function needsReload(loadedAtMs, nowMs) {
  return !Number.isFinite(loadedAtMs) || nowMs - loadedAtMs >= RELOAD_AFTER_MS || nowMs < loadedAtMs;
}

/**
 * Sender mit ihren Sendungen im Fenster: entries = Senderauswahl [{ key, channel }] (Reihenfolge bleibt),
 * results = epg:range-many-Antworten (eine oder mehrere zusammengefasst). hasEpg: Sendungen im Fenster
 * oder Schlüssel in epgKeys (Sender hat EPG, aber nichts in den nächsten Stunden). hideNoEpg blendet Sender
 * ohne EPG aus (Standard, Etappe 3.5).
 */
function buildChannels({ entries, results, epgKeys = null, hideNoEpg = true }) {
  const slotsByKey = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (result && typeof result.channelKey === 'string' && Array.isArray(result.slots)) slotsByKey.set(result.channelKey, result.slots);
  }
  const out = [];
  (Array.isArray(entries) ? entries : []).forEach((entry, order) => {
    const raw = slotsByKey.get(entry.key) || [];
    const rows = [];
    const seen = new Set();
    for (const slot of raw) {
      if (!slot || !Number.isFinite(slot.start) || !Number.isFinite(slot.stop) || seen.has(slot.start)) continue;
      seen.add(slot.start);
      rows.push(viewModel.slotToRow({ channelKey: entry.key, channel: entry.channel, slot, order }));
    }
    rows.sort((a, b) => a.start - b.start);
    const hasEpg = rows.length > 0 || (epgKeys instanceof Set && epgKeys.has(entry.key));
    if (hideNoEpg && !hasEpg) return;
    out.push({ key: entry.key, channel: entry.channel, rows, hasEpg });
  });
  return out;
}

/**
 * Laufende, nächste und übernächste Sendung eines Senders zum Zeitpunkt nowMs.
 * Lücken: ohne laufende Sendung (current null) rücken die kommenden Sendungen trotzdem nach.
 * genres (Etappe 3.6, Genre-Chips): die Positionen bleiben, Zellen mit nicht passendem Genre entfallen (null) —
 * wie im Mockup; ein Sender ohne passende Zelle fällt per hasMatch() aus der Liste.
 */
function assign(channel, nowMs, genres = null) {
  let current = null;
  const upcoming = [];
  for (const row of channel.rows) {
    if (row.start <= nowMs && nowMs < row.stop) {
      if (!current || row.start > current.start) current = row;
    } else if (row.start > nowMs) {
      upcoming.push(row);
    }
  }
  const picks = { current, next: upcoming[0] || null, after: upcoming[1] || null };
  if (!genreFilter.isActive(genres)) return picks;
  const keep = row => (row && genreFilter.matchesGenre(genres, row.genre) ? row : null);
  return { current: keep(picks.current), next: keep(picks.next), after: keep(picks.after) };
}

/** Hat der Sender mindestens eine (passende) Zelle? */
function hasMatch(assignment) {
  return !!(assignment.current || assignment.next || assignment.after);
}

/** Signatur der Zuordnung: ändert sie sich, werden die Zellen der Zeile neu aufgebaut (sonst nur aktualisiert). */
function assignmentSig(assignment) {
  return [assignment.current, assignment.next, assignment.after].map(row => (row ? row.id : '-')).join('>');
}

module.exports = {
  WINDOW_MS,
  RELOAD_AFTER_MS,
  ROW_HEIGHT_WIDE,
  ROW_HEIGHT_NARROW,
  isNarrow,
  rowHeight,
  windowFor,
  needsReload,
  buildChannels,
  assign,
  hasMatch,
  assignmentSig,
};
