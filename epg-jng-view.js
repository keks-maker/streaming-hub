// „Jetzt & Gleich“ (Etappe 3.5, M7): je Sender laufende, nächste und übernächste Sendung.
//
// Factory-Muster wie epg-channel-view.js: reine DOM-Sicht ohne Daten- oder Aufnahme-Logik. Die Zuordnung
// kommt aus epg-jng-model.js, Marker/Toggle/Fortschritt je Sendung aus epg-row-dom.js (Variante 'jng',
// dieselbe updateRowNode-Logik wie Liste und Kanalansicht) — Planen/Abbrechen/Stoppen läuft über den
// Callback onToggle (epg-view.js → runToggle, die einzige Aufnehmen-Logik).
//
// Virtualisierung: Zeilen mit fester Höhe (breit/schmal, siehe Modell), nur der sichtbare Bereich
// plus Überstand liegt im DOM. tick() schreibt den Fortschritt fort und baut nur Zeilen neu auf,
// deren Zuordnung (laufend/nächste/übernächste) sich geändert hat. Texte nur per textContent.

'use strict';

const jngModel = require('./epg-jng-model.js');
const { createRowNode, updateRowNode } = require('./epg-row-dom.js');
const { h, createChannelLogo } = require('./epg-dom.js');

const OVERSCAN_PX = 400;

/**
 * deps: now(), getMarkers(rows) → Marker je Zeile (wie grid.matchMarkers), isSelected(rowId), onOpen(row),
 * onToggle(row, element), onChannelClick(channel), sanitizeLogoUrl(url).
 */
