'use strict';

// Mediathek-Startansicht: Suchfeld, Quellenleiste (Chips) und der Inhalt je Filter – Reihen der Quellen mit Nachladen,
// Meine Serien, Weiterschauen, Suchergebnisse mit Paging sowie „Weitere Mediatheken“ (Weblink-Dienste). Dünne Ansicht:
// Zustand und Regeln liegen in mediathek-hub-model.js.

const { filterItems, resolveFilter, activeSources, searchFilter, buildRows, resumeCard, SEARCH_DEBOUNCE_MS } = require('./mediathek-hub-model.js');
const { sourceBadge } = require('./mediathek-format.js');
const { el, button, createEntryCard, createCardFactory, createRow, appendToRow, setIcon } = require('./mediathek-cards.js');

const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const REFRESH_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/></svg>';

/**
 * ctx: { store, search, view ({ filter, text }), settings(), services(), iconSrc(svc), openService(svc), openSeries(series),
 *        openGenre(genre), openDetail(entry, series, trigger), play(entry, series, trigger), toggleFavorite(series),
 *        isBlocked(entryId), openSettings(), announce(text), timers,
 *        downloads?: { enabled(), activeCount(), root (Element), view ({ enter(), leave(), focusFirst() }) } }
 */
function createMediathekHome(root, ctx) {
  const doc = root.ownerDocument || document;
  const { store, search, view } = ctx;
  const timers = ctx.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
  let debounce = null;
  let observer = null;

  // ── Kopf: Suche, Aktualisieren ──
  const bar = el(doc, 'div', 'mediathek-searchrow');
  const field = el(doc, 'label', 'mediathek-search');
  const icon = el(doc, 'span', 'mediathek-search-icon');
  icon.setAttribute('aria-hidden', 'true');
  setIcon(icon, SEARCH_SVG);
  const input = el(doc, 'input', 'mediathek-search-input');
  input.type = 'search';
  input.id = 'mediathekSearch';
  input.placeholder = 'Mediatheken durchsuchen';
  input.setAttribute('aria-label', 'Mediatheken durchsuchen');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 200;
  const clear = button(doc, 'mediathek-search-clear', '×', () => setQuery('', { focus: true }), 'Suche löschen');
  clear.hidden = true;
  field.append(icon, input, clear);
  const refresh = button(doc, 'mediathek-tool-btn', '', () => ctx.reload(), 'Mediatheken aktualisieren');
  refresh.title = 'Aktualisieren';
  setIcon(refresh, REFRESH_SVG);
  bar.append(field, refresh);

  const chips = el(doc, 'div', 'mediathek-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Quellen');
  const content = el(doc, 'div', 'mediathek-content');
  content.id = 'mediathekContent';
  root.textContent = '';
  root.append(bar, chips, content);

  function enabled() {
    return ctx.enabledSources();
  }

  function isSearching() {
    return view.text.trim() !== '';
  }

  function setQuery(text, { focus = false } = {}) {
    view.text = text;
    if (input.value !== text) input.value = text;
    clear.hidden = text === '';
    if (debounce) timers.clearTimeout(debounce);
    debounce = null;
    if (text.trim() === '') {
      search.clear();
    } else {
      search.search(text, enabled());
    }
    if (focus) input.focus();
    render();
  }

  input.addEventListener('input', () => {
    view.text = input.value;
    clear.hidden = input.value === '';
    if (debounce) timers.clearTimeout(debounce);
    debounce = null;
    if (input.value.trim() === '') {
      search.clear();
      render();
      return;
    }
    debounce = timers.setTimeout(() => {
      debounce = null;
      search.search(view.text, enabled());
      render();
    }, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (debounce) timers.clearTimeout(debounce);
      debounce = null;
      if (input.value.trim()) {
        search.search(input.value, enabled());
        render();
      }
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
    }
  });

  // ── Chips ──
  function currentFilter(items) {
    return resolveFilter(view.filter, items);
  }

  function items() {
    const searching = isSearching();
    const list = filterItems({ enabledSources: enabled(), searching, counts: searching ? search.counts() : {}, hasOthers: ctx.services().length > 0, downloads: Boolean(ctx.downloads && ctx.downloads.enabled()) });
    const active = ctx.downloads ? ctx.downloads.activeCount() : 0;
    return list.map(item => (item.id === 'downloads' && active > 0 ? { ...item, count: active } : item));
  }

  function renderChips(list) {
    const active = currentFilter(list);
    chips.textContent = '';
    for (const item of list) {
      const label = item.count === null || item.count === undefined ? item.label : `${item.label} (${item.count})`;
      const chip = button(doc, `mediathek-chip${item.external ? ' is-external' : ''}`, label, () => {
        view.filter = item.id;
        render({ keepFocus: item.id });
        ctx.announce(`${item.label} ausgewählt`);
      });
      chip.dataset.filter = item.id;
      chip.setAttribute('aria-pressed', String(item.id === active));
      if (item.id === active) chip.classList.add('is-on');
      chips.appendChild(chip);
    }
  }

  // ── Inhalt ──
  const hint = (text, className = '') => el(doc, 'p', `mediathek-hint ${className}`.trim(), text);

  function block(className) {
    return el(doc, 'div', `mediathek-block ${className || ''}`.trim());
  }

  function loadingLine(text) {
    const line = block('mediathek-status');
    const spin = el(doc, 'span', 'mediathek-spinner');
    spin.setAttribute('aria-hidden', 'true');
    line.append(spin, el(doc, 'span', '', text));
    line.setAttribute('role', 'status');
    return line;
  }

  function errorBlock(text, onRetry, label = 'Erneut versuchen') {
    const box = block('mediathek-error');
    box.setAttribute('role', 'alert');
    box.append(el(doc, 'span', '', text), button(doc, 'mediathek-btn', label, onRetry));
    return box;
  }

  const cards = createCardFactory(doc, { ...ctx, isFavorite: series => store.isFavorite(series) });
  const entryCard = (entry, series) => cards.entry(entry, series || null);
  const seriesCard = series => cards.series(series);

  function grid(children) {
    const list = el(doc, 'ul', 'mediathek-grid');
    children.forEach(child => list.appendChild(child));
    return list;
  }

  function groupBlock(title, count, children, id) {
    const section = el(doc, 'section', 'mediathek-group');
    section.dataset.group = id;
    const head = el(doc, 'h3', 'mediathek-group-title');
    head.append(el(doc, 'span', '', title), el(doc, 'span', 'mediathek-group-count', String(count)));
    section.append(head, grid(children));
    return section;
  }

  function resumeEntryCard(item) {
    const card = resumeCard(item);
    const entry = { id: `resume:${card.sourceId}:${card.title}`, title: card.title, sourceId: card.sourceId, imageUrl: card.imageUrl, duration: null, subtitle: card.series ? card.series.title : null };
    return createEntryCard(doc, entry, {
      progress: card.fraction,
      onPlay: trigger => ctx.openResume(item, trigger),
    });
  }

  function renderResumeRow(sources) {
    const snapshot = store.snapshot();
    const list = snapshot.resume.filter(item => sources.includes(item.sourceId));
    if (!list.length) return null;
    const row = createRow(doc, { id: 'resume', title: 'Weiterschauen' });
    row.section.dataset.kind = 'resume';
    list.forEach(item => appendToRow(row.list, resumeEntryCard(item)));
    return row.section;
  }

  function renderFavoritesRow(sources) {
    const list = store.snapshot().favorites.filter(series => sources.includes(series.sourceId));
    if (!list.length) return null;
    const row = createRow(doc, { id: 'favorites', title: 'Meine Serien' });
    row.section.dataset.kind = 'favorites';
    list.forEach(series => appendToRow(row.list, seriesCard(series)));
    return row.section;
  }

  function renderHub(filter) {
    const sources = activeSources(filter, enabled());
    const nodes = [];
    const resume = renderResumeRow(sources);
    if (resume) nodes.push(resume);
    const favorites = renderFavoritesRow(sources);
    if (favorites) nodes.push(favorites);
    const showBadge = filter === 'all';
    for (const rowData of buildRows(store.snapshot().home, sources)) {
      const row = createRow(doc, {
        id: rowData.id,
        title: rowData.title,
        badge: showBadge ? sourceBadge(rowData.sourceId) : null,
        canMore: Boolean(rowData.nextPage),
        moreState: rowData.moreState,
        onMore: () => store.loadMoreRow(rowData.sourceId, rowData.sectionIndex),
      });
      rowData.genres.forEach(genre => appendToRow(row.list, cards.genre(genre)));
      rowData.series.forEach(series => appendToRow(row.list, seriesCard(series)));
      rowData.entries.forEach(entry => appendToRow(row.list, entryCard(entry, null)));
      nodes.push(row.section);
    }
    for (const sourceId of sources) {
      const state = store.snapshot().home[sourceId];
      if (!state || state.status === 'loading') nodes.push(loadingLine(`${sourceBadge(sourceId)} wird geladen …`));
      else if (state.status === 'failed') nodes.push(errorBlock(`${sourceBadge(sourceId)}: ${state.error}`, () => store.loadHome(sourceId, { force: true })));
    }
    return nodes;
  }

  function renderSearch(filter) {
    const snapshot = search.snapshot();
    const nodes = [];
    const results = search.results(searchFilter(filter));
    if (snapshot.error) nodes.push(errorBlock(`Suche fehlgeschlagen: ${snapshot.error}`, () => search.search(snapshot.query, snapshot.sources)));
    if (results.series.length) nodes.push(groupBlock('Serien', results.series.length, results.series.map(seriesCard), 'series'));
    if (results.entries.length) nodes.push(groupBlock('Folgen', results.entries.length, results.entries.map(entry => entryCard(entry, null)), 'entries'));
    if (search.isEmpty(searchFilter(filter))) {
      const empty = hint(`Keine Treffer für „${snapshot.query}“.`, 'mediathek-empty');
      empty.setAttribute('role', 'status');
      nodes.push(empty);
    }
    if (snapshot.loading) nodes.push(loadingLine('Suche läuft …'));
    else if (snapshot.loadingMore) nodes.push(loadingLine('Weitere Treffer werden geladen …'));
    else if (snapshot.moreFailed) nodes.push(errorBlock('Weitere Treffer konnten nicht geladen werden.', () => search.loadMore(searchFilter(filter))));
    else if (search.hasMore(searchFilter(filter))) {
      const more = block('mediathek-more');
      more.dataset.sentinel = '1';
      more.appendChild(button(doc, 'mediathek-btn', 'Weitere Treffer laden', () => search.loadMore(searchFilter(filter))));
      nodes.push(more);
    }
    return nodes;
  }

  function renderFavorites() {
    const list = store.snapshot().favorites.filter(series => enabled().includes(series.sourceId));
    if (!list.length) return [hint('Noch keine Serien gemerkt. Mit dem Stern an einer Serie landet sie hier.', 'mediathek-empty')];
    return [groupBlock('Meine Serien', list.length, list.map(seriesCard), 'favorites')];
  }

  function renderResume() {
    const snapshot = store.snapshot();
    const list = snapshot.resume.filter(item => enabled().includes(item.sourceId));
    if (!list.length) return [hint(snapshot.resumeLoaded ? 'Nichts zum Weiterschauen. Angefangene Sendungen erscheinen hier.' : 'Wird geladen …', 'mediathek-empty')];
    return [groupBlock('Weiterschauen', list.length, list.map(resumeEntryCard), 'resume')];
  }

  function renderOthers() {
    const services = ctx.services();
    const section = el(doc, 'section', 'mediathek-group mediathek-others');
    section.dataset.group = 'others';
    const head = el(doc, 'h3', 'mediathek-group-title');
    head.append(el(doc, 'span', '', 'Weitere Mediatheken'));
    const intro = hint('Diese Mediatheken öffnen als Webseite in der App. Hinzufügen oder ändern kannst du sie in den Einstellungen.');
    const list = el(doc, 'ul', 'mediathek-grid mediathek-service-grid');
    for (const svc of services) {
      const item = el(doc, 'li', 'mediathek-service');
      const btn = el(doc, 'button', 'mediathek-service-btn');
      btn.type = 'button';
      btn.dataset.serviceId = svc.id;
      btn.setAttribute('aria-label', `${svc.name} öffnen`);
      const iconBox = el(doc, 'span', 'mediathek-service-icon');
      iconBox.style.setProperty('--svc-c', /^#[0-9a-f]{3,8}$/i.test(svc.color || '') ? svc.color : '#1ab8e0');
      iconBox.appendChild(el(doc, 'span', 'mediathek-service-fallback', (svc.name || '?').slice(0, 1).toUpperCase()));
      const src = ctx.iconSrc(svc);
      if (src) {
        const image = el(doc, 'img');
        image.alt = '';
        image.addEventListener('error', () => image.remove());
        image.src = src;
        iconBox.appendChild(image);
      }
      btn.append(iconBox, el(doc, 'span', 'mediathek-card-title', svc.name), el(doc, 'span', 'mediathek-card-sub', 'Webseite'));
      btn.addEventListener('click', () => ctx.openService(svc));
      item.appendChild(btn);
      list.appendChild(item);
    }
    section.append(head, intro, list);
    if (!services.length) section.append(hint('Keine weiteren Mediatheken eingerichtet.', 'mediathek-empty'));
    return [section];
  }

  function focusKey() {
    const active = doc.activeElement;
    if (!active || !content.contains(active)) return null;
    const card = active.closest('[data-entry-id],[data-series-id],[data-service-id],[data-row]');
    if (!card) return null;
    const row = active.closest('[data-row],[data-group]');
    return { row: row ? row.dataset.row || row.dataset.group : '', entry: card.dataset.entryId || '', series: card.dataset.seriesId || '', cls: active.className };
  }

  function restoreFocus(key) {
    if (!key) return;
    const rows = [...content.querySelectorAll('[data-row],[data-group]')].filter(node => (node.dataset.row || node.dataset.group) === key.row);
    for (const row of rows) {
      const card = [...row.querySelectorAll('[data-entry-id],[data-series-id]')].find(node => (key.entry && node.dataset.entryId === key.entry) || (key.series && node.dataset.seriesId === key.series));
      const target = card && (card.querySelector(`.${String(key.cls).split(' ')[0]}`) || card.querySelector('button'));
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
    }
  }

  function observeSentinel() {
    if (observer) observer.disconnect();
    observer = null;
    const sentinel = content.querySelector('[data-sentinel]');
    const Observer = doc.defaultView && doc.defaultView.IntersectionObserver;
    if (!sentinel || !Observer) return;
    observer = new Observer(entries => {
      if (entries.some(entry => entry.isIntersecting)) search.loadMore(searchFilter(currentFilter(items())));
    });
    observer.observe(sentinel);
  }

  function render({ keepFocus = null } = {}) {
    const list = items();
    const filter = currentFilter(list);
    const key = keepFocus ? null : focusKey();
    renderChips(list);
    if (keepFocus) {
      const chip = chips.querySelector(`[data-filter="${keepFocus}"]`);
      if (chip) chip.focus({ preventScroll: true });
    }
    content.textContent = '';
    content.dataset.filter = filter;
    content.setAttribute('aria-busy', String(search.snapshot().loading));
    let nodes;
    if (!enabled().length && filter !== 'others') {
      const empty = block('mediathek-empty-state');
      empty.append(hint('Alle Mediatheken sind ausgeblendet.'), button(doc, 'mediathek-btn', 'Einstellungen öffnen', () => ctx.openSettings()));
      nodes = [empty];
    } else if (isSearching() && filter !== 'others') nodes = renderSearch(filter);
    else if (filter === 'favorites') nodes = renderFavorites();
    else if (filter === 'resume') nodes = renderResume();
    else if (filter === 'others') nodes = renderOthers();
    else if (filter === 'downloads' && ctx.downloads && ctx.downloads.enabled()) nodes = [ctx.downloads.root];
    else nodes = renderHub(filter);
    if (ctx.downloads) {
      if (nodes.length === 1 && nodes[0] === ctx.downloads.root) ctx.downloads.view.enter();
      else ctx.downloads.view.leave();
    }
    nodes.forEach(node => content.appendChild(node));
    restoreFocus(key);
    observeSentinel();
  }

  return {
    render,
    /** Nur die Quellenleiste neu zeichnen (z. B. Zähler am Downloads-Chip). */
    refreshChips() {
      const focused = chips.contains(doc.activeElement) ? doc.activeElement.dataset.filter : null;
      renderChips(items());
      const again = focused && chips.querySelector(`[data-filter="${focused}"]`);
      if (again) again.focus({ preventScroll: true });
    },
    isDownloadsShown: () => currentFilter(items()) === 'downloads' && !isSearching(),
    setQuery,
    /** Wiederherstellen der Suche beim Zurückkehren: Feldinhalt setzen, ohne neue Anfrage. */
    syncInput() {
      if (input.value !== view.text) input.value = view.text;
      clear.hidden = view.text === '';
    },
    /** Fokus auf den gewählten Chip (nicht ins Suchfeld: dort wären globale Tastenkürzel wie Strg+H gesperrt). */
    focusFirst() {
      const target = chips.querySelector('.is-on') || chips.querySelector('button');
      if (target) target.focus({ preventScroll: true });
    },
    dispose() {
      if (debounce) timers.clearTimeout(debounce);
      if (observer) observer.disconnect();
    },
    input,
  };
}

module.exports = { createMediathekHome };
