// RASTER des EPG-Programmführers (Etappe 3.3, T-B): durchgehende Zeitachse, Senderspalte und
// Zeitleiste sticky, Blöcke virtualisiert (Zeilen und x-Bereich ±1 Viewport), Nachladen über
// epg:range-many (schlank, debounced). Rein darstellend: Auswahl, Detail-Modal, Marker-Daten und
// Zeitanker gehören epg-view.js (gemeinsamer Zustand für Liste und Raster).
//
// Alle Texte (Titel, Sender) nur per textContent/createElement — nie über HTML-Strings.

'use strict';

const grid = require('./lib/epg-grid.js');
const model = require('./epg-grid-model.js');
const viewModel = require('./epg-view-model.js');
const { h } = require('./epg-dom.js');

const FETCH_DEBOUNCE_MS = 120;

/**
 * deps:
 *   api.getEpgRangeMany(keys, fromMs, toMs)
 *   now()                       Uhr
 *   getMarkerData()             { schedules, recordings } für grid.matchMarkers
 *   isSelected(rowId)           Auswahl (gemeinsam mit der Liste)
 *   onOpen(row, element)        Klick auf einen Block → Detail-Modal
 *   onChannelClick(channel)     optional (Kanalansicht kommt in 3.4): nur dann sind Sendernamen klickbar
 *   onScroll()                  Scrollposition hat sich geändert (Tab/Anker nachführen)
 *   onError(err)
 */