function createJngView(deps) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  let channels = []; // [{ key, channel, rows, hasEpg }]
  let assignments = []; // je Kanal { current, next, after }
  let nodes = new Map(); // Kanal-Schlüssel → { el, cells: [entry|null ×3], sig, chan }
  let narrow = false;
  let frame = 0;
  let loadedAt = null;

  const head = h('div', { className: 'epg-jng-head', attrs: { 'aria-hidden': 'true' } }, [
    h('span', { text: 'Sender' }),
    h('span', { text: 'Läuft' }),
    h('span', { text: 'Danach' }),
    h('span', { text: 'Danach' }),
  ]);
  const spacer = h('div', { className: 'epg-jng-spacer', id: 'epgJngItems', attrs: { role: 'list', 'aria-label': 'Jetzt und Gleich' } });
  const scroll = h('div', { className: 'epg-jng-scroll', id: 'epgJng', attrs: { tabindex: '0' } }, [spacer]);
  const emptyEl = h('div', { className: 'epg-jng-empty', id: 'epgJngEmpty', attrs: { role: 'status' }, hidden: true });
  const el = h('div', { className: 'epg-jng', hidden: true }, [head, scroll, emptyEl]);

  function rowHeight() {
    return jngModel.rowHeight(narrow);
  }

  function viewportH() {
    return scroll.clientHeight || 600;
  }

  function recompute(nowMs = now()) {
    assignments = channels.map(channel => jngModel.assign(channel, nowMs));
  }

  function createPlaceholder(text, extraClass = '') {
    return h('div', { className: `epg-jcell is-empty${extraClass ? ` ${extraClass}` : ''}`, text });
  }

  function buildRowNode(index) {
    const channel = channels[index];
    const name = channel.channel.name || channel.key;
    const logo = createChannelLogo({ name, channel: channel.channel, sanitizeLogoUrl: deps.sanitizeLogoUrl });
    const chan = h('button', {
      className: 'epg-jchan',
      type: 'button',
      attrs: { 'aria-label': `Alle Sendungen von ${name}`, title: `Alle Sendungen von ${name}` },
    }, [logo, h('span', { className: 'epg-jchan-name', text: name })]);
    chan.addEventListener('click', () => {
      if (typeof deps.onChannelClick === 'function') deps.onChannelClick(channel.channel);
    });
    const slots = [0, 1, 2].map(() => h('div', { className: 'epg-jslot' }));
    const rowEl = h('div', { className: 'epg-jrow', attrs: { role: 'listitem' } }, [chan, ...slots]);
    rowEl.dataset.channelKey = channel.key;
    return { el: rowEl, slots, cells: [null, null, null], sig: '', chan };
  }

  /** Zellen einer Zeile neu aufbauen (nur bei geänderter Zuordnung). */
  function fillCells(entry, channel, assignment) {
    entry.cells = [null, null, null];
    const picks = [assignment.current, assignment.next, assignment.after];
    entry.slots.forEach((slot, i) => {
      slot.textContent = '';
      slot.classList.toggle('is-span', false);
      const row = picks[i];
      if (row) {
        const cell = createRowNode(row, { variant: 'jng' });
        cell.row = row;
        entry.cells[i] = cell;
        slot.appendChild(cell.el);
        return;
      }
      if (i === 0 && !channel.rows.length) {
        slot.classList.add('is-span');
        slot.appendChild(createPlaceholder(channel.hasEpg ? 'Kein Programm in den nächsten Stunden' : 'Kein EPG im Cache'));
        return;
      }
      if (i > 0 && !channel.rows.length) return;
      slot.appendChild(createPlaceholder(i === 0 ? 'Keine laufende Sendung' : '–'));
    });
  }

  function render() {
    frame = 0;
    if (el.hidden || !channels.length) {
      if (!channels.length) clearNodes();
      return;
    }
    const nowMs = now();
    const height = rowHeight();
    const top = scroll.scrollTop;
    const from = Math.max(0, Math.floor((top - OVERSCAN_PX) / height));
    const to = Math.min(channels.length, Math.ceil((top + viewportH() + OVERSCAN_PX) / height));
    const wanted = new Set();
    for (let i = from; i < to; i += 1) wanted.add(channels[i].key);
    for (const [key, entry] of nodes) {
      if (!wanted.has(key)) {
        entry.el.remove();
        nodes.delete(key);
      }
    }
    const visible = [];
    let j = 0;
    for (let i = from; i < to; i += 1) {
      const channel = channels[i];
      let entry = nodes.get(channel.key);
      if (!entry) {
        entry = buildRowNode(i);
        nodes.set(channel.key, entry);
      }
      entry.el.style.top = `${i * height}px`;
      entry.el.style.height = `${height}px`;
      const sig = jngModel.assignmentSig(assignments[i]);
      if (entry.sig !== sig) {
        entry.sig = sig;
        fillCells(entry, channel, assignments[i]);
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
  }

  function scheduleRender() {
    if (!frame) frame = window.requestAnimationFrame(render);
  }

  function clearNodes() {
    nodes = new Map();
    spacer.textContent = '';
  }

  function findCell(rowId) {
    for (const entry of nodes.values()) {
      for (const cell of entry.cells) if (cell && cell.row.id === rowId) return cell;
    }
    return null;
  }

  // Ein Klick-Handler für alle Zellen: Toggle → Aufnehmen-Logik des Overlays, sonst Detail-Modal
  spacer.addEventListener('click', event => {
    const cellEl = event.target.closest('.epg-jcell[data-row-id]');
    if (!cellEl) return;
    const cell = findCell(cellEl.dataset.rowId);
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
    channels = Array.isArray(next) ? next : [];
    emptyEl.hidden = channels.length > 0;
    loadedAt = loadedAtMs;
    clearNodes();
    recompute();
    spacer.style.height = `${channels.length * rowHeight()}px`;
    render();
  }

  /** Breites/schmales Layout (Fensterbreite < 900 px): feste Zeilenhöhe wechselt, Zeilen werden neu gelegt. */
  function setNarrow(value) {
    const on = !!value;
    if (on === narrow && el.classList.contains('is-narrow') === on) return;
    narrow = on;
    el.classList.toggle('is-narrow', on);
    spacer.style.height = `${channels.length * rowHeight()}px`;
    render();
  }

  /** 30-s-Takt: Zuordnung fortschreiben (Wechsel der laufenden Sendung), Fortschritt und Marker aktualisieren. */
  function tick() {
    if (!channels.length) return;
    recompute();
    render();
  }

  function setVisible(on) {
    el.hidden = !on;
    if (on) {
      recompute();
      render();
    }
  }

  function invalidate() {
    for (const entry of nodes.values()) for (const cell of entry.cells) if (cell) cell.sig = '';
    if (!el.hidden) render();
  }

  function reset() {
    channels = [];
    assignments = [];
    loadedAt = null;
    emptyEl.hidden = true;
    clearNodes();
    spacer.style.height = '';
    scroll.scrollTop = 0;
  }

  /** Fokus-Rückgabe: Kopf-Knopf (Sendername) einer Zeile oder null. */
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
      emptyEl.textContent = text || '';
    },
    channelElement,
    cellElement,
    count: () => channels.length,
    loadedAt: () => loadedAt,
    scrollToTop: () => {
      scroll.scrollTop = 0;
      render();
    },
    scrollTop: () => scroll.scrollTop,
    setScrollTop: value => {
      scroll.scrollTop = value;
      render();
    },
    /** Zeilen- und Zellenzahl im DOM (Virtualisierungstest). */
    domRowCount: () => spacer.children.length,
  };
}

module.exports = { createJngView };
