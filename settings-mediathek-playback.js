'use strict';

// Einstellungen ▸ Mediatheken ▸ Wiedergabe: bevorzugte Qualität, Sprache der Tonspur und Untertitel automatisch.
// Die Vorgaben gelten, soweit der Stream die Auswahl anbietet (HLS: Stufen, Tonspuren, Untertitel); im Player jederzeit änderbar.

const { el, statusLine, setStatus, formatIpcError } = require('./settings-radio-dom.js');

const FIELDS = [
  {
    key: 'quality',
    label: 'Bevorzugte Qualität',
    hint: 'Höchste Stufe bis zu dieser Höhe. „Automatisch“ passt sich der Verbindung an. Bei Beiträgen ohne Stufen (MP4) gibt es keine Auswahl.',
    options: [
      { value: 'auto', label: 'Automatisch' },
      { value: '1080', label: 'Bis 1080p' },
      { value: '720', label: 'Bis 720p' },
      { value: '540', label: 'Bis 540p (sparsam)' },
    ],
  },
  {
    key: 'audioLanguage',
    label: 'Bevorzugte Sprache',
    hint: 'Welche Tonspur zuerst gewählt wird, wenn ein Beitrag mehrere hat (zum Beispiel bei arte). Audiodeskription wird nicht automatisch gewählt.',
    options: [
      { value: 'de', label: 'Deutsch' },
      { value: 'original', label: 'Originalsprache' },
    ],
  },
  {
    key: 'subtitles',
    label: 'Untertitel automatisch',
    hint: 'Schaltet passende Untertitel beim Start ein, sofern der Beitrag welche anbietet.',
    options: [
      { value: 'off', label: 'Aus' },
      { value: 'de', label: 'Deutsch' },
      { value: 'original', label: 'Originalsprache' },
    ],
  },
];

function createMediathekPlaybackView(root, { mediathek, logger = null } = {}) {
  const doc = root.ownerDocument || document;
  const controls = new Map();
  root.textContent = '';
  for (const field of FIELDS) {
    const row = el(doc, 'label', 'tv-mode-label');
    const select = el(doc, 'select');
    select.id = `settingsMediathek-${field.key}`;
    select.dataset.field = field.key;
    for (const option of field.options) {
      const item = el(doc, 'option', '', option.label);
      item.value = option.value;
      select.appendChild(item);
    }
    row.append(el(doc, 'span', '', `${field.label}: `), select);
    const hint = el(doc, 'p', 'settings-field-hint', field.hint);
    hint.id = `${select.id}-hint`;
    select.setAttribute('aria-describedby', hint.id);
    root.append(row, hint);
    controls.set(field.key, select);
    select.addEventListener('change', () => save(field.key, select));
  }
  const statusEl = statusLine(doc, 'settingsMediathekPlaybackStatus');
  root.appendChild(statusEl);
  let current = null;

  function show(settings) {
    current = settings;
    for (const field of FIELDS) {
      const value = settings && settings[field.key];
      controls.get(field.key).value = field.options.some(option => option.value === value) ? value : field.options[0].value;
    }
  }

  async function save(key, select) {
    try {
      const result = await mediathek.setSettings({ [key]: select.value });
      show(result.settings);
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      select.value = current && current[key] ? current[key] : FIELDS.find(field => field.key === key).options[0].value;
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  async function refresh() {
    try {
      const result = await mediathek.getSettings();
      show(result && result.settings);
      setStatus(statusEl, '');
    } catch (error) {
      if (logger) logger.warn('Mediathek-Wiedergabe konnte nicht geladen werden:', error && error.message ? error.message : error);
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  return { refresh, show };
}

module.exports = { createMediathekPlaybackView, FIELDS };
