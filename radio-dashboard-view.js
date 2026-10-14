// Radio-Dashboard (R2): Werkzeugleiste „Senderverwaltung“, Statuszeile, Kachelraster der Favoriten
// (globale Reihenfolge) und Leerzustand. Alle Sender-/Nutzerdaten werden ausschließlich per textContent
// bzw. als Bild-URL (img.src) gesetzt, kein innerHTML. Daten und Steuerung laufen über window.radio.
// Die Verdrahtung (Link-Ziel der Senderverwaltung, Toast, Sichtbarkeit) liegt in renderer.js.

'use strict';

const { radioDashboardModel, popularFavoriteKeys, refreshSummaryText } = require('./radio-dashboard-model.js');

const ICON_MANAGE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/></svg>';
const ICON_REFRESH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>';
const EQ_BARS = 4;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tileId(tile) {
  return `${tile.sourceId}\u0000${tile.id}`;
}

function createRadioDashboard(root, options = {}) {
  const { radio, onOpenManagement, notify, logger } = options;
  const doc = root.ownerDocument || document;

  // Gerüst: Werkzeugleiste, Raster, Leerzustand
  const toolbar = el(doc, 'div', 'dashboard-hub-toolbar radio-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Radio-Werkzeuge');
  const manage = el(doc, 'button', 'dashboard-hub-tool');
  manage.type = 'button';
  manage.id = 'radioManage';
  manage.title = 'Senderverwaltung';
  const manageIcon = el(doc, 'span');
  manageIcon.setAttribute('aria-hidden', 'true');
  manageIcon.innerHTML = ICON_MANAGE; // statisches SVG, keine Nutzerdaten
  manage.append(manageIcon, el(doc, 'span', 'dashboard-hub-tool-label', 'Senderverwaltung'));
  manage.addEventListener('click', () => onOpenManagement && onOpenManagement());
  const refreshList = el(doc, 'button', 'dashboard-hub-tool');
  refreshList.type = 'button';
  refreshList.id = 'radioRefreshList';
  refreshList.title = 'Stream-Adressen der mitgelieferten Sender beim Senderverzeichnis abgleichen';
  const refreshIcon = el(doc, 'span');
  refreshIcon.setAttribute('aria-hidden', 'true');
  refreshIcon.innerHTML = ICON_REFRESH; // statisches SVG, keine Nutzerdaten
  refreshList.append(refreshIcon, el(doc, 'span', 'dashboard-hub-tool-label', 'Liste aktualisieren'));
  const status = el(doc, 'span', 'radio-status');
  status.id = 'radioStatus';
  status.setAttribute('aria-live', 'polite');
  toolbar.append(manage, refreshList, status);

  const grid = el(doc, 'div', 'dashboard-grid radio-grid');
  grid.id = 'radioGrid';
  grid.setAttribute('aria-label', 'Radio-Favoriten');

  const empty = el(doc, 'div', 'dashboard-empty radio-empty');
  empty.id = 'radioEmpty';
  empty.hidden = true;
  const emptyMessage = el(doc, 'p', 'radio-empty-message');
  const addPopular = el(doc, 'button', 'radio-empty-btn', 'Beliebte Sender hinzufügen');
  addPopular.type = 'button';
  addPopular.id = 'radioAddPopular';
  const emptyHint = el(doc, 'p', 'radio-empty-hint');
  empty.append(emptyMessage, addPopular, emptyHint);

  root.textContent = '';
  root.append(toolbar, grid, empty);

  let sources = [];
  let state = null;
  let loaded = false;
  let renderedKeys = '';
  const tiles = new Map(); // id → { button, name, meta, icon }
  let seq = 0;
  const unsubscribers = [];

  const report = (message, error) => {
    if (logger) logger.warn(`Radio-Dashboard: ${message}`, error && error.message ? error.message : error || '');
    if (notify) notify(message);
  };

  function buildTile(model) {
    const button = el(doc, 'button', 'dashboard-tile radio-tile');
    button.type = 'button';
    button.style.setProperty('--tile-color', '#f59e0b');
    const glow = el(doc, 'span', 'dashboard-tile-glow');
    const icon = el(doc, 'span', 'dashboard-tile-icon');
    const fallback = el(doc, 'span', 'dashboard-tile-fallback', model.initial);
    fallback.setAttribute('aria-hidden', 'true');
    icon.appendChild(fallback);
    if (model.logo) {
      const image = doc.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.src = model.logo;
      image.addEventListener('error', () => {
        image.remove();
        icon.classList.add('has-error');
      });
      icon.appendChild(image);
    } else {
      icon.classList.add('has-error');
    }
    const eq = el(doc, 'span', 'radio-eq');
    eq.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < EQ_BARS; i += 1) eq.appendChild(el(doc, 'span'));
    const content = el(doc, 'span', 'dashboard-tile-content');
    const name = el(doc, 'span', 'dashboard-tile-name', model.name);
    const meta = el(doc, 'span', 'dashboard-tile-meta');
    content.append(name, meta);
    button.append(glow, icon, eq, content);
    button.addEventListener('click', () => onTileClick(button.dataset.sourceId, button.dataset.stationId));
    return { button, meta };
  }

  function patchTile(entry, model) {
    const { button, meta } = entry;
    button.dataset.sourceId = model.sourceId;
    button.dataset.stationId = model.id;
    button.dataset.state = model.state;
    button.dataset.action = model.action;
    button.classList.toggle('is-active', model.active);
    button.classList.toggle('is-error', model.state === 'error');
    button.setAttribute('aria-label', model.ariaLabel);
    if (meta.textContent !== model.meta) meta.textContent = model.meta;
  }

  function currentModel() {
    return radioDashboardModel({ sources, state });
  }

  function render() {
    const model = currentModel();
    status.textContent = loaded ? model.countText : '';
    // Name und Logo gehören zum Schlüssel: Anpassungen aus der Senderverwaltung (R3) bauen die Kachel neu auf
    const keys = model.tiles.map(tile => [tileId(tile), tile.name, tile.logo || ''].join('\u0001')).join('\n');
    empty.hidden = !(loaded && model.empty);
    grid.hidden = model.empty;
    emptyMessage.textContent = model.emptyMessage;
    emptyHint.textContent = model.emptyHint;
    addPopular.hidden = model.popular === 0;
    if (keys !== renderedKeys) {
      // Favoritenliste hat sich geändert: Raster neu aufbauen
      renderedKeys = keys;
      tiles.clear();
      grid.textContent = '';
      model.tiles.forEach(tile => {
        const entry = buildTile(tile);
        tiles.set(tileId(tile), entry);
        grid.appendChild(entry.button);
      });
    }
    model.tiles.forEach(tile => patchTile(tiles.get(tileId(tile)), tile));
    return model;
  }

  async function onTileClick(sourceId, stationId) {
    const tile = currentModel().tiles.find(t => t.sourceId === sourceId && t.id === stationId);
    if (!tile) return;
    try {
      if (tile.action === 'pause') await radio.pause();
      else if (tile.action === 'resume') await radio.play();
      else if (tile.action === 'stop') await radio.stop();
      else await radio.play(tile.key);
    } catch (error) {
      report(`Radio: ${error && error.message ? error.message : 'Wiedergabe nicht möglich'}`, error);
    }
  }

  addPopular.addEventListener('click', async () => {
    const keys = popularFavoriteKeys(sources);
    if (!keys.length) return;
    addPopular.disabled = true;
    try {
      // nacheinander: jede Änderung schreibt die Quellendatei, die Reihenfolge der Liste bleibt erhalten
      for (const key of keys) await radio.setFavorite(key, true);
      await refresh();
    } catch (error) {
      report('Radio: Beliebte Sender konnten nicht hinzugefügt werden', error);
    } finally {
      addPopular.disabled = false;
    }
  });

  refreshList.addEventListener('click', async () => {
    if (refreshList.disabled || typeof radio.refreshStreamUrls !== 'function') return;
    refreshList.disabled = true;
    refreshList.setAttribute('aria-busy', 'true');
    try {
      const result = await radio.refreshStreamUrls();
      if (notify) notify(refreshSummaryText(result));
      if (result && result.ok) await refresh();
    } catch (error) {
      report('Radio: Liste konnte nicht aktualisiert werden', error);
    } finally {
      refreshList.disabled = false;
      refreshList.removeAttribute('aria-busy');
    }
  });

  /** Quellen laden (veraltete Antworten werden verworfen) und anzeigen. */
  async function refresh() {
    const mine = ++seq;
    try {
      const next = await radio.getSources();
      if (mine !== seq) return;
      sources = Array.isArray(next) ? next : [];
      loaded = true;
    } catch (error) {
      if (mine !== seq) return;
      loaded = true;
      report('Radio: Senderliste nicht verfügbar', error);
    }
    render();
  }

  unsubscribers.push(
    radio.onState(next => {
      state = next;
      render();
    }),
    radio.onSourcesChanged(next => {
      seq += 1;
      sources = Array.isArray(next) ? next : sources;
      loaded = true;
      render();
    }),
  );
  Promise.resolve(radio.getState())
    .then(initial => {
      if (!state) state = initial;
      render();
    })
    .catch(() => {});

  function dispose() {
    unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
  }

  render();
  return { render, refresh, dispose, getModel: currentModel };
}

module.exports = { createRadioDashboard };
