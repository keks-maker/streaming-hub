'use strict';

// Zustand und Logik des Mediathek-Hubs (rein, ohne DOM): Filterleiste, Startseiten-Reihen je Quelle mit Nachladen,
// Weiterschauen/Meine Serien und die Suche mit Paging. Netzwerk läuft über das injizierte api (window.mediathek);
// jede Anfrage trägt ein Token, nur die jüngste Anfrage setzt Zustand (veraltete Antworten werden verworfen).

const { sourceLabel } = require('./mediathek-format.js');

/** Der „Downloads“-Chip ist aktiv; sichtbar ist er nur bei eingeschalteter Einstellung „Download-Funktion anzeigen“ (showDownloads). */
const DOWNLOADS_CHIP_ENABLED = true;
const ROW_LIMIT = 40;
const GENRES_TITLE = 'Genres';
const SPECIAL_FILTERS = ['favorites', 'resume', 'downloads', 'others'];
const SEARCH_DEBOUNCE_MS = 450;

const SEARCH_MESSAGES = { failed: 'Die Suche ist fehlgeschlagen.', moreFailed: 'Weitere Treffer konnten nicht geladen werden.' };

/** IPC-Aufruf, der nie wirft: { ok: false, error } statt Exception. */
async function safeCall(run) {
  try {
    const result = await run();
    return result && typeof result === 'object' ? result : { ok: false, error: 'Keine Antwort' };
  } catch (error) {
    return { ok: false, error: (error && error.message) || 'Anfrage fehlgeschlagen', code: 'error' };
  }
}

function createEmitter() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * Chips der Quellenleiste. Während einer Suche nur „Alle“ und die Quellen (mit Trefferzahl); sonst zusätzlich
 * Meine Serien, Weiterschauen, (Downloads), Weitere Mediatheken.
 */
function filterItems({ enabledSources, searching = false, counts = {}, downloads = false, hasOthers = true }) {
  const items = [{ id: 'all', label: 'Alle', count: searching ? counts.all ?? 0 : null }];
  for (const id of enabledSources) items.push({ id, label: sourceLabel(id), count: searching ? counts[id] ?? 0 : null, source: true });
  if (!searching) {
    items.push({ id: 'favorites', label: 'Meine Serien' }, { id: 'resume', label: 'Weiterschauen' });
    if (downloads) items.push({ id: 'downloads', label: 'Downloads' });
    if (hasOthers) items.push({ id: 'others', label: 'Weitere Mediatheken', external: true });
  }
  return items;
}

/** Mitgelieferte Standard-Weblinks der nativ unterstützten Quellen (ids und Hosts wie in services.json). */
const NATIVE_DEFAULT_SERVICES = {
  ard: 'www.ardmediathek.de',
  zdf: 'www.zdf.de',
  arte: 'www.arte.tv',
};

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

/** Ist der Eintrag einer der mitgelieferten Standard-Weblinks (id UND Host)? Ein selbst angelegter Dienst mit gleicher id, aber anderer URL zählt nicht. */
function isNativeDefaultService(svc) {
  return Object.prototype.hasOwnProperty.call(NATIVE_DEFAULT_SERVICES, svc.id) && hostOf(svc.url) === NATIVE_DEFAULT_SERVICES[svc.id];
}

/** Weblink-Dienste für „Weitere Mediatheken“: Gruppe mediathek ohne die durch ARD/ZDF/arte ersetzten Standardeinträge. */
function otherMediathekServices(services) {
  return (services || []).filter(svc => svc && svc.group === 'mediathek' && !isNativeDefaultService(svc));
}

/** Gewählter Filter, falls (noch) vorhanden, sonst „Alle“. */
function resolveFilter(filter, items) {
  return items.some(item => item.id === filter) ? filter : 'all';
}

/** Quellen, für die Inhalte gezeigt/gesucht werden: Quellenfilter oder alle aktivierten. */
function activeSources(filter, enabledSources) {
  return enabledSources.includes(filter) ? [filter] : enabledSources.slice();
}

/** Beim Suchen gelten Spezial-Chips nicht: dann alle Quellen. */
function searchFilter(filter) {
  return SPECIAL_FILTERS.includes(filter) ? 'all' : filter;
}

/** Reihen aller aktiven Quellen reihum gemischt (ARD 1, ZDF 1, arte 1, ARD 2 …); Genre-Reihen stehen zuerst. */
function buildRows(home, sources) {
  const perSource = sources.map(sourceId => {
    const entry = home[sourceId];
    const sections = entry && entry.status === 'loaded' ? entry.sections : [];
    return sections.map((section, index) => ({
      id: `${sourceId}-${index}`,
      title: section.title,
      sourceId,
      sectionIndex: index,
      series: section.series.slice(0, ROW_LIMIT),
      genres: section.genres,
      entries: section.entries.slice(0, ROW_LIMIT),
      nextPage: section.nextPage || null,
      moreState: section.moreState || 'idle',
    }));
  });
  const merged = [];
  const longest = Math.max(0, ...perSource.map(list => list.length));
  for (let i = 0; i < longest; i += 1) for (const list of perSource) if (i < list.length) merged.push(list[i]);
  const isGenres = row => row.title === GENRES_TITLE && row.genres.length > 0;
  return [...merged.filter(isGenres), ...merged.filter(row => !isGenres(row)).filter(row => row.series.length + row.genres.length + row.entries.length > 0)];
}

