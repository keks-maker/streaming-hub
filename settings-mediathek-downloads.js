'use strict';

// Einstellungen ▸ Mediatheken ▸ Downloads: fünf Unterseiten (Ablage, Qualität, Ton & Untertitel, Steuerung, Hinweise) nach dem
// Muster von settings-mediathek-playback.js. Jede Änderung wird sofort über downloads:settings-set gespeichert; Werte, die der
// Main begrenzt hat, und Fehler (z. B. nicht nutzbarer Speicherort) erscheinen direkt am Feld.

const model = require('./settings-mediathek-downloads-model.js');
const { el, statusLine, setStatus, formatIpcError } = require('./settings-radio-dom.js');

/**
 * roots: { storage, quality, audio, control, notes } (Elemente der Unterseiten); options: { downloads (window.downloads), logger, onSaved(settings) }
 */
function createMediathekDownloadsSettings(roots, { downloads, logger = null, onSaved = null } = {}) {
  const controls = new Map(); // key -> { type, node(s) }
  const notes = new Map(); // key -> Element (Hinweis am Feld)
  const statuses = {};
  let current = null;

  function note(key, text, isError = false) {
    const node = notes.get(key);
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('error', Boolean(isError));
  }

  function status(page, text, isError = false) {
    if (statuses[page]) setStatus(statuses[page], text, isError);
  }

  function describedBy(control, ...nodes) {
    control.setAttribute('aria-describedby', nodes.filter(Boolean).map(node => node.id).join(' '));
  }

  async function save(page, patch, keyForNote) {
    try {
      const result = await downloads.setSettings(patch);
      if (!result || result.ok === false) {
        const message = (result && (result.error || result.message)) || 'Die Einstellung wurde nicht gespeichert.';
        if (keyForNote) note(keyForNote, message, true);
        status(page, message, true);
        show(current);
        return null;
      }
      show(result);
      const clamps = model.clampMessages(result);
      for (const key of Object.keys(patch)) note(key, clamps[key] || '');
      status(page, Object.keys(clamps).length ? '✓ Gespeichert, ein Wert wurde angepasst' : '✓ Gespeichert');
      if (onSaved) onSaved(result);
      return result;
    } catch (error) {
      const message = formatIpcError(error);
      if (keyForNote) note(keyForNote, message, true);
      status(page, message, true);
      show(current);
      return null;
    }
  }

  function hintFor(doc, id, text) {
    const hint = el(doc, 'p', 'settings-field-hint', text || '');
    hint.id = id;
    hint.hidden = !text;
    return hint;
  }

  function noteNode(doc, key, id) {
    const node = el(doc, 'p', 'settings-field-note');
    node.id = id;
    node.setAttribute('role', 'status');
    notes.set(key, node);
    return node;
  }

  function buildSelect(doc, page, field, root) {
    const id = `settingsDl-${field.key}`;
    const row = el(doc, 'label', 'tv-mode-label');
    const select = el(doc, 'select');
    select.id = id;
    select.dataset.field = field.key;
    for (const option of field.options) {
      const item = el(doc, 'option', '', option.label);
      item.value = option.value;
      select.appendChild(item);
    }
    row.append(el(doc, 'span', '', `${field.label}: `), select);
    const hint = hintFor(doc, `${id}-hint`, field.hint);
    describedBy(select, hint);
    root.append(row, hint);
    select.addEventListener('change', () => save(page, { [field.key]: select.value }, field.key));
    controls.set(field.key, { type: 'select', select });
  }

  function buildToggle(doc, page, field, root) {
    const id = `settingsDl-${field.key}`;
    const row = el(doc, 'label', 'tv-mode-label settings-check-row');
    const box = el(doc, 'input');
    box.type = 'checkbox';
    box.id = id;
    box.dataset.field = field.key;
    row.append(box, el(doc, 'span', '', field.label));
    const hint = hintFor(doc, `${id}-hint`, field.hint);
    describedBy(box, hint);
    root.append(row, hint);
    box.addEventListener('change', () => save(page, { [field.key]: box.checked }, field.key));
    controls.set(field.key, { type: 'toggle', box });
  }

  function buildNumber(doc, page, field, root) {
    const id = `settingsDl-${field.key}`;
    const row = el(doc, 'label', 'tv-mode-label');
    const input = el(doc, 'input', 'settings-number-input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.id = id;
    input.dataset.field = field.key;
    input.size = 8;
    row.append(el(doc, 'span', '', `${field.label}: `), input);
    if (field.unit) row.append(el(doc, 'span', 'settings-unit', ` ${field.unit}`));
    const hint = hintFor(doc, `${id}-hint`, field.hint);
    const message = noteNode(doc, field.key, `${id}-note`);
    describedBy(input, hint, message);
    root.append(row, hint, message);
    const commit = () => {
      const value = model.parseNumber(input.value);
      if (value === null) {
        note(field.key, 'Bitte eine Zahl eingeben.', true);
        show(current);
        return;
      }
      save(page, { [field.key]: value }, field.key);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    controls.set(field.key, { type: 'number', input });
  }

  function buildScheme(doc, page, field, root) {
    const id = `settingsDl-${field.key}`;
    const row = el(doc, 'label', 'tv-mode-label');
    const input = el(doc, 'input', 'settings-wide-input');
    input.type = 'text';
    input.id = id;
    input.maxLength = 120;
    input.dataset.field = field.key;
    input.spellcheck = false;
    row.append(el(doc, 'span', '', `${field.label}: `), input);
    const preview = el(doc, 'p', 'settings-field-hint settings-scheme-preview');
    preview.id = `${id}-preview`;
    const hint = hintFor(doc, `${id}-hint`, field.hint);
    const message = noteNode(doc, field.key, `${id}-note`);
    describedBy(input, preview, hint, message);
    root.append(row, preview, hint, message);
    input.addEventListener('input', () => {
      preview.textContent = `Beispiel: ${model.schemePreview(input.value)}.mp4`;
    });
    input.addEventListener('change', async () => {
      const typed = input.value.trim();
      const result = await save(page, { fileNameScheme: typed }, field.key);
      if (result && result.fileNameScheme !== typed) note(field.key, `Ungültiges Schema (nur bekannte Platzhalter, keine Pfadzeichen). Es gilt: ${result.fileNameScheme}`, true);
    });
    controls.set(field.key, { type: 'scheme', input, preview });
  }

  function buildLanguages(doc, page, field, root) {
    const group = el(doc, 'div', 'settings-language-slots');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', field.label);
    const selects = [];
    for (let index = 0; index < model.SLOT_COUNT; index += 1) {
      const row = el(doc, 'label', 'tv-mode-label');
      const select = el(doc, 'select');
      select.id = `settingsDl-${field.key}-${index}`;
      select.dataset.field = `${field.key}-${index}`;
      for (const option of model.languageOptions(index > 0)) {
        const item = el(doc, 'option', '', option.label);
        item.value = option.value;
        select.appendChild(item);
      }
      row.append(el(doc, 'span', '', index === 0 ? 'Hauptsprache: ' : `${index + 1}. Sprache: `), select);
      select.addEventListener('change', () => save(page, { audioLanguages: model.languagesFromSlots(selects.map(item => item.value)) }, field.key));
      selects.push(select);
      group.appendChild(row);
    }
    const hint = hintFor(doc, `settingsDl-${field.key}-hint`, field.hint);
    root.append(el(doc, 'p', 'settings-field-label', field.label), group, hint);
    controls.set(field.key, { type: 'languages', selects });
  }

  function buildRoot(doc, page, field, root) {
    const id = 'settingsDl-storageRoot';
    const row = el(doc, 'div', 'settings-root-row');
    const label = el(doc, 'label', 'settings-field-label', `${field.label}:`);
    label.setAttribute('for', id);
    const input = el(doc, 'input', 'settings-wide-input');
    input.type = 'text';
    input.id = id;
    input.dataset.field = 'storageRoot';
    input.spellcheck = false;
    input.maxLength = 1000;
    const pick = el(doc, 'button', 'settings-btn', 'Wählen …');
    pick.type = 'button';
    pick.id = 'settingsDlPickRoot';
    const apply = el(doc, 'button', 'settings-btn', 'Übernehmen');
    apply.type = 'button';
    apply.id = 'settingsDlApplyRoot';
    const reset = el(doc, 'button', 'settings-btn', 'Standard');
    reset.type = 'button';
    reset.id = 'settingsDlResetRoot';
    row.append(input, pick, apply, reset);
    const message = noteNode(doc, 'storageRoot', `${id}-note`);
    const hint = hintFor(doc, `${id}-hint`, 'Standard ist der Unterordner „Mediathek“ im Speicherort der Aufnahmen. Auch Netzwerkordner sind möglich. Bereits geladene Folgen bleiben im bisherigen Ordner.');
    describedBy(input, hint, message);
    root.append(label, row, hint, message);

    async function check() {
      const value = input.value.trim();
      if (!value) {
        note('storageRoot', 'Bitte einen Ordner angeben.', true);
        return null;
      }
      let result;
      try {
        result = await downloads.validateRoot(value);
      } catch (error) {
        note('storageRoot', formatIpcError(error), true);
        return null;
      }
      const text = model.rootCheckText(result);
      note('storageRoot', text.text, !text.ok);
      return text.ok ? value : null;
    }

    apply.addEventListener('click', async () => {
      const value = await check();
      if (value) {
        const result = await save(page, { storageRoot: value }, 'storageRoot');
        if (result) note('storageRoot', 'Speicherort geändert.');
      }
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        apply.click();
      }
    });
    reset.addEventListener('click', async () => {
      const result = await save(page, { storageRoot: null }, 'storageRoot');
      if (result) note('storageRoot', 'Standard-Speicherort wird verwendet.');
    });
    pick.addEventListener('click', async () => {
      let picked;
      try {
        picked = await downloads.pickFolder();
      } catch (error) {
        note('storageRoot', formatIpcError(error), true);
        return;
      }
      if (!picked || !picked.root) return;
      input.value = picked.root;
      apply.click();
    });
    controls.set('storageRoot', { type: 'root', input });
  }

  function buildNotice(doc, field, root) {
    const box = el(doc, 'div', 'settings-notice');
    box.setAttribute('role', 'note');
    box.appendChild(el(doc, 'h5', 'settings-notice-title', field.title));
    field.paragraphs.forEach(text => box.appendChild(el(doc, 'p', 'settings-notice-text', text)));
    root.appendChild(box);
  }

  function buildInfo(doc, field, root) {
    root.append(el(doc, 'p', 'settings-field-label', field.label), el(doc, 'p', 'settings-field-hint', field.text));
  }

  for (const [page, root] of Object.entries(roots)) {
    if (!root) continue;
    const doc = root.ownerDocument || document;
    root.textContent = '';
    for (const field of model.PAGES[page].fields) {
      if (field.type === 'select') buildSelect(doc, page, field, root);
      else if (field.type === 'toggle') buildToggle(doc, page, field, root);
      else if (field.type === 'number') buildNumber(doc, page, field, root);
      else if (field.type === 'scheme') buildScheme(doc, page, field, root);
      else if (field.type === 'languages') buildLanguages(doc, page, field, root);
      else if (field.type === 'root') buildRoot(doc, page, field, root);
      else if (field.type === 'notice') buildNotice(doc, field, root);
      else if (field.type === 'info') buildInfo(doc, field, root);
    }
    statuses[page] = statusLine(doc, `settingsMediathekDl-${page}-status`);
    root.appendChild(statuses[page]);
  }

  /** Alle Felder mit den gespeicherten Werten füllen (Antwort von downloads:settings-get/-set). */
  function show(settings) {
    if (!settings) return;
    current = settings;
    for (const [key, control] of controls) {
      if (control.type === 'select') {
        const value = String(settings[key]);
        control.select.value = [...control.select.options].some(option => option.value === value) ? value : control.select.options[0].value;
      } else if (control.type === 'toggle') control.box.checked = Boolean(settings[key]);
      else if (control.type === 'number') control.input.value = String(settings[key] ?? '');
      else if (control.type === 'scheme') {
        control.input.value = settings[key] || '';
        control.preview.textContent = `Beispiel: ${model.schemePreview(control.input.value)}.mp4`;
      } else if (control.type === 'root') control.input.value = settings.effectiveStorageRoot || '';
      else if (control.type === 'languages') {
        const slots = model.languageSlots(settings.audioLanguages);
        control.selects.forEach((select, index) => {
          select.value = slots[index];
        });
      }
    }
  }

  async function refresh() {
    try {
      const result = await downloads.getSettings();
      show(result);
      for (const page of Object.keys(statuses)) status(page, '');
      for (const key of notes.keys()) note(key, '');
    } catch (error) {
      if (logger) logger.warn('Download-Einstellungen konnten nicht geladen werden:', error && error.message ? error.message : error);
      for (const page of Object.keys(statuses)) status(page, formatIpcError(error), true);
    }
  }

  return { refresh, show };
}

module.exports = { createMediathekDownloadsSettings };
