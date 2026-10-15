// Podcast-Dashboard (P3): Werkzeugleiste (Suchen, Jetzt aktualisieren, Statuszeile), „Neue Episoden“, „Meine Abos“ und
// Leerzustand mit Suchfeld und Kurzliste „Beliebte öffentlich-rechtliche Sendungen“ (Abo erst nach Klick). Alle Feed-Texte per
// textContent. Daten kommen aus podcast-data.js, Navigation und Meldungen aus dem Kontext (podcast-hub-view.js).

'use strict';

const { podcastDashboardModel } = require('./podcast-dashboard-model.js');
const { createEpisodeList, playEpisodeItem } = require('./podcast-episode-list-view.js');
const { createCover } = require('./podcast-cover-view.js');

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';
const ICON_REFRESH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ICON_MANAGE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="17" r="2" fill="currentColor"/></svg>';

function toolButton(doc, { id, label, title, icon }) {
  const button = el(doc, 'button', 'dashboard-hub-tool');
  button.type = 'button';
  button.id = id;
  button.title = title;
  const iconNode = el(doc, 'span');
  iconNode.setAttribute('aria-hidden', 'true');
  iconNode.innerHTML = icon; // statisches SVG, keine Nutzerdaten
  button.append(iconNode, el(doc, 'span', 'dashboard-hub-tool-label', label));
  return button;
}

