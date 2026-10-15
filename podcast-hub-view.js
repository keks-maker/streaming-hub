// Podcast-Bereich (P3): Hülle der Podcast-Oberfläche im Dashboard. Hält die drei Ansichten (Dashboard, Sendungsseite,
// Suche), den gemeinsamen Datenspeicher (podcast-data.js) und den Player-Zustand, verwaltet die Route
// ({ view: 'home' } | { view: 'search', term? } | { view: 'show', id, preview? }) und eine Sprachausgabe-Zone (aria-live).
// Die Verdrahtung mit der Navigation (Zurück-Stapel, Wiederherstellung) liegt in renderer.js.

'use strict';

const { createPodcastData } = require('./podcast-data.js');
const { createPodcastDashboard } = require('./podcast-dashboard-view.js');
const { createPodcastShowView } = require('./podcast-show-view.js');
const { createPodcastSearchView } = require('./podcast-search-view.js');

const HOME = { view: 'home' };
const CLOCK_REFRESH_MS = 60 * 1000;

/** Route für den Navigationsstapel: ohne Vorschau-Daten, nur serialisierbar. null für die Übersicht. */
function persistableRoute(route) {
  if (!route || route.view === 'home') return null;
  if (route.view === 'search') return { view: 'search' };
  if (route.view === 'show' && typeof route.id === 'string' && route.id) return { view: 'show', id: route.id };
  return null;
}

/** Prüft eine gespeicherte Route (Wiederherstellung); alles Unbekannte führt zur Übersicht. */
function normalizeRoute(route) {
  if (!route || typeof route !== 'object') return HOME;
  if (route.view === 'search') return { view: 'search', term: typeof route.term === 'string' ? route.term : undefined };
  if (route.view === 'show' && typeof route.id === 'string' && route.id) return { view: 'show', id: route.id, preview: route.preview || null };
  return HOME;
}

/**
 * options: { podcasts (window.podcasts), logger, notify(text), onBeforeNavigate() (vor jedem Routenwechsel: Verlauf sichern),
 *            onBack() (Zurück-Aktion der Navigation; liefert true, wenn behandelt), now, timers (Tests) }
 */
function createPodcastHub(root, options = {}) {
  const { podcasts, logger = null, notify = null, onBeforeNavigate = null, onBack = null, now = () => Date.now(), timers } = options;
  const doc = root.ownerDocument || document;
  const data = createPodcastData({ podcasts, logger });

  const live = doc.createElement('span');
  live.className = 'sr-only';
  live.id = 'podcastLive';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  const panel = name => {
    const node = doc.createElement('div');
    node.className = `podcast-panel podcast-panel-${name}`;
    node.id = `podcastPanel-${name}`;
    node.hidden = true;
    return node;
  };
  const homePanel = panel('home');
  const showPanel = panel('show');
  const searchPanel = panel('search');
  root.textContent = '';
  root.append(live, homePanel, showPanel, searchPanel);

  let route = HOME;
  let visible = false;
  let playerState = null;
  let clockTimer = null;
  let announceToggle = false;

  const announce = text => {
    announceToggle = !announceToggle;
    live.textContent = announceToggle ? text : text + String.fromCharCode(160); // gleicher Text wird erneut vorgelesen
  };

  const ctx = {
    podcasts,
    data,
    logger,
    notify,
    timers,
    announce,
    now,
    getPlayer: () => playerState,
    open: next => open(next),
    back: () => back(),
    home: () => open(HOME, { silent: true }), // z. B. nach dem Abbestellen: die Sendungsseite gibt es nicht mehr
  };
  const home = createPodcastDashboard(homePanel, ctx);
  const show = createPodcastShowView(showPanel, ctx);
  const search = createPodcastSearchView(searchPanel, ctx);

  function renderCurrent() {
    if (!visible) return;
    if (route.view === 'show') {
      const snap = data.snapshot();
      if (snap.loaded && !route.preview && !snap.subscriptions.some(sub => sub.id === route.id)) {
        route = HOME; // Abo nicht (mehr) vorhanden und keine Vorschau: zurück zur Übersicht
        applyPanels();
      }
    }
    if (route.view === 'home') home.render();
    else if (route.view === 'show') show.render();
    else search.render();
  }

  function applyPanels() {
    homePanel.hidden = route.view !== 'home';
    showPanel.hidden = route.view !== 'show';
    searchPanel.hidden = route.view !== 'search';
    root.dataset.view = route.view;
    if (route.view === 'show') show.enter(route);
    else if (route.view === 'search') search.enter(route);
  }

  /** Wechselt die Ansicht. options.silent: ohne Verlaufseintrag (Wiederherstellung). options.focus: Fokus in die neue Ansicht. */
  function open(next, { silent = false, focus = true } = {}) {
    const target = normalizeRoute(next);
    if (!silent && onBeforeNavigate) onBeforeNavigate();
    route = target;
    applyPanels();
    renderCurrent();
    if (focus && visible) {
      if (route.view === 'show') show.focusFirst();
      else if (route.view === 'home') home.focusFirst();
    }
  }

  function back() {
    if (onBack && onBack()) return;
    open(HOME, { silent: true });
  }

  /** Bereich anzeigen (Navigation zu „Podcasts“); route optional (Wiederherstellung, Mini-Player). */
  function showArea(nextRoute) {
    visible = true;
    route = normalizeRoute(nextRoute);
    applyPanels();
    renderCurrent();
    if (!clockTimer) clockTimer = setInterval(renderCurrent, CLOCK_REFRESH_MS);
  }

  function hideArea() {
    visible = false;
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  }

  /** Daten neu laden (beim Öffnen des Bereichs). */
  async function refresh() {
    await Promise.all([data.load(), data.loadCatalog()]);
  }

  data.subscribe(renderCurrent);
  Promise.resolve(podcasts.player.getState())
    .then(initial => {
      if (!playerState) playerState = initial;
      renderCurrent();
    })
    .catch(() => {});
  const stopPlayer = podcasts.player.onState(next => {
    playerState = next;
    renderCurrent();
  });

  function dispose() {
    hideArea();
    data.dispose();
    if (typeof stopPlayer === 'function') stopPlayer();
  }

  return { open, back, showArea, hideArea, refresh, dispose, getRoute: () => persistableRoute(route), getRouteView: () => route.view, data };
}

module.exports = { createPodcastHub, persistableRoute, normalizeRoute, HOME };
