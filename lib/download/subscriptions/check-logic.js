'use strict';

// Prüflogik eines Serien-Abos (rein): welche Folgen sind neu, was gilt als bekannt, wie viele werden je Prüfung geladen.
// Neu = nicht in knownEntryIds (auch nicht über die OV-/AD-Variante) und nicht im Download-Index; die Reihenfolge der
// neuen Folgen bestimmt der Serien-Batch (bald ablaufende zuerst, dann chronologisch).

const { sortForBatch } = require('../batch.js');

/** Alle IDs, unter denen dieselbe Folge geführt wird (Folge selbst, OV- und AD-Variante). */
function idsOfEntry(entry) {
  const ids = [entry.id];
  for (const id of [entry.originalVersionId, entry.audioDescriptionId]) if (id) ids.push(id);
  return ids;
}

/** Folgen ohne Dubletten (nach ID), nur gültige Einträge. */
function uniqueEpisodes(episodes) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(episodes) ? episodes : []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

/** Ausgangsstand für „nur künftige Folgen“: alle derzeit vorhandenen Folgen (inklusive Varianten) gelten als bekannt. */
function baselineIds(episodes) {
  const ids = new Set();
  for (const entry of uniqueEpisodes(episodes)) for (const id of idsOfEntry(entry)) ids.add(id);
  return [...ids];
}

/**
 * Zerlegt die aktuelle Folgenliste einer Serie.
 * Eingabe: { episodes, known (Iterable von IDs), isDuplicate(entry) -> bool (Download-Index), nowMs, maxPerCheck }
 * Ergebnis: { take: [Folgen zum Einreihen, sortiert, höchstens maxPerCheck], deferred: Anzahl übrig für die nächste Prüfung,
 *             settled: [IDs, die ab sofort bekannt sind (bereits im Index, nicht abrufbar)], geo: Anzahl wegen Region übersprungener Folgen }
 */
function planCheck({ episodes, known, isDuplicate = () => false, nowMs = Date.now(), maxPerCheck }) {
  const knownIds = new Set(known);
  const settled = [];
  const candidates = [];
  let geo = 0;
  for (const entry of uniqueEpisodes(episodes)) {
    const ids = idsOfEntry(entry);
    if (ids.some(id => knownIds.has(id))) continue;
    if (isDuplicate(entry)) {
      settled.push(...ids);
      continue;
    }
    if (entry.regionRestricted === true) {
      settled.push(...ids); // nicht abrufbar: nicht jede Prüfung erneut versuchen
      geo += 1;
      continue;
    }
    candidates.push(entry);
  }
  const ordered = sortForBatch(candidates, nowMs);
  const limit = Number.isInteger(maxPerCheck) && maxPerCheck > 0 ? maxPerCheck : ordered.length;
  return { take: ordered.slice(0, limit), deferred: Math.max(0, ordered.length - limit), settled, geo };
}

module.exports = { idsOfEntry, uniqueEpisodes, baselineIds, planCheck };
