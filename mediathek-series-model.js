'use strict';

// Zustand der Serienseite und der Genre-Seite (rein, ohne DOM). Serie: Folgen laden (nur die jüngste Anfrage zählt),
// Staffelfilter, Sortierung und das Ziel des Abspielen-Knopfs (Fortsetzen / Nächste Folge / Erste). Die Auswahl-Logik
// selbst liegt im Core (lib/mediathek/series-page.js) und wird hier nur genutzt.

const { orderedSeasons } = require('./lib/mediathek/series-page.js');
const { groupBySeason } = require('./lib/mediathek/entries.js');
const { safeCall, createEmitter, mergeSection } = require('./mediathek-hub-model.js');

const PLAY_LABELS = { start: 'Abspielen', resume: 'Fortsetzen', next: 'Nächste Folge' };
/** Seiten (ARD: je 48 Folgen), die ein Klick auf „Weitere Folgen laden“ nachlädt. */
const MORE_PAGES = 4;

function createSeriesPage({ api, series }) {
  const emitter = createEmitter();
  let token = 0;
  let seasonToken = 0;
  const state = {
    series,
    status: 'idle', // idle | loading | loaded | failed
    error: null,
    seasons: [],
    seasonNumbers: [],
    playTarget: null,
    emptyNote: null,
    emptyConnect: false,
    favorite: false,
    newestFirst: false, // Serien werden von vorn geschaut
    selectedSeason: null,
    pages: 1, // ARD: geladene Folgenseiten
    hasMore: false,
    progress: null, // { loaded, total } (ARD)
    availableSeasons: null, // ARD: Staffeln aus dem Staffel-Widget (komplett nachladbar)
    loadingMore: false,
    moreError: null,
    seasonData: {}, // Staffel -> komplett geladene Staffeln [{ number, entries }] (ARD)
    seasonStatus: 'idle', // idle | loading | failed
    seasonError: null,
  };

  const call = options => safeCall(() => api.series(series, options));

  /** Staffel komplett laden (nur mit availableSeasons); Antworten veralteter Wahl entfallen. */
  async function loadSeason(number) {
    if (number === null || !state.availableSeasons || !state.availableSeasons.includes(number) || state.seasonData[number]) {
      state.seasonStatus = 'idle';
      return;
    }
    seasonToken += 1;
    const mine = seasonToken;
    state.seasonStatus = 'loading';
    state.seasonError = null;
    emitter.emit();
    const result = await call({ season: number });
    if (mine !== seasonToken) return;
    if (result.ok) {
      state.seasonData[number] = Array.isArray(result.seasons) ? result.seasons : [];
      state.seasonStatus = 'idle';
    } else {
      state.seasonStatus = 'failed';
      state.seasonError = result.error || 'Die Staffel konnte nicht geladen werden.';
    }
    emitter.emit();
  }

  function apply(result) {
    state.seasons = Array.isArray(result.seasons) ? result.seasons : [];
    state.seasonNumbers = Array.isArray(result.seasonNumbers) ? result.seasonNumbers : [];
    state.playTarget = result.playTarget || null;
    state.emptyNote = typeof result.emptyNote === 'string' ? result.emptyNote : null;
    state.emptyConnect = result.emptyConnect === true;
    state.favorite = result.favorite === true;
    state.hasMore = result.hasMore === true;
    state.progress = result.progress && Number.isFinite(result.progress.loaded) && Number.isFinite(result.progress.total) ? result.progress : null;
    state.availableSeasons = Array.isArray(result.availableSeasons) ? result.availableSeasons : null;
    if (state.selectedSeason !== null && !state.seasonNumbers.includes(state.selectedSeason)) state.selectedSeason = null;
  }

  async function load() {
    token += 1;
    const mine = token;
    state.status = 'loading';
    state.error = null;
    state.moreError = null;
    state.loadingMore = false;
    state.seasonData = {};
    emitter.emit();
    const result = await call({ pages: state.pages });
    if (token !== mine) return;
    if (result.ok) {
      apply(result);
      state.status = 'loaded';
      emitter.emit();
      if (state.selectedSeason !== null) loadSeason(state.selectedSeason);
      return;
    }
    state.status = 'failed';
    state.error = result.error || 'Die Folgen konnten nicht geladen werden.';
    emitter.emit();
  }

  /** Weitere Folgenseiten nachladen (ARD); die bisherige Liste bleibt sichtbar, Fehler erscheinen unter der Liste. */
  async function loadMore() {
    if (state.status !== 'loaded' || !state.hasMore || state.loadingMore) return;
    const mine = token;
    state.loadingMore = true;
    state.moreError = null;
    emitter.emit();
    const result = await call({ pages: state.pages + MORE_PAGES });
    if (token !== mine) return;
    state.loadingMore = false;
    if (result.ok) {
      state.pages += MORE_PAGES;
      const favorite = state.favorite;
      apply(result);
      state.favorite = favorite;
    } else {
      state.moreError = result.error || 'Weitere Folgen konnten nicht geladen werden.';
    }
    emitter.emit();
  }

  /** Staffeln für die Anzeige: bei gewählter, komplett geladener Staffel deren Folgen, sonst die bisher geladene Liste. */
  const baseSeasons = () => (state.selectedSeason !== null && state.seasonData[state.selectedSeason] ? state.seasonData[state.selectedSeason] : state.seasons);

  return {
    subscribe: emitter.subscribe,
    snapshot: () => state,
    load,
    loadMore,
    retrySeason: () => loadSeason(state.selectedSeason),
    setSort(newestFirst) {
      state.newestFirst = Boolean(newestFirst);
      emitter.emit();
    },
    /** Staffel wählen; null = alle, unbekannte Staffeln werden ignoriert. Mit availableSeasons wird die Staffel komplett nachgeladen. */
    selectSeason(number) {
      if (number !== null && !state.seasonNumbers.includes(number)) return;
      state.selectedSeason = number;
      if (number === null) {
        seasonToken += 1;
        state.seasonStatus = 'idle';
        state.seasonError = null;
      }
      emitter.emit();
      if (number !== null) loadSeason(number);
    },
    setFavorite(value) {
      state.favorite = Boolean(value);
      emitter.emit();
    },
    /** Staffeln für die Anzeige (Filter + Sortierung). */
    visibleSeasons: () => orderedSeasons(baseSeasons(), { newestFirst: state.newestFirst, selectedSeason: state.selectedSeason }),
    /** Alle bisher geladenen Folgen (Liste plus komplett geladene Staffeln), nach Staffel gruppiert: Grundlage für Download-Auswahl und Abo. */
    loadedSeasons() {
      const entries = new Map();
      const add = list => {
        for (const season of list) for (const entry of season.entries) if (!entries.has(entry.id) || (entries.get(entry.id).season === null && entry.season !== null)) entries.set(entry.id, entry);
      };
      for (const list of Object.values(state.seasonData)) add(list);
      add(state.seasons);
      return groupBySeason([...entries.values()]);
    },
    total() {
      return this.visibleSeasons().reduce((sum, season) => sum + season.entries.length, 0);
    },
    /** Beschriftung des Abspielen-Knopfs. */
    playLabel: () => (state.playTarget && PLAY_LABELS[state.playTarget.kind]) || PLAY_LABELS.start,
    showSeasonPicker: () => state.seasonNumbers.length > 1,
    /** Nachladen der Liste anbieten: nur ohne Staffelwahl (eine gewählte Staffel liegt komplett vor). */
    canLoadMore: () => state.hasMore && (state.selectedSeason === null || !state.seasonData[state.selectedSeason]),
  };
}

/** Genre-/Rubrik-Seite (arte, ARD, ZDF): Reihen mit Nachladen. */
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
      state.error = result.error || 'Die Seite konnte nicht geladen werden.';
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

module.exports = { createSeriesPage, createGenrePage, PLAY_LABELS, MORE_PAGES };
