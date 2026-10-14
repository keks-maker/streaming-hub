'use strict';

// Einstellungen → Radio → Sender (R3): Senderverwaltung inline. Suche (Name, Genre, Region), Ansicht Alle/Favoriten,
// Filter Quelle/Genre/Region, Stern, „Reihenfolge bearbeiten“ (Drag&Drop + ▲▼, globale Reihenfolge), Vorhören
// (play/stop) und Anpassung gelieferter Sender (Name, Logo-URL, Stream-URL als stationOverrides). Logik: settings-radio-stations-model.js.
// Persistenz ausschließlich über window.radio; die Quellen kommen per radio:get-sources und radio:sources-changed.

const model = require('./settings-radio-stations-model.js');
const { paginate } = require('./lib/settings-channel-logic.js');
const { safeLogoUrl } = require('./radio-dashboard-model.js');
const { el, statusLine, setStatus, labelledField, textInput, button, focusNode, findAll, childList, formatIpcError } = require('./settings-radio-dom.js');

const PAGE_SIZE = 50;

function keyOf(station) {
  return `${station.sourceId}\u0000${station.id}`;
}

function createRadioStationsView(root, { radio, logger = null, onEditCustom = null, pageSize = PAGE_SIZE } = {}) {
  const doc = root.ownerDocument || document;
  const state = {
    sources: [],
    radioState: null,
    loaded: false,
    query: '',
    view: 'all',
    sourceId: '',
    genre: '',
    region: '',
    page: 0,
    reorder: false,
    open: null, // { key, sourceId, stationId, original, hasOverride, draft, initial, errors, hint }
    restoreFocus: null,
  };

  // ── Gerüst ──
  const toolbar = el(doc, 'div', 'settings-chan-toolbar');
  const search = textInput(doc, { field: 'search', placeholder: 'Sender, Genre oder Region suchen …', type: 'search' });
  search.id = 'settingsRadioSearch';
  search.setAttribute('aria-label', 'Sender suchen');
  const views = el(doc, 'div', 'settings-chan-views');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', 'Ansicht');
  const viewAll = button(doc, 'settings-chan-view active', 'Alle Sender');
  viewAll.id = 'settingsRadioViewAll';
  const viewFav = button(doc, 'settings-chan-view', 'Favoriten');
  viewFav.id = 'settingsRadioViewFav';
  views.append(viewAll, viewFav);
  toolbar.append(search, views);

  const filters = el(doc, 'div', 'settings-chan-toolbar settings-radio-filters');
  const selects = {};
  for (const [field, label] of [
    ['sourceId', 'Quelle'],
    ['genre', 'Genre'],
    ['region', 'Region'],
  ]) {
    const select = el(doc, 'select', 'settings-group-select');
    select.id = `settingsRadioFilter-${field}`;
    select.dataset.field = field;
    select.addEventListener('change', () => {
      state[field] = select.value;
      state.page = 0;
      render();
    });
    selects[field] = select;
    const wrap = el(doc, 'label', 'settings-radio-filter');
    wrap.append(el(doc, 'span', 'settings-field-label', label), select);
    filters.appendChild(wrap);
  }
  const reorderBtn = button(doc, 'settings-action-btn', 'Reihenfolge bearbeiten', 'reorder');
  reorderBtn.id = 'settingsRadioReorder';
  filters.appendChild(reorderBtn);

  const countEl = el(doc, 'div', 'settings-chan-count');
  countEl.id = 'settingsRadioCount';
  countEl.setAttribute('aria-live', 'polite');
  const listEl = el(doc, 'div', 'settings-chan-list');
  listEl.id = 'settingsRadioList';
  listEl.setAttribute('role', 'list');
  const pagerEl = el(doc, 'div', 'settings-chan-pager');
  const statusEl = statusLine(doc, 'settingsRadioStatus');
  root.textContent = '';
  root.append(toolbar, filters, countEl, listEl, pagerEl, statusEl);

  // ── Daten ──
  const report = (message, error) => {
    if (logger) logger.warn(`Radio-Einstellungen: ${message}`, error && error.message ? error.message : error || '');
  };
  const fail = error => {
    setStatus(statusEl, formatIpcError(error), true);
    render();
  };

  function setSources(next) {
    if (!Array.isArray(next)) return;
    // Das Broadcast-Ereignis nach dem eigenen Speichern liefert denselben Stand: nicht neu zeichnen, sonst geht der Fokus verloren
    const serialized = JSON.stringify(next);
    if (state.loaded && serialized === state.serialized) return;
    state.serialized = serialized;
    state.sources = next;
    state.loaded = true;
    if (state.open && !model.overrideDraft(next, { sourceId: state.open.sourceId, stationId: state.open.stationId })) state.open = null;
    render();
  }

  async function refresh() {
    // Beim erneuten Öffnen der Seite beginnt der Bearbeitungsmodus nicht von selbst (Suche und Ansicht bleiben)
    state.reorder = false;
    state.open = null;
    try {
      setSources(await radio.getSources());
      render();
      state.radioState = (await radio.getState()) || state.radioState;
      updatePreviewButtons();
    } catch (error) {
      report('Sender konnten nicht geladen werden', error);
      setStatus(statusEl, 'Sender konnten nicht geladen werden', true);
    }
  }

  const filtersOf = () => ({ view: state.view, query: state.query, sourceId: state.sourceId, genre: state.genre, region: state.region });

  async function toggleFavorite(station) {
    try {
      setStatus(statusEl, '');
      state.restoreFocus = { key: keyOf(station), action: 'fav' };
      setSources(await radio.setFavorite({ sourceId: station.sourceId, stationId: station.id }, !station.favorite));
    } catch (error) {
      fail(error);
    }
  }

  async function saveOrder(list, focus) {
    try {
      setStatus(statusEl, '');
      state.restoreFocus = focus;
      setSources(await radio.setFavoriteOrder(list));
    } catch (error) {
      fail(error);
    }
  }

  // ── Vorhören ──
  const isPreviewing = station => {
    const current = state.radioState && state.radioState.station;
    return Boolean(current) && current.sourceId === station.sourceId && current.id === station.id && ['loading', 'playing'].includes(state.radioState.status);
  };

  async function togglePreview(station) {
    try {
      setStatus(statusEl, '');
      if (isPreviewing(station)) await radio.stop();
      else await radio.play({ sourceId: station.sourceId, stationId: station.id });
    } catch (error) {
      fail(error);
    }
  }

  function updatePreviewButtons() {
    findAll(listEl, n => n.dataset && n.dataset.action === 'preview').forEach(applyPreviewState);
  }

  function applyPreviewState(btn) {
    const station = { sourceId: btn.dataset.sourceId, id: btn.dataset.stationId };
    const active = isPreviewing(station);
    btn.textContent = active ? '■' : '▶';
    btn.setAttribute('aria-pressed', String(active));
    btn.setAttribute('aria-label', `${btn.dataset.name}: ${active ? 'Vorhören beenden' : 'vorhören'}`);
    btn.title = active ? 'Vorhören beenden' : 'Vorhören';
  }

  function onRadioState(next) {
    const before = state.radioState;
    state.radioState = next;
    updatePreviewButtons();
    if (next && next.status === 'error' && (!before || before.status !== 'error') && next.station && state.open === null) {
      setStatus(statusEl, `${next.station.name}: ${next.error || 'Stream nicht erreichbar'}`, true);
    }
  }

  // ── Bearbeiten (stationOverrides) ──
  function toggleDetail(station) {
    if (station.custom) {
      if (onEditCustom) onEditCustom(station.id);
      return;
    }
    const key = keyOf(station);
    if (state.open && state.open.key === key) state.open = null;
    else {
      const info = model.overrideDraft(state.sources, { sourceId: station.sourceId, stationId: station.id });
      if (!info) return;
      state.open = { key, sourceId: station.sourceId, stationId: station.id, ...info, initial: JSON.stringify(info.draft), errors: {}, hint: '' };
      state.focusDetail = true;
    }
    setStatus(statusEl, '');
    render();
  }

  async function saveDetail() {
    const open = state.open;
    if (!open) return;
    open.errors = model.validateOverrideDraft(open.draft);
    if (Object.keys(open.errors).length) {
      setStatus(statusEl, 'Bitte die markierten Felder korrigieren', true);
      render();
      return;
    }
    try {
      const sources = await radio.setOverride({ sourceId: open.sourceId, stationId: open.stationId }, model.buildOverridePatch(open.draft, open.original));
      state.open = null;
      state.restoreFocus = { key: open.key, action: 'edit' };
      setStatus(statusEl, '✓ Sender gespeichert');
      setSources(sources);
      render();
    } catch (error) {
      fail(error);
    }
  }

  async function resetDetail() {
    const open = state.open;
    if (!open) return;
    try {
      const sources = await radio.clearOverride({ sourceId: open.sourceId, stationId: open.stationId });
      state.open = null;
      state.restoreFocus = { key: open.key, action: 'edit' };
      setStatus(statusEl, '✓ Auf Original zurückgesetzt');
      setSources(sources);
      render();
    } catch (error) {
      fail(error);
    }
  }

  function buildDetail() {
    const open = state.open;
    const form = el(doc, 'form', 'settings-chan-detail');
    form.noValidate = true;
    const input = (field, label, placeholder, originalValue) => {
      const control = textInput(doc, { field, value: open.draft[field], placeholder });
      control.addEventListener('input', () => {
        open.draft[field] = control.value;
        if (statusEl.classList.contains('error')) setStatus(statusEl, '');
        open.hint = '';
        hint.textContent = '';
      });
      const original = originalValue ? `Original: ${originalValue}` : 'Original: –';
      form.appendChild(labelledField(doc, label, control, { error: open.errors[field], hint: original, idBase: `settingsRadioEdit-${field}` }));
    };
    const hint = el(doc, 'div', 'settings-chan-detail-hint');
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    input('name', 'Sendername', 'Sendername', open.original.name);
    input('logo', 'Logo-URL', 'https://… (leer = Original)', open.original.logo);
    input('streamUrl', 'Stream-URL', 'https://… (leer = Original)', open.original.streamUrl);
    hint.textContent = open.hint || '';
    form.appendChild(hint);
    const actions = el(doc, 'div', 'settings-tv-actions');
    const save = el(doc, 'button', 'modal-btn modal-btn-save', 'Speichern');
    save.type = 'submit';
    const reset = button(doc, 'settings-action-btn', 'Auf Original zurücksetzen', 'reset');
    reset.disabled = !open.hasOverride;
    reset.addEventListener('click', resetDetail);
    const cancel = button(doc, 'settings-action-btn', 'Abbrechen', 'cancel');
    cancel.addEventListener('click', () => {
      state.open = null;
      state.restoreFocus = { key: open.key, action: 'edit' };
      render();
    });
    actions.append(save, reset, cancel);
    form.appendChild(actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      saveDetail();
    });
    // Escape bleibt lokal: ohne Änderungen schließt es den Bereich, sonst Hinweis (kein stiller Datenverlust).
    form.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (JSON.stringify(open.draft) === open.initial) {
        state.open = null;
        state.restoreFocus = { key: open.key, action: 'edit' };
        render();
      } else {
        open.hint = 'Ungespeicherte Änderungen – speichern oder mit „Abbrechen“ verwerfen';
        hint.textContent = open.hint;
        focusNode(save);
      }
    });
    return form;
  }

  // ── Liste ──
  function buildRow(station, ctx) {
    const key = keyOf(station);
    const isOpen = Boolean(state.open && state.open.key === key);
    const row = el(doc, 'div', `settings-chan-row${isOpen ? ' open' : ''}`);
    row.setAttribute('role', 'listitem');
    row.dataset.key = key;
    row.dataset.stationId = station.id;
    const head = el(doc, 'div', 'settings-chan-head');

    const logo = el(doc, 'img', 'settings-chan-logo');
    logo.alt = '';
    logo.loading = 'lazy';
    const src = safeLogoUrl(station.logo);
    logo.addEventListener('error', () => {
      logo.removeAttribute('src');
      logo.classList.add('empty');
    });
    if (src) logo.src = src;
    else logo.classList.add('empty');
    head.appendChild(logo);

    const info = el(doc, 'div', 'settings-chan-info');
    info.appendChild(el(doc, 'div', 'settings-chan-name', station.name));
    const meta = el(doc, 'div', 'settings-chan-meta');
    meta.appendChild(el(doc, 'span', '', ctx.sourceNames.get(station.sourceId) || station.sourceId));
    if (station.genre) meta.appendChild(el(doc, 'span', '', station.genre));
    if (station.region) meta.appendChild(el(doc, 'span', '', station.region));
    if (station.removed) {
      const badge = el(doc, 'span', 'settings-chan-badge warn', 'nicht mehr in der Liste');
      badge.title = 'Dieser Favorit wird von der Senderliste nicht mehr geliefert; er bleibt gespeichert, bis du ihn entfernst.';
      meta.appendChild(badge);
    }
    if (ctx.overridden.has(key)) meta.appendChild(el(doc, 'span', 'settings-chan-badge', 'angepasst'));
    info.appendChild(meta);
    head.appendChild(info);

    const actions = el(doc, 'div', 'settings-chan-actions');
    const star = button(doc, `settings-chan-fav${station.favorite ? ' active' : ''}`, station.favorite ? '★' : '☆', 'fav');
    star.setAttribute('aria-pressed', String(station.favorite));
    star.setAttribute('aria-label', `${station.name}: ${station.favorite ? 'aus Favoriten entfernen' : 'zu Favoriten hinzufügen'}`);
    star.addEventListener('click', () => toggleFavorite(station));
    actions.appendChild(star);

    if (state.reorder && ctx.canReorder && station.favorite) {
      const pos = model.favoritePosition(state.sources, station);
      const mk = (action, symbol, text, delta, disabled) => {
        const b = button(doc, 'settings-chan-move', symbol, action);
        b.setAttribute('aria-label', `${station.name}: ${text}`);
        if (disabled) b.disabled = true;
        else b.addEventListener('click', () => saveOrder(model.moveFavorite(state.sources, station, delta), { key, action }));
        return b;
      };
      actions.appendChild(mk('up', '▲', 'in der Reihenfolge nach oben', -1, pos.index <= 0));
      actions.appendChild(mk('down', '▼', 'in der Reihenfolge nach unten', 1, pos.index === -1 || pos.index >= pos.count - 1));
      const handle = el(doc, 'span', 'settings-chan-drag', '⠿');
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Zum Umsortieren ziehen';
      handle.draggable = true;
      handle.addEventListener('dragstart', event => {
        event.dataTransfer.setData('text/plain', key);
        event.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        findAll(listEl, n => n.classList && n.classList.contains('drag-over')).forEach(n => n.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', event => {
        event.preventDefault();
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', event => {
        event.preventDefault();
        row.classList.remove('drag-over');
        const dragged = event.dataTransfer.getData('text/plain');
        if (!dragged || dragged === key) return;
        const [sourceId, id] = dragged.split('\u0000');
        saveOrder(model.dropFavorite(state.sources, { sourceId, id }, { sourceId: station.sourceId, id: station.id }), { key: dragged, action: 'fav' });
      });
      actions.appendChild(handle);
    }

    const preview = button(doc, 'settings-chan-move settings-radio-preview', '▶', 'preview');
    preview.dataset.sourceId = station.sourceId;
    preview.dataset.stationId = station.id;
    preview.dataset.name = station.name;
    applyPreviewState(preview);
    preview.addEventListener('click', () => togglePreview(station));
    actions.appendChild(preview);

    const edit = button(doc, 'settings-action-btn', isOpen ? 'Schließen' : 'Bearbeiten', 'edit');
    edit.setAttribute('aria-expanded', String(isOpen));
    edit.setAttribute('aria-label', `${station.name}: ${isOpen ? 'Bearbeiten schließen' : station.custom ? 'unter „Eigene Sender“ bearbeiten' : 'bearbeiten'}`);
    edit.addEventListener('click', () => toggleDetail(station));
    actions.appendChild(edit);
    head.appendChild(actions);
    row.appendChild(head);
    if (isOpen) row.appendChild(buildDetail());
    return row;
  }

  function renderFilters() {
    const facets = model.facets(state.sources);
    const fill = (select, items, allLabel, current) => {
      select.textContent = '';
      const all = el(doc, 'option', '', allLabel);
      all.value = '';
      select.appendChild(all);
      for (const item of items) {
        const option = el(doc, 'option', '', item.name);
        option.value = item.id;
        select.appendChild(option);
      }
      select.value = items.some(i => i.id === current) ? current : '';
    };
    fill(selects.sourceId, facets.sources, 'Alle Quellen', state.sourceId);
    fill(selects.genre, facets.genres.map(g => ({ id: g, name: g })), 'Alle Genres', state.genre);
    fill(selects.region, facets.regions.map(r => ({ id: r, name: r })), 'Alle Regionen', state.region);
    // Auswahl, die es nicht mehr gibt, fällt auf „alle“ zurück
    for (const field of ['sourceId', 'genre', 'region']) state[field] = selects[field].value;
  }

  function captureFocus() {
    const active = doc.activeElement;
    if (!active || typeof root.contains !== 'function' || !root.contains(active) || !active.dataset || !active.dataset.field) return null;
    const rowEl = typeof active.closest === 'function' ? active.closest('.settings-chan-row') : null;
    return rowEl ? { key: rowEl.dataset.key, field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd } : null;
  }

  function restoreFocus(saved) {
    const rowOf = key => childList(listEl).find(r => r.dataset.key === key);
    const within = (row, pred) => (row ? findAll(row, pred)[0] : null);
    if (state.restoreFocus) {
      const { key, action } = state.restoreFocus;
      state.restoreFocus = null;
      const row = rowOf(key);
      // Ist die Pfeiltaste am Rand der Liste deaktiviert, bleibt der Fokus beim Gegenstück (Tastaturbedienung)
      const opposite = { up: 'down', down: 'up' }[action];
      const enabled = name => within(row, n => n.dataset && n.dataset.action === name && !n.disabled);
      focusNode(enabled(action) || (opposite && enabled(opposite)) || enabled('fav'));
      return;
    }
    if (state.focusDetail) {
      state.focusDetail = false;
      focusNode(findAll(listEl, n => n.dataset && n.dataset.field === 'name')[0]);
      return;
    }
    if (!saved) return;
    const control = within(rowOf(saved.key), n => n.dataset && n.dataset.field === saved.field);
    if (!control) return;
    focusNode(control);
    if (typeof saved.start === 'number' && typeof control.setSelectionRange === 'function') {
      try {
        control.setSelectionRange(saved.start, saved.end);
      } catch {
        /* Eingabetyp ohne Selektion */
      }
    }
  }

  function render() {
    if (!state.loaded) return;
    const saved = captureFocus();

    renderFilters();
    if (state.view === 'all') state.reorder = false;
    const canReorder = model.canReorder(filtersOf());
    if (!canReorder) state.reorder = false;
    const items = model.filterStations(state.sources, filtersOf());
    const total = model.totalInView(state.sources, state.view);
    if (state.restoreFocus) {
      const at = items.findIndex(s => keyOf(s) === state.restoreFocus.key);
      if (at !== -1) state.page = Math.floor(at / pageSize);
    }
    const pageInfo = paginate(items, state.page, pageSize);
    state.page = pageInfo.page;

    viewAll.setAttribute('aria-pressed', String(state.view === 'all'));
    viewFav.setAttribute('aria-pressed', String(state.view === 'favorites'));
    viewAll.classList.toggle('active', state.view === 'all');
    viewFav.classList.toggle('active', state.view === 'favorites');
    reorderBtn.hidden = state.view !== 'favorites';
    reorderBtn.disabled = !canReorder;
    reorderBtn.textContent = state.reorder ? 'Reihenfolge fertig' : 'Reihenfolge bearbeiten';
    reorderBtn.setAttribute('aria-pressed', String(state.reorder));
    reorderBtn.title = canReorder ? '' : 'Umsortieren ist bei aktiver Suche oder Filter nicht möglich';

    const sourceNames = new Map(state.sources.map(s => [s.id, s.name]));
    const overridden = new Set();
    for (const source of state.sources) {
      for (const id of Object.keys(source.stationOverrides || {})) if (Object.keys(source.stationOverrides[id] || {}).length) overridden.add(`${source.id}\u0000${id}`);
    }
    const ctx = { sourceNames, overridden, canReorder };
    listEl.textContent = '';
    if (!items.length) {
      const empty = state.view === 'favorites' && !model.fold(state.query) && !state.sourceId && !state.genre && !state.region;
      listEl.appendChild(el(doc, 'div', 'service-list-empty', empty ? 'Keine Favoriten vorhanden. Setze einen Stern bei „Alle Sender“.' : 'Keine Sender gefunden.'));
    }
    pageInfo.items.forEach(station => listEl.appendChild(buildRow(station, ctx)));
    let count = model.countText(items.length, total);
    if (state.reorder && pageInfo.pages > 1) count += ' – Drag&Drop gilt nur innerhalb einer Seite, über Seitengrenzen die Pfeil-Buttons nutzen';
    countEl.textContent = count;
    renderPager(pageInfo);

    restoreFocus(saved);
  }

  function renderPager(info) {
    pagerEl.textContent = '';
    if (info.pages <= 1) return;
    const mk = (text, page, disabled) => {
      const b = button(doc, 'settings-action-btn', text);
      b.disabled = disabled;
      b.addEventListener('click', () => {
        state.page = page;
        render();
      });
      return b;
    };
    pagerEl.append(mk('‹ Zurück', info.page - 1, info.page === 0), el(doc, 'span', 'settings-chan-pageinfo', `Seite ${info.page + 1} von ${info.pages}`), mk('Weiter ›', info.page + 1, info.page >= info.pages - 1));
  }

  search.addEventListener('input', () => {
    state.query = search.value;
    state.page = 0;
    render();
  });
  viewAll.addEventListener('click', () => {
    state.view = 'all';
    state.page = 0;
    render();
  });
  viewFav.addEventListener('click', () => {
    state.view = 'favorites';
    state.page = 0;
    render();
  });
  reorderBtn.addEventListener('click', () => {
    state.reorder = !state.reorder;
    render();
    focusNode(reorderBtn);
  });

  const unsubscribers = [];
  if (radio.onSourcesChanged) unsubscribers.push(radio.onSourcesChanged(setSources));
  if (radio.onState) unsubscribers.push(radio.onState(onRadioState));

  return {
    refresh,
    render,
    getState: () => state,
    dispose: () => unsubscribers.forEach(off => typeof off === 'function' && off()),
  };
}

module.exports = { createRadioStationsView, PAGE_SIZE };