function createGridView(deps) {
  const api = deps.api;
  let axis = null;
  let entries = []; // [{ key, channel }] — Zeilen
  let entryByKey = new Map();
  let signature = '';
  let pxPerMin = model.DEFAULT_ZOOM;
  const store = model.createSlotStore();
  let blocks = new Map(); // Block-Schlüssel → { el, refs, row, sig }
  let chans = new Map(); // Zeilenindex → Element
  let fetchSeq = 0;
  let fetchTimer = null;
  let frame = 0;
  let visibleFlag = false;

  // ── DOM ──
  const corner = h('div', { className: 'epg-grid-corner', text: 'Sender' });
  const track = h('div', { className: 'epg-grid-ruler-track' });
  const ruler = h('div', { className: 'epg-grid-ruler', attrs: { 'aria-hidden': 'true' } }, [corner, track]);
  const chancol = h('div', { className: 'epg-grid-chancol' });
  const nowLine = h('div', { className: 'epg-grid-nowline', attrs: { 'aria-hidden': 'true' } });
  const area = h('div', { className: 'epg-grid-rows', id: 'epgGridRows' }, [nowLine]);
  const main = h('div', { className: 'epg-grid-main' }, [chancol, area]);
  const canvas = h('div', { className: 'epg-grid-canvas' }, [ruler, main]);
  const el = h('div', { className: 'epg-grid-scroll', id: 'epgGrid', attrs: { tabindex: '0' }, hidden: true }, [canvas]);

  function viewportW() {
    return Math.max(0, el.clientWidth - model.CHANNEL_COL_WIDTH);
  }

  function viewportH() {
    return Math.max(0, el.clientHeight - model.RULER_HEIGHT);
  }

  // ── Aufbau (Achse, Zeilen oder Zoom ändern sich) ──

  function clearNodes() {
    for (const entry of blocks.values()) entry.el.remove();
    blocks = new Map();
    for (const node of chans.values()) node.remove();
    chans = new Map();
  }

  function build() {
    clearNodes();
    if (!axis) return;
    const width = model.axisWidth(axis, pxPerMin);
    const height = entries.length * model.ROW_HEIGHT;
    track.style.width = `${width}px`;
    area.style.width = `${width}px`;
    area.style.height = `${height}px`;
    chancol.style.height = `${height}px`;
    // Gitterlinien alle 30 min (Tagesbeginn 05:00 liegt auf einer Halbstunde), Zeilenlinien alle 64 px
    area.style.backgroundSize = `${30 * pxPerMin}px 100%, 100% ${model.ROW_HEIGHT}px`;
    for (const old of area.querySelectorAll('.epg-grid-dayline')) old.remove();
    track.textContent = '';
    const marks = model.rulerMarks(axis, pxPerMin);
    for (const hour of marks.hours) {
      const tick = h('div', { className: 'epg-ruler-hour', text: hour.label });
      tick.style.left = `${hour.left}px`;
      track.appendChild(tick);
    }
    for (const day of marks.days) {
      const label = h('div', { className: 'epg-ruler-day', text: day.label });
      label.style.left = `${day.left}px`;
      track.appendChild(label);
      const line = h('div', { className: 'epg-grid-dayline', attrs: { 'aria-hidden': 'true' } });
      line.style.left = `${day.left}px`;
      area.appendChild(line);
    }
    positionNowLine();
  }

  function positionNowLine() {
    if (!axis) return;
    const nowMs = deps.now();
    const inside = nowMs >= axis.originMs && nowMs <= axis.endMs;
    nowLine.hidden = !inside;
    if (inside) nowLine.style.left = `${model.xForTime(axis, nowMs, pxPerMin)}px`;
  }

  /**
   * Achse, Zeilen und Zoom setzen. Ändert sich etwas, wird neu aufgebaut; die Zeit am linken Rand
   * bleibt dabei stehen. refetch: Daten verwerfen und neu holen (epg:changed, Aktualisieren).
   */
  function configure({ axis: nextAxis, entries: nextEntries, zoom, refetch = false }) {
    const nextSig = `${nextAxis ? `${nextAxis.originMs}-${nextAxis.endMs}` : 'x'}|${zoom}|${nextEntries.length}|${nextEntries
      .map(e => e.key)
      .join(',')}`;
    const keepTime = axis && el.scrollLeft >= 0 ? model.timeForX(axis, el.scrollLeft, pxPerMin) : null;
    axis = nextAxis;
    entries = nextEntries;
    entryByKey = new Map(entries.map(e => [e.key, e]));
    pxPerMin = zoom;
    if (refetch) {
      fetchSeq += 1;
      store.clear();
    }
    if (nextSig !== signature) {
      signature = nextSig;
      build();
      if (keepTime !== null && axis) el.scrollLeft = model.scrollLeftForTime(axis, keepTime, pxPerMin);
    }
    if (visibleFlag) {
      render();
      fetchNow();
    }
  }

  // ── Rendern ──

  function createChannelCell(index) {
    const entry = entries[index];
    const name = entry.channel.name || entry.key;
    const cell = typeof deps.onChannelClick === 'function'
      ? h('button', { className: 'epg-grid-chan epg-grid-chan-btn', type: 'button', text: name })
      : h('div', { className: 'epg-grid-chan', text: name });
    cell.title = name;
    cell.style.top = `${index * model.ROW_HEIGHT}px`;
    cell.style.height = `${model.ROW_HEIGHT}px`;
    cell.dataset.channelKey = entry.key;
    return cell;
  }

  function createBlock(row, geometry) {
    const marker = h('span', { className: 'epg-marker' });
    const titleEl = h('div', { className: 'epg-block-title', text: row.title || '(ohne Titel)' });
    const timeEl = h('div', { className: 'epg-block-time', text: `${viewModel.clock(row.start)}–${viewModel.clock(row.stop)}` });
    const barFill = h('span', { className: 'epg-progress-fill' });
    const bar = h('span', { className: 'epg-block-bar', hidden: true }, [barFill]);
    const button = h('button', { className: 'epg-block', type: 'button' }, geometry.narrow ? [marker, bar] : [marker, titleEl, timeEl, bar]);
    button.title = model.blockTooltip(row, viewModel.clock);
    button.setAttribute('aria-label', `${row.title || 'Sendung'}, ${row.channel.name || row.channelKey}, ${viewModel.clock(row.start)}`);
    button.classList.toggle('is-narrow', geometry.narrow);
    button.dataset.blockKey = row.id;
    button.style.left = `${geometry.left}px`;
    button.style.width = `${geometry.width}px`;
    return { el: button, refs: { marker, bar, barFill }, row, sig: '' };
  }

  function updateBlock(entry, nowMs, marker) {
    const info = viewModel.rowPhase(entry.row, nowMs);
    const percent = Math.round(info.progress * 100);
    const selected = deps.isSelected(entry.row.id);
    const sig = `${info.phase}|${percent}|${marker ? marker.state : ''}|${selected}`;
    if (entry.sig === sig) return;
    entry.sig = sig;
    const { el: node, refs } = entry;
    node.classList.toggle('is-now', info.phase === 'now');
    node.classList.toggle('is-past', info.phase === 'past');
    node.classList.toggle('is-selected', selected);
    refs.bar.hidden = info.phase !== 'now';
    refs.barFill.style.width = `${percent}%`;
    refs.marker.dataset.state = marker ? marker.state : '';
    refs.marker.textContent = marker ? '●' : '';
    refs.marker.title = marker ? (marker.state === 'recording' ? 'Aufnahme läuft' : 'Aufnahme geplant') : '';
  }

  function currentWindow() {
    return grid.virtualWindow({
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      viewportWidth: viewportW() || 800,
      viewportHeight: viewportH() || 400,
      rowHeight: model.ROW_HEIGHT,
      rowCount: entries.length,
      originMs: axis.originMs,
      pxPerMin,
      overscan: 1,
    });
  }

  function render() {
    frame = 0;
    if (!visibleFlag || !axis || !entries.length) return;
    const nowMs = deps.now();
    const win = currentWindow();
    const wanted = new Map();
    const order = [];
    for (let r = win.rowStart; r < win.rowEnd; r += 1) {
      for (const row of store.window(entries[r].key, win.fromMs, win.toMs)) {
        wanted.set(row.id, { row, r });
        order.push(row);
      }
    }
    // Zeilenköpfe
    for (const [index, node] of chans) {
      if (index < win.rowStart || index >= win.rowEnd) {
        node.remove();
        chans.delete(index);
      }
    }
    for (let r = win.rowStart; r < win.rowEnd; r += 1) {
      if (!chans.has(r)) {
        const node = createChannelCell(r);
        chancol.appendChild(node);
        chans.set(r, node);
      }
    }
    // Blöcke
    for (const [key, entry] of blocks) {
      if (!wanted.has(key)) {
        entry.el.remove();
        blocks.delete(key);
      }
    }
    const data = deps.getMarkerData();
    const markers = order.length ? grid.matchMarkers(order.map(viewModel.markerSlot), data.schedules, data.recordings, nowMs) : [];
    const markerById = new Map(order.map((row, i) => [row.id, markers[i]]));
    for (const { row, r } of wanted.values()) {
      let entry = blocks.get(row.id);
      if (!entry) {
        const geometry = model.blockGeometry(row, axis, pxPerMin);
        entry = createBlock(row, geometry);
        entry.el.style.top = `${r * model.ROW_HEIGHT + 2}px`;
        area.appendChild(entry.el);
        blocks.set(row.id, entry);
      }
      updateBlock(entry, nowMs, markerById.get(row.id) || null);
    }
    positionNowLine();
  }

  function scheduleRender() {
    if (!frame) frame = window.requestAnimationFrame(render);
  }

  // ── Nachladen ──

  function fetchNow() {
    clearTimeout(fetchTimer);
    fetchTimer = null;
    if (!visibleFlag || !axis || !entries.length) return;
    const win = currentWindow();
    const keys = entries.slice(win.rowStart, win.rowEnd).map(e => e.key);
    const calls = model.neededFetches({ fromMs: win.fromMs, toMs: win.toMs, axis, keys, loaded: store.loaded });
    const seq = fetchSeq;
    for (const call of calls) {
      for (const key of call.keys) store.loaded.add(model.loadedKey(call.bucket, key));
      Promise.resolve()
        .then(() => api.getEpgRangeMany(call.keys, call.fromMs, call.toMs))
        .then(results => {
          if (seq !== fetchSeq) return;
          for (const result of Array.isArray(results) ? results : []) {
            const entry = entryByKey.get(result.channelKey);
            if (entry) store.ingest(entry, result.slots);
          }
          scheduleRender();
        })
        .catch(err => {
          if (seq !== fetchSeq) return;
          for (const key of call.keys) store.loaded.delete(model.loadedKey(call.bucket, key));
          if (typeof deps.onError === 'function') deps.onError(err);
        });
    }
  }

  function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchNow, FETCH_DEBOUNCE_MS);
  }

  function onScrollEvent() {
    scheduleRender();
    scheduleFetch();
    if (typeof deps.onScroll === 'function') deps.onScroll();
  }

  el.addEventListener('scroll', onScrollEvent);
  area.addEventListener('click', event => {
    const button = event.target.closest('.epg-block');
    if (!button) return;
    const entry = blocks.get(button.dataset.blockKey);
    if (entry) deps.onOpen(entry.row, button);
  });
  chancol.addEventListener('click', event => {
    const cell = event.target.closest('.epg-grid-chan-btn');
    if (!cell || typeof deps.onChannelClick !== 'function') return;
    const entry = entryByKey.get(cell.dataset.channelKey);
    if (entry) deps.onChannelClick(entry.channel);
  });

  // ── Steuerung durch epg-view.js ──

  /** Sichtbarkeit; beim Einblenden rendern und fehlende Daten holen. */
  function setVisible(on) {
    visibleFlag = !!on;
    el.hidden = !visibleFlag;
    if (visibleFlag) {
      render();
      fetchNow();
    }
  }

  function scrollTime(ms, ratio = 0) {
    if (!axis) return;
    el.scrollLeft = model.scrollLeftForTime(axis, ms - (viewportW() * ratio) / pxPerMin * grid.MINUTE_MS, pxPerMin);
    render();
    fetchNow();
  }

  function scrollToNow() {
    if (!axis) return;
    el.scrollLeft = model.scrollLeftForNow(axis, deps.now(), pxPerMin, viewportW());
    render();
    fetchNow();
  }

  /** Zeile (Kanal) vertikal in den Sichtbereich holen. */
  function revealChannel(key) {
    const index = entries.findIndex(e => e.key === key);
    if (index < 0) return;
    const top = index * model.ROW_HEIGHT;
    if (top < el.scrollTop || top + model.ROW_HEIGHT > el.scrollTop + viewportH()) el.scrollTop = Math.max(0, top - model.ROW_HEIGHT);
  }

  /** Neuzeichnen mit zurückgesetzten Signaturen (Marker, Auswahl). */
  function invalidate() {
    for (const entry of blocks.values()) entry.sig = '';
    render();
  }

  /** Daten verwerfen, Knoten behalten (epg:changed). */
  function reload() {
    fetchSeq += 1;
    store.clear();
    invalidate();
    fetchNow();
  }

  function reset() {
    fetchSeq += 1;
    clearTimeout(fetchTimer);
    fetchTimer = null;
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    store.clear();
    clearNodes();
    axis = null;
    entries = [];
    entryByKey = new Map();
    signature = '';
    visibleFlag = false;
    el.hidden = true;
    track.textContent = '';
    for (const old of area.querySelectorAll('.epg-grid-dayline')) old.remove();
    area.style.width = '';
    area.style.height = '';
    chancol.style.height = '';
    track.style.width = '';
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }

  return {
    el,
    configure,
    setVisible,
    render,
    scheduleRender,
    scrollTime,
    scrollToNow,
    revealChannel,
    invalidate,
    reload,
    reset,
    tick: render,
    scrollLeft: () => el.scrollLeft,
    setScrollLeft: px => {
      el.scrollLeft = px;
    },
    timeAtLeft: () => (axis ? model.timeForX(axis, el.scrollLeft, pxPerMin) : null),
    getAxis: () => axis,
    getZoom: () => pxPerMin,
    blockElement: rowId => {
      const entry = blocks.get(rowId);
      return entry ? entry.el : null;
    },
    isReady: () => !!axis && entries.length > 0,
  };
}

module.exports = { createGridView };