/** Zeilen der Quellenleiste ohne Quellen, die in den Einstellungen ausgeblendet sind. */
function enabledSourceIds(settings) {
  const sources = settings && settings.sources ? settings.sources : {};
  return ['ard', 'zdf', 'arte'].filter(id => sources[id] !== false);
}

/** Fügt eine nachgeladene Seite an die Reihe an (ohne Dubletten); liefert die neue Reihe. */
function mergeSection(section, more) {
  const seen = new Set(section.entries.map(entry => entry.id));
  const fresh = (more.entries || []).filter(entry => !seen.has(entry.id));
  const seenSeries = new Set(section.series.map(series => series.id));
  const freshSeries = (more.series || []).filter(series => !seenSeries.has(series.id));
  return { ...section, entries: section.entries.concat(fresh), series: section.series.concat(freshSeries), nextPage: more.nextPage || null, moreState: 'idle' };
}

function cleanSection(section) {
  return {
    title: String(section.title || ''),
    entries: Array.isArray(section.entries) ? section.entries : [],
    series: Array.isArray(section.series) ? section.series : [],
    genres: Array.isArray(section.genres) ? section.genres : [],
    nextPage: section.nextPage || null,
    moreState: 'idle',
  };
}

/** Hub-Zustand: Startseiten je Quelle, Weiterschauen, Meine Serien. */
function createHubStore({ api }) {
  const emitter = createEmitter();
  const tokens = {};
  const state = { home: {}, resume: [], resumeLoaded: false, favorites: [] };

  async function loadHome(sourceId, { force = false } = {}) {
    const current = state.home[sourceId];
    if (!force && current && (current.status === 'loaded' || current.status === 'loading')) return;
    tokens[sourceId] = (tokens[sourceId] || 0) + 1;
    const token = tokens[sourceId];
    state.home[sourceId] = { status: 'loading', sections: [], error: null };
    emitter.emit();
    const result = await safeCall(() => api.home(sourceId));
    if (tokens[sourceId] !== token) return;
    state.home[sourceId] = result.ok
      ? { status: 'loaded', sections: (result.sections || []).map(cleanSection), error: null }
      : { status: 'failed', sections: [], error: result.error || 'Die Mediathek konnte nicht geladen werden.' };
    emitter.emit();
  }

  /** Nachladen einer Reihe (arte nextPage). Nur eine Anfrage je Reihe; veraltete Antworten (neu geladene Startseite) entfallen. */
  async function loadMoreRow(sourceId, index) {
    const entry = state.home[sourceId];
    const section = entry && entry.sections[index];
    if (!section || !section.nextPage || section.moreState === 'loading') return;
    const token = tokens[sourceId];
    section.moreState = 'loading';
    emitter.emit();
    const result = await safeCall(() => api.loadMore({ title: section.title, nextPage: section.nextPage }));
    if (tokens[sourceId] !== token || state.home[sourceId] !== entry) return;
    entry.sections[index] = result.ok && result.section ? mergeSection(section, result.section) : { ...section, moreState: 'failed' };
    emitter.emit();
  }

  async function loadResume() {
    const result = await safeCall(() => api.getResumeList());
    state.resume = result.ok && Array.isArray(result.items) ? result.items : [];
    state.resumeLoaded = true;
    emitter.emit();
  }

  async function loadFavorites() {
    const result = await safeCall(() => api.getFavorites());
    if (result.ok && Array.isArray(result.series)) {
      state.favorites = result.series;
      emitter.emit();
    }
  }

  return {
    subscribe: emitter.subscribe,
    snapshot: () => state,
    loadHome,
    loadMoreRow,
    loadResume,
    loadFavorites,
    setFavorites(list) {
      state.favorites = Array.isArray(list) ? list : [];
      emitter.emit();
    },
    isFavorite: series => state.favorites.some(item => item.id === series.id && item.sourceId === series.sourceId),
    /** Alle Quellen neu laden (Aktualisieren, geänderte Quellen). */
    reloadAll: sources => Promise.all(sources.map(id => loadHome(id, { force: true }))),
    loadAll: sources => Promise.all(sources.map(id => loadHome(id))),
  };
}

/**
 * Suche mit Paging und Request-Token. Jede neue Suche (und jedes Leeren) erhöht das Token; Antworten früherer Anfragen
 * ändern den Zustand nicht mehr. Seite 0 jeder Quelle wird parallel geladen; ARD pagt weiter (hasMore).
 */
