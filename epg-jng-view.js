// „Jetzt & Gleich“ (Etappe 3.5, M7; Umbau auf die Senderkachel S3): je Sender eine Kachel mit laufender Sendung
// (Medienfläche, Titel, „Sender · noch X Min.“, Fortschritt) und den Zeilen „Danach …“ für nächste und übernächste Sendung.
//
// Factory-Muster wie epg-channel-view.js: reine DOM-Sicht ohne Daten- oder Aufnahme-Logik. Die Zuordnung kommt aus
// epg-jng-model.js, den Kachelaufbau liefert epg-jng-tile-dom.js (Komponente aus livetv-tile.js, dieselbe wie die
// LiveTV-Favoriten), Marker/Toggle/Fortschritt je Sendung epg-row-dom.js (updateRowNode wie Liste und Kanalansicht) —
// Planen/Abbrechen/Stoppen läuft über den Callback onToggle (epg-view.js → runToggle, die einzige Aufnehmen-Logik).
//
// Virtualisierung: responsives Raster mit fester Kachelhöhe (Modell: gridLayout), nur die sichtbaren Rasterzeilen plus
// Überstand liegen im DOM. tick() schreibt den Fortschritt fort und baut nur Kacheln neu auf, deren Zuordnung
// (laufend/nächste/übernächste) sich geändert hat. Texte nur per textContent.
//
// Etappe 3.6: Genre-Filter (setGenres) — die Positionen laufend/nächste/übernächste bleiben, nicht passende Zellen entfallen,
// Sender ohne passende Zelle verschwinden. Vorschaubilder: Die schlanken Daten (epg:range-many) tragen kein Bild; für die
// laufende und die „Danach“-Sendungen der SICHTBAREN Kacheln holt getIcons (epg:range je Sender, entprellt) die Bild-URLs. Das Kachelbild lädt der Kachel-Baustein aus dem
// Bild-Cache des Main (epg-image:get), die 64×36-Vorschau der „Danach“-Zeilen lädt kit.loadThumb über denselben Cache (kein Fremdhost im Renderer). Kein Vorab-Laden; fehlt der Bilddienst, bleiben Verlauf bzw. Platzhalter.
// Die stumme Vorschau (Hover/Fokus) gehört dem Kachel-Baustein: eine gleichzeitig.

'use strict';

const jngModel = require('./epg-jng-model.js');
const { updateRowNode } = require('./epg-row-dom.js');
const { h } = require('./epg-dom.js');
const { createTile, fillTile } = require('./epg-jng-tile-dom.js');
const { createLiveTvTileKit } = require('./livetv-tile.js');

const OVERSCAN_PX = 400;
const THUMB_DEBOUNCE_MS = 120;
const EMPTY_FILTERED = 'Keine Sendungen für die gewählten Genres. Wähle „Alle“, um den Filter aufzuheben.';

/**
 * deps: now(), getMarkers(rows) → Marker je Zeile (wie grid.matchMarkers), isSelected(rowId), onOpen(row),
 * onToggle(row, element), onChannelClick(channel), sanitizeLogoUrl(url),
 * tiles (Kachel-Baustein aus livetv-tile.js; ohne wird einer aus sanitizeLogoUrl/getEpgImage gebaut),
 * getEpgImage(url, stopMs) → Promise<data:-URL|null> (nur ohne tiles),
 * getIcons(channelKey, fromMs, toMs) → Promise<Slot[]> (volle Projektion, optional: ohne sind keine Vorschaubilder möglich).
 */
