'use strict';

// Reihenfolge eines Serien-Batches (Konzept §4): was bald abläuft zuerst, dann chronologisch.

const SOON_EXPIRING_MS = 14 * 24 * 3600 * 1000;

/** Sortierung eines Serien-Batches: bald ablaufende zuerst (nach Ablaufdatum), dann chronologisch (Staffel, Folge, Sendedatum). */
function sortForBatch(entries, nowMs) {
  const soon = entry => {
    const until = entry.availableUntil ? Date.parse(entry.availableUntil) : NaN;
    return Number.isFinite(until) && until > nowMs && until - nowMs <= SOON_EXPIRING_MS ? until : null;
  };
  const rank = value => (value === null || value === undefined ? Infinity : value);
  const indexed = entries.map((entry, index) => ({ entry, index, soon: soon(entry) }));
  indexed.sort((a, b) => {
    if (a.soon !== null || b.soon !== null) {
      if (a.soon === null) return 1;
      if (b.soon === null) return -1;
      if (a.soon !== b.soon) return a.soon - b.soon;
    }
    return rank(a.entry.season) - rank(b.entry.season) || rank(a.entry.episode) - rank(b.entry.episode) || String(a.entry.airedAt || '').localeCompare(String(b.entry.airedAt || '')) || a.index - b.index;
  });
  return indexed.map(item => item.entry);
}

module.exports = { sortForBatch, SOON_EXPIRING_MS };
