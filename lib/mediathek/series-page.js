'use strict';

// Reine Logik der Serienseite (Port von MediathekSeriesPage in MediathekPageModels.swift): Staffelauswahl, Sortierung,
// chronologische Reihenfolge und das Ziel des Abspielen-Buttons. Staffeln sind { number: Zahl|null, entries } (groupBySeason).

/** Staffelnummern aufsteigend; die Auswahl erscheint nur bei mehr als einer Staffel. */
function seasonNumbers(seasons) {
  return [...new Set(seasons.map(season => season.number).filter(number => number !== null))].sort((a, b) => a - b);
}

/** Anzuzeigende Staffeln: Staffelfilter (selectedSeason, null = alle) und Sortierung angewendet. */
function orderedSeasons(seasons, { newestFirst = false, selectedSeason = null } = {}) {
  const numbered = seasons.filter(season => season.number !== null && (selectedSeason === null || season.number === selectedSeason));
  const rest = selectedSeason === null ? seasons.filter(season => season.number === null) : [];
  const list = newestFirst ? [...numbered].reverse() : numbered;
  return [...list, ...rest].map(season => ({ number: season.number, entries: newestFirst ? [...season.entries].reverse() : season.entries }));
}

/** Nach Datum aufsteigend (stabil), Folgen ohne Datum zuletzt. */
function byDate(list) {
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const a = left.entry.airedAt;
      const b = right.entry.airedAt;
      if (a && b) return a === b ? left.index - right.index : a < b ? -1 : 1;
      if (a) return -1;
      if (b) return 1;
      return left.index - right.index;
    })
    .map(item => item.entry);
}

/** Alle Folgen chronologisch (Staffel, Folge aufsteigend), unabhängig von der Anzeige; ohne Nummern nach Datum. */
function chronological(seasons) {
  const result = [];
  const numbered = seasons.filter(season => season.number !== null).sort((a, b) => a.number - b.number);
  for (const season of numbered) {
    const withNumber = season.entries.filter(entry => entry.episode !== null).sort((a, b) => a.episode - b.episode);
    result.push(...withNumber, ...byDate(season.entries.filter(entry => entry.episode === null)));
  }
  result.push(...byDate(seasons.filter(season => season.number === null).flatMap(season => season.entries)));
  return result;
}

/**
 * Abspielen/Fortsetzen/Nächste Folge: (a) begonnene, nicht beendete Folge dieser Serie; (b) sonst die Folge nach der zuletzt
 * gesehenen (chronologisch); (c) sonst die erste Folge. watchProgress: createWatchProgress (watch-progress.js).
 * Ergebnis { entry, kind: 'start'|'resume'|'next', label } oder null ohne Folgen.
 */
function playTarget(seasons, series, watchProgress) {
  const all = chronological(seasons);
  if (!all.length) return null;
  const labels = { start: 'Abspielen', resume: 'Fortsetzen', next: 'Nächste Folge' };
  const result = (entry, kind) => ({ entry, kind, label: labels[kind] });
  const last = watchProgress.lastUnfinishedEpisode(series);
  const resume = last ? all.find(entry => entry.title === last.title) : null;
  if (resume) return result(resume, 'resume');
  const titles = new Set(all.map(entry => entry.title));
  const seen = watchProgress.entries().find(item => item.url && (!item.series || (item.series.id === series.id && item.series.sourceId === series.sourceId)) && titles.has(item.title));
  if (seen) {
    const index = all.findIndex(entry => entry.title === seen.title);
    if (index + 1 < all.length) return result(all[index + 1], 'next');
  }
  return result(all[0], 'start');
}

module.exports = { seasonNumbers, orderedSeasons, chronological, playTarget };
