'use strict';

// Dialoge der Serien-Abos: „Neue Folgen automatisch laden“ (Auswahl künftige/auch vorhandene Folgen, optional abweichende
// Download-Optionen) und „Abo-Optionen“ (Optionen eines bestehenden Abos). Gerüst, Fokusfalle und Auswahlfelder stammen aus
// mediathek-download-dialogs-view.js; Serientitel nur per textContent.

const options = require('./mediathek-download-options-model.js');
const model = require('./mediathek-subscriptions-model.js');
const { el, button } = require('./mediathek-cards.js');
const { openModal, field, titleBlock } = require('./mediathek-download-dialogs-view.js');

/** Auswahl-Felder für die Optionen des Abos (Vorbelegung: globale Einstellungen, überlagert von den Optionen des Abos). */
function startForm(settings, overrides) {
  const form = {};
  for (const key of options.OVERRIDE_FIELDS) if ((settings || {})[key] !== undefined) form[key] = Array.isArray(settings[key]) ? [...settings[key]] : settings[key];
  return { ...form, ...(overrides || {}) };
}

/** Nur die Felder, die von den globalen Einstellungen abweichen (der Rest folgt weiter den Einstellungen). */
function changedOverrides(settings, form) {
  const current = settings || {};
  const result = {};
  for (const [key, value] of Object.entries(options.overridesForRequest(form))) if (JSON.stringify(value) !== JSON.stringify(current[key])) result[key] = value;
  return result;
}

/**
 * ctx: { host (Element für Dialoge), store (createSubscriptionsStore), getSettings() -> Download-Einstellungen, announce(text), say(text),
 *        selection({ series, seasons, stateOf, mode, trigger, onSubmitted }) (Auswahlliste der Download-Dialoge) }
 */
