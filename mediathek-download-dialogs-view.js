'use strict';

// Dialoge der Mediathek-Downloads: „Download-Optionen“ (eine Folge, mit Vorschau aus downloads:plan), Auswahlliste für Serien
// („n Folgen laden“) und die Rückfrage beim Löschen. Alle Dialoge: Fokusfalle, Esc schließt, Fokus kehrt zurück, Texte der Sender
// nur per textContent. Logik liegt in mediathek-download-options-model.js und mediathek-download-select-model.js.

const options = require('./mediathek-download-options-model.js');
const selectModel = require('./mediathek-download-select-model.js');
const { entryForIpc } = require('./mediathek-hub-model.js');
const { subtitleText } = require('./mediathek-format.js');
const { el, button } = require('./mediathek-cards.js');

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Gemeinsames Gerüst: Hintergrund, Dialog, Esc, Tab-Falle; liefert { dialog, close }. */
function openModal(host, { labelledBy, className = '', trigger = null, onClose = null }) {
  const doc = host.ownerDocument || document;
  const backdrop = el(doc, 'div', 'mediathek-modal');
  const dialog = el(doc, 'div', `mediathek-dialog ${className}`.trim());
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', labelledBy);
  backdrop.appendChild(dialog);
  let closed = false;
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
    if (onClose) onClose();
  }
  backdrop.addEventListener('mousedown', event => {
    if (event.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = [...backdrop.querySelectorAll(FOCUSABLE)];
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  (doc.body || host).appendChild(backdrop); // außerhalb der Ansicht, damit der Hintergrund auch die Navigationsleiste abdunkelt
  return { dialog, close, backdrop, isOpen: () => !closed };
}

function field(doc, id, labelText, choices, value, onChange) {
  const wrap = el(doc, 'label', 'mediathek-form-row');
  wrap.setAttribute('for', id);
  const select = el(doc, 'select', 'mediathek-player-select mediathek-form-select');
  select.id = id;
  for (const choice of choices) {
    const option = el(doc, 'option', '', choice.label);
    option.value = choice.value;
    select.appendChild(option);
  }
  select.value = String(value);
  if (select.value !== String(value)) select.selectedIndex = 0;
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(el(doc, 'span', 'mediathek-form-label', labelText), select);
  return wrap;
}

function titleBlock(doc, text, id, sub) {
  const nodes = [];
  const title = el(doc, 'h2', 'mediathek-dialog-title', text);
  title.id = id;
  nodes.push(title);
  if (sub) nodes.push(el(doc, 'p', 'mediathek-dialog-meta', sub));
  return nodes;
}

/**
 * ctx: { api (window.downloads), getSettings() -> Download-Einstellungen, announce(text), say(text) (sichtbare Meldung), onChanged(), host (Element für Dialoge),
 *        getFreeBytes() }
 */
function createMediathekDownloadDialogs(ctx) {
  const host = ctx.host;
  const doc = host.ownerDocument || document;
  let current = null; // offener Dialog { close }

  const closeCurrent = () => {
    if (current) current.close({ restoreFocus: false });
    current = null;
  };

  // ── Rückfrage beim Löschen ──
  function confirmDelete(item) {
    closeCurrent();
    return new Promise(resolve => {
      let result = { confirmed: false, deleteFile: true };
      const modal = openModal(host, { labelledBy: 'mediathekDlConfirmTitle', className: 'mediathek-dialog-small', trigger: doc.activeElement, onClose: () => resolve(result) });
      current = modal;
      const { dialog } = modal;
      dialog.append(...titleBlock(doc, 'Download löschen?', 'mediathekDlConfirmTitle'));
      dialog.appendChild(el(doc, 'p', 'mediathek-dialog-desc', `„${item.title}“ wird aus der Bibliothek entfernt.`));
      const row = el(doc, 'label', 'mediathek-check-row');
      const box = el(doc, 'input');
      box.type = 'checkbox';
      box.checked = true;
      box.id = 'mediathekDlConfirmFile';
      row.append(box, el(doc, 'span', '', 'Datei auch von der Festplatte löschen'));
      dialog.appendChild(row);
      const actions = el(doc, 'div', 'mediathek-actions');
      const cancel = button(doc, 'mediathek-btn', 'Abbrechen', () => modal.close());
      cancel.id = 'mediathekDlConfirmCancel';
      const ok = button(doc, 'mediathek-btn mediathek-btn-danger', 'Löschen', () => {
        result = { confirmed: true, deleteFile: box.checked };
        modal.close();
      });
      ok.id = 'mediathekDlConfirmOk';
      actions.append(ok, cancel);
      dialog.appendChild(actions);
      cancel.focus();
    });
  }

  // ── Download-Optionen (eine Folge) ──
  function openOptions({ entry, series = null, trigger = null }) {
    closeCurrent();
    const settings = ctx.getSettings() || {};
    const form = options.initialOverrides(settings);
    let preview = null; // Ergebnis von downloads:plan
    let loading = true;
    let submitting = false;
    let submitError = null;
    let token = 0;
    const modal = openModal(host, { labelledBy: 'mediathekDlOptionsTitle', className: 'mediathek-dialog-options', trigger, onClose: () => (token += 1) });
    current = modal;
    const { dialog } = modal;

    async function plan() {
      token += 1;
      const mine = token;
      loading = true;
      render();
      let result;
      try {
        result = await ctx.api.plan(entryForIpc(entry), options.overridesForRequest(form), series || undefined);
      } catch (error) {
        result = { ok: false, message: (error && error.message) || 'Die Vorschau ist nicht möglich.' };
      }
      if (mine !== token || !modal.isOpen()) return;
      preview = result;
      loading = false;
      render();
    }

    async function submit() {
      const view = options.previewOf(preview);
      if (submitting || !view.canDownload) return;
      submitting = true;
      submitError = null;
      render();
      let result;
      try {
        result = await ctx.api.enqueue({ entry: entryForIpc(entry), series: series || undefined, overrides: options.overridesForRequest(form) });
      } catch (error) {
        result = { ok: false, message: (error && error.message) || 'Der Download konnte nicht gestartet werden.' };
      }
      submitting = false;
      if (!modal.isOpen()) return;
      if (result && result.ok) {
        modal.close();
        current = null;
        ctx.announce(`${entry.title} zur Warteschlange hinzugefügt`);
        ctx.onChanged();
      } else {
        submitError = (result && result.message) || 'Der Download konnte nicht gestartet werden.';
        render();
      }
    }

    function render() {
      const hadFocus = dialog.contains(doc.activeElement) ? doc.activeElement.id : '';
      dialog.textContent = '';
      const closeBtn = button(doc, 'mediathek-dialog-close', '×', () => modal.close(), 'Schließen');
      dialog.appendChild(closeBtn);
      dialog.append(...titleBlock(doc, 'Download-Optionen', 'mediathekDlOptionsTitle', [entry.title, subtitleText(entry)].filter(Boolean).join(' · ')));

      const available = preview && preview.available ? preview.available : null;
      const lists = options.choices(available, form);
      const set = key => value => {
        form[key] = value;
        plan();
      };
      const grid = el(doc, 'div', 'mediathek-form');
      grid.append(
        field(doc, 'mediathekDlOptHeight', 'Qualität', lists.maxHeight, form.maxHeight, set('maxHeight')),
        field(doc, 'mediathekDlOptContainer', 'Container', lists.container, form.container, set('container')),
        field(doc, 'mediathekDlOptAudio', 'Tonspuren', lists.audioMode, form.audioMode, set('audioMode')),
        field(doc, 'mediathekDlOptAd', 'Audiodeskription', lists.audioDescription, form.audioDescription, set('audioDescription')),
        field(doc, 'mediathekDlOptSubs', 'Untertitel', lists.subtitleMode, form.subtitleMode, set('subtitleMode')),
        field(doc, 'mediathekDlOptSubsDelivery', 'Untertitel-Ablage', lists.subtitleDelivery, form.subtitleDelivery, set('subtitleDelivery')),
      );
      dialog.appendChild(grid);
      const info = options.availabilityText(available);
      if (available) {
        const lines = el(doc, 'p', 'mediathek-form-note');
        lines.textContent = [info.audio, info.subtitles].filter(Boolean).join(' · ');
        dialog.appendChild(lines);
      }

      const box = el(doc, 'div', 'mediathek-preview');
      box.id = 'mediathekDlPreview';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      box.setAttribute('aria-busy', String(loading));
      const view = options.previewOf(preview);
      if (loading) {
        const spin = el(doc, 'span', 'mediathek-spinner');
        spin.setAttribute('aria-hidden', 'true');
        box.append(spin, el(doc, 'span', '', 'Vorschau wird berechnet …'));
      } else if (view.blocking) {
        box.appendChild(el(doc, 'p', `mediathek-dialog-hint ${view.kind === 'error' ? 'is-unavailable' : 'is-geo'}`, view.blocking));
      } else {
        const list = el(doc, 'dl', 'mediathek-preview-list');
        for (const row of view.rows) list.append(el(doc, 'dt', '', row.label), el(doc, 'dd', '', row.value));
        box.appendChild(list);
      }
      dialog.appendChild(box);
      for (const warning of loading ? [] : view.warnings) dialog.appendChild(el(doc, 'p', 'mediathek-dialog-hint is-geo', warning));
      if (submitError) {
        const error = el(doc, 'p', 'mediathek-dialog-hint is-unavailable', submitError);
        error.setAttribute('role', 'alert');
        dialog.appendChild(error);
      }

      const actions = el(doc, 'div', 'mediathek-actions');
      const go = button(doc, 'mediathek-btn mediathek-btn-primary', submitting ? 'Wird hinzugefügt …' : 'Herunterladen', submit);
      go.id = 'mediathekDlOptionsGo';
      go.disabled = loading || submitting || !view.canDownload;
      actions.append(go, button(doc, 'mediathek-btn', 'Abbrechen', () => modal.close()));
      dialog.appendChild(actions);
      const again = hadFocus && dialog.querySelector(`#${hadFocus}`);
      if (again && !again.disabled) again.focus();
    }

    render();
    plan();
    const first = dialog.querySelector('#mediathekDlOptHeight');
    if (first) first.focus();
    return modal;
  }

  /** Ein-Klick: ohne Dialog einreihen (Einstellung „Optionen-Dialog überspringen“). */
  async function quickDownload({ entry, series = null }) {
    let result;
    try {
      result = await ctx.api.enqueue({ entry: entryForIpc(entry), series: series || undefined, overrides: {} });
    } catch (error) {
      result = { ok: false, message: (error && error.message) || 'Der Download konnte nicht gestartet werden.' };
    }
    if (result && result.ok) {
      ctx.announce(`${entry.title} zur Warteschlange hinzugefügt`);
      ctx.onChanged();
    } else {
      ctx.say(`Download nicht möglich: ${(result && result.message) || 'Unbekannter Fehler'}`);
    }
    return result;
  }

  /** Einstieg „Herunterladen“ bei einer Folge: Dialog oder Ein-Klick je nach Einstellung. */
  function startEpisode({ entry, series = null, trigger = null }) {
    if (options.shouldSkipDialog(ctx.getSettings())) return quickDownload({ entry, series });
    openOptions({ entry, series, trigger });
    return Promise.resolve(null);
  }

  // ── Serien-Auswahl ──
  function openSelection({ series, seasons, stateOf, mode = 'all', trigger = null, onSubmitted = null }) {
    closeCurrent();
    const settings = ctx.getSettings() || {};
    const form = options.initialOverrides(settings);
    const selection = selectModel.createSelection({ seasons, stateOf, maxHeight: form.maxHeight });
    selection.preselect(mode);
    let submitting = false;
    let message = null;
    const modal = openModal(host, { labelledBy: 'mediathekDlSelectTitle', className: 'mediathek-dialog-select', trigger });
    current = modal;
    const { dialog } = modal;

    async function submit() {
      const ids = selection.ids();
      if (submitting || !ids.length) return;
      submitting = true;
      message = null;
      render();
      let result;
      try {
        result = await ctx.api.enqueueMany({ series, entryIds: ids, overrides: { maxHeight: form.maxHeight } });
      } catch (error) {
        result = { ok: false, message: (error && error.message) || 'Die Folgen konnten nicht eingereiht werden.' };
      }
      submitting = false;
      if (!modal.isOpen()) return;
      const text = selectModel.resultText(result);
      if (result && result.ok && result.added > 0) {
        modal.close();
        current = null;
        ctx.announce(text);
        ctx.onChanged();
        if (onSubmitted) onSubmitted(result);
      } else {
        message = text;
        render();
      }
    }

    function rowFor(row) {
      const id = `mediathekDlSel-${row.entry.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
      const li = el(doc, 'li', `mediathek-select-row${row.selectable ? '' : ' is-disabled'}`);
      li.dataset.entryId = row.entry.id;
      const label = el(doc, 'label', 'mediathek-check-row');
      label.setAttribute('for', id);
      const box = el(doc, 'input');
      box.type = 'checkbox';
      box.id = id;
      box.checked = row.selected;
      box.disabled = !row.selectable;
      box.dataset.entryId = row.entry.id;
      box.addEventListener('change', () => {
        selection.toggle(row.entry.id);
        render();
      });
      const text = el(doc, 'span', 'mediathek-select-text');
      text.append(el(doc, 'span', 'mediathek-card-title', row.entry.title));
      const stateText = { done: 'Bereits geladen', running: 'Wird geladen', queued: 'In der Warteschlange', paused: 'Angehalten', scheduled: 'Zurückgestellt' }[row.state];
      const sub = [subtitleText(row.entry), stateText].filter(Boolean).join(' · ');
      if (sub) text.appendChild(el(doc, 'span', 'mediathek-card-sub', sub));
      label.append(box, text);
      li.appendChild(label);
      return li;
    }

    function render() {
      const hadFocus = dialog.contains(doc.activeElement) ? doc.activeElement.id : '';
      const scroll = dialog.querySelector('.mediathek-select-scroll');
      const scrollTop = scroll ? scroll.scrollTop : 0;
      dialog.textContent = '';
      dialog.appendChild(button(doc, 'mediathek-dialog-close', '×', () => modal.close(), 'Schließen'));
      dialog.append(...titleBlock(doc, 'Folgen laden', 'mediathekDlSelectTitle', series.title));

      const tools = el(doc, 'div', 'mediathek-select-tools');
      const all = button(doc, 'mediathek-btn', 'Alle wählen', () => {
        selection.selectAll();
        render();
      });
      all.id = 'mediathekDlSelAll';
      const none = button(doc, 'mediathek-btn', 'Keine', () => {
        selection.clear();
        render();
      });
      none.id = 'mediathekDlSelNone';
      tools.append(all, none, field(doc, 'mediathekDlSelHeight', 'Qualität', options.choices(null, form).maxHeight, form.maxHeight, value => {
        form.maxHeight = value;
        selection.setMaxHeight(value);
        render();
      }));
      dialog.appendChild(tools);

      const scrollBox = el(doc, 'div', 'mediathek-select-scroll');
      for (const season of seasons) {
        const section = el(doc, 'section', 'mediathek-select-season');
        const sid = `mediathekDlSeason-${season.number === null ? 'x' : season.number}`;
        const head = el(doc, 'label', 'mediathek-check-row mediathek-select-season-head');
        head.setAttribute('for', sid);
        const state = selection.seasonState(season.number);
        const box = el(doc, 'input');
        box.type = 'checkbox';
        box.id = sid;
        box.checked = state === 'on';
        box.indeterminate = state === 'some';
        box.disabled = state === 'none';
        box.addEventListener('change', () => {
          selection.toggleSeason(season.number);
          render();
        });
        head.append(box, el(doc, 'span', 'mediathek-season-title', season.number === null ? 'Weitere Folgen' : `Staffel ${season.number}`));
        const list = el(doc, 'ul', 'mediathek-select-list');
        selection.rows.filter(row => row.season === season.number).forEach(row => list.appendChild(rowFor(row)));
        section.append(head, list);
        scrollBox.appendChild(section);
      }
      dialog.appendChild(scrollBox);

      const free = ctx.getFreeBytes();
      const totals = selection.totals(free);
      const line = el(doc, 'p', 'mediathek-select-totals', selectModel.totalsText(totals, free));
      line.id = 'mediathekDlSelTotals';
      line.setAttribute('role', 'status');
      line.setAttribute('aria-live', 'polite');
      dialog.appendChild(line);
      if (totals.enoughSpace === false) dialog.appendChild(el(doc, 'p', 'mediathek-dialog-hint is-geo', 'Der freie Platz reicht voraussichtlich nicht. Wähle weniger Folgen oder eine niedrigere Qualität.'));
      if (totals.unknownSize > 0 && totals.count > 0) dialog.appendChild(el(doc, 'p', 'mediathek-form-note', `Bei ${totals.unknownSize} ${totals.unknownSize === 1 ? 'Folge' : 'Folgen'} ist die Dauer unbekannt; die Größe ist darin nicht enthalten.`));
      if (message) {
        const error = el(doc, 'p', 'mediathek-dialog-hint is-unavailable', message);
        error.setAttribute('role', 'alert');
        dialog.appendChild(error);
      }
      const actions = el(doc, 'div', 'mediathek-actions');
      const go = button(doc, 'mediathek-btn mediathek-btn-primary', submitting ? 'Wird hinzugefügt …' : selectModel.submitLabel(totals.count), submit);
      go.id = 'mediathekDlSelGo';
      go.disabled = submitting || totals.count === 0;
      actions.append(go, button(doc, 'mediathek-btn', 'Abbrechen', () => modal.close()));
      dialog.appendChild(actions);

      const newScroll = dialog.querySelector('.mediathek-select-scroll');
      if (newScroll) newScroll.scrollTop = scrollTop;
      const again = hadFocus && dialog.querySelector(`#${CSS.escape(hadFocus)}`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }

    render();
    const first = dialog.querySelector('#mediathekDlSelGo:not(:disabled)') || dialog.querySelector('#mediathekDlSelAll');
    if (first) first.focus();
    return modal;
  }

  return { confirmDelete, openOptions, openSelection, quickDownload, startEpisode, close: closeCurrent, isOpen: () => Boolean(current && current.isOpen()) };
}

module.exports = { createMediathekDownloadDialogs, openModal, field, titleBlock };
