// EPG-Programmführer (Etappe 3.3, Design B2): Kopfzeile + Tages-Tabs, LISTE, Detail-MODAL.
//
// Factory-Muster wie settings-view.js. Liest ausschließlich vom Main-Cache (epg:range-many
// schlank für die Liste, epg:find für das Detail) und kennt weder den Renderer-Datenweg des alten EPG noch die
// Aufnahme-Logik: Planen, Stoppen, Sender öffnen usw. kommen als Callbacks aus renderer.js
// (handleEpgRecordClick/openSchedulePlanningDialog bleiben die einzige Planungs-Logik).
//
// Der Zustand (Tage, Zeilen, Layout, Scroll-Anker, Auswahl, Modus) liegt im DOM-freien
// epg-view-modell (epg-view-model.js). Hier steht nur Aufbau und Verdrahtung des DOM.
//
// Sicherheit: Alle Texte stammen aus fremden EPG-Daten und werden ausschließlich per
// textContent/createElement gesetzt — nie über HTML-Strings.
//
// Lebenszyklus: open() meldet Ereignis-Abos (epg:changed, schedule:changed, recording:changed),
// 30-s-Tick und resize an; close() meldet alles wieder ab und gibt Daten und Knoten frei
// (wiederholtes Öffnen/Schließen leckt weder Listener noch Speicher).

'use strict';

const grid = require('./lib/epg-grid.js');
const scheduleUi = require('./lib/recorder/schedule-ui-model.js');
const model = require('./epg-view-model.js');
const gridModel = require('./epg-grid-model.js');
const { createGridView } = require('./epg-grid-view.js');
const { h, trapTab } = require('./epg-dom.js');

const TICK_MS = 30 * 1000;
const OVERSCAN_PX = 400;
const SCROLL_RELOAD_DEBOUNCE_MS = 250;
const MARKER_DEBOUNCE_MS = 120;
const TOAST_MS = 5000;
const FETCH_PARALLEL = 3;

/**
 * root: das leere Overlay-Element (#epgOverlay). deps:
 *   api            window.electronAPI-Teilmenge (getEpgStatus, getEpgRangeMany, findEpg, refreshEpgCache,
 *                  listSchedules, listRecordings, removeSchedule, onEpgChanged, onScheduleChanged,
 *                  onRecordingChanged)
 *   getChannels()  alle Sender (tvChannels);  isFavorite(channel)
 *   recordProgramme(ctx)   „Aufnehmen“ → bestehender Weg (Zukunftsregel, Planungsdialog)
 *   stopRecording(recId)   laufende Aufnahme stoppen
 *   openChannel(channel)   Sender im Player öffnen
 *   getMediathek(channel, title) → { label, open() } | null
 *   showPlanned()          Sprung zur Geplant-Liste
 *   onError(err)           optionale Fehlerprotokollierung;  now()  Uhr (Standard Date.now)
 */
