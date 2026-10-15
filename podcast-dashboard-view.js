// Podcast-Dashboard: Werkzeugleiste (Suchen, Jetzt aktualisieren, Statuszeile), zweigeteilt: links die abonnierten Podcasts
// (erster Eintrag „Alle neuen Episoden“, Standard), rechts die Episodenliste der Auswahl (Filter „Alle Episoden/Nur neue“, Sortierung);
// Leerzustand mit Suchfeld und Kurzliste „Beliebte öffentlich-rechtliche Sendungen“ (Abo erst nach Klick). Alle Feed-Texte per
// textContent. Auswahl, Filter und Sortierung liegen im Sitzungszustand des Hubs (ctx.view) und bleiben beim Wechsel zur
// Sendungsseite erhalten. Daten kommen aus podcast-data.js, Navigation und Meldungen aus dem Kontext (podcast-hub-view.js).

'use strict';

const { podcastDashboardModel, ALL_ID, PAGE_SIZE } = require('./podcast-dashboard-model.js');
const { SORTS } = require('./podcast-episode-model.js');
const { createEpisodeList, playEpisodeItem } = require('./podcast-episode-list-view.js');
const { createCover } = require('./podcast-cover-view.js');
const { createSuggestionList } = require('./podcast-suggestions-view.js');

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

