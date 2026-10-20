'use strict';

// Mediathek-Bereich: Hülle der nativen Oberfläche im Dashboard. Hält Hub-Zustand, Suche, Einstellungen, die drei
// Ansichten (Start, Serie, Genre), Detail-Fenster und Player. Route: { view: 'home' } | { view: 'series', series } |
// { view: 'genre', genre }. Die Verdrahtung mit der Navigation (Zurück-Stapel) liegt in renderer.js (Muster podcast-hub-view.js).

const { createHubStore, createSearchStore, enabledSourceIds, entryForIpc } = require('./mediathek-hub-model.js');
const { blockedFromResolution } = require('./mediathek-detail-model.js');
const { isPlayableUrl, startPosition } = require('./mediathek-player-model.js');
const { createMediathekHome } = require('./mediathek-home-view.js');
const { createMediathekSeriesView } = require('./mediathek-series-view.js');
const { createMediathekGenreView } = require('./mediathek-genre-view.js');
const { createMediathekDetail } = require('./mediathek-detail-view.js');
const { createMediathekPlayer } = require('./mediathek-player-view.js');

const HOME = { view: 'home' };
const DEFAULT_SETTINGS = { sources: { ard: true, zdf: true, arte: true }, quality: 'auto', audioLanguage: 'de', subtitles: 'off' };

const isText = value => typeof value === 'string' && value !== '';

/** Gespeicherte Route prüfen (Wiederherstellung); Unbekanntes führt zur Startansicht. */
function normalizeRoute(route) {
  if (!route || typeof route !== 'object') return HOME;
  const s = route.series;
  if (route.view === 'series' && s && isText(s.id) && isText(s.title) && isText(s.sourceId) && isText(s.groupingURL)) {
    return { view: 'series', series: { id: s.id, title: s.title, imageUrl: s.imageUrl || null, description: s.description || null, sourceId: s.sourceId, groupingURL: s.groupingURL } };
  }
  const g = route.genre;
  if (route.view === 'genre' && g && isText(g.id) && isText(g.sourceId)) {
    return { view: 'genre', genre: { id: g.id, title: isText(g.title) ? g.title : g.id, imageUrl: g.imageUrl || null, sourceId: g.sourceId } };
  }
  return HOME;
}

/** Route für den Navigationsstapel (nur serialisierbare Felder); null für die Startansicht. */
function persistableRoute(route) {
  const normalized = normalizeRoute(route);
  return normalized.view === 'home' ? null : normalized;
}

/**
 * options: { mediathek (window.mediathek), logger, notify(text), services() (Weblink-Dienste der Gruppe mediathek),
 *            iconSrc(svc), openService(svc), openWeb(url, title), onBeforeNavigate(), onBack() -> bool, onOpenSettings(),
 *            onPlaybackStart(), timers }
 */
