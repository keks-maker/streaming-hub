'use strict';

// Einstellungen → Podcasts → Abos (P4): Liste in der gespeicherten Reihenfolge (subscriptionRank), Reihenfolge ändern
// (Drag & Drop oder ▲▼), Abbestellen mit Bestätigung, Anpassung von Name und Cover (Cover nur nach Prüfung im Main:
// Zieladresse und Bild), Fehlerstatus je Abo und „Jetzt aktualisieren“. Alle Feed-Daten per textContent. Logik:
// settings-podcast-subs-model.js; Ziehgriff/Pfeile: settings-reorder-dom.js.

const model = require('./settings-podcast-subs-model.js');
const { el, statusLine, setStatus, labelledField, textInput, button, focusNode, findAll, formatIpcError } = require('./settings-radio-dom.js');
const { attachDragReorder, createMoveButtons } = require('./settings-reorder-dom.js');
const { createCover } = require('./podcast-cover-view.js');
const { initialOf } = require('./podcast-format.js');

function createPodcastSubsView(root, { podcasts, logger = null, now = () => Date.now() } = {}) {
  const doc = root.ownerDocument || document;
  const state = {
    subs: [],
    loaded: false,
    refreshing: false,
    confirmRemove: null, // Abo-ID
    form: null, // { id, values, errors, busy }
    restoreFocus: null, // { id, action } | { field }
    serialized: '',
  };

  const toolbar = el(doc, 'div', 'settings-chan-toolbar');
  const summaryEl = el(doc, 'span', 'settings-chan-count');
  summaryEl.id = 'settingsPodcastSubsSummary';
  const refreshBtn = button(doc, 'settings-action-btn', 'Jetzt aktualisieren', 'refresh');
  refreshBtn.id = 'settingsPodcastSubsRefresh';
  toolbar.append(refreshBtn, summaryEl);
  const hint = el(doc, 'p', 'settings-field-hint', 'Die Reihenfolge gilt im Podcast-Dashboard unter „Meine Abos“. Ziehe einen Eintrag am Griff oder nutze die Pfeil-Knöpfe.');
  const listEl = el(doc, 'div', 'settings-chan-list');
  listEl.id = 'settingsPodcastSubsList';
  listEl.setAttribute('role', 'list');
  const emptyEl = el(doc, 'p', 'settings-field-hint', 'Noch keine Abos. Podcasts findest du im Podcast-Bereich über „Podcasts suchen“; eigene Feeds fügst du unter „Eigene Feeds“ hinzu.');
  emptyEl.id = 'settingsPodcastSubsEmpty';
  const statusEl = statusLine(doc, 'settingsPodcastSubsStatus');
  root.textContent = '';
  root.append(toolbar, hint, listEl, emptyEl, statusEl);

  const fail = (error, fallback) => {
    setStatus(statusEl, formatIpcError(error) || fallback, true);
    render();
  };

  function setSubs(next) {
    if (!Array.isArray(next)) return;
    // Ereignis nach dem eigenen Speichern liefert denselben Stand: nicht neu zeichnen (Fokus bleibt)
    const serialized = JSON.stringify(next);
    if (state.loaded && serialized === state.serialized) return;
    state.serialized = serialized;
    state.subs = next;
    state.loaded = true;
    if (state.confirmRemove && !next.some(sub => sub.id === state.confirmRemove)) state.confirmRemove = null;
    if (state.form && !next.some(sub => sub.id === state.form.id)) state.form = null;
    render();
  }

  async function refresh() {
    try {
      setSubs(await podcasts.list());
    } catch (error) {
      if (logger) logger.warn('Podcast-Einstellungen: Abos konnten nicht geladen werden', error && error.message);
      setStatus(statusEl, 'Abos konnten nicht geladen werden', true);
    }
  }

  async function saveOrder(order, focus) {
    if (!order) return;
    state.restoreFocus = focus || null;
    try {
      setSubs(await podcasts.reorder({ order }));
      setStatus(statusEl, '✓ Reihenfolge gespeichert');
    } catch (error) {
      fail(error, 'Reihenfolge konnte nicht gespeichert werden');
    }
  }

  async function unsubscribe(sub) {
    state.confirmRemove = null;
    try {
      await podcasts.unsubscribe(sub.id);
      setSubs(await podcasts.list());
      setStatus(statusEl, `✓ „${sub.title}“ abbestellt`);
      state.restoreFocus = { field: 'list' };
      render();
    } catch (error) {
      fail(error, 'Abbestellen nicht möglich');
    }
  }

  async function refreshAll() {
    if (state.refreshing) return;
    state.refreshing = true;
    setStatus(statusEl, 'Abos werden geprüft …');
    render();
    try {
      const result = await podcasts.refresh({ force: true });
      await refresh();
      if (result && result.ok === false) setStatus(statusEl, result.error || 'Aktualisierung nicht möglich', true);
      else {
        const failed = result && result.failed ? result.failed : 0;
        setStatus(statusEl, failed ? `Geprüft, ${failed} ${failed === 1 ? 'Abo hat' : 'Abos haben'} einen Fehler.` : '✓ Alle Abos geprüft');
      }
    } catch (error) {
      setStatus(statusEl, formatIpcError(error) || 'Aktualisierung nicht möglich', true);
    } finally {
      state.refreshing = false;
      render();
    }
  }

  // ── Anpassung (Name, Cover) ──

  function openForm(sub) {
    const overrides = sub.overrides || {};
    state.form = { id: sub.id, values: { title: overrides.title || '', cover: overrides.cover || '' }, errors: {}, busy: false, focusField: 'title' };
    render();
  }

  function closeForm(restore) {
    state.form = null;
    state.restoreFocus = restore || null;
    render();
  }

  async function submitForm() {
    const form = state.form;
    if (!form || form.busy) return;
    const sub = state.subs.find(entry => entry.id === form.id);
    if (!sub) return closeForm();
    const { values, errors } = model.validateOverrideForm(form.values);
    form.values = values;
    form.errors = errors;
    const patch = Object.keys(errors).length ? null : model.overridePatch(sub, values);
    if (Object.keys(errors).length) {
      form.focusField = errors.title ? 'title' : 'cover';
      render();
      return;
    }
    if (!patch) return closeForm({ id: sub.id, action: 'edit' });
    form.busy = true;
    setStatus(statusEl, patch.cover ? 'Cover wird geprüft …' : 'Wird gespeichert …');
    render();
    try {
      await podcasts.setOverride({ id: sub.id, ...patch });
      setSubs(await podcasts.list());
      setStatus(statusEl, '✓ Gespeichert');
      closeForm({ id: sub.id, action: 'edit' });
    } catch (error) {
      form.busy = false;
      const message = formatIpcError(error) || 'Anpassung konnte nicht gespeichert werden';
      if (patch.cover && /Cover/.test(message)) {
        form.errors = { cover: message };
        form.focusField = 'cover';
        setStatus(statusEl, '');
        render();
      } else fail(error, 'Anpassung konnte nicht gespeichert werden');
    }
  }

  async function resetForm() {
    const form = state.form;
    if (!form || form.busy) return;
    form.values = { title: '', cover: '' };
    await submitForm();
  }

  function buildForm(sub) {
    const form = state.form;
    const wrap = el(doc, 'form', 'settings-chan-detail');
    wrap.dataset.id = sub.id;
    wrap.noValidate = true;
    const titleInput = textInput(doc, { field: 'title', value: form.values.title, placeholder: (sub.original && sub.original.title) || sub.title });
    titleInput.id = `settingsPodcastTitle-${sub.id}`;
    titleInput.maxLength = model.MAX_TITLE_LENGTH;
    titleInput.disabled = form.busy;
    const coverInput = textInput(doc, { field: 'cover', value: form.values.cover, placeholder: 'https://… (leer = Cover des Feeds)', type: 'url' });
    coverInput.id = `settingsPodcastCover-${sub.id}`;
    coverInput.disabled = form.busy;
    titleInput.addEventListener('input', () => (form.values.title = titleInput.value));
    coverInput.addEventListener('input', () => (form.values.cover = coverInput.value));
    wrap.append(
      labelledField(doc, 'Anzeigename', titleInput, { error: form.errors.title, idBase: titleInput.id, hint: 'Leer lassen, um den Namen des Feeds zu verwenden.' }),
      labelledField(doc, 'Cover-Adresse', coverInput, {
        error: form.errors.cover,
        idBase: coverInput.id,
        hint: 'Das Bild wird über den Main-Prozess geprüft und geladen (keine internen Adressen).',
      }),
    );
    const actions = el(doc, 'div', 'settings-chan-actions');
    const save = button(doc, 'modal-btn modal-btn-save', form.busy ? 'Wird geprüft …' : 'Speichern', 'save');
    save.type = 'submit';
    save.disabled = form.busy;
    const reset = button(doc, 'settings-action-btn', 'Zurücksetzen', 'reset');
    reset.disabled = form.busy || !(sub.overrides && (sub.overrides.title || sub.overrides.cover));
    reset.addEventListener('click', resetForm);
    const cancel = button(doc, 'settings-action-btn', 'Abbrechen', 'cancel');
    cancel.disabled = form.busy;
    cancel.addEventListener('click', () => closeForm({ id: sub.id, action: 'edit' }));
    actions.append(save, reset, cancel);
    wrap.appendChild(actions);
    wrap.addEventListener('submit', event => {
      event.preventDefault();
      submitForm();
    });
    return wrap;
  }

  // ── Zeilen ──

  function buildRow(sub, index, order) {
    const row = el(doc, 'div', 'settings-chan-row settings-podcast-row');
    row.setAttribute('role', 'listitem');
    row.dataset.id = sub.id;
    row.dataset.custom = String(model.isCustom(sub));
    const head = el(doc, 'div', 'settings-chan-head');
    attachDragReorder(doc, {
      row,
      parent: head,
      key: sub.id,
      listEl,
      onDrop: (dragged, target) => saveOrder(model.dropOn(order, dragged, target), { id: dragged, action: 'up' }),
    });
    const cover = createCover(doc, { podcasts, className: 'settings-podcast-cover' });
    cover.update({ url: sub.cover, initial: initialOf(sub.title) });
    head.appendChild(cover.element);

    const info = el(doc, 'div', 'settings-chan-info');
    const name = el(doc, 'div', 'settings-chan-name');
    name.appendChild(el(doc, 'span', 'settings-podcast-name', sub.title));
    if (sub.overrides && (sub.overrides.title || sub.overrides.cover)) {
      const badge = el(doc, 'span', 'settings-chan-badge', 'angepasst');
      badge.title = 'Name oder Cover wurden von dir geändert';
      name.appendChild(badge);
    }
    info.appendChild(name);
    const meta = el(doc, 'div', 'settings-chan-meta');
    if (sub.author) meta.appendChild(el(doc, 'span', '', sub.author));
    meta.appendChild(el(doc, 'span', '', model.sourceLabel(sub)));
    const status = model.feedStatus(sub, now());
    const statusNode = el(doc, 'span', `settings-podcast-feedstatus ${status.kind}`, status.text);
    if (status.kind === 'error') statusNode.setAttribute('role', 'note');
    meta.appendChild(statusNode);
    info.appendChild(meta);
    head.appendChild(info);

    const actions = el(doc, 'div', 'settings-chan-actions');
    createMoveButtons(doc, {
      parent: actions,
      name: sub.title,
      canUp: index > 0,
      canDown: index < order.length - 1,
      onMove: delta => saveOrder(model.moveId(order, sub.id, delta), { id: sub.id, action: delta < 0 ? 'up' : 'down' }),
    });
    const edit = button(doc, 'settings-action-btn', 'Anpassen', 'edit');
    edit.setAttribute('aria-label', `${sub.title}: Name und Cover anpassen`);
    edit.setAttribute('aria-expanded', String(Boolean(state.form && state.form.id === sub.id)));
    edit.addEventListener('click', () => (state.form && state.form.id === sub.id ? closeForm({ id: sub.id, action: 'edit' }) : openForm(sub)));
    actions.appendChild(edit);
    if (state.confirmRemove === sub.id) {
      const sure = button(doc, 'settings-action-btn settings-danger-btn', 'Wirklich abbestellen', 'confirm-remove');
      sure.setAttribute('aria-label', `${sub.title}: endgültig abbestellen`);
      sure.addEventListener('click', () => unsubscribe(sub));
      const keep = button(doc, 'settings-action-btn', 'Behalten', 'cancel-remove');
      keep.addEventListener('click', () => {
        state.confirmRemove = null;
        state.restoreFocus = { id: sub.id, action: 'remove' };
        render();
      });
      actions.append(sure, keep);
    } else {
      const remove = button(doc, 'settings-action-btn settings-danger-btn', 'Abbestellen', 'remove');
      remove.setAttribute('aria-label', `${sub.title}: abbestellen`);
      remove.addEventListener('click', () => {
        state.confirmRemove = sub.id;
        state.restoreFocus = { id: sub.id, action: 'confirm-remove' };
        render();
      });
      actions.appendChild(remove);
    }
    head.appendChild(actions);
    row.appendChild(head);
    if (state.form && state.form.id === sub.id) row.appendChild(buildForm(sub));
    return row;
  }

  function applyFocus() {
    const target = state.restoreFocus;
    state.restoreFocus = null;
    if (state.form && state.form.focusField) {
      const field = state.form.focusField;
      state.form.focusField = null;
      focusNode(findAll(listEl, node => node.dataset && node.dataset.field === field)[0]);
      return;
    }
    if (!target) return;
    if (target.field === 'list') {
      focusNode(findAll(root, node => node.dataset && node.dataset.action === 'refresh')[0]);
      return;
    }
    const row = findAll(listEl, node => node.dataset && node.dataset.id === target.id && node.classList.contains('settings-podcast-row'))[0];
    if (!row) return;
    let node = findAll(row, n => n.dataset && n.dataset.action === target.action && !n.disabled)[0];
    if (!node) node = findAll(row, n => n.dataset && n.dataset.action && !n.disabled)[0]; // z. B. ▲ am Listenanfang: nächster Knopf
    focusNode(node);
  }

  function render() {
    const order = model.idsOf(state.subs);
    listEl.textContent = '';
    state.subs.forEach((sub, index) => listEl.appendChild(buildRow(sub, index, order)));
    emptyEl.hidden = !state.loaded || state.subs.length > 0;
    listEl.hidden = state.subs.length === 0;
    summaryEl.textContent = state.loaded ? model.summary(state.subs) : '';
    refreshBtn.disabled = state.refreshing || state.subs.length === 0;
    refreshBtn.textContent = state.refreshing ? 'Wird geprüft …' : 'Jetzt aktualisieren';
    applyFocus();
  }

  refreshBtn.addEventListener('click', refreshAll);
  const unsubscribers = [];
  if (typeof podcasts.onSubscriptionsChanged === 'function') unsubscribers.push(podcasts.onSubscriptionsChanged(list => setSubs(list)));
  if (typeof podcasts.onRefreshed === 'function') unsubscribers.push(podcasts.onRefreshed(() => refresh()));

  return {
    refresh,
    render,
    getState: () => state,
    dispose: () => unsubscribers.forEach(off => typeof off === 'function' && off()),
  };
}

module.exports = { createPodcastSubsView };
