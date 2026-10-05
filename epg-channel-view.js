// KANALANSICHT des EPG-Programmführers (Etappe 3.4): Kopfzeile mit Zurück, Logo und Kanalname,
// eine Programmliste über 7 TV-Tage (Tag-Köpfe, Zeit, Titel, Genre, Dauer, Aufnahme-Toggle).
// Rein darstellend: Daten, Marker, Auswahl, Detail-Modal und die Toggle-Aktionen (Planen, Rückfrage,
// Stoppen) gehören epg-view.js und werden über deps angebunden — es gibt keine zweite Toggle-Logik.
// Zeilenaufbau und -aktualisierung kommen aus epg-row-dom.js (gleicher Code wie die Liste).
//
// Die Liste hat höchstens ~300 Zeilen (7 Tage × ein Sender) und wird ohne Virtualisierung gebaut.
// Der 30-s-Tick baut nichts neu: update() aktualisiert nur Fortschritt, Klassen und Kennzeichen.
//
// Alle Texte (Kanalname, Titel) nur per textContent/createElement — nie über HTML-Strings.

'use strict';

const model = require('./epg-channel-model.js');
const { createRowNode, updateRowNode } = require('./epg-row-dom.js');
const { h, createChannelLogo } = require('./epg-dom.js');

/** „Jetzt“ steht beim Anspringen auf dieser Höhe des Viewports. */
const NOW_ANCHOR_RATIO = 0.3;

/**
 * deps:
 *   now()                        Uhr
 *   sanitizeLogoUrl(url)         Logo-URL prüfen (Renderer: safeResourceUrl); ohne Funktion kein Logo
 *   getMarkers(rows)             grid.matchMarkers-Ergebnis je Zeile (gleiche Reihenfolge)
 *   isSelected(rowId)            Auswahl (gemeinsam mit Liste und Raster)
 *   onBack()                     Zurück-Button
 *   onOpen(row, element)         Klick auf eine Zeile → Detail-Modal
 *   onToggle(row, element)       Klick auf den Aufnahme-Toggle → bestehender Toggle-Weg in epg-view.js
 *   onAction(action)             Aktion des Zustands-Buttons ('refresh')
 *   onScroll()                   Scrollposition hat sich geändert (aktiven Tab nachführen)
 */