/** ctx: { podcasts, data, getPlayer(), now(), open(route), announce(text), notify(text), logger, manage() (optional: Einstellungen → Podcasts) } */
function createPodcastDashboard(root, ctx) {
  const { podcasts, data, getPlayer, now, open, announce, notify, logger } = ctx;
  const doc = root.ownerDocument || document;

  const toolbar = el(doc, 'div', 'dashboard-hub-toolbar podcast-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Podcast-Werkzeuge');
  const searchOpen = toolButton(doc, { id: 'podcastSearchOpen', label: 'Podcasts suchen', title: 'Podcasts suchen und eigene Feeds hinzufügen', icon: ICON_SEARCH });
  const refresh = toolButton(doc, { id: 'podcastRefresh', label: 'Jetzt aktualisieren', title: 'Alle Abos auf neue Episoden prüfen', icon: ICON_REFRESH });
  const manage = toolButton(doc, { id: 'podcastManage', label: 'Podcasts verwalten', title: 'Abos, eigene Feeds und Wiedergabe in den Einstellungen verwalten', icon: ICON_MANAGE });
  manage.hidden = typeof ctx.manage !== 'function';
  manage.addEventListener('click', () => ctx.manage());
  const status = el(doc, 'span', 'podcast-status');
  status.id = 'podcastStatus';
  status.setAttribute('aria-live', 'polite');
  toolbar.append(searchOpen, refresh, manage, status);

  const loadError = el(doc, 'p', 'podcast-error');
  loadError.hidden = true;
  loadError.setAttribute('role', 'alert');

  const newSection = el(doc, 'section', 'podcast-section');
  newSection.id = 'podcastNewSection';
  const newHeading = el(doc, 'h2', 'podcast-section-title', 'Neue Episoden');
  newHeading.id = 'podcastNewHeading';
  newSection.setAttribute('aria-labelledby', newHeading.id);
  const newList = createEpisodeList(doc, {
    podcasts,
    showShow: true,
    label: 'Neue Episoden',
    onPlay: item => run(() => playEpisodeItem(podcasts.player, item), 'Wiedergabe nicht möglich'),
    onMark: item => markEpisode(item),
  });
  newList.element.id = 'podcastNewList';
  const newEmpty = el(doc, 'p', 'podcast-section-empty', 'Keine neuen Episoden. Alles gehört.');
  newEmpty.id = 'podcastNewEmpty';
  newSection.append(newHeading, newList.element, newEmpty);

  const showSection = el(doc, 'section', 'podcast-section');
  showSection.id = 'podcastShowsSection';
  const showHeading = el(doc, 'h2', 'podcast-section-title', 'Meine Abos');
  showHeading.id = 'podcastShowsHeading';
  showSection.setAttribute('aria-labelledby', showHeading.id);
  const grid = el(doc, 'ul', 'podcast-show-grid');
  grid.id = 'podcastShowGrid';
  grid.setAttribute('aria-label', 'Meine Abos');
  showSection.append(showHeading, grid);

  // Leerzustand: Suchfeld und Kurzliste
  const empty = el(doc, 'section', 'podcast-empty');
  empty.id = 'podcastEmpty';
  empty.hidden = true;
  const emptyMessage = el(doc, 'p', 'podcast-empty-message');
  const emptyForm = el(doc, 'form', 'podcast-search-form');
  emptyForm.setAttribute('role', 'search');
  const emptyLabel = el(doc, 'label', 'sr-only', 'Podcast suchen');
  const emptyInput = doc.createElement('input');
  emptyInput.type = 'search';
  emptyInput.id = 'podcastEmptySearch';
  emptyInput.className = 'podcast-input';
  emptyInput.placeholder = 'Sendung suchen, z. B. „Tagesschau“';
  emptyInput.autocomplete = 'off';
  emptyInput.maxLength = 100;
  emptyLabel.htmlFor = emptyInput.id;
  const emptySubmit = el(doc, 'button', 'podcast-btn podcast-btn-primary', 'Suchen');
  emptySubmit.type = 'submit';
  emptyForm.append(emptyLabel, emptyInput, emptySubmit);
  const popularHeading = el(doc, 'h2', 'podcast-section-title', 'Beliebte öffentlich-rechtliche Sendungen');
  popularHeading.id = 'podcastPopularHeading';
  const popularList = el(doc, 'ul', 'podcast-popular-list');
  popularList.id = 'podcastPopular';
  popularList.setAttribute('aria-labelledby', popularHeading.id);
  empty.append(emptyMessage, emptyForm, popularHeading, popularList);

  const loading = el(doc, 'p', 'podcast-section-empty', 'Podcasts werden geladen …');
  loading.id = 'podcastLoading';

  root.textContent = '';
  root.append(toolbar, loadError, loading, newSection, showSection, empty);

  const tiles = new Map(); // id → { li, button, cover, title, author, badge, error }
  let tilesSignature = '';
  let popularSignature = '';
  let lastStatus = '';

  const report = (message, error) => {
    if (logger) logger.warn(`Podcast-Dashboard: ${message}`, error && error.message ? error.message : error || '');
    if (notify) notify(message);
  };
  async function run(fn, message) {
    try {
      await fn();
    } catch (error) {
      report(`Podcast: ${error && error.message ? error.message : message}`, error);
    }
  }

  async function markEpisode(item) {
    await run(async () => {
      await podcasts.setPlayed({ podcastId: item.podcastId, episodeId: item.episodeId, played: item.markPlayed });
      announce(item.markPlayed ? `${item.title} als gehört markiert` : `${item.title} als ungehört markiert`);
    }, 'Status nicht änderbar');
  }

  function buildTile() {
    const li = el(doc, 'li', 'podcast-show');
    const button = el(doc, 'button', 'podcast-show-btn');
    button.type = 'button';
    const cover = createCover(doc, { podcasts });
    const badge = el(doc, 'span', 'podcast-badge');
    badge.setAttribute('aria-hidden', 'true');
    const text = el(doc, 'span', 'podcast-show-text');
    const title = el(doc, 'span', 'podcast-show-title');
    const author = el(doc, 'span', 'podcast-show-author');
    const error = el(doc, 'span', 'podcast-show-error');
    text.append(title, author, error);
    button.append(cover.element, badge, text);
    li.appendChild(button);
    const entry = { li, button, cover, badge, title, author, error, id: null };
    button.addEventListener('click', () => open({ view: 'show', id: entry.id }));
    return entry;
  }

  function patchTile(entry, tile) {
    entry.id = tile.id;
    entry.li.dataset.podcastId = tile.id;
    entry.li.classList.toggle('is-active', tile.active);
    entry.li.classList.toggle('has-error', tile.error);
    entry.button.setAttribute('aria-label', tile.ariaLabel);
    entry.cover.update({ url: tile.cover, initial: tile.initial });
    entry.badge.hidden = tile.unheard === 0;
    entry.badge.textContent = tile.badgeText;
    entry.title.textContent = tile.title;
    entry.author.textContent = tile.author;
    entry.error.textContent = tile.errorText;
    entry.error.hidden = !tile.error;
  }

  function renderShows(shows) {
    const signature = shows.map(tile => tile.id).join('\n');
    if (signature !== tilesSignature) {
      tilesSignature = signature;
      const keep = new Map(tiles);
      tiles.clear();
      grid.textContent = '';
      for (const tile of shows) {
        const entry = keep.get(tile.id) || buildTile();
        tiles.set(tile.id, entry);
        grid.appendChild(entry.li);
      }
    }
    shows.forEach(tile => patchTile(tiles.get(tile.id), tile));
  }

  function renderPopular(popular) {
    const signature = popular.map(entry => entry.catalogId).join('\n');
    if (signature === popularSignature) return;
    popularSignature = signature;
    popularList.textContent = '';
    for (const entry of popular) {
      const li = el(doc, 'li', 'podcast-popular');
      const cover = createCover(doc, { podcasts });
      cover.update({ url: entry.cover, initial: entry.initial });
      const text = el(doc, 'span', 'podcast-popular-text');
      text.append(el(doc, 'span', 'podcast-show-title', entry.title), el(doc, 'span', 'podcast-show-author', entry.author));
      const add = el(doc, 'button', 'podcast-btn', 'Abonnieren');
      add.type = 'button';
      add.dataset.catalogId = entry.catalogId;
      add.setAttribute('aria-label', entry.ariaLabel);
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          await podcasts.subscribe({ catalogId: entry.catalogId });
          await data.load();
          announce(`${entry.title} abonniert`);
        } catch (error) {
          report(`Podcast: ${error && error.message ? error.message : 'Abo nicht möglich'}`, error);
          add.disabled = false;
        }
      });
      li.append(cover.element, text, add);
      popularList.appendChild(li);
    }
  }

  function render() {
    const snap = data.snapshot();
    const model = podcastDashboardModel({ subscriptions: snap.subscriptions, episodes: snap.episodes, player: getPlayer(), catalog: snap.catalog, loaded: snap.loaded, loadError: snap.loadError, now: now() });
    const hasShows = model.shows.length > 0;
    loading.hidden = model.loaded;
    loadError.hidden = !model.loadError;
    loadError.textContent = model.loadError;
    newSection.hidden = !hasShows;
    showSection.hidden = !hasShows;
    empty.hidden = !model.empty;
    emptyMessage.textContent = model.emptyMessage;
    refresh.disabled = snap.refreshing || !hasShows;
    refresh.toggleAttribute('aria-busy', snap.refreshing);
    const statusText = snap.refreshing ? 'Aktualisiere …' : model.statusText;
    if (status.textContent !== statusText) status.textContent = statusText;
    lastStatus = statusText;
    newEmpty.hidden = model.newEpisodes.length > 0;
    newList.element.hidden = model.newEpisodes.length === 0;
    newList.render(model.newEpisodes);
    renderShows(model.shows);
    renderPopular(model.popular);
    return model;
  }

  searchOpen.addEventListener('click', () => open({ view: 'search' }));
  emptyForm.addEventListener('submit', event => {
    event.preventDefault();
    open({ view: 'search', term: emptyInput.value });
  });
  refresh.addEventListener('click', async () => {
    if (refresh.disabled) return;
    try {
      const result = await data.refreshAll();
      if (result && result.ok === false) {
        report(`Podcast: ${result.error || 'Aktualisierung nicht möglich'}`);
      } else if (result) {
        const failed = Number(result.failed) || 0;
        announce(failed ? `Aktualisiert, ${failed} ${failed === 1 ? 'Feed' : 'Feeds'} nicht erreichbar` : 'Aktualisiert');
      }
    } catch (error) {
      report('Podcast: Aktualisierung fehlgeschlagen', error);
    }
  });

  return { render, getStatus: () => lastStatus, focusFirst: () => (searchOpen.focus(), searchOpen) };
}

module.exports = { createPodcastDashboard };
