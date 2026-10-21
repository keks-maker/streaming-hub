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
const { createMediathekDownloadsView } = require('./mediathek-downloads-view.js');
const { createMediathekDownloadDialogs } = require('./mediathek-download-dialogs-view.js');
const { createSubscriptionDialogs } = require('./mediathek-subscription-dialogs-view.js');
const { updateSubscriptionBadge } = require('./mediathek-cards.js');

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
 *            onPlaybackStart(), timers, downloads ({ api: window.downloads, store: createDownloadsStore, subs: createSubscriptionsStore (Serien-Abos) }, optional),
 *            fileManager (Anzeigename des Dateimanagers) }
 */
function createMediathekHub(root, options = {}) {
  const { mediathek, logger = null, notify = null, services = () => [], iconSrc = () => null, openService = () => {}, openWeb = () => {}, onBeforeNavigate = null, onBack = null, onOpenSettings = null, onOpenAccounts = null, onPlaybackStart = null, timers, downloads: downloadOptions = null, fileManager = 'Dateimanager' } = options;
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
  const clock = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

  // Sichtbare Meldung (zusätzlich zur Ansage für Screenreader): Fehler beim Abspielen, Download-Hinweise
  const banner = doc.createElement('div');
  banner.className = 'mediathek-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'alert');
  const bannerText = doc.createElement('span');
  bannerText.className = 'mediathek-banner-text';
  const bannerClose = doc.createElement('button');
  bannerClose.type = 'button';
  bannerClose.className = 'mediathek-banner-close';
  bannerClose.textContent = '×';
  bannerClose.setAttribute('aria-label', 'Meldung schließen');
  banner.append(bannerText, bannerClose);
  let bannerTimer = null;
  const hideBanner = () => {
    if (bannerTimer) clock.clearTimeout(bannerTimer);
    bannerTimer = null;
    banner.hidden = true;
  };
  bannerClose.addEventListener('click', hideBanner);
  const showBanner = text => {
    bannerText.textContent = text;
    banner.hidden = false;
    if (bannerTimer) clock.clearTimeout(bannerTimer);
    bannerTimer = clock.setTimeout(hideBanner, 9000);
  };

  root.textContent = '';
  root.append(live, banner, homePanel, seriesPanel, genrePanel);

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
    showBanner(text);
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

  const fskKnown = new Map(); // "<quelle>:<id>" -> nachgeladene Altersfreigabe (ZDF-Teaser nennen sie oft nicht)

  /** Eintrag mit Altersfreigabe: ZDF ohne Angabe fragt einmal das Dokument ab (Main cached); Fehler lassen den Eintrag unverändert. */
  async function withFsk(entry) {
    if (!entry || typeof entry.fsk === 'number' || entry.sourceId !== 'zdf' || typeof mediathek.entryFsk !== 'function') return entry;
    const key = `${entry.sourceId}:${entry.id}`;
    if (!fskKnown.has(key)) {
      try {
        const result = await mediathek.entryFsk(entryForIpc(entry));
        if (result && result.ok) fskKnown.set(key, typeof result.fsk === 'number' ? result.fsk : null);
      } catch {
        return entry;
      }
    }
    const fsk = fskKnown.get(key);
    return typeof fsk === 'number' ? { ...entry, fsk } : entry;
  }

  function openDetail(entry, series, trigger) {
    detail.open({ entry, series, trigger });
    withFsk(entry).then(full => {
      if (full !== entry) detail.refreshEntry(full);
    });
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
      openDetail(entry, series || null, trigger);
      return;
    }
    blocked.delete(entry.id);
    detail.close({ restoreFocus: false });
    player.open({ entry: await withFsk(entry), series: series || null, url: result.resolution.url, startPosition: startPosition(result), trigger });
  }

  // ── Downloads (optional): Zustand liegt im Store des Renderers (auch für den Navbar-Indikator) ──
  const dlApi = downloadOptions && downloadOptions.api;
  const dlStore = downloadOptions && downloadOptions.store;
  const subsStore = (dlStore && downloadOptions.subs) || null;
  let dlSettings = { showDownloads: true, skipOptionsDialog: false };
  let dlFullSettings = {}; // alle Download-Einstellungen (Vorbelegung der Abo-Optionen)
  const dlEnabled = () => Boolean(dlStore) && dlSettings.showDownloads !== false;
  const dlRoot = doc.createElement('div');
  dlRoot.className = 'mediathek-downloads';
  dlRoot.id = 'mediathekDownloads';
  let dialogs = null;
  let dlView = null;
  let subDialogs = null;
  if (dlStore) {
    dialogs = createMediathekDownloadDialogs({
      api: dlApi,
      host: root,
      getSettings: () => dlSettings,
      announce: text => announce(text),
      say: text => say(text),
      onChanged: () => dlStore.load(),
      getFreeBytes: () => dlStore.snapshot().freeBytes,
    });
    if (subsStore) {
      subDialogs = createSubscriptionDialogs({
        host: root,
        store: subsStore,
        getSettings: () => dlFullSettings,
        announce: text => announce(text),
        say: text => say(text),
        selection: args => dialogs.openSelection({ ...args, stateOf: entry => dlStore.stateOf(entry) }),
      });
    }
    dlView = createMediathekDownloadsView(dlRoot, {
      store: dlStore,
      subs: subsStore ? { store: subsStore, openOptions: (sub, trigger) => subDialogs.openOptions({ sub, trigger }) } : null,
      announce: text => announce(text),
      fileManager,
      confirmDelete: item => dialogs.confirmDelete(item),
      playLocal: (info, item) => playLocal(info, item),
    });
  }

  /** Offline-Wiedergabe eines fertigen Downloads im Mediathek-Player (dl://-Adresse aus dem Main, Fortsetzen, Verlauf). */
  function playLocal(info, item) {
    player.open({
      entry: { id: info.entryId, title: info.historyTitle, sourceId: info.sourceId, imageUrl: item.imageUrl || null, fsk: typeof info.fsk === 'number' ? info.fsk : null },
      series: null,
      url: info.url,
      startPosition: typeof info.start === 'number' && info.start > 0 ? info.start : 0,
      trigger: doc.activeElement,
    });
  }

  function loadDownloadSettings() {
    if (!dlApi || !dlApi.getSettings) return Promise.resolve();
    return dlApi
      .getSettings()
      .then(result => {
        if (result && typeof result === 'object') dlFullSettings = result;
        if (result && typeof result === 'object') dlSettings = { showDownloads: result.showDownloads !== false, skipOptionsDialog: result.skipOptionsDialog === true };
      })
      .catch(error => {
        if (logger) logger.warn('Download-Einstellungen konnten nicht geladen werden:', error && error.message ? error.message : error);
      });
  }

  /** Öffnet den Downloads-Bereich (Chip „Downloads“) mit der gewünschten Ansicht. */
  function openDownloads(tab = 'queue') {
    if (!dlEnabled()) return;
    view.filter = 'downloads';
    view.text = '';
    home.setQuery('');
    dlView.showTab(tab);
    open(HOME);
  }

  const seriesDownloads = dlStore
    ? {
        enabled: dlEnabled,
        stateOf: entry => dlStore.stateOf(entry),
        count: series => dlStore.downloadedCount(series),
        start: (entry, series, trigger) => dialogs.startEpisode({ entry, series, trigger }),
        openSelection: args => dialogs.openSelection({ ...args, stateOf: entry => dlStore.stateOf(entry) }),
        openArea: tab => openDownloads(tab),
        subscribe: listener => {
          const stopDownloads = dlStore.subscribe(listener);
          const stopSubs = subsStore ? subsStore.subscribe(listener) : null;
          return () => {
            stopDownloads();
            if (stopSubs) stopSubs();
          };
        },
        auto: subsStore ? { isOn: series => subsStore.isSubscribed(series), toggle: toggleAutoDownload } : null,
      }
    : null;

  /** Schalter „Neue Folgen automatisch laden“ im Serienkopf: ein = Dialog (Auswahl der Folgen), aus = Abo entfernen. */
  async function toggleAutoDownload(series, { seasons = [], trigger = null } = {}) {
    const sub = subsStore.find(series);
    if (!sub) {
      subDialogs.openEnable({ series, seasons, stateOf: entry => dlStore.stateOf(entry), trigger });
      return;
    }
    const result = await subsStore.remove(sub.id);
    const text = result && result.ok ? `Neue Folgen von ${series.title} werden nicht mehr automatisch geladen` : `Das Abo konnte nicht entfernt werden: ${(result && (result.message || result.error)) || 'Unbekannter Fehler'}`;
    announce(text);
    if (!result || !result.ok) say(text);
  }

  /** Abo-Symbole der Serienkarten in Meine Serien nachziehen (ohne Neuaufbau). */
  function patchSubscriptionBadges() {
    for (const card of homePanel.querySelectorAll('.mediathek-series-card[data-series-id]')) {
      const titleNode = card.querySelector('.mediathek-card-title');
      const series = { id: card.dataset.seriesId, sourceId: card.dataset.sourceId, title: titleNode ? titleNode.textContent : '' };
      updateSubscriptionBadge(card, series, subsStore.isSubscribed(series));
    }
  }
  if (subsStore) subsStore.subscribe(patchSubscriptionBadges);

  const cardCtx = {
    isSubscribed: series => (subsStore ? subsStore.isSubscribed(series) : false),
    isBlocked: id => blocked.get(id) || null,
    isFavorite: series => store.isFavorite(series),
    play,
    openDetail,
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
    openAccounts: () => onOpenAccounts && onOpenAccounts(),
    downloads: dlStore ? { enabled: dlEnabled, activeCount: () => dlStore.activeCount(), root: dlRoot, view: dlView } : null,
    reload: () => {
      if (dlStore) dlStore.load();
      if (subsStore) subsStore.load();
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
  const seriesView = createMediathekSeriesView(seriesPanel, { ...cardCtx, api: mediathek, back: () => back(), announce, downloads: seriesDownloads });
  const genreView = createMediathekGenreView(genrePanel, { ...cardCtx, api: mediathek, back: () => back() });
  const detail = createMediathekDetail(root, {
    play,
    isBlocked: id => blocked.get(id) || null,
    isFavorite: series => store.isFavorite(series),
    toggleFavorite,
    openWeb: (url, title) => openWeb(url, title),
    canDownload: dlEnabled,
    download: (entry, series, trigger) => dialogs.startEpisode({ entry, series, trigger }),
    downloadState: entry => (dlStore ? dlStore.stateOf(entry) : { state: 'none', percent: null }),
  });
  const player = createMediathekPlayer(root, {
    getSettings: () => settings,
    saveProgress: ({ entry, position, duration }) => mediathek.saveWatchProgress({ sourceId: entry.sourceId, title: entry.title, position, duration }),
    onStart: () => onPlaybackStart && onPlaybackStart(),
    onClose: () => {
      if (!visible) return;
      store.loadResume();
      if (dlStore) dlStore.load(); // "Gesehen" nach der Wiedergabe
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
    // Einstiegsroute { view: 'home', search: { sourceId, text } } (z. B. EPG „In <Mediathek> ansehen“): Quelle vorwählen und suchen
    const preset = next && next.view === 'home' && next.search && typeof next.search.text === 'string' && next.search.text.trim() ? next.search : null;
    applyPanels();
    if (!settingsLoaded) await loadSettings();
    await loadDownloadSettings();
    if (!visible) return;
    if (dlStore) dlStore.load();
    if (subsStore) subsStore.load();
    store.loadAll(enabledSources());
    store.loadFavorites();
    if (preset) {
      view.filter = enabledSources().includes(preset.sourceId) ? preset.sourceId : 'all';
      home.setQuery(preset.text.trim().slice(0, 200));
    }
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
    if (dialogs) dialogs.close();
    if (dlView) dlView.leave();
    hideBanner();
  }

  store.subscribe(() => {
    if (visible && route.view === 'home') home.render();
  });
  search.subscribe(() => {
    if (visible && route.view === 'home') home.render();
  });
  if (dlStore) {
    dlStore.subscribe(() => {
      if (!visible) return;
      if (route.view === 'home') home.refreshChips();
      if (detail.isOpen()) detail.render();
    });
  }
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
    /** Download-Einstellungen wurden geändert (Einstellungen ▸ Downloads): Chip und Schaltflächen anpassen. */
    refreshDownloadSettings: async () => {
      await loadDownloadSettings();
      if (visible) renderCurrent();
    },
    openDownloads,
    showMessage: showBanner,
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