function createChannelView(deps) {
  let dayData = [];
  let signature = '';
  let nodes = new Map(); // rowId → { el, refs, sig, variant }
  let rowsById = new Map();
  let marks = { running: null, next: null };
  let stateKind = 'ready';

  const backBtn = h('button', { className: 'epg-btn epg-channel-back', id: 'epgChannelBack', type: 'button', text: '← Alle Sender' });
  backBtn.title = 'Zurück zur Übersicht (Esc)';
  const logoHost = h('span', { className: 'epg-channel-logo-host' });
  const nameEl = h('h2', { className: 'epg-channel-name', id: 'epgChannelName' });
  const nowEl = h('div', { className: 'epg-channel-now', id: 'epgChannelNow', attrs: { 'aria-live': 'off' } });
  const nowLabel = h('span');
  const nowTitle = h('b');
  const nowSuffix = h('span');
  nowEl.append(nowLabel, nowTitle, nowSuffix);
  const span = h('span', { className: 'epg-channel-span', text: '7 TV-Tage · Tag = 05:00–05:00' });
  const head = h('div', { className: 'epg-channel-head' }, [backBtn, logoHost, h('div', { className: 'epg-channel-title' }, [nameEl, nowEl]), span]);

  const list = h('div', { className: 'epg-channel-list', id: 'epgChannelList', attrs: { role: 'list', tabindex: '0' } });
  const stateTitle = h('div', { className: 'epg-state-title' });
  const stateText = h('div', { className: 'epg-state-text' });
  const stateBtn = h('button', { className: 'epg-btn epg-state-btn', type: 'button', hidden: true });
  const stateEl = h('div', { className: 'epg-state epg-channel-state', id: 'epgChannelState', attrs: { role: 'status' }, hidden: true }, [
    stateTitle,
    stateText,
    stateBtn,
  ]);
  const el = h('div', { className: 'epg-channel', id: 'epgChannel', hidden: true }, [head, list, stateEl]);

  backBtn.addEventListener('click', () => deps.onBack());
  stateBtn.addEventListener('click', () => deps.onAction(stateBtn.dataset.action || ''));
  list.addEventListener('scroll', () => deps.onScroll());
  list.addEventListener('click', event => {
    const rowEl = event.target.closest('.epg-crow');
    if (!rowEl) return;
    const row = rowsById.get(rowEl.dataset.rowId);
    if (!row) return;
    const toggleEl = event.target.closest('.epg-toggle');
    if (toggleEl) deps.onToggle(row, toggleEl);
    else deps.onOpen(row, rowEl.querySelector('.epg-row-open'));
  });

  // ── Kopf ──

  /** Name und Logo des Senders; meta aus epg-channel-model.channelMeta, channel = Playlist-Kanalobjekt. */
  function setChannel(meta, channel) {
    nameEl.textContent = meta.name;
    logoHost.textContent = '';
    logoHost.appendChild(createChannelLogo({ name: meta.name, channel, sanitizeLogoUrl: deps.sanitizeLogoUrl, extraClass: 'epg-channel-logo' }));
    backBtn.setAttribute('aria-label', 'Zurück zu allen Sendern');
    list.setAttribute('aria-label', `Sendungen von ${meta.name}`);
  }

  function renderNowLine(nowMs) {
    const line = model.nowLine(dayData, nowMs);
    nowLabel.textContent = line.label;
    nowTitle.textContent = line.title;
    nowSuffix.textContent = line.suffix;
  }

  // ── Zustand ──

  function setState(next) {
    stateKind = next.kind;
    const ready = next.kind === 'ready';
    list.hidden = !ready;
    stateEl.hidden = ready;
    el.dataset.state = next.kind;
    if (ready) return;
    stateTitle.textContent = next.title;
    stateText.textContent = next.text;
    stateText.hidden = !next.text;
    stateBtn.hidden = !next.action;
    stateBtn.dataset.action = next.action || '';
    stateBtn.textContent = 'Jetzt aktualisieren';
  }

  // ── Daten und Liste ──

  /** Oberste (teilweise) sichtbare Zeile + Abstand: Anker, damit ein Neuaufbau die Position hält. */
  function captureAnchor() {
    const top = list.scrollTop;
    for (const [id, entry] of nodes) {
      if (entry.el.offsetTop + entry.el.offsetHeight > top) return { id, delta: top - entry.el.offsetTop };
    }
    return null;
  }

  function buildDay(entry) {
    const block = h('div', { className: `epg-cday${entry.empty ? ' is-empty' : ''}` });
    block.dataset.dayKey = entry.day.key;
    block.appendChild(h('div', { className: 'epg-cday-head', text: entry.day.heading, attrs: { role: 'presentation' } }));
    if (entry.empty) {
      block.appendChild(h('p', { className: 'epg-cday-note', text: model.emptyDayNote(entry.day) }));
      return block;
    }
    for (const row of entry.rows) {
      const node = createRowNode(row, { variant: 'channel' });
      nodes.set(row.id, node);
      rowsById.set(row.id, row);
      block.appendChild(node.el);
    }
    return block;
  }

  /**
   * Daten setzen. Unveränderte Daten (gleiche Signatur) lassen den DOM unangetastet (kein Flackern bei
   * epg:changed ohne Änderung); sonst Neuaufbau mit gehaltener Scrollposition. Rückgabe: neu aufgebaut?
   */
  function setData(nextDayData) {
    const nextSig = model.dataSignature(nextDayData);
    dayData = nextDayData;
    if (nextSig === signature && nodes.size > 0) {
      update();
      return false;
    }
    const anchor = captureAnchor();
    const previousTop = list.scrollTop;
    signature = nextSig;
    nodes = new Map();
    rowsById = new Map();
    list.textContent = '';
    for (const entry of dayData) list.appendChild(buildDay(entry));
    if (anchor && nodes.has(anchor.id)) list.scrollTop = nodes.get(anchor.id).el.offsetTop + anchor.delta;
    else list.scrollTop = previousTop;
    update();
    return true;
  }

  /** Fortschritt, Klassen, Marker, Toggle und Kennzeichen aller Zeilen; baut nichts neu auf. */
  function update() {
    const nowMs = deps.now();
    marks = model.highlights(dayData, nowMs);
    renderNowLine(nowMs);
    if (!nodes.size) return;
    const rows = [];
    for (const id of nodes.keys()) rows.push(rowsById.get(id));
    const markers = deps.getMarkers(rows);
    rows.forEach((row, i) => {
      updateRowNode(nodes.get(row.id), row, {
        nowMs,
        marker: markers[i] || null,
        selected: deps.isSelected(row.id),
        flag: model.flagFor(row, marks),
      });
    });
  }

  /** Signaturen zurücksetzen und neu zeichnen (Marker, Auswahl). */
  function invalidate() {
    for (const entry of nodes.values()) entry.sig = '';
    update();
  }

  // ── Scrollen ──

  function dayTops() {
    return [...list.querySelectorAll('.epg-cday')].map(block => ({ key: block.dataset.dayKey, top: block.offsetTop }));
  }

  function dayTop(dayKey) {
    const block = list.querySelector(`.epg-cday[data-day-key="${CSS.escape(dayKey)}"]`);
    return block ? block.offsetTop : null;
  }

  function scrollToDay(dayKey) {
    const top = dayTop(dayKey);
    if (top === null) return null;
    list.scrollTop = top;
    return list.scrollTop;
  }

  /** Zeile so scrollen, dass sie auf NOW_ANCHOR_RATIO der Höhe steht (laufende/nächste Sendung). */
  function scrollToRow(rowId) {
    const node = nodes.get(rowId);
    if (!node) return null;
    list.scrollTop = Math.max(0, node.el.offsetTop - (list.clientHeight || 400) * NOW_ANCHOR_RATIO);
    return list.scrollTop;
  }

  /** Ziel aus epg-channel-model.initialTarget anspringen; liefert die erreichte Position oder null. */
  function scrollToTarget(target) {
    if (!target) return null;
    return target.kind === 'row' ? scrollToRow(target.rowId) : scrollToDay(target.dayKey);
  }

  // ── Fokus ──

  function rowOpenElement(rowId) {
    const node = nodes.get(rowId);
    return node ? node.refs.open : null;
  }

  function reset() {
    dayData = [];
    signature = '';
    nodes = new Map();
    rowsById = new Map();
    marks = { running: null, next: null };
    list.textContent = '';
    list.scrollTop = 0;
    stateEl.hidden = true;
    list.hidden = false;
    logoHost.textContent = '';
    nameEl.textContent = '';
  }

  return {
    el,
    backBtn,
    list,
    setChannel,
    setState,
    setData,
    update,
    invalidate,
    reset,
    dayTops,
    scrollToDay,
    scrollToRow,
    scrollToTarget,
    scrollTop: () => list.scrollTop,
    setScrollTop: px => {
      list.scrollTop = px;
    },
    rowOpenElement,
    getRow: rowId => rowsById.get(rowId) || null,
    hasRows: () => nodes.size > 0,
    getState: () => stateKind,
    getMarks: () => marks,
  };
}

module.exports = { createChannelView };