function createEpgView(root, deps) {
  const api = deps.api;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const viewState = model.createViewState();

  // ── Laufzeitdaten (nur zwischen open() und close()) ──
  let isOpen = false;
  let loadSeq = 0;
  let status = null;
  let loadError = '';
  let days = [];
  let channelEntries = [];
  let channelByKey = new Map();
  let hasFavorites = false;
  let channelsWithEpg = new Set(); // rohe Schlüssel mit mindestens einer Sendung (Raster zeigt nur diese Sender)
  let coverageToMs = null;
  let dayRows = new Map(); // dayKey → rows
  let dayPromises = new Map(); // dayKey → Promise (laufende/fertige Abrufe)
  let layout = null;
  let rowsById = new Map();
  let schedules = [];
  let recordings = [];
  let loading = false;
  let refreshing = false;
  let nodes = new Map(); // item.key → { el, refs, sig }
  let detailCache = new Map();
  let opener = null;
  let subs = [];
  let tickTimer = null;
  let reloadTimer = null;
  let markerTimer = null;
  let toastTimer = null;
  let frame = 0;
  let todayKey = '';
  let modalRow = null;
  let modalSeq = 0;
  let confirmCtx = null;
  let mediathekOpen = null;
  let dayPin = null;

  // ── DOM-Gerüst ──
  root.textContent = '';
  root.className = 'epg-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Programmführer');
  root.style.display = 'none';

  const nowBtn = h('button', { className: 'epg-btn', id: 'epgNowBtn', type: 'button', text: 'Jetzt' });
  const standEl = h('span', { className: 'epg-stand', id: 'epgStand', attrs: { 'aria-live': 'polite' } });
  const refreshBtn = h('button', {
    className: 'epg-btn epg-refresh-btn',
    id: 'epgRefreshBtn',
    type: 'button',
    attrs: { title: 'EPG-Cache jetzt aktualisieren' },
    text: '↻ Aktualisieren',
  });
  const closeBtn = h('button', {
    className: 'epg-close-btn',
    id: 'epgCloseBtn',
    type: 'button',
    attrs: { 'aria-label': 'Programmführer schließen' },
    text: '×',
  });
  const modeListBtn = h('button', { className: 'epg-seg-btn', id: 'epgModeList', type: 'button', text: 'Liste' });
  const modeGridBtn = h('button', { className: 'epg-seg-btn', id: 'epgModeGrid', type: 'button', text: 'Raster' });
  const modeSeg = h('div', { className: 'epg-seg', attrs: { role: 'group', 'aria-label': 'Ansicht' } }, [modeListBtn, modeGridBtn]);
  const header = h('div', { className: 'epg-header' }, [
    h('div', { className: 'epg-header-left' }, [h('h2', { className: 'epg-title', text: 'Programmführer' }), modeSeg]),
    h('div', { className: 'epg-header-actions' }, [nowBtn, standEl, refreshBtn, closeBtn]),
  ]);
  const dayTabs = h('div', { className: 'epg-daytabs', id: 'epgDayTabs', attrs: { role: 'group', 'aria-label': 'Tag' } });
  // Raster-Werkzeuge (nur im Raster sichtbar): Zoom 3/5/8 px/min und Schnellsprünge
  const zoomBtns = gridModel.ZOOMS.map(z => {
    const btn = h('button', { className: 'epg-seg-btn epg-zoom-btn', type: 'button', text: String(z), attrs: { title: `${z} px pro Minute` } });
    btn.dataset.zoom = String(z);
    return btn;
  });
  const zoomSeg = h('div', { className: 'epg-seg', id: 'epgZoom', attrs: { role: 'group', 'aria-label': 'Zoom (px pro Minute)' } }, zoomBtns);
  const jump2015Btn = h('button', { className: 'epg-btn epg-jump-btn', id: 'epgJump2015', type: 'button', text: '20:15' });
  const jump2200Btn = h('button', { className: 'epg-btn epg-jump-btn', id: 'epgJump2200', type: 'button', text: '22:00' });
  const gridTools = h('div', { className: 'epg-grid-tools', id: 'epgGridTools', hidden: true }, [jump2015Btn, jump2200Btn, zoomSeg]);
  const filterBar = h('div', { className: 'epg-filterbar' }, [dayTabs, gridTools]);

  const listHead = h('div', { className: 'epg-list-head', attrs: { 'aria-hidden': 'true' } }, [
    h('span', { text: 'Zeit' }),
    h('span', { text: 'Sender' }),
    h('span', { text: 'Titel' }),
    h('span', { className: 'epg-col-action-head', text: 'Aktion' }),
  ]);
  const spacer = h('div', { className: 'epg-list-spacer', id: 'epgListItems', attrs: { role: 'list', 'aria-label': 'Programm' } });
  const scroll = h('div', { className: 'epg-list-scroll', id: 'epgList', attrs: { tabindex: '0' } }, [listHead, spacer]);
  const stateTitle = h('div', { className: 'epg-state-title' });
  const stateText = h('div', { className: 'epg-state-text' });
  const stateBtn = h('button', { className: 'epg-btn epg-state-btn', type: 'button', hidden: true });
  const stateEl = h('div', { className: 'epg-state', id: 'epgState', attrs: { role: 'status' }, hidden: true }, [
    stateTitle,
    stateText,
    stateBtn,
  ]);
  const gridView = createGridView({
    api,
    now,
    getMarkerData: () => ({ schedules: markerList(), recordings }),
    isSelected: id => viewState.selectedRowId === id,
    onOpen: row => openDetail(row),
    onChannelClick: typeof deps.onChannelClick === 'function' ? deps.onChannelClick : undefined,
    onScroll: () => followGrid(),
    onError: err => warn(err),
  });
  const body = h('div', { className: 'epg-body', id: 'epgBody' }, [scroll, gridView.el, stateEl]);

  // Detail-Modal
  const dTitle = h('h3', { className: 'epg-detail-title', id: 'epgDetailTitle' });
  const dClose = h('button', {
    className: 'epg-detail-close',
    id: 'epgDetailClose',
    type: 'button',
    attrs: { 'aria-label': 'Schließen' },
    text: '×',
  });
  const dMeta = h('div', { className: 'epg-detail-meta', id: 'epgDetailMeta' });
  const dToggle = h('button', { className: 'epg-toggle epg-toggle-primary', id: 'epgDetailRecordBtn', type: 'button' });
  const dPlanned = h('div', { className: 'epg-detail-planned', id: 'epgDetailPlanned', hidden: true });
  const dPlannedText = h('span', { className: 'epg-detail-planned-text' });
  const dPlannedLink = h('button', {
    className: 'epg-link-btn',
    id: 'epgDetailPlannedLink',
    type: 'button',
    text: 'Zur Geplant-Liste',
  });
  dPlanned.append(dPlannedText, dPlannedLink);
  const dHint = h('div', { className: 'epg-detail-hint', id: 'epgDetailHint', hidden: true });
  const dNotice = h('div', { className: 'epg-detail-notice', id: 'epgDetailNotice', attrs: { role: 'status' }, hidden: true });
  const dDesc = h('div', { className: 'epg-detail-desc', id: 'epgDetailDesc' });
  const dWatch = h('button', { className: 'epg-action-btn epg-watch-btn', id: 'epgDetailWatchBtn', type: 'button', text: 'Sender öffnen' });
  const dMediathek = h('button', {
    className: 'epg-action-btn epg-mediathek-btn',
    id: 'epgDetailMediathekBtn',
    type: 'button',
    hidden: true,
  });
  const dActions = h('div', { className: 'epg-detail-actions', id: 'epgDetailActions' }, [dWatch, dMediathek]);
  const modal = h(
    'div',
    {
      className: 'epg-detail-modal',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'epgDetailTitle' },
    },
    [
      h('div', { className: 'epg-detail-header' }, [dTitle, dClose]),
      dMeta,
      h('div', { className: 'epg-detail-primary' }, [dToggle, dPlanned]),
      dHint,
      dNotice,
      dDesc,
      dActions,
    ],
  );
  const backdrop = h('div', { className: 'epg-detail-backdrop', id: 'epgDetailBackdrop', hidden: true }, [modal]);

  // Rückfrage (Abbrechen/Stoppen)
  const confirmText = h('div', { className: 'epg-confirm-text', id: 'epgConfirmText' });
  const confirmYes = h('button', { className: 'epg-btn epg-btn-primary', id: 'epgConfirmYes', type: 'button' });
  const confirmNo = h('button', { className: 'epg-btn', id: 'epgConfirmNo', type: 'button' });
  const confirmEl = h(
    'div',
    {
      className: 'epg-confirm',
      id: 'epgConfirm',
      attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'epgConfirmText' },
      hidden: true,
    },
    [confirmText, h('div', { className: 'epg-confirm-actions' }, [confirmYes, confirmNo])],
  );
  const toastEl = h('div', { className: 'epg-toast', id: 'epgToast', attrs: { role: 'status' }, hidden: true });

  root.append(header, filterBar, body, backdrop, confirmEl, toastEl);

  // ── Hilfen ──

  function warn(err) {
    if (typeof deps.onError === 'function') deps.onError(err);
  }

  function markerList() {
    const out = [];
    for (const entry of schedules) if (entry && (entry.state === 'scheduled' || entry.state === 'recording')) out.push(entry);
    return out;
  }

  function markerFor(row) {
    return grid.matchMarkers([model.markerSlot(row)], markerList(), recordings, now())[0] || null;
  }

  function loadedRun() {
    if (!days.length) return [];
    let start = days.findIndex(d => d.isToday);
    if (start < 0) start = 0;
    if (!dayRows.has(days[start].key)) {
      start = days.findIndex(d => dayRows.has(d.key));
      if (start < 0) return [];
    }
    let lo = start;
    let hi = start;
    while (lo > 0 && dayRows.has(days[lo - 1].key)) lo -= 1;
    while (hi < days.length - 1 && dayRows.has(days[hi + 1].key)) hi += 1;
    return days.slice(lo, hi + 1).map(day => ({ day, rows: dayRows.get(day.key) }));
  }

  function rowCount() {
    let n = 0;
    for (const rows of dayRows.values()) n += rows.length;
    return n;
  }

  /** Baut das Layout neu. keepPosition: Scrollposition anhand des obersten Items erhalten. */
  function rebuildLayout({ keepPosition = true } = {}) {
    const old = layout;
    const top = scroll.scrollTop;
    let anchorKey = null;
    let anchorDelta = 0;
    if (old && keepPosition && old.count) {
      const idx = model.itemIndexAt(old, top);
      anchorKey = old.items[idx].key;
      anchorDelta = top - old.offsets[idx];
    }
    const run = loadedRun();
    layout = model.buildLayout(run, now());
    rowsById = new Map();
    for (const idx of layout.rowIndex) rowsById.set(layout.items[idx].row.id, layout.items[idx].row);
    spacer.style.height = `${layout.total}px`;
    if (anchorKey !== null) {
      const idx = layout.indexOfKey(anchorKey);
      if (idx >= 0) scroll.scrollTop = layout.offsets[idx] + anchorDelta;
      else if (viewState.anchorMs !== null) {
        const t = model.scrollTopForTime(layout, viewState.anchorMs);
        if (t !== null) scroll.scrollTop = t;
      }
    }
  }

  // ── Rendern ──

  function setRowSignature(entry, sig) {
    if (entry.sig === sig) return false;
    entry.sig = sig;
    return true;
  }

  function updateRow(entry, row, nowMs, marker) {
    const info = model.rowPhase(row, nowMs);
    const toggle = model.toggleState({ row, marker, nowMs });
    const minutesText = info.minutesLeft ? `noch ${info.minutesLeft} min` : '';
    const percent = Math.round(info.progress * 100);
    const selected = viewState.selectedRowId === row.id;
    const sig = [info.phase, minutesText, percent, marker ? marker.state : '', toggle.kind, toggle.disabled, selected].join('|');
    if (!setRowSignature(entry, sig)) return;
    const { el, refs } = entry;
    el.classList.toggle('is-now', info.phase === 'now');
    el.classList.toggle('is-past', info.phase === 'past');
    el.classList.toggle('is-selected', selected);
    el.dataset.phase = info.phase;
    refs.sub.textContent = minutesText;
    refs.bar.hidden = info.phase !== 'now';
    refs.barFill.style.width = `${percent}%`;
    refs.marker.dataset.state = marker ? marker.state : '';
    refs.marker.textContent = marker ? '●' : '';
    refs.marker.title = marker ? (marker.state === 'recording' ? 'Aufnahme läuft' : 'Aufnahme geplant') : '';
    refs.marker.setAttribute('aria-label', refs.marker.title);
    refs.toggle.textContent = toggle.label;
    refs.toggle.dataset.kind = toggle.kind;
    refs.toggle.disabled = toggle.disabled;
    refs.toggle.title = toggle.hint;
    refs.toggle.setAttribute(
      'aria-label',
      `${toggle.label.replace(/^[●✕■]\s*/, '')}: ${row.title} (${row.channel.name || row.channelKey}, ${model.clock(row.start)})`,
    );
  }

  function createRowNode(row) {
    const marker = h('span', { className: 'epg-marker' });
    const time = h('span', { className: 'epg-time', text: model.clock(row.start) });
    const timeLine = h('div', { className: 'epg-time-line' }, [marker, time]);
    if (row.night) timeLine.appendChild(h('span', { className: 'epg-night', text: 'Nacht', attrs: { title: 'Nach Mitternacht (Vorabend-TV-Tag)' } }));
    const sub = h('span', { className: 'epg-time-sub' });
    const barFill = h('span', { className: 'epg-progress-fill' });
    const bar = h('span', { className: 'epg-progress', hidden: true }, [barFill]);
    const subLine = h('div', { className: 'epg-sub-line' }, [sub, bar]);
    const timeCell = h('div', { className: 'epg-col-time' }, [timeLine, subLine]);
    const channelCell = h('div', { className: 'epg-col-channel', text: row.channel.name || row.channelKey });
    channelCell.title = row.channel.name || row.channelKey;
    const open = h('button', { className: 'epg-row-open', type: 'button', text: row.title || '(ohne Titel)' });
    open.title = row.title;
    const toggle = h('button', { className: 'epg-toggle', type: 'button' });
    const actionCell = h('div', { className: 'epg-col-action' }, [toggle]);
    const el = h(
      'div',
      { className: 'epg-list-row epg-program', attrs: { role: 'listitem' } },
      [timeCell, channelCell, h('div', { className: 'epg-col-title' }, [open]), actionCell],
    );
    el.dataset.rowId = row.id;
    el.style.height = `${model.ROW_HEIGHT}px`;
    return { el, refs: { sub, bar, barFill, marker, toggle, open }, sig: '' };
  }

  function createNode(item) {
    if (item.type === 'row') return createRowNode(item.row);
    const el = h('div', { className: item.type === 'day' ? 'epg-day-head' : 'epg-now-line', attrs: { role: 'presentation' } });
    if (item.type === 'day') {
      el.textContent = item.day.heading;
      el.style.height = `${model.DAY_HEIGHT}px`;
    } else {
      el.style.height = `${model.NOW_HEIGHT}px`;
    }
    return { el, refs: {}, sig: '' };
  }

  function renderWindow() {
    frame = 0;
    if (!isOpen || !layout || scroll.hidden) return;
    const nowMs = now();
    const viewportH = scroll.clientHeight || 600;
    const range = model.visibleItems(layout, scroll.scrollTop, viewportH, OVERSCAN_PX);
    const rows = [];
    for (let i = range.from; i < range.to; i += 1) if (layout.items[i].type === 'row') rows.push(layout.items[i].row);
    const markers = rows.length ? grid.matchMarkers(rows.map(model.markerSlot), markerList(), recordings, nowMs) : [];
    const markerByRow = new Map(rows.map((row, i) => [row.id, markers[i]]));

    const wanted = new Set();
    for (let i = range.from; i < range.to; i += 1) wanted.add(layout.items[i].key);
    for (const [key, entry] of nodes) {
      if (!wanted.has(key)) {
        entry.el.remove();
        nodes.delete(key);
      }
    }
    let j = 0;
    for (let i = range.from; i < range.to; i += 1) {
      const item = layout.items[i];
      let entry = nodes.get(item.key);
      if (!entry) {
        entry = createNode(item);
        nodes.set(item.key, entry);
      }
      entry.el.style.top = `${layout.offsets[i]}px`;
      if (item.type === 'row') {
        updateRow(entry, item.row, nowMs, markerByRow.get(item.row.id) || null);
      } else if (item.type === 'now') {
        const text = `Jetzt ${model.clock(nowMs)}`;
        if (setRowSignature(entry, text)) entry.el.textContent = text;
      }
      const ref = spacer.children[j];
      if (ref !== entry.el) spacer.insertBefore(entry.el, ref || null);
      j += 1;
    }
  }

  function scheduleRender() {
    if (!frame) frame = window.requestAnimationFrame(renderWindow);
  }

  function renderDayTabs() {
    dayTabs.textContent = '';
    for (const day of days) {
      const btn = h('button', { className: 'epg-daytab', type: 'button', text: day.label });
      btn.dataset.dayKey = day.key;
      btn.title = `${model.calendarLabel(day.startMs)} (TV-Tag 05:00–05:00)`;
      btn.addEventListener('click', () => goToDay(day.key));
      dayTabs.appendChild(btn);
    }
    syncDayTabs();
  }

  function syncDayTabs() {
    for (const btn of dayTabs.children) {
      const active = btn.dataset.dayKey === viewState.dayKey;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      if (active && typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderStand() {
    const at = status && Number.isFinite(status.lastSuccessAt) ? status.lastSuccessAt : null;
    if (at === null) {
      standEl.textContent = status ? 'Noch kein Abruf' : '';
      return;
    }
    const sameDay = new Date(at).toDateString() === new Date(now()).toDateString();
    standEl.textContent = `Stand ${sameDay ? '' : `${model.calendarLabel(at)} `}${model.clock(at)}`;
  }

  function showState(next) {
    const ready = next.kind === 'ready';
    scroll.hidden = !(ready && viewState.mode === 'list');
    gridView.setVisible(ready && viewState.mode === 'grid');
    stateEl.hidden = ready;
    nowBtn.disabled = !ready;
    modeListBtn.disabled = !ready;
    modeGridBtn.disabled = !ready;
    root.dataset.state = next.kind;
    if (ready) return;
    stateTitle.textContent = next.title;
    stateText.textContent = next.text;
    stateText.hidden = !next.text;
    stateBtn.hidden = !next.action;
    stateBtn.dataset.action = next.action || '';
    stateBtn.textContent = next.action === 'show-all' ? 'Alle Sender zeigen' : 'Jetzt aktualisieren';
  }

  function applyDerivedState(stillLoading) {
    const next = model.deriveViewState({
      status,
      loadError,
      loading: stillLoading,
      channelCount: channelEntries.length,
      hasFavorites,
      showAll: viewState.showAll,
      rowCount: rowCount(),
      hasDays: days.length > 0,
    });
    showState(next);
    return next;
  }

  // ── Daten ──

  async function fetchDay(day, seq) {
    const keys = model.chunkKeys(channelEntries.map(c => c.key));
    const results = [];
    for (let i = 0; i < keys.length; i += FETCH_PARALLEL) {
      const batch = await Promise.all(keys.slice(i, i + FETCH_PARALLEL).map(chunk => api.getEpgRangeMany(chunk, day.startMs, day.endMs)));
      if (seq !== loadSeq) return null;
      for (const part of batch) results.push(...part);
    }
    for (const entry of results) if (entry.slots && entry.slots.length) channelsWithEpg.add(entry.channelKey);
    return model.buildDayRows(day, results, channelByKey);
  }

  function ensureDay(day, seq) {
    if (dayRows.has(day.key)) return Promise.resolve();
    let promise = dayPromises.get(day.key);
    if (!promise) {
      promise = fetchDay(day, seq).then(rows => {
        if (rows && seq === loadSeq) dayRows.set(day.key, rows);
      });
      dayPromises.set(day.key, promise);
    }
    return promise;
  }

  /** Reihenfolge der Abrufe: heute, morgen, gestern, dann übermorgen usw. (Lauf bleibt zusammenhängend). */
  function loadOrder() {
    const todayIdx = Math.max(0, days.findIndex(d => d.isToday));
    const order = [days[todayIdx]];
    let lo = todayIdx - 1;
    let hi = todayIdx + 1;
    while (lo >= 0 || hi < days.length) {
      if (hi < days.length) order.push(days[hi++]);
      if (lo >= 0) order.push(days[lo--]);
    }
    return order.filter(Boolean);
  }

  async function loadStatusAndPlan(seq) {
    status = await api.getEpgStatus();
    if (seq !== loadSeq) return false;
    const nowMs = now();
    todayKey = grid.tvDayOf(nowMs).key;
    const fromMs = Math.min(
      ...(status.sources || []).map(s => (Number.isFinite(s.coverageFromMs) ? s.coverageFromMs : Infinity)),
    );
    coverageToMs = Number.isFinite(status.coverageToMs) ? status.coverageToMs : null;
    days = model.planDays({
      nowMs,
      coverageFromMs: Number.isFinite(fromMs) ? fromMs : null,
      coverageToMs: Number.isFinite(status.coverageToMs) ? status.coverageToMs : null,
    });
    const channels = deps.getChannels();
    hasFavorites = model.selectChannels({ channels, isFavorite: deps.isFavorite, showAll: false }).length > 0;
    channelEntries = model.selectChannels({ channels, isFavorite: deps.isFavorite, showAll: viewState.showAll });
    channelByKey = new Map(channelEntries.map(c => [c.key, c.channel]));
    return true;
  }

  /**
   * Lädt Status, Tage und Daten. initial: Sprung auf „Jetzt“ nach dem ersten Tag;
   * sonst (epg:changed, Aktualisieren, Sender-Wechsel) bleibt die Position erhalten.
   */
  async function loadAll({ initial = false } = {}) {
    loadSeq += 1;
    const seq = loadSeq;
    loadError = '';
    loading = true;
    if (initial) {
      dayRows = new Map();
      dayPromises = new Map();
      layout = null;
      channelsWithEpg = new Set();
      gridView.reset();
      clearNodes();
    }
    try {
      if (!(await loadStatusAndPlan(seq))) return;
      renderStand();
      renderDayTabs();
      if (!viewState.dayKey || !days.some(d => d.key === viewState.dayKey)) {
        viewState.setDay(days.find(d => d.isToday)?.key || days[0]?.key || null);
        syncDayTabs();
      }
      if (!days.length || !channelEntries.length) {
        dayRows = new Map();
        dayPromises = new Map();
        layout = null;
        gridView.reset();
        clearNodes();
        loading = false;
        applyDerivedState(false);
        return;
      }
      applyDerivedState(true);
      // Neuabruf: frische Tage sammeln und gemeinsam austauschen (keine Zwischenzustände)
      const reload = !initial && layout !== null;
      const keep = reload ? [...dayRows.keys()] : [];
      if (!initial) {
        dayRows = new Map();
        dayPromises = new Map();
      }
      const order = loadOrder();
      const first = order[0];
      const firstTargets = reload ? order.filter(d => keep.includes(d.key)) : [first];
      await Promise.all(firstTargets.map(d => ensureDay(d, seq)));
      if (seq !== loadSeq) return;
      const hadLayout = layout !== null;
      let jumped = hadLayout;
      rebuildLayout({ keepPosition: hadLayout });
      syncGridData(reload);
      const state = applyDerivedState(rowCount() === 0 && order.length > firstTargets.length);
      if (state.kind === 'ready') {
        if (!jumped) {
          jumpNow();
          jumped = true;
        } else renderCurrent();
        follow();
      }
      loading = false;
      // übrige Tage im Hintergrund, nächster zuerst
      for (const day of order) {
        if (dayRows.has(day.key)) continue;
        await ensureDay(day, seq);
        if (seq !== loadSeq) return;
        rebuildLayout({ keepPosition: true });
        syncGridData(false);
        const next = applyDerivedState(rowCount() === 0 && day !== order[order.length - 1]);
        if (next.kind === 'ready') {
          if (!jumped) {
            jumpNow();
            jumped = true;
          } else renderCurrent();
          follow();
        }
      }
    } catch (err) {
      if (seq !== loadSeq) return;
      warn(err);
      loadError = scheduleUi.ipcErrorMessage(err);
      loading = false;
      applyDerivedState(false);
    }
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (isOpen) loadAll({ initial: false });
    }, SCROLL_RELOAD_DEBOUNCE_MS);
  }

  async function refreshMarkers() {
    try {
      const [s, r] = await Promise.all([api.listSchedules(), api.listRecordings()]);
      if (!isOpen) return;
      schedules = Array.isArray(s) ? s : [];
      recordings = Array.isArray(r) ? r : [];
      for (const entry of nodes.values()) entry.sig = '';
      renderWindow();
      gridView.invalidate();
      renderModal();
    } catch (err) {
      warn(err);
    }
  }

  function scheduleMarkers() {
    clearTimeout(markerTimer);
    markerTimer = setTimeout(() => {
      markerTimer = null;
      if (isOpen) refreshMarkers();
    }, MARKER_DEBOUNCE_MS);
  }

  // ── Scrollen und Sprünge ──

  function updateFollow() {
    if (!layout) return;
    const anchor = model.anchorTimeAt(layout, scroll.scrollTop);
    if (anchor !== null) viewState.setAnchor(anchor);
    const active = model.resolveActiveDay(layout, scroll.scrollTop, dayPin);
    dayPin = active.pin;
    const key = active.key;
    if (key && key !== viewState.dayKey) {
      viewState.setDay(key);
      syncDayTabs();
    }
  }

  function jumpToNow() {
    if (!layout) return;
    const top = model.scrollTopForNow(layout, scroll.clientHeight || 600, model.NOW_ANCHOR_RATIO, listHead.offsetHeight);
    scroll.scrollTop = top === null ? 0 : top;
    renderWindow();
    updateFollow();
  }

  /** Raster/Liste: Zeitanker und gewählten Tag nachführen (Scrollposition des aktiven Modus). */
  function follow() {
    if (viewState.mode === 'grid') followGrid();
    else updateFollow();
  }

  function followGrid() {
    const axis = gridView.getAxis();
    if (!axis || !isOpen) return;
    const left = gridView.scrollLeft();
    viewState.setAnchor(gridModel.anchorFromScrollLeft(viewState.anchorMs, left, axis, gridView.getZoom()));
    let key;
    if (dayPin && Math.abs(left - dayPin.top) < 2) key = dayPin.key;
    else {
      dayPin = null;
      key = gridModel.dayKeyAtTime(days, viewState.anchorMs);
    }
    if (key && key !== viewState.dayKey) {
      viewState.setDay(key);
      syncDayTabs();
    }
  }

  function renderCurrent() {
    if (viewState.mode === 'grid') gridView.render();
    else renderWindow();
  }

  function jumpNow() {
    if (viewState.mode === 'grid') {
      gridView.scrollToNow();
      followGrid();
    } else jumpToNow();
  }

  /** Raster-Daten (Achse, Sender mit EPG, Zoom) an das Raster geben. */
  function syncGridData(refetch) {
    gridView.configure({
      axis: gridModel.axisFor({ days, coverageToMs }),
      entries: gridModel.gridRowsFor(channelEntries, channelsWithEpg),
      zoom: viewState.zoom,
      refetch,
    });
  }

  function syncModeUi() {
    const grid_ = viewState.mode === 'grid';
    modeListBtn.classList.toggle('active', !grid_);
    modeGridBtn.classList.toggle('active', grid_);
    modeListBtn.setAttribute('aria-pressed', String(!grid_));
    modeGridBtn.setAttribute('aria-pressed', String(grid_));
    gridTools.hidden = !grid_;
    for (const btn of zoomBtns) {
      const active = Number(btn.dataset.zoom) === viewState.zoom;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  /** Moduswechsel Liste ↔ Raster: Tag, Zeitanker und Auswahl bleiben erhalten. */
  function setMode(mode) {
    if (!isOpen || !layout || mode === viewState.mode) return;
    follow();
    const anchor = viewState.anchorMs;
    if (!viewState.setMode(mode)) return;
    dayPin = null;
    syncModeUi();
    if (mode === 'grid') {
      syncGridData(false);
      scroll.hidden = true;
      gridView.setVisible(true);
      if (Number.isFinite(anchor)) gridView.scrollTime(anchor);
      else gridView.scrollToNow();
      const selected = viewState.selectedRowId;
      if (selected) gridView.revealChannel(selected.slice(0, selected.lastIndexOf('|')));
      followGrid();
    } else {
      gridView.setVisible(false);
      scroll.hidden = false;
      const top = Number.isFinite(anchor) ? model.scrollTopForTime(layout, anchor) : null;
      if (top !== null) scroll.scrollTop = top;
      renderWindow();
      updateFollow();
    }
  }

  function setZoom(zoom) {
    if (!viewState.setZoom(zoom)) return;
    syncModeUi();
    syncGridData(false);
    followGrid();
  }

  function jumpToClock(hour, minute) {
    const day = days.find(d => d.key === viewState.dayKey) || days.find(d => d.isToday) || days[0];
    if (!day || viewState.mode !== 'grid') return;
    gridView.scrollTime(grid.tvDayTime(day.startMs, hour, minute), 0.1);
    dayPin = null;
    followGrid();
  }

  async function goToNow() {
    dayPin = null;
    if (viewState.mode === 'grid') {
      gridView.scrollToNow();
      followGrid();
      return;
    }
    const today = days.find(d => d.isToday);
    if (!today) return;
    await ensureDay(today, loadSeq);
    if (!dayRows.has(today.key)) return;
    if (!layout || layout.nowIndex < 0) rebuildLayout({ keepPosition: false });
    jumpToNow();
  }

  async function goToDay(dayKey) {
    const idx = days.findIndex(d => d.key === dayKey);
    if (idx < 0) return;
    viewState.setDay(dayKey);
    syncDayTabs();
    if (viewState.mode === 'grid') {
      gridView.scrollTime(days[idx].startMs);
      dayPin = { key: dayKey, top: gridView.scrollLeft() };
      followGrid();
      return;
    }
    const seq = loadSeq;
    const todayIdx = Math.max(0, days.findIndex(d => d.isToday));
    const between = days.slice(Math.min(idx, todayIdx), Math.max(idx, todayIdx) + 1);
    if (between.some(d => !dayRows.has(d.key))) {
      await Promise.all(between.map(d => ensureDay(d, seq)));
      if (seq !== loadSeq || !isOpen) return;
      rebuildLayout({ keepPosition: true });
    }
    const top = layout ? model.scrollTopForDay(layout, dayKey) : null;
    if (top === null) return;
    scroll.scrollTop = top;
    dayPin = { key: dayKey, top: scroll.scrollTop };
    renderWindow();
    updateFollow();
    viewState.setDay(dayKey);
    syncDayTabs();
  }

  function onScroll() {
    scheduleRender();
    updateFollow();
  }

  function onResize() {
    if (!isOpen) return;
    scheduleRender();
    gridView.scheduleRender();
  }

  // ── Tick (30 s): Fortschritt ohne Neuaufbau ──

  function tick() {
    if (!isOpen || loading) return;
    const nowMs = now();
    if (grid.tvDayOf(nowMs).key !== todayKey) {
      scheduleReload();
      return;
    }
    renderStand();
    if (!layout) return;
    if (viewState.mode === 'grid') gridView.tick();
    const next = model.buildLayout(loadedRun(), nowMs);
    if (next.nowIndex !== layout.nowIndex) rebuildLayout({ keepPosition: true });
    renderWindow();
  }

  // ── Zeilen- und Toggle-Aktionen ──

  function resolveDetail(row) {
    let promise = detailCache.get(row.id);
    if (!promise) {
      promise = Promise.resolve()
        .then(() => api.findEpg(row.channelKey, row.start))
        .catch(err => {
          warn(err);
          return null;
        });
      detailCache.set(row.id, promise);
    }
    return promise;
  }

  function setNotice(message, ok = false) {
    if (!isOpen) return;
    if (backdrop.hidden) {
      showToast(message, ok);
      return;
    }
    dNotice.textContent = message || '';
    dNotice.hidden = !message;
    dNotice.classList.toggle('ok', !!message && ok);
  }

  function showToast(message, ok = false) {
    clearTimeout(toastTimer);
    toastEl.textContent = message || '';
    toastEl.hidden = !message;
    toastEl.classList.toggle('ok', !!message && ok);
    if (message) {
      toastTimer = setTimeout(() => {
        toastEl.hidden = true;
        toastTimer = null;
      }, TOAST_MS);
    }
  }

  function closeConfirm({ restoreFocus = true } = {}) {
    if (confirmEl.hidden) return;
    const ctx = confirmCtx;
    confirmCtx = null;
    confirmEl.hidden = true;
    if (restoreFocus && ctx) focusOpener(ctx.returnTo);
  }

  function focusOpener(target) {
    if (target && target.isConnected && typeof target.focus === 'function') {
      target.focus();
      return;
    }
    (backdrop.hidden ? scroll : dToggle).focus();
  }

  function askConfirm(kind, title, returnTo, onYes) {
    const copy = model.confirmCopy(kind, title);
    confirmText.textContent = copy.message;
    confirmYes.textContent = copy.yes;
    confirmNo.textContent = copy.no;
    confirmCtx = { returnTo, onYes };
    confirmEl.hidden = false;
    confirmNo.focus();
  }

  async function runToggle(row, returnTo) {
    setNotice('');
    const marker = markerFor(row);
    const toggle = model.toggleState({ row, marker, nowMs: now() });
    if (toggle.disabled) {
      setNotice(toggle.hint);
      return;
    }
    if (toggle.kind === 'record') {
      let description = '';
      if (toggle.verdict === 'future') {
        const slot = await resolveDetail(row);
        description = slot && typeof slot.desc === 'string' ? slot.desc : '';
      }
      deps.recordProgramme({
        title: row.title,
        description,
        channel: row.channel.name || '',
        channelId: row.channel.id || '',
        tvgId: row.channel.tvgId || '',
        startMs: row.start,
        stopMs: row.stop,
      });
      return;
    }
    const targets = model.resolveMarkerTargets(marker, schedules);
    if (toggle.kind === 'cancel') {
      if (!targets.scheduleIds.length) {
        setNotice('Die geplante Aufnahme wurde nicht gefunden.');
        return;
      }
      askConfirm('cancel', targets.titles.join(' · ') || row.title, returnTo, async () => {
        for (const id of targets.scheduleIds) {
          try {
            await api.removeSchedule(id);
          } catch (err) {
            setNotice(`Absagen nicht möglich: ${scheduleUi.ipcErrorMessage(err)}`);
          }
        }
        refreshMarkers();
      });
      return;
    }
    if (!targets.recIds.length) {
      setNotice('Die laufende Aufnahme konnte nicht zugeordnet werden. Stoppe sie im Player oder in der Aufnahmen-Bibliothek.');
      return;
    }
    askConfirm('stop', targets.titles.join(' · ') || row.title, returnTo, async () => {
      for (const recId of targets.recIds) {
        try {
          await deps.stopRecording(recId);
        } catch (err) {
          setNotice(`Aufnahme konnte nicht gestoppt werden: ${scheduleUi.ipcErrorMessage(err)}`);
        }
      }
      refreshMarkers();
    });
  }

  // ── Modal ──

  function renderModal() {
    if (backdrop.hidden || !modalRow) return;
    const row = modalRow;
    const marker = markerFor(row);
    const toggle = model.toggleState({ row, marker, nowMs: now() });
    dToggle.textContent = toggle.label;
    dToggle.dataset.kind = toggle.kind;
    dToggle.disabled = toggle.disabled;
    dHint.textContent = toggle.hint;
    dHint.hidden = !toggle.hint;
    dPlanned.hidden = !marker;
    if (marker) {
      dPlannedText.textContent = marker.state === 'recording' ? 'Aufnahme läuft' : 'Aufnahme geplant ✓';
      dPlannedLink.hidden = marker.state !== 'scheduled';
    }
  }

  function openDetail(row) {
    modalRow = row;
    modalSeq += 1;
    const seq = modalSeq;
    viewState.select(row.id);
    for (const entry of nodes.values()) entry.sig = '';
    renderWindow();
    gridView.invalidate();
    dTitle.textContent = row.title || '(ohne Titel)';
    const minutes = model.durationMinutes(row.start, row.stop);
    dMeta.textContent = `${model.formatDetailTime(row.start, row.stop)} · ${minutes} min · ${row.channel.name || row.channelKey}`;
    dDesc.textContent = 'Beschreibung wird geladen …';
    dNotice.hidden = true;
    dNotice.textContent = '';
    dNotice.classList.remove('ok');
    const mediathek = deps.getMediathek ? deps.getMediathek(row.channel, row.title) : null;
    dMediathek.hidden = !mediathek;
    dMediathek.textContent = mediathek ? mediathek.label : '';
    mediathekOpen = mediathek ? mediathek.open : null;
    backdrop.hidden = false;
    renderModal();
    (dToggle.disabled ? dClose : dToggle).focus();
    resolveDetail(row).then(slot => {
      if (seq !== modalSeq || backdrop.hidden) return;
      dDesc.textContent = slot && slot.desc ? slot.desc : 'Keine Beschreibung verfügbar.';
    });
  }

  function closeDetail() {
    if (backdrop.hidden) return;
    closeConfirm({ restoreFocus: false });
    backdrop.hidden = true;
    modalRow = null;
    modalSeq += 1;
    const rowId = viewState.selectedRowId;
    const entry = rowId ? nodes.get(`r:${rowId}`) : null;
    gridView.invalidate();
    focusOpener(viewState.mode === 'grid' ? gridView.blockElement(rowId) : entry ? entry.refs.open : null);
  }

  // ── Ereignisse ──

  function onListClick(event) {
    const rowEl = event.target.closest('.epg-list-row');
    if (!rowEl) return;
    const row = rowsById.get(rowEl.dataset.rowId);
    if (!row) return;
    const toggleEl = event.target.closest('.epg-toggle');
    if (toggleEl) {
      runToggle(row, toggleEl);
      return;
    }
    openDetail(row);
  }

  function onRootKeydown(event) {
    if (!confirmEl.hidden) {
      trapTab(event, confirmEl);
      return;
    }
    if (!backdrop.hidden) {
      trapTab(event, modal);
      return;
    }
    trapTab(event, root);
  }

  function addHandler(target, type, fn) {
    target.addEventListener(type, fn);
    subs.push(() => target.removeEventListener(type, fn));
  }

  function bind() {
    addHandler(spacer, 'click', onListClick);
    addHandler(scroll, 'scroll', onScroll);
    addHandler(window, 'resize', onResize);
    addHandler(root, 'keydown', onRootKeydown);
    addHandler(nowBtn, 'click', () => goToNow());
    addHandler(modeListBtn, 'click', () => setMode('list'));
    addHandler(modeGridBtn, 'click', () => setMode('grid'));
    addHandler(jump2015Btn, 'click', () => jumpToClock(20, 15));
    addHandler(jump2200Btn, 'click', () => jumpToClock(22, 0));
    for (const btn of zoomBtns) addHandler(btn, 'click', () => setZoom(Number(btn.dataset.zoom)));
    addHandler(closeBtn, 'click', () => close());
    addHandler(refreshBtn, 'click', () => refresh());
    addHandler(stateBtn, 'click', () => {
      if (stateBtn.dataset.action === 'show-all') {
        viewState.setShowAll(true);
        loadAll({ initial: true });
      } else {
        refresh();
      }
    });
    addHandler(dClose, 'click', () => closeDetail());
    addHandler(backdrop, 'click', e => {
      if (e.target === backdrop) closeDetail();
    });
    addHandler(dToggle, 'click', () => {
      if (modalRow) runToggle(modalRow, dToggle);
    });
    addHandler(dPlannedLink, 'click', () => {
      close();
      if (typeof deps.showPlanned === 'function') deps.showPlanned();
    });
    addHandler(dWatch, 'click', () => {
      const row = modalRow;
      close();
      if (row && typeof deps.openChannel === 'function') deps.openChannel(row.channel);
    });
    addHandler(dMediathek, 'click', () => {
      const run = mediathekOpen;
      close();
      if (typeof run === 'function') run();
    });
    addHandler(confirmYes, 'click', () => {
      const ctx = confirmCtx;
      closeConfirm();
      if (ctx) ctx.onYes();
    });
    addHandler(confirmNo, 'click', () => closeConfirm());
    for (const [name, handler] of [
      ['onEpgChanged', scheduleReload],
      ['onScheduleChanged', scheduleMarkers],
      ['onRecordingChanged', scheduleMarkers],
    ]) {
      if (typeof api[name] === 'function') {
        const off = api[name](handler);
        if (typeof off === 'function') subs.push(off);
      }
    }
    tickTimer = setInterval(tick, TICK_MS);
    subs.push(() => clearInterval(tickTimer));
    root.dataset.subs = String(subs.length);
  }

  function unbind() {
    for (const off of subs) off();
    subs = [];
    tickTimer = null;
    clearTimeout(reloadTimer);
    clearTimeout(markerTimer);
    clearTimeout(toastTimer);
    reloadTimer = markerTimer = toastTimer = null;
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    root.dataset.subs = '0';
  }

  function clearNodes() {
    nodes = new Map();
    spacer.textContent = '';
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↻ Aktualisiere …';
    try {
      status = await api.refreshEpgCache();
      renderStand();
    } catch (err) {
      warn(err);
      showToast(`Aktualisieren fehlgeschlagen: ${scheduleUi.ipcErrorMessage(err)}`);
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Aktualisieren';
    }
    if (isOpen) loadAll({ initial: false });
  }

  // ── Öffentliche API ──

  function open() {
    if (isOpen) return;
    isOpen = true;
    opener = document.activeElement;
    root.style.display = 'flex';
    detailCache = new Map();
    viewState.select(null);
    syncModeUi();
    bind();
    showState({ kind: 'loading', title: 'EPG wird geladen …', text: '', action: null });
    refreshMarkers();
    nowBtn.focus();
    loadAll({ initial: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    loadSeq += 1;
    closeConfirm({ restoreFocus: false });
    backdrop.hidden = true;
    modalRow = null;
    modalSeq += 1;
    root.style.display = 'none';
    unbind();
    // Daten und Knoten freigeben (Ansichtszustand wie Tag/Modus bleibt für die Sitzung)
    dayRows = new Map();
    dayPromises = new Map();
    detailCache = new Map();
    rowsById = new Map();
    layout = null;
    dayPin = null;
    gridView.reset();
    channelsWithEpg = new Set();
    coverageToMs = null;
    spacer.style.height = '';
    schedules = [];
    recordings = [];
    channelEntries = [];
    channelByKey = new Map();
    days = [];
    status = null;
    loading = false;
    clearNodes();
    dayTabs.textContent = '';
    toastEl.hidden = true;
    const back = opener;
    opener = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  /** Esc-Kette: erst Rückfrage, dann Detail-Modal, dann Overlay. true = Taste verbraucht. */
  function handleEscape() {
    if (!isOpen) return false;
    if (!confirmEl.hidden) {
      closeConfirm();
      return true;
    }
    if (!backdrop.hidden) {
      closeDetail();
      return true;
    }
    close();
    return true;
  }

  return {
    open,
    close,
    handleEscape,
    isOpen: () => isOpen,
    notify: setNotice,
    getState: () => viewState.snapshot(),
  };
}

module.exports = { createEpgView };