function createSubscriptionDialogs(ctx) {
  const host = ctx.host;
  const doc = host.ownerDocument || document;
  let current = null;

  const closeCurrent = () => {
    if (current) current.close({ restoreFocus: false });
    current = null;
  };

  function optionFields(form, onChange) {
    const lists = options.choices(null, form);
    const grid = el(doc, 'div', 'mediathek-form');
    const set = key => value => {
      form[key] = value;
      onChange();
    };
    grid.append(
      field(doc, 'mediathekSubOptHeight', 'Qualität', lists.maxHeight, form.maxHeight, set('maxHeight')),
      field(doc, 'mediathekSubOptContainer', 'Container', lists.container, form.container, set('container')),
      field(doc, 'mediathekSubOptAudio', 'Tonspuren', lists.audioMode, form.audioMode, set('audioMode')),
      field(doc, 'mediathekSubOptAd', 'Audiodeskription', lists.audioDescription, form.audioDescription, set('audioDescription')),
      field(doc, 'mediathekSubOptSubs', 'Untertitel', lists.subtitleMode, form.subtitleMode, set('subtitleMode')),
      field(doc, 'mediathekSubOptSubsDelivery', 'Untertitel-Ablage', lists.subtitleDelivery, form.subtitleDelivery, set('subtitleDelivery')),
    );
    return grid;
  }

  function errorLine(text) {
    const line = el(doc, 'p', 'mediathek-dialog-hint is-unavailable', text);
    line.setAttribute('role', 'alert');
    return line;
  }

  /** Abo einrichten. series: die Serie; seasons/stateOf nur für „auch bereits vorhandene Folgen“ (Auswahlliste). */
  function openEnable({ series, seasons = [], stateOf = () => ({ state: 'none' }), trigger = null }) {
    closeCurrent();
    const form = startForm(ctx.getSettings(), {});
    let mode = 'future';
    let custom = false;
    let busy = false;
    let message = null;
    const modal = openModal(host, { labelledBy: 'mediathekSubTitle', className: 'mediathek-dialog-options', trigger });
    current = modal;
    const { dialog } = modal;

    const overrides = () => (custom ? changedOverrides(ctx.getSettings(), form) : {});

    async function create() {
      const result = await ctx.store.add({ series, mode: 'future', overrides: overrides() });
      ctx.announce(model.addResultText(result, series.title));
      if (!result || !result.ok) ctx.say(model.addResultText(result, series.title));
      return result;
    }

    async function submit() {
      if (busy) return;
      if (mode === 'all') {
        // Zuerst die Folgen wählen, die jetzt geladen werden; das Abo (nur Neues) entsteht nach dem Einreihen
        modal.close({ restoreFocus: false });
        current = null;
        ctx.selection({ series, seasons, stateOf, mode: 'all', trigger, onSubmitted: () => create() });
        return;
      }
      busy = true;
      message = null;
      render();
      const result = await create();
      busy = false;
      if (!modal.isOpen()) return;
      if (result && result.ok) {
        modal.close();
        current = null;
      } else {
        message = model.addResultText(result, series.title);
        render();
      }
    }

    function render() {
      const hadFocus = dialog.contains(doc.activeElement) ? doc.activeElement.id : '';
      dialog.textContent = '';
      dialog.appendChild(button(doc, 'mediathek-dialog-close', '×', () => modal.close(), 'Schließen'));
      dialog.append(...titleBlock(doc, 'Neue Folgen automatisch laden', 'mediathekSubTitle', series.title));
      dialog.appendChild(el(doc, 'p', 'mediathek-dialog-desc', 'Die App prüft regelmäßig, ob es neue Folgen gibt, und lädt sie. Das klappt nur, solange die App läuft.'));

      const group = el(doc, 'fieldset', 'mediathek-radio-group');
      group.appendChild(el(doc, 'legend', 'mediathek-form-label', 'Welche Folgen?'));
      for (const option of model.MODE_OPTIONS) {
        const row = el(doc, 'label', 'mediathek-check-row');
        const radio = el(doc, 'input');
        radio.type = 'radio';
        radio.name = 'mediathekSubMode';
        radio.id = `mediathekSubMode-${option.id}`;
        radio.value = option.id;
        radio.checked = mode === option.id;
        radio.addEventListener('change', () => {
          mode = option.id;
          render();
        });
        const text = el(doc, 'span', 'mediathek-select-text');
        text.append(el(doc, 'span', 'mediathek-card-title', option.label), el(doc, 'span', 'mediathek-card-sub', option.hint));
        row.append(radio, text);
        group.appendChild(row);
      }
      dialog.appendChild(group);

      const customRow = el(doc, 'label', 'mediathek-check-row');
      const customBox = el(doc, 'input');
      customBox.type = 'checkbox';
      customBox.id = 'mediathekSubCustom';
      customBox.checked = custom;
      customBox.addEventListener('change', () => {
        custom = customBox.checked;
        render();
      });
      customRow.append(customBox, el(doc, 'span', '', 'Abweichende Download-Optionen für dieses Abo'));
      dialog.appendChild(customRow);
      if (custom) dialog.appendChild(optionFields(form, () => {}));
      else dialog.appendChild(el(doc, 'p', 'mediathek-form-note', 'Es gelten deine globalen Download-Einstellungen.'));

      if (message) dialog.appendChild(errorLine(message));
      const actions = el(doc, 'div', 'mediathek-actions');
      const go = button(doc, 'mediathek-btn mediathek-btn-primary', busy ? 'Wird eingerichtet …' : mode === 'all' ? 'Weiter zur Auswahl' : 'Aktivieren', submit);
      go.id = 'mediathekSubGo';
      go.disabled = busy;
      actions.append(go, button(doc, 'mediathek-btn', 'Abbrechen', () => modal.close()));
      dialog.appendChild(actions);
      const again = hadFocus && dialog.querySelector(`#${CSS.escape(hadFocus)}`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }

    render();
    const first = dialog.querySelector(`#mediathekSubMode-${mode}`);
    if (first) first.focus();
    return modal;
  }

  /** Optionen eines bestehenden Abos ändern. */
  function openOptions({ sub, trigger = null }) {
    closeCurrent();
    const form = startForm(ctx.getSettings(), sub.overrides);
    let busy = false;
    let message = null;
    const modal = openModal(host, { labelledBy: 'mediathekSubOptTitle', className: 'mediathek-dialog-options', trigger });
    current = modal;
    const { dialog } = modal;

    async function save(overrides) {
      if (busy) return;
      busy = true;
      message = null;
      render();
      const result = await ctx.store.update({ id: sub.id, overrides });
      busy = false;
      if (!modal.isOpen()) return;
      if (result && result.ok) {
        modal.close();
        current = null;
        ctx.announce(`Optionen für ${sub.title} gespeichert`);
      } else {
        message = `Die Optionen wurden nicht gespeichert: ${(result && (result.message || result.error)) || 'Unbekannter Fehler'}`;
        render();
      }
    }

    function render() {
      const hadFocus = dialog.contains(doc.activeElement) ? doc.activeElement.id : '';
      dialog.textContent = '';
      dialog.appendChild(button(doc, 'mediathek-dialog-close', '×', () => modal.close(), 'Schließen'));
      dialog.append(...titleBlock(doc, 'Abo-Optionen', 'mediathekSubOptTitle', sub.title));
      dialog.appendChild(el(doc, 'p', 'mediathek-dialog-desc', 'Diese Optionen gelten für alle Folgen, die dieses Abo künftig lädt.'));
      dialog.appendChild(optionFields(form, () => {}));
      if (message) dialog.appendChild(errorLine(message));
      const actions = el(doc, 'div', 'mediathek-actions');
      const go = button(doc, 'mediathek-btn mediathek-btn-primary', busy ? 'Wird gespeichert …' : 'Speichern', () => save(changedOverrides(ctx.getSettings(), form)));
      go.id = 'mediathekSubOptGo';
      go.disabled = busy;
      const reset = button(doc, 'mediathek-btn', 'Standard verwenden', () => save({}));
      reset.id = 'mediathekSubOptReset';
      reset.disabled = busy;
      actions.append(go, reset, button(doc, 'mediathek-btn', 'Abbrechen', () => modal.close()));
      dialog.appendChild(actions);
      const again = hadFocus && dialog.querySelector(`#${CSS.escape(hadFocus)}`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }

    render();
    const first = dialog.querySelector('#mediathekSubOptHeight');
    if (first) first.focus();
    return modal;
  }

  return { openEnable, openOptions, close: closeCurrent, isOpen: () => Boolean(current && current.isOpen()) };
}

module.exports = { createSubscriptionDialogs, startForm, changedOverrides };
