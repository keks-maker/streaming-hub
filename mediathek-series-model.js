'use strict';

// Zustand der Serienseite und der Genre-Seite (rein, ohne DOM). Serie: Folgen laden (nur die jüngste Anfrage zählt),
// Staffelfilter, Sortierung und das Ziel des Abspielen-Knopfs (Fortsetzen / Nächste Folge / Erste). Die Auswahl-Logik
// selbst liegt im Core (lib/mediathek/series-page.js) und wird hier nur genutzt.

const { orderedSeasons } = require('./lib/mediathek/series-page.js');
const { safeCall, createEmitter, mergeSection } = require('./mediathek-hub-model.js');

const PLAY_LABELS = { start: 'Abspielen', resume: 'Fortsetzen', next: 'Nächste Folge' };

function createSeriesPage({ api, series }) {
  const emitter = createEmitter();
  let token = 0;
  const state = {
    series,
    status: 'idle', // idle | loading | loaded | failed
    error: null,
    seasons: [],
    seasonNumbers: [],
    playTarget: null,
    favorite: false,
    newestFirst: false, // Serien werden von vorn geschaut
    selectedSeason: null,
  };

  async function load() {
    token += 1;
    const mine = token;
    state.status = 'loading';
    state.error = null;
    emitter.emit();
    const result = await safeCall(() => api.series(series));
    if (token !== mine) return;
    if (result.ok) {
      state.seasons = Array.isArray(result.seasons) ? result.seasons : [];
      state.seasonNumbers = Array.isArray(result.seasonNumbers) ? result.seasonNumbers : [];
      state.playTarget = result.playTarget || null;
      state.favorite = result.favorite === true;
      if (state.selectedSeason !== null && !state.seasonNumbers.includes(state.selectedSeason)) state.selectedSeason = null;
      state.status = 'loaded';
    } else {
      state.status = 'failed';
      state.error = result.error || 'Die Folgen konnten nicht geladen werden.';
    }
    emitter.emit();
  }

  return {
    subscribe: emitter.subscribe,
    snapshot: () => state,
    load,
    setSort(newestFirst) {
      state.newestFirst = Boolean(newestFirst);
      emitter.emit();
    },
    /** Staffel wählen; null = alle, unbekannte Staffeln werden ignoriert. */
    selectSeason(number) {
      if (number !== null && !state.seasonNumbers.includes(number)) return;
      state.selectedSeason = number;
      emitter.emit();
    },
    setFavorite(value) {
      state.favorite = Boolean(value);
      emitter.emit();
    },
    /** Staffeln für die Anzeige (Filter + Sortierung). */
    visibleSeasons: () => orderedSeasons(state.seasons, { newestFirst: state.newestFirst, selectedSeason: state.selectedSeason }),
    total() {
      return this.visibleSeasons().reduce((sum, season) => sum + season.entries.length, 0);
    },
    /** Beschriftung des Abspielen-Knopfs. */
    playLabel: () => (state.playTarget && PLAY_LABELS[state.playTarget.kind]) || PLAY_LABELS.start,
    showSeasonPicker: () => state.seasonNumbers.length > 1,
  };
}

/** Genre-Seite (arte): Reihen mit Nachladen. */
function createGenrePage({ api, genre }) {
  const emitter = createEmitter();
  let token = 0;
  const state = { genre, status: 'idle', error: null, sections: [] };

  async function load() {
    token += 1;
    const mine = token;
    state.status = 'loading';
    state.error = null;
    emitter.emit();
    const result = await safeCall(() => api.genre(genre));
    if (token !== mine) return;
    if (result.ok) {
      state.sections = (result.sections || []).map(section => ({
        title: String(section.title || ''),
        entries: section.entries || [],
        series: section.series || [],
        genres: section.genres || [],
        nextPage: section.nextPage || null,
        moreState: 'idle',
      }));
      state.status = 'loaded';
    } else {
      state.status = 'failed';
      state.error = result.error || 'Die Genre-Seite konnte nicht geladen werden.';
    }
    emitter.emit();
  }

  async function loadMore(index) {
    const section = state.sections[index];
    if (!section || !section.nextPage || section.moreState === 'loading') return;
    const mine = token;
    section.moreState = 'loading';
    emitter.emit();
    const result = await safeCall(() => api.loadMore({ title: section.title, nextPage: section.nextPage }));
    if (token !== mine || state.sections[index] !== section) return;
    state.sections[index] = result.ok && result.section ? mergeSection(section, result.section) : { ...section, moreState: 'failed' };
    emitter.emit();
  }

  return { subscribe: emitter.subscribe, snapshot: () => state, load, loadMore };
}

module.exports = { createSeriesPage, createGenrePage, PLAY_LABELS };