/** ctx: { podcasts, data, view (Sitzungszustand { selection, filter, sort }), getPlayer(), now(), open(route), openEpisode(item, trigger), announce(text), notify(text), logger, manage() (optional: Einstellungen → Podcasts) } */
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

  // Zweigeteilt: links die Abos, rechts die Episoden der Auswahl
  const split = el(doc, 'div', 'podcast-split');
  split.id = 'podcastSplit';

  const showSection = el(doc, 'aside', 'podcast-subs');
  showSection.id = 'podcastShowsSection';
  const showHeading = el(doc, 'h2', 'podcast-section-title', 'Meine Abos');
  showHeading.id = 'podcastShowsHeading';
  showSection.setAttribute('aria-labelledby', showHeading.id);
  const grid = el(doc, 'ul', 'podcast-show-grid');
  grid.id = 'podcastShowGrid';
  grid.setAttribute('aria-label', 'Meine Abos');
  showSection.append(showHeading, grid);

  const newSection = el(doc, 'section', 'podcast-section podcast-episodes');
  newSection.id = 'podcastNewSection';
  const columnHead = el(doc, 'div', 'podcast-column-head');
  const newHeading = el(doc, 'h2', 'podcast-section-title', 'Alle neuen Episoden');
  newHeading.id = 'podcastNewHeading';
  newSection.setAttribute('aria-labelledby', newHeading.id);
  const openShow = el(doc, 'button', 'podcast-btn', 'Sendung öffnen');
  openShow.type = 'button';
  openShow.id = 'podcastOpenShow';
  const controls = el(doc, 'div', 'podcast-column-controls');
  const filterGroup = el(doc, 'div', 'podcast-filter');
  filterGroup.setAttribute('role', 'group');
  filterGroup.setAttribute('aria-label', 'Episoden filtern (neu: ungehört, höchstens 30 Tage alt)');
  const filterButtons = new Map();
  for (const [value, text] of [['all', 'Alle Episoden'], ['new', 'Nur neue']]) {
    const button = el(doc, 'button', 'podcast-filter-btn', text);
    button.type = 'button';
    button.dataset.filter = value;
    button.addEventListener('click', () => setView({ filter: value }));
    filterButtons.set(value, button);
    filterGroup.appendChild(button);
  }
  const sortLabel = el(doc, 'label', 'podcast-sort');
  const sortSelect = doc.createElement('select');
  sortSelect.id = 'podcastSort';
  sortSelect.className = 'podcast-select';
  for (const entry of SORTS) {
    const option = doc.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    sortSelect.appendChild(option);
  }
  sortLabel.append(el(doc, 'span', 'sr-only', 'Sortierung'), sortSelect);
  sortSelect.addEventListener('change', () => setView({ sort: sortSelect.value }));
  controls.append(filterGroup, sortLabel);
  columnHead.append(newHeading, openShow, controls);
  const columnHint = el(doc, 'p', 'podcast-section-empty podcast-column-hint');
  columnHint.id = 'podcastColumnHint';
  const newList = createEpisodeList(doc, {
    podcasts,
    showShow: true,
    label: 'Episoden',
    onOpen: (item, trigger) => ctx.openEpisode(item, trigger),
    onPlay: item => run(() => playEpisodeItem(podcasts.player, item), 'Wiedergabe nicht möglich'),
    onMark: item => markEpisode(item),
  });
  newList.element.id = 'podcastNewList';
  const newEmpty = el(doc, 'p', 'podcast-section-empty', 'Keine neuen Episoden. Alles gehört.');
  newEmpty.id = 'podcastNewEmpty';
  const newMore = el(doc, 'button', 'podcast-btn podcast-more', 'Mehr laden');
  newMore.type = 'button';
  newMore.id = 'podcastNewMore';
  newMore.hidden = true;
  newMore.addEventListener('click', () => setView({ limit: ctx.view.limit + PAGE_SIZE }));
  newSection.append(columnHead, columnHint, newList.element, newEmpty, newMore);
  split.append(showSection, newSection);

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
  const popular = createSuggestionList(doc, {
    podcasts,
    data,
    announce,
    report: (text, error) => report(text, error),
    id: 'podcastPopular',
    label: 'Beliebte öffentlich-rechtliche Sendungen',
  });
  popular.element.setAttribute('aria-labelledby', popularHeading.id);
  empty.append(emptyMessage, emptyForm, popularHeading, popular.element);

  const loading = el(doc, 'p', 'podcast-section-empty', 'Podcasts werden geladen …');
  loading.id = 'podcastLoading';

  root.textContent = '';
  root.append(toolbar, loadError, loading, split, empty);

  const tiles = new Map(); // id → { li, button, cover, title, author, badge, error }
  let tilesSignature = '';
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
    const eq = el(doc, 'span', 'podcast-eq');
    eq.setAttribute('aria-hidden', 'true'); // „spielt gerade“ steht im aria-label der Schaltfläche
    for (let i = 0; i < 3; i += 1) eq.appendChild(el(doc, 'span'));
    const text = el(doc, 'span', 'podcast-show-text');
    const title = el(doc, 'span', 'podcast-show-title');
    const author = el(doc, 'span', 'podcast-show-author');
    const error = el(doc, 'span', 'podcast-show-error');
    text.append(title, author, error);
    button.append(cover.element, text, eq, badge);
    li.appendChild(button);
    const entry = { li, button, cover, badge, eq, title, author, error, id: null };
    button.addEventListener('click', () => setView({ selection: entry.id }));
    // Doppelklick öffnet die Sendungsseite (Tastatur: Schaltfläche „Sendung öffnen“ rechts)
    button.addEventListener('dblclick', () => entry.id !== ALL_ID && open({ view: 'show', id: entry.id }));
    return entry;
  }

  function patchTile(entry, tile) {
    entry.id = tile.id;
    entry.li.dataset.podcastId = tile.id;
    entry.li.classList.toggle('is-active', Boolean(tile.active)); // Wiedergabe (eigene Markierung, getrennt von der Auswahl)
    entry.li.classList.toggle('is-playing', Boolean(tile.playing));
    entry.eq.title = tile.active ? (tile.playing ? 'spielt gerade' : 'pausiert') : '';
    entry.li.classList.toggle('is-selected', tile.selected);
    entry.li.classList.toggle('has-error', Boolean(tile.error));
    entry.button.setAttribute('aria-label', tile.ariaLabel);
    if (tile.selected) entry.button.setAttribute('aria-current', 'true');
    else entry.button.removeAttribute('aria-current');
    entry.button.tabIndex = tile.selected ? 0 : -1; // Pfeiltasten wandern durch die Liste, Tab verlässt sie
    entry.cover.update({ url: tile.cover, initial: tile.initial });
    entry.badge.hidden = tile.newCount === 0;
    entry.badge.textContent = tile.badgeText;
    entry.badge.title = tile.badgeLabel;
    entry.badge.setAttribute('aria-label', tile.badgeLabel);
    entry.title.textContent = tile.title;
    entry.author.textContent = tile.author;
    entry.error.textContent = tile.errorText || '';
    entry.error.hidden = !tile.error;
  }

  function renderShows(allEntry, shows) {
    const tilesModel = [{ ...allEntry, cover: null, initial: '☰', error: false, errorText: '' }, ...shows];
    const signature = tilesModel.map(tile => tile.id).join('\n');
    if (signature !== tilesSignature) {
      tilesSignature = signature;
      const keep = new Map(tiles);
      tiles.clear();
      grid.textContent = '';
      for (const tile of tilesModel) {
        const entry = keep.get(tile.id) || buildTile();
        tiles.set(tile.id, entry);
        grid.appendChild(entry.li);
      }
    }
    tilesModel.forEach(tile => patchTile(tiles.get(tile.id), tile));
    tiles.get(ALL_ID).li.classList.add('podcast-show-all');
  }

  /** Auswahl, Filter oder Sortierung ändern (Sitzungszustand im Hub) und neu zeichnen. */
  function setView(patch) {
    Object.assign(ctx.view, patch);
    if (patch.selection !== undefined) Object.assign(ctx.view, { filter: 'all', limit: PAGE_SIZE }); // neues Abo: alle Episoden, erste Seite
    else if (patch.filter !== undefined) ctx.view.limit = PAGE_SIZE;
    const model = render();
    if (patch.selection !== undefined && model) announce(model.column.isAll ? `Alle neuen Episoden: ${model.column.hint || 'keine'}` : `${model.column.heading}: ${model.column.hint}`);
  }

  function render() {
    const snap = data.snapshot();
    const model = podcastDashboardModel({ subscriptions: snap.subscriptions, episodes: snap.episodes, player: getPlayer(), catalog: snap.catalog, loaded: snap.loaded, loadError: snap.loadError, now: now(), view: ctx.view });
    const column = model.column;
    Object.assign(ctx.view, { selection: column.selection, filter: column.filter, sort: column.sort, limit: column.limit }); // bereinigt (z. B. nach dem Abbestellen)
    const hasShows = model.shows.length > 0;
    loading.hidden = model.loaded;
    loadError.hidden = !model.loadError;
    loadError.textContent = model.loadError;
    split.hidden = !hasShows;
    empty.hidden = !model.empty;
    emptyMessage.textContent = model.emptyMessage;
    refresh.disabled = snap.refreshing || !hasShows;
    refresh.toggleAttribute('aria-busy', snap.refreshing);
    const statusText = snap.refreshing ? 'Aktualisiere …' : model.statusText;
    if (status.textContent !== statusText) status.textContent = statusText;
    lastStatus = statusText;
    if (newHeading.textContent !== column.heading) newHeading.textContent = column.heading;
    openShow.hidden = !column.canOpenShow;
    openShow.setAttribute('aria-label', `${column.heading}: Sendung öffnen`);
    filterGroup.hidden = !column.filterVisible;
    for (const [value, button] of filterButtons) button.setAttribute('aria-pressed', String(column.filter === value));
    if (sortSelect.value !== column.sort) sortSelect.value = column.sort;
    columnHint.textContent = column.hint;
    columnHint.hidden = !column.hint;
    newEmpty.textContent = column.emptyText;
    newEmpty.hidden = column.items.length > 0 || !column.emptyText;
    newList.element.hidden = column.items.length === 0;
    newList.render(column.items);
    newMore.hidden = !column.hasMore;
    newMore.textContent = column.moreLabel;
    renderShows(model.allEntry, model.shows);
    popular.render(model.popular);
    return model;
  }

  // Pfeiltasten in der Abo-Liste: Auswahl folgt dem Fokus (Pos1/Ende springen an Anfang/Ende)
  grid.addEventListener('keydown', event => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(grid.querySelectorAll('.podcast-show-btn'));
    const index = buttons.indexOf(doc.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const li = buttons[target].closest('li');
    setView({ selection: li.dataset.podcastId });
    const moved = grid.querySelectorAll('.podcast-show-btn')[target];
    if (moved) moved.focus();
  });
  openShow.addEventListener('click', () => {
    if (ctx.view.selection && ctx.view.selection !== ALL_ID) open({ view: 'show', id: ctx.view.selection });
  });

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
