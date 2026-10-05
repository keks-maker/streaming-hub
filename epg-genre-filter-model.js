// Genre-Filter des Programmführers (Etappe 3.6, M4/F3) — rein und DOM-frei.
//
// Die Genre-Chips der Schnellfilter-Leiste schalten Genre-Gruppen (film, serie, news, sport, doku, kinder,
// show, musik, sonstiges — Beschriftung/Auswahl aus epg-genres.js, Zuordnung der Kategorien im Main) an oder aus.
// Ohne aktive Gruppe gilt kein Filter. Eine Sendung ohne Genre (keine Kategorie in der Quelle) passt zu
// keiner aktiven Gruppe. Der Filter ist reiner Sitzungszustand (wie die Senderauswahl, kein Setting):
//   Raster          nicht passende Blöcke werden gedämpft (Struktur bleibt)
//   Liste, J&G      es wird wirklich gefiltert
//   Suche           Treffer werden gefiltert (Genre aus den geladenen Zeilen, sonst per epg:range-many nachgeschlagen)
//   Kanalansicht    unverändert (die Chips sind dort ausgeblendet)

'use strict';

const { GENRES, genreLabel, cleanGenre } = require('./epg-genres.js');

/** Reihenfolge der Chips. */
const ORDER = Object.freeze(['film', 'serie', 'news', 'sport', 'doku', 'kinder', 'show', 'musik', 'sonstiges']);

/** Beliebige Eingabe (Array, Set, Einzelwert) → gültige, eindeutige Gruppen in Chip-Reihenfolge. */
function normalizeGenres(input) {
  const list = input instanceof Set ? [...input] : Array.isArray(input) ? input : [];
  const wanted = new Set(list.filter(g => typeof g === 'string' && cleanGenre(g)));
  return ORDER.filter(g => wanted.has(g));
}

/** Gruppe an/aus: liefert die neue Liste (die alte bleibt unverändert). */
function toggleGenre(current, genre) {
  if (!cleanGenre(genre)) return normalizeGenres(current);
  const set = new Set(normalizeGenres(current));
  if (set.has(genre)) set.delete(genre);
  else set.add(genre);
  return normalizeGenres(set);
}

function isActive(genres) {
  return normalizeGenres(genres).length > 0;
}

/** Passt eine Sendung der Gruppe rowGenre zum Filter? Ohne aktiven Filter immer; ohne Genre nie (bei aktivem Filter). */
function matchesGenre(genres, rowGenre) {
  const list = normalizeGenres(genres);
  if (!list.length) return true;
  const genre = cleanGenre(rowGenre);
  return !!genre && list.includes(genre);
}

/** Zeilen (mit Feld genre), die zum Filter passen; ohne aktiven Filter dasselbe Array. */
function filterRows(rows, genres) {
  const list = normalizeGenres(genres);
  const all = Array.isArray(rows) ? rows : [];
  if (!list.length) return all;
  return all.filter(row => row && list.includes(cleanGenre(row.genre)));
}

/** Chips für die Leiste: [{ genre, label, pressed }] in fester Reihenfolge. */
function chipStates(genres) {
  const active = new Set(normalizeGenres(genres));
  return ORDER.map(genre => ({ genre, label: genreLabel(genre), pressed: active.has(genre) }));
}

/** „Film, Sport“ — für Hinweistexte; '' ohne Filter. */
function describe(genres) {
  return normalizeGenres(genres).map(genreLabel).join(', ');
}

/** Sitzungszustand des Filters (überlebt Moduswechsel und Schließen/Öffnen des Overlays). */
function createGenreFilter() {
  let genres = [];
  return {
    list: () => genres.slice(),
    isActive: () => genres.length > 0,
    toggle(genre) {
      genres = toggleGenre(genres, genre);
      return genres.slice();
    },
    set(next) {
      genres = normalizeGenres(next);
      return genres.slice();
    },
    clear() {
      genres = [];
    },
    matches: rowGenre => matchesGenre(genres, rowGenre),
  };
}

// ── Suche: Genre der Treffer nachschlagen ──
// epg:search liefert schlanke Treffer ohne Genre. Treffer, die nicht zu den geladenen Zeilen gehören
// (z. B. hinter dem Ende der geladenen Tage), bekommen ihr Genre per epg:range-many je Sender.

/**
 * Abrufe für Treffer ohne bekanntes Genre: [{ key, fromMs, toMs }] je Sender (Fenster um seine unbekannten Treffer).
 * isKnown(id): Zeile mit dieser ID ist bereits mit Genre geladen.
 */
function planGenreLookups(rows, isKnown) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || (typeof isKnown === 'function' && isKnown(row.id))) continue;
    const entry = byKey.get(row.channelKey);
    if (entry) {
      entry.fromMs = Math.min(entry.fromMs, row.start);
      entry.toMs = Math.max(entry.toMs, row.stop);
    } else {
      byKey.set(row.channelKey, { key: row.channelKey, fromMs: row.start, toMs: row.stop });
    }
  }
  return [...byKey.values()];
}

/** Genre aus den Antworten (slotsByKey: Schlüssel → schlanke Slots) in die Zeilen übernehmen; neue Objekte. */
function applyLookedUpGenres(rows, slotsByKey) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const slots = slotsByKey instanceof Map ? slotsByKey.get(row.channelKey) : null;
    const slot = Array.isArray(slots) ? slots.find(s => s && s.start === row.start) : null;
    return slot && cleanGenre(slot.genre) ? { ...row, genre: cleanGenre(slot.genre) } : row;
  });
}

module.exports = {
  GENRES,
  ORDER,
  normalizeGenres,
  toggleGenre,
  isActive,
  matchesGenre,
  filterRows,
  chipStates,
  describe,
  createGenreFilter,
  planGenreLookups,
  applyLookedUpGenres,
};
