// Einstellungen: LiveTV-Seite "Sender" (Issue #4, Etappe 3).
// Senderverwaltung inline: Quellenfilter, Suche, Ansicht Alle/Favoriten, Favoriten setzen und
// umsortieren (Drag&Drop + Buttons), Detailbereich mit Name, EPG-Zuweisung (tvg-id),
// Logo-URL und Stream-URL-Überschreibung. Persistenz ausschließlich über updateTvSource
// (favorites / channelOverrides) – Datenformat von tvsources.json unverändert.
// Große Listen: seitenweise Darstellung (PAGE_SIZE), Logos lazy.

const {
  normEpgId,
  channelKey,
  isFav,
  filterManagedChannels,
  toggleFavoriteList,
  moveFavoriteAmongVisible,
  visibleFavoritePosition,
  moveFavoriteTo,
  mergeOverride,
  buildOverrideChanges,
  validateOverrideChanges,
  paginate,
} = require('./lib/settings-channel-logic.js');
const { formatIpcError } = require('./settings-tv-sources.js');
const { channelLogoError } = require('./lib/input-validation.js');

const PAGE_SIZE = 50;
const COMBO_LIMIT = 100;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createTvChannelsView({
  root,
  api,
  getSources,
  getChannels,
  getOriginalUrls,
  getEpgIndex,
  getEpgChannelList,
  safeResourceUrl,
  safeColor,
  reload,
}) {
  const pageEl = root.querySelector('[data-settings-page="livetv-channels"]');
  const searchInput = root.querySelector('#settingsTvChannelsSearch');
  const viewAllBtn = root.querySelector('#settingsTvChannelsViewAll');
  const viewFavBtn = root.querySelector('#settingsTvChannelsViewFav');
  const sourcesHost = root.querySelector('#settingsTvChannelsSources');
  const countEl = root.querySelector('#settingsTvChannelsCount');
  const listHost = root.querySelector('#settingsTvChannelsList');
  const pagerHost = root.querySelector('#settingsTvChannelsPager');
  const statusEl = root.querySelector('#settingsTvChannelsStatus');

  // Logo-URL für die Anzeige. Eingegebene bzw. gespeicherte Overrides werden nur als http(s)-URL
  // gezeigt (kein file:/UNC-Zugriff, kein Auflösen gegen die App-URL); das Playlist-Logo
  // (ch.logo) behält das bisherige Verhalten.
  function overrideLogoUrl(value) {
    const text = String(value || '').trim();
    if (!text || channelLogoError(text) || !/^https?:\/\//i.test(text)) return '';
    return safeResourceUrl(text, { allowRelative: false });
  }
  function displayLogoUrl(ch) {
    return overrideLogoUrl(ch.tvgLogo) || safeResourceUrl(ch.logo);
  }

  const state = {
    selected: null, // Set der Quellen-IDs; null = alle
    query: '',
    view: 'all',
    page: 0,
    open: null, // { key, sourceId, channelId, draft, errors }
    renderMs: 0,
  };

  function setStatus(message, isError = false) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function sourcesById() {
    return new Map(getSources().map(s => [s.id, s]));
  }

  function selectedIds() {
    const all = getSources().map(s => s.id);
    if (!state.selected) return all;
    return all.filter(id => state.selected.has(id));
  }

  function currentItems() {
    return filterManagedChannels(getChannels(), getSources(), {
      sourceIds: selectedIds(),
      query: state.query,
      view: state.view,
    });
  }

  function isVisible() {
    return Boolean(pageEl && !pageEl.hidden && !root.hidden);
  }

  // ── Persistenz ──

  async function saveFavorites(source, favorites) {
    source.favorites = favorites; // optimistisch; tv-sources-changed liefert den Stand zurück
    try {
      await api.updateTvSource(source.id, { favorites });
      setStatus('');
    } catch (e) {
      setStatus(formatIpcError(e), true);
    }
    render();
  }

  function toggleFavorite(ch) {
    const source = sourcesById().get(ch.sourceId);
    if (!source) return;
    saveFavorites(source, toggleFavoriteList(source.favorites, ch.id));
  }

  // Sender einer Quelle, die in der geladenen Playlist existieren (Gegenstück zu "Geister"-Favoriten).
  function visibleIdsOf(sourceId) {
    return new Set(getChannels().filter(c => c.sourceId === sourceId).map(c => c.id));
  }

  function moveFav(ch, delta, focusAction) {
    const source = sourcesById().get(ch.sourceId);
    if (!source) return;
    state.restoreFocus = { key: channelKey(ch.sourceId, ch.id), action: focusAction };
    saveFavorites(source, moveFavoriteAmongVisible(source.favorites, ch.id, delta, visibleIdsOf(ch.sourceId)));
  }

  function dropFav(draggedKey, target) {
    const [sid, chId] = draggedKey.split('\u0000');
    if (sid !== target.sourceId || chId === target.id) return;
    const source = sourcesById().get(sid);
    if (!source) return;
    saveFavorites(source, moveFavoriteTo(source.favorites, chId, target.id));
  }

  // ── Detailbereich ──

  function openDraft(ch) {
    const source = sourcesById().get(ch.sourceId);
    const ov = (source && source.channelOverrides && source.channelOverrides[ch.id]) || {};
    const original = (getOriginalUrls()[ch.sourceId] || {})[ch.id] || ch.url || '';
    const urlEnabled = typeof ov.url === 'string' && ov.url.length > 0;
    return {
      name: ch.name || '',
      tvgId: ch.tvgId || '',
      tvgLogo: ch.tvgLogo || ch.logo || '',
      urlEnabled,
      url: urlEnabled ? ov.url : original,
    };
  }

  function toggleDetail(ch) {
    const key = channelKey(ch.sourceId, ch.id);
    if (state.open && state.open.key === key) {
      state.open = null;
    } else {
      const draft = openDraft(ch);
      state.open = { key, sourceId: ch.sourceId, channelId: ch.id, draft, initial: JSON.stringify(draft), errors: {} };
      state.focusDetail = true;
    }
    setStatus('');
    render();
  }

  async function saveDetail(ch) {
    const open = state.open;
    if (!open) return;
    const changes = buildOverrideChanges(ch, open.draft);
    const errors = validateOverrideChanges(changes);
    open.errors = errors;
    if (Object.keys(errors).length) {
      setStatus('Bitte die markierten Felder korrigieren', true);
      render();
      return;
    }
    const source = sourcesById().get(ch.sourceId);
    if (!source) return;
    const merged = mergeOverride(source.channelOverrides, ch.id, changes);
    try {
      await api.updateTvSource(source.id, { channelOverrides: merged });
      source.channelOverrides = merged;
      state.open = null;
      setStatus('✓ Sender gespeichert');
      await reload();
    } catch (e) {
      setStatus(formatIpcError(e), true);
    }
    render();
  }

  function buildDetail(ch) {
    const open = state.open;
    const draft = open.draft;
    const original = (getOriginalUrls()[ch.sourceId] || {})[ch.id] || ch.url || '';
    const wrap = el('form', 'settings-chan-detail');
    wrap.noValidate = true;

    const fieldError = key => {
      const msg = open.errors[key];
      return msg ? el('div', 'settings-chan-error', msg) : null;
    };
    const labelled = (labelText, control, errKey) => {
      const f = el('label', 'settings-field');
      f.appendChild(el('span', 'settings-field-label', labelText));
      f.appendChild(control);
      const err = errKey && fieldError(errKey);
      if (err) f.appendChild(err);
      return f;
    };
    const textInput = (field, value, placeholder, extra = '') => {
      const input = el('input', `modal-input ${extra}`.trim());
      input.type = 'text';
      input.value = value;
      input.placeholder = placeholder || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.field = field;
      if (open.errors[field]) input.setAttribute('aria-invalid', 'true');
      input.addEventListener('input', () => {
        draft[field] = input.value;
        if (field === 'tvgLogo') updatePreview();
        if (field === 'tvgId') {
          updateEpgBadge();
          renderCombo();
        }
      });
      return input;
    };

    const nameInput = textInput('name', draft.name, 'Sendername');
    wrap.appendChild(labelled('Sendername (leer = Original)', nameInput, 'name'));

    // EPG-Zuweisung mit Combobox
    const epgBadge = el('span', 'settings-chan-epg');
    const tvgInput = textInput('tvgId', draft.tvgId, 'tvg-id …');
    tvgInput.setAttribute('role', 'combobox');
    tvgInput.setAttribute('aria-autocomplete', 'list');
    tvgInput.setAttribute('aria-expanded', 'false');
    const combo = el('div', 'settings-chan-combo');
    combo.setAttribute('role', 'listbox');
    combo.hidden = true;
    const epgField = el('div', 'settings-field');
    const epgLabel = el('span', 'settings-field-label', 'EPG-Zuweisung (tvg-id) ');
    epgLabel.appendChild(epgBadge);
    epgField.appendChild(epgLabel);
    const comboWrap = el('div', 'settings-chan-combo-wrap');
    comboWrap.appendChild(tvgInput);
    comboWrap.appendChild(combo);
    epgField.appendChild(comboWrap);
    const tvgErr = fieldError('tvgId');
    if (tvgErr) epgField.appendChild(tvgErr);
    wrap.appendChild(epgField);

    function updateEpgBadge() {
      const index = getEpgIndex();
      const value = draft.tvgId.trim();
      epgBadge.className = 'settings-chan-epg';
      if (!index) {
        epgBadge.textContent = '(EPG nicht geladen)';
      } else if (value && index.has(normEpgId(value))) {
        epgBadge.textContent = '✓ EPG gefunden';
        epgBadge.classList.add('ok');
      } else {
        epgBadge.textContent = '✗ kein EPG-Eintrag';
        epgBadge.classList.add('missing');
      }
    }

    function closeCombo() {
      combo.hidden = true;
      tvgInput.setAttribute('aria-expanded', 'false');
    }

    // Fokus zurück ins Feld, ohne dass das Focus-Ereignis die Liste erneut öffnet.
    let suppressOpen = false;
    function focusInputClosed() {
      suppressOpen = true;
      tvgInput.focus();
      suppressOpen = false;
    }

    function pick(channelId) {
      draft.tvgId = channelId;
      tvgInput.value = channelId;
      updateEpgBadge();
      closeCombo();
      focusInputClosed();
    }

    function renderCombo() {
      const list = getEpgChannelList();
      combo.innerHTML = '';
      const q = draft.tvgId.toLowerCase().trim();
      const matched = q ? list.filter(e => e.normId.includes(q) || e.channelId.toLowerCase().includes(q)) : list;
      if (!list.length) {
        combo.appendChild(el('div', 'settings-chan-combo-empty', 'EPG nicht geladen – erst EPG aktualisieren'));
      } else if (!matched.length) {
        combo.appendChild(el('div', 'settings-chan-combo-empty', 'Keine EPG-Treffer'));
      }
      matched.slice(0, COMBO_LIMIT).forEach(entry => {
        const item = el('button', 'settings-chan-combo-item', entry.channelId);
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.title = entry.sampleTitle || '';
        item.addEventListener('mousedown', e => e.preventDefault());
        item.addEventListener('click', () => pick(entry.channelId));
        combo.appendChild(item);
      });
      if (matched.length > COMBO_LIMIT) {
        combo.appendChild(el('div', 'settings-chan-combo-empty', `… und ${matched.length - COMBO_LIMIT} weitere`));
      }
      combo.hidden = false;
      tvgInput.setAttribute('aria-expanded', 'true');
    }

    tvgInput.addEventListener('focus', () => {
      if (!suppressOpen) renderCombo();
    });
    // Liste schließen, sobald der Fokus das Combobox-Feld samt Liste verlässt.
    comboWrap.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!comboWrap.contains(window.document.activeElement)) closeCombo();
      }, 150);
    });
    tvgInput.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        if (combo.hidden) renderCombo();
        const first = combo.querySelector('.settings-chan-combo-item');
        if (first) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === 'Escape' && !combo.hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeCombo();
      }
    });
    combo.addEventListener('keydown', e => {
      const items = [...combo.querySelectorAll('.settings-chan-combo-item')];
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && idx < items.length - 1) {
        e.preventDefault();
        items[idx + 1].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) items[idx - 1].focus();
        else tvgInput.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeCombo();
        focusInputClosed();
      }
    });
    updateEpgBadge();

    // Logo
    const logoInput = textInput('tvgLogo', draft.tvgLogo, 'https://… (leer = Original)');
    const preview = el('img', 'settings-chan-logo-preview');
    preview.alt = '';
    preview.loading = 'lazy';
    preview.addEventListener('error', () => {
      preview.removeAttribute('src');
      preview.hidden = true;
    });
    function updatePreview() {
      const safe = overrideLogoUrl(draft.tvgLogo);
      if (safe) {
        preview.src = safe;
        preview.hidden = false;
      } else {
        preview.removeAttribute('src');
        preview.hidden = true;
      }
    }
    updatePreview();
    const logoField = labelled('Logo-URL', logoInput, 'tvgLogo');
    logoField.appendChild(preview);
    wrap.appendChild(logoField);

    // URL-Überschreibung
    const urlBox = el('div', 'settings-chan-urlbox');
    const originalRow = el('div', 'settings-chan-original');
    originalRow.appendChild(el('span', 'settings-field-label', 'Original-URL'));
    const originalCode = el('code', '', original);
    originalCode.title = original;
    originalRow.appendChild(originalCode);
    urlBox.appendChild(originalRow);
    const toggleLabel = el('label', 'tv-mode-label');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = draft.urlEnabled;
    toggle.dataset.field = 'urlEnabled';
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(document.createTextNode(' Eigene Stream-URL verwenden'));
    urlBox.appendChild(toggleLabel);
    const urlInput = textInput('url', draft.url, 'https://…');
    const urlRow = el('div', 'settings-chan-urlrow');
    urlRow.hidden = !draft.urlEnabled;
    urlRow.appendChild(urlInput);
    const resetBtn = el('button', 'settings-action-btn', 'Auf Original zurücksetzen');
    resetBtn.type = 'button';
    resetBtn.dataset.action = 'reset-url';
    urlRow.appendChild(resetBtn);
    urlBox.appendChild(urlRow);
    const urlErr = fieldError('url');
    if (urlErr) urlBox.appendChild(urlErr);
    toggle.addEventListener('change', () => {
      draft.urlEnabled = toggle.checked;
      if (draft.urlEnabled && !draft.url) draft.url = original;
      urlInput.value = draft.url;
      urlRow.hidden = !draft.urlEnabled;
    });
    resetBtn.addEventListener('click', () => {
      draft.urlEnabled = false;
      draft.url = original;
      urlInput.value = original;
      toggle.checked = false;
      urlRow.hidden = true;
    });
    wrap.appendChild(urlBox);

    const actions = el('div', 'settings-tv-actions');
    const save = el('button', 'modal-btn modal-btn-save', 'Speichern');
    save.type = 'submit';
    const cancel = el('button', 'settings-action-btn', 'Abbrechen');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.addEventListener('click', () => {
      state.open = null;
      setStatus('');
      render();
    });
    actions.appendChild(save);
    actions.appendChild(cancel);
    wrap.appendChild(actions);
    wrap.addEventListener('submit', e => {
      e.preventDefault();
      saveDetail(ch);
    });
    // Escape im Detailbereich wird lokal behandelt (die Einstellungen bleiben offen):
    // ohne Änderungen schließt es den Bereich, mit ungespeicherten Änderungen bleibt der
    // Entwurf erhalten und ein Hinweis erscheint (kein stiller Datenverlust).
    wrap.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (JSON.stringify(open.draft) === open.initial) {
        state.open = null;
        setStatus('');
        state.restoreFocus = { key: channelKey(ch.sourceId, ch.id), action: 'edit' };
        render();
      } else {
        setStatus('Ungespeicherte Änderungen – speichern oder mit „Abbrechen“ verwerfen', true);
      }
    });
    return wrap;
  }

  // ── Liste ──

  function buildRow(ch, ctx) {
    const { sourcesMap, multiSource, canReorder } = ctx;
    const source = sourcesMap.get(ch.sourceId);
    const key = channelKey(ch.sourceId, ch.id);
    const label = ch.name || ch.tvgId || ch.id;
    const row = el('div', 'settings-chan-row');
    row.setAttribute('role', 'listitem');
    row.dataset.key = key;
    row.dataset.channelId = ch.id;
    const isOpen = state.open && state.open.key === key;
    if (isOpen) row.classList.add('open');

    const head = el('div', 'settings-chan-head');

    const logo = el('img', 'settings-chan-logo');
    logo.alt = '';
    logo.loading = 'lazy';
    logo.decoding = 'async';
    const logoSrc = displayLogoUrl(ch);
    // Fehlgeschlagene Logos: Platzhalter statt Broken-Image-Symbol.
    logo.addEventListener('error', () => {
      logo.removeAttribute('src');
      logo.classList.add('empty');
    });
    if (logoSrc) logo.src = logoSrc;
    else logo.classList.add('empty');
    head.appendChild(logo);

    const info = el('div', 'settings-chan-info');
    const nameLine = el('div', 'settings-chan-name');
    if (multiSource && source) {
      const dot = el('span', 'settings-chan-dot');
      dot.style.background = safeColor(source.color, '#a78bfa');
      dot.title = source.name;
      nameLine.appendChild(dot);
    }
    nameLine.appendChild(document.createTextNode(ch.name || '(ohne Namen)'));
    info.appendChild(nameLine);

    const meta = el('div', 'settings-chan-meta');
    const index = getEpgIndex();
    const epgOk = Boolean(index && ch.tvgId && index.has(normEpgId(ch.tvgId)));
    const epg = el('span', `settings-chan-epg ${epgOk ? 'ok' : 'missing'}`, epgOk ? '✓ EPG' : '✗ EPG');
    epg.title = ch.tvgId ? `tvg-id: ${ch.tvgId}` : 'Keine tvg-id';
    meta.appendChild(epg);
    meta.appendChild(el('span', 'settings-chan-tvgid', ch.tvgId || 'keine tvg-id'));
    if (ch.group) meta.appendChild(el('span', 'settings-chan-group', ch.group));
    const ov = (source && source.channelOverrides && source.channelOverrides[ch.id]) || null;
    if (ov && typeof ov.url === 'string' && ov.url) meta.appendChild(el('span', 'settings-chan-badge warn', 'URL überschrieben'));
    else if (ov && Object.keys(ov).length) meta.appendChild(el('span', 'settings-chan-badge', 'angepasst'));
    info.appendChild(meta);
    head.appendChild(info);

    const actions = el('div', 'settings-chan-actions');
    const fav = isFav(ch, sourcesMap);
    const star = el('button', `settings-chan-fav${fav ? ' active' : ''}`, fav ? '★' : '☆');
    star.type = 'button';
    star.dataset.action = 'fav';
    star.setAttribute('aria-pressed', String(fav));
    star.setAttribute('aria-label', `${label}: ${fav ? 'aus Favoriten entfernen' : 'zu Favoriten hinzufügen'}`);
    star.addEventListener('click', () => toggleFavorite(ch));
    actions.appendChild(star);

    if (state.view === 'favorites') {
      const pos = visibleFavoritePosition((source && source.favorites) || [], ch.id, visibleIdsOf(ch.sourceId));
      const mk = (action, symbol, label, delta, disabled) => {
        const b = el('button', 'settings-chan-move', symbol);
        b.type = 'button';
        b.dataset.action = action;
        b.setAttribute('aria-label', `${label}: ${label}`);
        if (disabled) b.disabled = true;
        else b.addEventListener('click', () => moveFav(ch, delta, action));
        return b;
      };
      actions.appendChild(mk('up', '↑', 'in der Reihenfolge nach oben', -1, !canReorder || pos.index <= 0));
      actions.appendChild(mk('down', '↓', 'in der Reihenfolge nach unten', 1, !canReorder || pos.index === -1 || pos.index >= pos.count - 1));
      const handle = el('span', 'settings-chan-drag', '⠿');
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Zum Umsortieren ziehen';
      handle.draggable = canReorder;
      if (canReorder) {
        handle.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', key);
          e.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        handle.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          listHost.querySelectorAll('.drag-over').forEach(n => n.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', e => {
          e.preventDefault();
          row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
          e.preventDefault();
          row.classList.remove('drag-over');
          const dragged = e.dataTransfer.getData('text/plain');
          if (dragged) dropFav(dragged, ch);
        });
      }
      actions.appendChild(handle);
    }

    const edit = el('button', 'settings-action-btn', isOpen ? 'Schließen' : 'Bearbeiten');
    edit.type = 'button';
    edit.dataset.action = 'edit';
    edit.setAttribute('aria-expanded', String(Boolean(isOpen)));
    edit.setAttribute('aria-label', `${label}: ${isOpen ? 'Bearbeiten schließen' : 'bearbeiten'}`);
    edit.addEventListener('click', () => toggleDetail(ch));
    actions.appendChild(edit);
    head.appendChild(actions);
    row.appendChild(head);

    if (isOpen) row.appendChild(buildDetail(ch));
    return row;
  }

  function renderSources() {
    sourcesHost.innerHTML = '';
    const sources = getSources();
    if (sources.length < 2) return;
    sources.forEach(src => {
      const active = !state.selected || state.selected.has(src.id);
      const pill = el('button', `settings-chan-pill${active ? ' active' : ''}`, src.name);
      pill.type = 'button';
      pill.setAttribute('aria-pressed', String(active));
      pill.addEventListener('click', () => {
        const next = new Set(state.selected || sources.map(s => s.id));
        if (next.has(src.id)) next.delete(src.id);
        else next.add(src.id);
        if (!next.size) sources.forEach(s => next.add(s.id));
        state.selected = next.size === sources.length ? null : next;
        state.page = 0;
        render();
      });
      sourcesHost.appendChild(pill);
    });
  }

  function renderPager(info) {
    pagerHost.innerHTML = '';
    if (info.pages <= 1) return;
    const prev = el('button', 'settings-action-btn', '‹ Zurück');
    prev.type = 'button';
    prev.disabled = info.page === 0;
    prev.addEventListener('click', () => {
      state.page = info.page - 1;
      render();
    });
    const next = el('button', 'settings-action-btn', 'Weiter ›');
    next.type = 'button';
    next.disabled = info.page >= info.pages - 1;
    next.addEventListener('click', () => {
      state.page = info.page + 1;
      render();
    });
    pagerHost.appendChild(prev);
    pagerHost.appendChild(el('span', 'settings-chan-pageinfo', `Seite ${info.page + 1} von ${info.pages}`));
    pagerHost.appendChild(next);
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    const rowEl = active.closest('.settings-chan-row');
    return {
      key: rowEl ? rowEl.dataset.key : null,
      action: active.dataset.action || null,
      field: active.dataset.field || null,
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
      inList: listHost.contains(active),
    };
  }

  function restoreFocus(saved) {
    if (state.restoreFocus) {
      const { key, action } = state.restoreFocus;
      state.restoreFocus = null;
      const row = [...listHost.children].find(r => r.dataset.key === key);
      const btn = row && row.querySelector(`[data-action="${action}"]:not(:disabled)`);
      if (btn) {
        btn.focus();
        return;
      }
      if (row) {
        const fallback = row.querySelector('[data-action="fav"]');
        if (fallback) fallback.focus();
      }
      return;
    }
    if (state.focusDetail) {
      state.focusDetail = false;
      const first = listHost.querySelector('.settings-chan-detail [data-field="name"]');
      if (first) first.focus();
      return;
    }
    if (!saved || !saved.inList) return;
    let target = null;
    const row = [...listHost.children].find(r => r.dataset.key === saved.key);
    if (row && saved.field) target = row.querySelector(`[data-field="${saved.field}"]`);
    else if (row && saved.action) target = row.querySelector(`[data-action="${saved.action}"]:not(:disabled)`);
    if (target) {
      target.focus();
      if (saved.start !== null && typeof target.setSelectionRange === 'function') {
        try {
          target.setSelectionRange(saved.start, saved.end);
        } catch {
          /* Eingabetyp ohne Selektion */
        }
      }
    }
  }

  function render() {
    if (!isVisible()) return;
    const t0 = Date.now();
    const saved = captureFocus();
    const sourcesMap = sourcesById();
    const sources = getSources();
    const channels = getChannels();
    const items = currentItems();
    // Nach dem Verschieben über eine Seitengrenze die Seite des verschobenen Senders anzeigen.
    if (state.restoreFocus) {
      const at = items.findIndex(c => channelKey(c.sourceId, c.id) === state.restoreFocus.key);
      if (at !== -1) state.page = Math.floor(at / PAGE_SIZE);
    }
    const info = paginate(items, state.page, PAGE_SIZE);
    state.page = info.page;

    // Ein geöffneter Sender, der nicht mehr existiert, schließt den Detailbereich.
    if (state.open && !channels.some(c => channelKey(c.sourceId, c.id) === state.open.key)) state.open = null;

    viewAllBtn.setAttribute('aria-pressed', String(state.view === 'all'));
    viewFavBtn.setAttribute('aria-pressed', String(state.view === 'favorites'));
    viewAllBtn.classList.toggle('active', state.view === 'all');
    viewFavBtn.classList.toggle('active', state.view === 'favorites');
    renderSources();

    const noQuery = !state.query.trim();
    const ctx = { sourcesMap, multiSource: sources.length > 1, canReorder: noQuery };
    listHost.innerHTML = '';
    if (!sources.length) {
      listHost.appendChild(el('div', 'service-list-empty', 'Keine TV-Quellen konfiguriert. Quellen verwaltest du unter „Quellen“.'));
    } else if (!channels.length) {
      listHost.appendChild(el('div', 'service-list-empty', 'Keine Sender geladen.'));
    } else if (!items.length) {
      listHost.appendChild(
        el('div', 'service-list-empty', state.view === 'favorites' && noQuery ? 'Keine Favoriten vorhanden.' : 'Keine Sender gefunden.'),
      );
    }
    const fragment = document.createDocumentFragment();
    info.items.forEach(ch => fragment.appendChild(buildRow(ch, ctx)));
    listHost.appendChild(fragment);
    if (state.view === 'favorites' && !noQuery && items.length) {
      countEl.textContent = `${info.total} Treffer – Umsortieren ist während der Suche deaktiviert`;
    } else {
      countEl.textContent = `${info.total} Sender`;
    }
    if (state.view === 'favorites' && noQuery && info.pages > 1) {
      countEl.textContent += ' – Drag&Drop gilt nur innerhalb einer Seite, über Seitengrenzen die Pfeil-Buttons nutzen';
    }
    renderPager(info);
    restoreFocus(saved);
    state.renderMs = Date.now() - t0;
  }

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    state.page = 0;
    render();
  });
  viewAllBtn.addEventListener('click', () => {
    state.view = 'all';
    state.page = 0;
    render();
  });
  viewFavBtn.addEventListener('click', () => {
    state.view = 'favorites';
    state.page = 0;
    render();
  });

  return { render, getState: () => state };
}

module.exports = { createTvChannelsView, PAGE_SIZE };