function createMediathekHub(root, options = {}) {
  const { mediathek, logger = null, notify = null, services = () => [], iconSrc = () => null, openService = () => {}, openWeb = () => {}, onBeforeNavigate = null, onBack = null, onOpenSettings = null, onPlaybackStart = null, timers } = options;
  const doc = root.ownerDocument || document;

  const live = doc.createElement('span');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  const panel = name => {
    const node = doc.createElement('div');
    node.className = `mediathek-panel mediathek-panel-${name}`;
    node.id = `mediathekPanel-${name}`;
    node.hidden = true;
    return node;
  };
  const homePanel = panel('home');
  const seriesPanel = panel('series');
  const genrePanel = panel('genre');
  root.textContent = '';
  root.append(live, homePanel, seriesPanel, genrePanel);

  let route = HOME;
  let visible = false;
  let settings = DEFAULT_SETTINGS;
  let settingsLoaded = false;
  let resolving = false;
  let toggle = false;
  const blocked = new Map(); // entryId -> { reason, message, webUrl }
  const view = { filter: 'all', text: '' };
  const store = createHubStore({ api: mediathek });
  const search = createSearchStore({ api: mediathek });

  const announce = text => {
    toggle = !toggle;
    live.textContent = toggle ? text : text + String.fromCharCode(160); // gleicher Text wird erneut vorgelesen
  };
  const say = text => {
    announce(text);
    if (notify) notify(text);
  };
  const enabledSources = () => enabledSourceIds(settings);

  // ── Aktionen für die Ansichten ──
  async function toggleFavorite(series) {
    const result = await mediathek.toggleFavorite(series).catch(() => null);
    if (!result || !result.ok) {
      say('Meine Serien konnte nicht geändert werden.');
      return null;
    }
    store.setFavorites(result.series);
    if (route.view === 'series' && route.series.id === series.id) seriesView.setFavorite(result.favorite);
    announce(result.favorite ? `${series.title} zu Meine Serien hinzugefügt` : `${series.title} aus Meine Serien entfernt`);
    return result.favorite;
  }

  async function play(entry, series, trigger) {
    if (resolving) return;
    resolving = true;
    root.classList.add('is-busy');
    announce('Wiedergabe wird vorbereitet');
    let result;
    try {
      result = await mediathek.resolvePlayback(entryForIpc(entry), series || null);
    } catch (error) {
      result = { ok: false, error: (error && error.message) || 'Wiedergabe nicht möglich.' };
    }
    resolving = false;
    root.classList.remove('is-busy');
    if (!visible) return;
    if (!result || !result.ok) {
      say(`Wiedergabe nicht möglich: ${(result && result.error) || 'Unbekannter Fehler'}`);
      return;
    }
    const problem = blockedFromResolution(result);
    if (problem || !isPlayableUrl(result.resolution.url)) {
      blocked.set(entry.id, { ...(problem || { reason: 'unavailable', message: 'Stream nicht verfügbar.' }), webUrl: result.webUrl || null });
      announce((problem && problem.message) || 'Stream nicht verfügbar.');
      renderCurrent();
      detail.open({ entry, series: series || null, trigger });
      return;
    }
    blocked.delete(entry.id);
    detail.close({ restoreFocus: false });
    player.open({ entry, series: series || null, url: result.resolution.url, startPosition: startPosition(result), trigger });
  }

  const cardCtx = {
    isBlocked: id => blocked.get(id) || null,
    isFavorite: series => store.isFavorite(series),
    play,
    openDetail: (entry, series, trigger) => detail.open({ entry, series, trigger }),
    openSeries: series => open({ view: 'series', series }),
    openGenre: genre => open({ view: 'genre', genre }),
    toggleFavorite,
  };

  const homeCtx = {
    ...cardCtx,
    store,
    search,
    view,
    timers,
    announce,
    enabledSources,
    services: () => services(),
    iconSrc,
    openService,
    openSettings: () => onOpenSettings && onOpenSettings(),
    reload: () => {
      store.reloadAll(enabledSources());
      store.loadResume();
      store.loadFavorites();
      if (view.text.trim()) search.search(view.text, enabledSources());
    },
    openResume: item => {
      if (item.series) open({ view: 'series', series: item.series });
      else home.setQuery(item.title);
    },
  };

  const home = createMediathekHome(homePanel, homeCtx);
  const seriesView = createMediathekSeriesView(seriesPanel, { ...cardCtx, api: mediathek, back: () => back(), announce });
  const genreView = createMediathekGenreView(genrePanel, { ...cardCtx, api: mediathek, back: () => back() });
  const detail = createMediathekDetail(root, {
    play,
    isBlocked: id => blocked.get(id) || null,
    isFavorite: series => store.isFavorite(series),
    toggleFavorite,
    openWeb: (url, title) => openWeb(url, title),
  });
  const player = createMediathekPlayer(root, {
    getSettings: () => settings,
    saveProgress: ({ entry, position, duration }) => mediathek.saveWatchProgress({ sourceId: entry.sourceId, title: entry.title, position, duration }),
    onStart: () => onPlaybackStart && onPlaybackStart(),
    onClose: () => {
      if (!visible) return;
      store.loadResume();
      if (route.view === 'series') seriesView.reload();
    },
    logger,
    timers,
  });

  function renderCurrent() {
    if (!visible) return;
    if (route.view === 'home') home.render();
    else if (route.view === 'series') seriesView.render();
    else genreView.render();
    if (detail.isOpen()) detail.render();
  }

  function applyPanels() {
    if (detail.isOpen()) detail.close({ restoreFocus: false });
    homePanel.hidden = route.view !== 'home';
    seriesPanel.hidden = route.view !== 'series';
    genrePanel.hidden = route.view !== 'genre';
    root.dataset.view = route.view;
    if (route.view === 'series') seriesView.enter(route.series);
    else if (route.view === 'genre') genreView.enter(route.genre);
    else {
      home.syncInput();
      store.loadResume();
      home.render();
    }
  }

  /** Wechselt die Ansicht. silent: ohne Verlaufseintrag (Wiederherstellung, Zurück). focus: Fokus in die neue Ansicht. */
  function open(next, { silent = false, focus = true } = {}) {
    const target = normalizeRoute(next);
    if (!silent && onBeforeNavigate) onBeforeNavigate();
    route = target;
    applyPanels();
    if (focus && visible) {
      if (route.view === 'series') seriesView.focusFirst();
      else if (route.view === 'genre') genreView.focusFirst();
    }
  }

  function back() {
    if (onBack && onBack()) return;
    open(HOME, { silent: true });
  }

  function loadSettings() {
    return mediathek
      .getSettings()
      .then(result => {
        if (result && result.ok && result.settings) settings = result.settings;
        settingsLoaded = true;
      })
      .catch(error => {
        settingsLoaded = true;
        if (logger) logger.warn('Mediathek-Einstellungen konnten nicht geladen werden:', error && error.message ? error.message : error);
      });
  }

  async function showArea(next) {
    visible = true;
    root.hidden = false;
    route = normalizeRoute(next);
    applyPanels();
    if (!settingsLoaded) await loadSettings();
    if (!visible) return;
    store.loadAll(enabledSources());
    store.loadFavorites();
    if (route.view === 'home') home.render();
    if (route.view === 'series') seriesView.focusFirst();
    else if (route.view === 'genre') genreView.focusFirst();
    else home.focusFirst();
  }

  function hideArea() {
    if (!visible && root.hidden) return;
    visible = false;
    root.hidden = true;
    if (player.isOpen()) player.close({ restoreFocus: false });
    if (detail.isOpen()) detail.close({ restoreFocus: false });
  }

  store.subscribe(() => {
    if (visible && route.view === 'home') home.render();
  });
  search.subscribe(() => {
    if (visible && route.view === 'home') home.render();
  });
  if (mediathek.onFavoritesChanged) mediathek.onFavoritesChanged(list => store.setFavorites(list));
  if (mediathek.onSettingsChanged) {
    mediathek.onSettingsChanged(next => {
      settings = next;
      settingsLoaded = true;
      if (!visible) return;
      store.loadAll(enabledSources());
      if (view.text.trim()) search.search(view.text, enabledSources());
      renderCurrent();
    });
  }

  return {
    showArea,
    hideArea,
    open,
    getRoute: () => persistableRoute(route),
    isVisible: () => visible,
    refresh: () => {
      if (!visible) return;
      store.loadResume();
      renderCurrent();
    },
    player,
    detail,
    store,
    search,
    home,
  };
}

module.exports = { createMediathekHub, normalizeRoute, persistableRoute };