function createJngView(deps) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const kit = deps.tiles
    || createLiveTvTileKit({
      safeResourceUrl: typeof deps.sanitizeLogoUrl === 'function' ? deps.sanitizeLogoUrl : url => url || '',
      getEpgImage: typeof deps.getEpgImage === 'function' ? deps.getEpgImage : () => Promise.resolve(null),
    });
  let allChannels = []; // [{ key, channel, rows, hasEpg }] — alle Sender der Auswahl
  let channels = []; // angezeigte Sender (mit aktivem Genre-Filter nur die mit passender Zelle)
  let assignments = []; // je angezeigtem Kanal { current, next, after }
  let genres = []; // aktiver Genre-Filter (leer = kein Filter)
  let emptyBase = '';
  const icons = new Map(); // Zeilen-ID → Bild-URL ('' = keine/unbrauchbar); nur bis zum nächsten Datenabruf
  let thumbTimer = null;
  let thumbEpoch = 0;
  let nodes = new Map(); // Kanal-Schlüssel → Kachel { el, cells: [entry|null ×3], sig, chan }
  let narrow = false;
  let frame = 0;
  let loadedAt = null;
  let lastWidth = 0;

  const spacer = h('div', { className: 'epg-jng-spacer', id: 'epgJngItems', attrs: { role: 'list', 'aria-label': 'Jetzt und Gleich' } });
  const scroll = h('div', { className: 'epg-jng-scroll', id: 'epgJng', attrs: { tabindex: '0' } }, [spacer]);
  const emptyEl = h('div', { className: 'epg-jng-empty', id: 'epgJngEmpty', attrs: { role: 'status' }, hidden: true });
  const el = h('div', { className: 'epg-jng', hidden: true }, [scroll, emptyEl]);

  function viewportH() {
    return scroll.clientHeight || 600;
  }

  /** Raster bei der aktuellen Breite des Scrollbereichs (im verborgenen Zustand die zuletzt bekannte Breite). */
  function layout() {
    const width = scroll.clientWidth || lastWidth || 1000;
    lastWidth = width;
    return jngModel.gridLayout(width, channels.length);
  }

  function applyHeight() {
    const height = `${layout().totalH}px`;
    if (spacer.style.height !== height) spacer.style.height = height;
  }

  function recompute(nowMs = now()) {
    if (genres.length) {
      channels = [];
      assignments = [];
      for (const channel of allChannels) {
        const assignment = jngModel.assign(channel, nowMs, genres);
        if (!jngModel.hasMatch(assignment)) continue;
        channels.push(channel);
        assignments.push(assignment);
      }
    } else {
      channels = allChannels;
      assignments = channels.map(channel => jngModel.assign(channel, nowMs));
    }
    applyHeight();
    updateEmpty();
  }

  /** Hinweis, solange nichts zu zeigen ist: Ladezustand/kein Programm (epg-view.js) oder „kein Treffer im Genre-Filter“. */
  function updateEmpty() {
    const filteredOut = channels.length === 0 && allChannels.length > 0 && genres.length > 0;
    emptyEl.hidden = channels.length > 0;
    emptyEl.textContent = filteredOut ? EMPTY_FILTERED : emptyBase;
  }

  function removeNode(key) {
    const entry = nodes.get(key);
    if (!entry) return;
    kit.stopPreviewOf(entry.el);
    entry.el.remove();
    nodes.delete(key);
  }

  function render() {
    frame = 0;
    if (el.hidden || !channels.length) {
      if (!channels.length) clearNodes();
      return;
    }
    const nowMs = now();
    const grid = layout();
    applyHeight();
    const top = scroll.scrollTop;
    const { from, to } = jngModel.visibleRange(grid, channels.length, top - OVERSCAN_PX, top + viewportH() + OVERSCAN_PX);
    const wanted = new Set();
    for (let i = from; i < to; i += 1) wanted.add(channels[i].key);
    for (const key of [...nodes.keys()]) if (!wanted.has(key)) removeNode(key);
    const visible = [];
    let j = 0;
    for (let i = from; i < to; i += 1) {
      const channel = channels[i];
      let entry = nodes.get(channel.key);
      if (!entry) {
        entry = createTile(channel, kit);
        entry.chan.addEventListener('click', event => {
          event.stopPropagation();
          if (typeof deps.onChannelClick === 'function') deps.onChannelClick(channel.channel);
        });
        nodes.set(channel.key, entry);
      }
      const pos = jngModel.tilePosition(grid, i);
      entry.el.style.top = `${pos.top}px`;
      entry.el.style.left = `${pos.left}px`;
      entry.el.style.width = `${grid.tileW}px`;
      entry.el.style.height = `${grid.tileH}px`;
      const sig = jngModel.assignmentSig(assignments[i]);
      if (entry.sig !== sig) {
        entry.sig = sig;
        fillTile(entry, channel, assignments[i], { filtered: genres.length > 0, kit });
      }
      for (const cell of entry.cells) if (cell) visible.push(cell);
      const ref = spacer.children[j];
      if (ref !== entry.el) spacer.insertBefore(entry.el, ref || null);
      j += 1;
    }
    if (!visible.length) return;
    const markers = deps.getMarkers(visible.map(cell => cell.row));
    visible.forEach((cell, i) => {
      updateRowNode(cell, cell.row, { nowMs, marker: markers[i] || null, selected: !!(deps.isSelected && deps.isSelected(cell.row.id)) });
    });
    applyThumbs();
    scheduleThumbs();
  }

  // ── Vorschaubilder (nur sichtbare Kacheln): laufende Sendung als Kachelbild (Bild-Cache des Main), „Danach“-Zeilen als 64×36-Vorschau ──

  /** Zellen der Kacheln, die tatsächlich im Viewport stehen (ohne Überstand). */
  function viewportCells() {
    const grid = layout();
    const { from, to } = jngModel.visibleRange(grid, channels.length, scroll.scrollTop, scroll.scrollTop + viewportH());
    const out = [];
    for (let i = from; i < to; i += 1) {
      const entry = nodes.get(channels[i].key);
      if (!entry) continue;
      for (const cell of entry.cells) if (cell) out.push({ key: channels[i].key, cell });
    }
    return out;
  }

  function scheduleThumbs() {
    if (typeof deps.getIcons !== 'function') return;
    clearTimeout(thumbTimer); // entprellt: beim schnellen Scrollen werden nur die Kacheln angefragt, auf denen die Ansicht stehen bleibt
    thumbTimer = setTimeout(loadThumbs, THUMB_DEBOUNCE_MS);
  }

  /** Bild-URLs der sichtbaren Zellen holen (ein epg:range je Sender, Zeitfenster seiner sichtbaren Zellen). */
  function loadThumbs() {
    thumbTimer = null;
    if (el.hidden || typeof deps.getIcons !== 'function') return;
    const epoch = thumbEpoch;
    const wanted = new Map(); // Sender-Schlüssel → { fromMs, toMs, ids }
    for (const { key, cell } of viewportCells()) {
      if (icons.has(cell.row.id)) continue;
      const w = wanted.get(key) || { fromMs: Infinity, toMs: -Infinity, ids: [] };
      w.fromMs = Math.min(w.fromMs, cell.row.start);
      w.toMs = Math.max(w.toMs, cell.row.stop);
      w.ids.push(cell.row);
      wanted.set(key, w);
    }
    for (const [key, w] of wanted) {
      for (const row of w.ids) icons.set(row.id, ''); // Abruf läuft (oder ist gescheitert): nicht erneut anfragen
      Promise.resolve()
        .then(() => deps.getIcons(key, w.fromMs, w.toMs))
        .then(slots => {
          if (epoch !== thumbEpoch) return;
          for (const row of w.ids) {
            const slot = (Array.isArray(slots) ? slots : []).find(s => s && s.start === row.start);
            if (slot && typeof slot.icon === 'string') icons.set(row.id, slot.icon);
          }
          if (!el.hidden) applyThumbs();
        })
        .catch(() => {});
    }
  }

  function applyThumbs() {
    for (const entry of nodes.values()) {
      entry.cells.forEach((cell, i) => {
        if (!cell) return;
        const url = icons.get(cell.row.id);
        if (!url) return;
        if (i === 0) kit.loadImage(entry.el, url, cell.row.stop);
        else kit.loadThumb(cell.refs.thumb, url, cell.row.stop);
      });
    }
  }

  function resetThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = null;
    thumbEpoch += 1;
    icons.clear();
  }

  function scheduleRender() {
    if (!frame) frame = window.requestAnimationFrame(render);
  }

  function clearNodes() {
    for (const key of [...nodes.keys()]) removeNode(key);
    nodes = new Map();
    spacer.textContent = '';
  }

  function findCell(rowId) {
    for (const entry of nodes.values()) {
      for (const cell of entry.cells) if (cell && cell.row.id === rowId) return cell;
    }
    return null;
  }

  // Ein Klick-Handler für alle Kacheln: Toggle → Aufnehmen-Logik des Overlays, Logo-Platte → Kanalansicht (eigener Handler),
  // sonst Detail-Modal der Sendung, auf die geklickt wurde (Kachel = laufende Sendung, „Danach“-Zeile = diese Sendung).
  spacer.addEventListener('click', event => {
    if (event.target.closest('.tv-tile-logo')) return;
    const holder = event.target.closest('[data-row-id]');
    if (!holder) return;
    const cell = findCell(holder.dataset.rowId);
    if (!cell) return;
    const toggleEl = event.target.closest('.epg-toggle');
    if (toggleEl) {
      if (typeof deps.onToggle === 'function') deps.onToggle(cell.row, toggleEl);
      return;
    }
    if (typeof deps.onOpen === 'function') deps.onOpen(cell.row);
  });

  scroll.addEventListener('scroll', scheduleRender);

  /** Kanäle samt ihrer Sendungen übernehmen (Neuaufbau; Scrollposition bleibt, soweit möglich). */
  function setChannels(next, loadedAtMs = now()) {
    allChannels = Array.isArray(next) ? next : [];
    if (loadedAtMs !== loadedAt) resetThumbs(); // neue Daten: Bild-URLs neu holen
    loadedAt = loadedAtMs;
    clearNodes();
    recompute();
    render();
  }

  /** Genre-Filter (Etappe 3.6): Kacheln neu aufbauen, Scrollposition bleibt. */
  function setGenres(list) {
    genres = Array.isArray(list) ? list.slice() : [];
    clearNodes();
    recompute();
    render();
  }

  /** Schmales Fenster (< 900 px): nur Klasse für die Darstellung; die Rasterspalten ergeben sich aus der Breite. */
  function setNarrow(value) {
    const on = !!value;
    narrow = on;
    el.classList.toggle('is-narrow', on);
    applyHeight();
    render();
  }

  /** 30-s-Takt: Zuordnung fortschreiben (Wechsel der laufenden Sendung), Fortschritt und Marker aktualisieren. */
  function tick() {
    if (!allChannels.length) return;
    recompute();
    render();
  }

  function setVisible(on) {
    el.hidden = !on;
    if (on) {
      recompute();
      render();
    } else {
      kit.stopPreview();
    }
  }

  function invalidate() {
    for (const entry of nodes.values()) for (const cell of entry.cells) if (cell) cell.sig = '';
    if (!el.hidden) render();
  }

  function reset() {
    allChannels = [];
    channels = [];
    assignments = [];
    loadedAt = null;
    resetThumbs();
    emptyEl.hidden = true;
    clearNodes();
    spacer.style.height = '';
    scroll.scrollTop = 0;
  }

  /** Fokus-Rückgabe: Logo-Platte (Kopf-Knopf, Sendername) einer Kachel oder null. */
  function channelElement(key) {
    const entry = nodes.get(key);
    return entry ? entry.chan : null;
  }

  function cellElement(rowId) {
    const cell = findCell(rowId);
    return cell ? cell.refs.open : null;
  }

  return {
    el,
    scroll,
    setChannels,
    setNarrow,
    setVisible,
    render,
    scheduleRender,
    tick,
    invalidate,
    reset,
    /** Hinweistext, solange keine Sender zu zeigen sind (lädt / kein Programm). */
    setEmptyText: text => {
      emptyBase = text || '';
      updateEmpty();
    },
    setGenres,
    channelElement,
    cellElement,
    count: () => channels.length,
    totalCount: () => allChannels.length,
    loadedAt: () => loadedAt,
    isNarrow: () => narrow,
    scrollToTop: () => {
      scroll.scrollTop = 0;
      render();
    },
    scrollTop: () => scroll.scrollTop,
    setScrollTop: value => {
      scroll.scrollTop = value;
      render();
    },
    /** Kacheln im DOM (Virtualisierungstest). */
    domRowCount: () => spacer.children.length,
  };
}

module.exports = { createJngView };
