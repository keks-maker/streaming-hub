// Genre-Normalisierung für EPG-Kategorien (Etappe 3.2; EPG-Konzept B3, AUF-Plan P13)
//
// normalizeGenre(categories[]) → 'film' | 'serie' | 'news' | 'sport' | 'doku' | 'kinder' |
// 'show' | 'musik' | 'sonstiges' | '' (leer = keine Kategorie).
//
// Daten statt Logik: Die Zuordnung liegt in genre-table.json und lässt sich ohne
// Codeänderung erweitern:
//   priority: Reihenfolge der Gruppen (vorn gewinnt, wenn mehrere Kategorien verschiedene
//             Gruppen ergeben — nicht die Reihenfolge in der Quelle)
//   exact:    Gruppe → vollständige Kategorienamen
//   contains: Gruppe → Teilstrings (nur dort, wo eindeutig)
// Matching gefaltet (lib/epg-text.js foldText: klein, ohne Umlaute/Akzente; Tabelleneinträge
// werden beim Laden gleich gefaltet). Je Kategorie gilt: ein exakter Treffer geht Teilstring-
// Treffern vor; sonst gewinnt die Gruppe mit der höchsten Priorität. Eine vorhandene, aber
// nicht zuordenbare Kategorie ergibt 'sonstiges' (Auffangwert, niedrigste Priorität).
//
// Rein (keine Node-/Electron-Abhängigkeit außer dem Laden der JSON-Tabelle).

'use strict';

const { foldText } = require('../epg-text.js');
const DEFAULT_TABLE = require('./genre-table.json');

const FALLBACK = 'sonstiges';

/**
 * Baut aus einer Tabelle (Format wie genre-table.json) die Nachschlage-Strukturen.
 * Öffentlich für Tests (eigene Tabellen), im Normalfall genügt normalizeGenre.
 */
function compileGenreTable(table) {
  const priority = Array.isArray(table.priority) ? table.priority.filter(g => typeof g === 'string') : [];
  const rank = new Map(priority.map((group, i) => [group, i]));
  const exact = new Map(); // gefalteter Name → Gruppe (höchste Priorität bei Mehrfacheinträgen)
  const contains = []; // { needle, group } nach Priorität sortiert
  const setBest = (map, key, group) => {
    const current = map.get(key);
    if (current === undefined || rank.get(group) < rank.get(current)) map.set(key, group);
  };
  for (const [group, names] of Object.entries(table.exact || {})) {
    if (!rank.has(group)) continue;
    for (const name of names) {
      const key = foldText(name);
      if (key) setBest(exact, key, group);
    }
  }
  for (const [group, needles] of Object.entries(table.contains || {})) {
    if (!rank.has(group)) continue;
    for (const needle of needles) {
      const key = foldText(needle);
      if (key) contains.push({ needle: key, group });
    }
  }
  contains.sort((a, b) => rank.get(a.group) - rank.get(b.group));
  return { rank, exact, contains, fallback: priority.includes(FALLBACK) ? FALLBACK : priority[priority.length - 1] };
}

function groupOfCategory(compiled, category) {
  const folded = foldText(category);
  if (!folded) return null;
  const exactGroup = compiled.exact.get(folded);
  if (exactGroup !== undefined) return exactGroup;
  for (const { needle, group } of compiled.contains) {
    if (folded.includes(needle)) return group;
  }
  return null;
}

function createGenreNormalizer(table = DEFAULT_TABLE) {
  const compiled = compileGenreTable(table);
  return function normalize(categories) {
    if (!Array.isArray(categories)) return '';
    let best = null;
    let any = false;
    for (const category of categories) {
      if (typeof category !== 'string' || !foldText(category)) continue;
      any = true;
      const group = groupOfCategory(compiled, category);
      if (group !== null && (best === null || compiled.rank.get(group) < compiled.rank.get(best))) best = group;
    }
    if (!any) return '';
    return best !== null ? best : compiled.fallback;
  };
}

const normalizeGenre = createGenreNormalizer();

module.exports = { normalizeGenre, createGenreNormalizer, compileGenreTable, GENRE_TABLE: DEFAULT_TABLE };