function createSearchStore({ api }) {
  const emitter = createEmitter();
  let token = 0;
  const state = { query: '', sources: [], series: [], entries: [], paging: {}, loading: false, loadingMore: false, error: null, moreFailed: false };

  const reset = (query, sources) => {
    Object.assign(state, { query, sources, series: [], entries: [], paging: {}, loading: false, loadingMore: false, error: null, moreFailed: false });
  };

  function append(list, items) {
    const seen = new Set(list.map(item => `${item.sourceId}:${item.id}`));
    return list.concat(items.filter(item => !seen.has(`${item.sourceId}:${item.id}`)));
  }

  function apply(sourceId, result) {
    state.series = append(state.series, (result.series || []).map(series => ({ ...series, sourceId: series.sourceId || sourceId })));
    state.entries = append(state.entries, (result.entries || []).map(entry => ({ ...entry, sourceId: entry.sourceId || sourceId })));
    state.paging[sourceId] = { page: result.page ?? 0, hasMore: result.hasMore === true };
  }

  /** Neue Suche; leerer Begriff räumt auf. Liefert das Token der Anfrage. */
  async function search(query, sources) {
    const text = String(query || '').trim();
    token += 1;
    const mine = token;
    reset(text, sources);
    if (!text || !sources.length) {
      emitter.emit();
      return mine;
    }
    state.loading = true;
    emitter.emit();
    const results = await Promise.all(sources.map(async sourceId => ({ sourceId, result: await safeCall(() => api.search(text, sourceId, 0)) })));
    if (token !== mine) return mine;
    let failed = 0;
    for (const { sourceId, result } of results) {
      if (result.ok) apply(sourceId, result);
      else failed += 1;
    }
    state.loading = false;
    state.error = failed === results.length ? results[0].result.error || SEARCH_MESSAGES.failed : null;
    emitter.emit();
    return mine;
  }

  /** Nächste Seite aller Quellen (oder der gewählten Quelle), die weitere Treffer melden. */
  async function loadMore(filter = 'all') {
    if (!state.query || state.loading || state.loadingMore) return;
    const pending = state.sources.filter(id => (filter === 'all' || filter === id) && state.paging[id] && state.paging[id].hasMore);
    if (!pending.length) return;
    const mine = token;
    state.loadingMore = true;
    state.moreFailed = false;
    emitter.emit();
    const results = await Promise.all(pending.map(async sourceId => ({ sourceId, result: await safeCall(() => api.search(state.query, sourceId, state.paging[sourceId].page + 1)) })));
    if (token !== mine) return;
    for (const { sourceId, result } of results) {
      if (result.ok) apply(sourceId, result);
      else state.moreFailed = true;
    }
    state.loadingMore = false;
    emitter.emit();
  }

  const inFilter = (item, filter) => filter === 'all' || item.sourceId === filter;
  return {
    subscribe: emitter.subscribe,
    snapshot: () => state,
    search,
    loadMore,
    clear: () => search('', []),
    /** Trefferzahl je Quelle bzw. „all“ (Serien + Folgen). */
    counts() {
      const counts = { all: state.series.length + state.entries.length };
      for (const id of state.sources) counts[id] = state.series.filter(s => s.sourceId === id).length + state.entries.filter(e => e.sourceId === id).length;
      return counts;
    },
    results: filter => ({ series: state.series.filter(item => inFilter(item, filter)), entries: state.entries.filter(item => inFilter(item, filter)) }),
    hasMore: (filter = 'all') => state.sources.some(id => (filter === 'all' || filter === id) && state.paging[id] && state.paging[id].hasMore),
    isEmpty: filter => !state.loading && !state.error && state.query !== '' && state.series.filter(item => inFilter(item, filter)).length + state.entries.filter(item => inFilter(item, filter)).length === 0 && !state.loadingMore,
  };
}

const ENTRY_FIELDS = ['id', 'title', 'subtitle', 'description', 'imageUrl', 'duration', 'sourceId', 'airedAt', 'partner', 'season', 'episode', 'regionRestricted', 'originalVersionId', 'audioDescriptionId', 'availableUntil', 'fsk'];

/** Folge für den IPC-Aufruf: nur die erlaubten Felder (der Main lehnt andere, z. B. streamUrl, ab und löst Adressen selbst auf). */
function entryForIpc(entry) {
  const result = {};
  for (const field of ENTRY_FIELDS) if (entry[field] !== undefined) result[field] = entry[field];
  return result;
}

/** Weiterschauen-Eintrag -> Karte (Folge ohne Stream-Adresse; Titel/Bild/Fortschritt aus dem Verlauf). */
function resumeCard(item) {
  return { title: item.title, sourceId: item.sourceId, imageUrl: item.imageUrl || null, series: item.series || null, fraction: item.fraction ?? null, fsk: Number.isInteger(item.fsk) ? item.fsk : null };
}

module.exports = {
  DOWNLOADS_CHIP_ENABLED,
  SEARCH_DEBOUNCE_MS,
  ROW_LIMIT,
  filterItems,
  otherMediathekServices,
  resolveFilter,
  activeSources,
  searchFilter,
  buildRows,
  enabledSourceIds,
  mergeSection,
  createHubStore,
  createSearchStore,
  resumeCard,
  entryForIpc,
  safeCall,
  createEmitter,
};
