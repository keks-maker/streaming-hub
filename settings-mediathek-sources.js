'use strict';

// Einstellungen ▸ Mediatheken ▸ Quellen: ARD, ZDF und arte ein-/ausblenden (Speichern über mediathek:set-settings).
// Die Weblink-Mediatheken (Hinzufügen/Bearbeiten) bleiben in der bestehenden Dienste-Verwaltung derselben Seite.

const { el, statusLine, setStatus, formatIpcError } = require('./settings-radio-dom.js');

const SOURCES = [
  { id: 'ard', label: 'ARD Mediathek', hint: 'Sendungen und Serien der ARD-Sender.' },
  { id: 'zdf', label: 'ZDF Mediathek', hint: 'Sendungen und Serien des ZDF.' },
  { id: 'arte', label: 'arte', hint: 'Filme, Dokumentationen und Genres von arte.' },
];

function createMediathekSourcesView(root, { mediathek, logger = null } = {}) {
  const doc = root.ownerDocument || document;
  const checks = new Map();
  const host = el(doc, 'div', 'settings-row settings-row-stack');
  for (const source of SOURCES) {
    const label = el(doc, 'label', 'tv-mode-label');
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.id = `settingsMediathekSource-${source.id}`;
    input.dataset.source = source.id;
    label.append(input, el(doc, 'span', '', ` ${source.label}`));
    const hint = el(doc, 'p', 'settings-field-hint', source.hint);
    hint.id = `${input.id}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    host.append(label, hint);
    checks.set(source.id, input);
    input.addEventListener('change', () => save(source.id, input));
  }
  const statusEl = statusLine(doc, 'settingsMediathekSourcesStatus');
  root.textContent = '';
  root.append(host, statusEl);

  function show(settings) {
    for (const [id, input] of checks) input.checked = !settings || !settings.sources || settings.sources[id] !== false;
  }

  async function save(id, input) {
    const wanted = input.checked;
    try {
      const result = await mediathek.setSettings({ sources: { [id]: wanted } });
      show(result.settings);
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      input.checked = !wanted;
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  async function refresh() {
    try {
      const result = await mediathek.getSettings();
      show(result && result.settings);
      setStatus(statusEl, '');
    } catch (error) {
      if (logger) logger.warn('Mediathek-Quellen konnten nicht geladen werden:', error && error.message ? error.message : error);
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  return { refresh, show };
}

module.exports = { createMediathekSourcesView, SOURCES };
