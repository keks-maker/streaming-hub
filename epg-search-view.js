// Trefferliste der Suche (Etappe 3.5, M8/P11): liegt über dem Inhalt des Programmführers.
//
// Reine DOM-Sicht: Zustand und Zeilen kommen aus epg-view.js (Daten und Zustandslogik in
// epg-search-model.js). Eine Zeile je Treffer: Titel · Sender · Wochentag Uhrzeit; ein Klick ruft onPick(row).
// Texte aus dem EPG nur per textContent.

'use strict';

const searchModel = require('./epg-search-model.js');
const { h } = require('./epg-dom.js');

/** deps: onPick(row), onClose() */
function createSearchView(deps) {
  const summary = h('span', { className: 'epg-search-summary', attrs: { 'aria-live': 'polite' } });
  const closeBtn = h('button', { className: 'epg-btn epg-search-close', id: 'epgSearchClose', type: 'button', text: '✕ Suche schließen (Esc)' });
  const headRow = h('div', { className: 'epg-search-head' }, [summary, closeBtn]);
  const list = h('div', { className: 'epg-search-list', id: 'epgSearchList', attrs: { role: 'list', 'aria-label': 'Suchergebnisse' } });
  const note = h('p', { className: 'epg-search-note', id: 'epgSearchNote', attrs: { role: 'status' } });
  const el = h('div', { className: 'epg-search', id: 'epgSearch', hidden: true }, [headRow, note, list]);
  let rowsById = new Map();

  closeBtn.addEventListener('click', () => {
    if (typeof deps.onClose === 'function') deps.onClose();
  });
  list.addEventListener('click', event => {
    const btn = event.target.closest('.epg-search-hit');
    if (!btn) return;
    const row = rowsById.get(btn.dataset.rowId);
    if (row && typeof deps.onPick === 'function') deps.onPick(row);
  });

  /**
   * state: deriveSearchState-Ergebnis; rows: Zeilen der Treffer; query: gesuchter Text (Überschrift);
   * includeDesc: Beschreibung wird mitdurchsucht (Hinweis in der Überschrift).
   */
  function render({ state, rows, query, includeDesc, nowMs }) {
    list.textContent = '';
    rowsById = new Map();
    const hasRows = state.kind === 'results' || (state.kind === 'loading' && rows.length > 0);
    if (hasRows) {
      const count = rows.length;
      summary.textContent = `${count} Treffer für „${query}“${includeDesc ? ' · inkl. Beschreibung' : ''}`;
    } else {
      summary.textContent = query ? `Suche nach „${query}“${includeDesc ? ' · inkl. Beschreibung' : ''}` : '';
    }
    note.textContent = state.text || '';
    note.hidden = !state.text;
    note.dataset.kind = state.kind;
    if (!hasRows) return;
    for (const row of rows) {
      const parts = searchModel.hitParts(row, nowMs);
      rowsById.set(row.id, row);
      const btn = h('button', { className: 'epg-search-hit', type: 'button', attrs: { role: 'listitem' } }, [
        h('span', { className: 'epg-search-title', text: parts.title }),
        h('span', { className: 'epg-search-channel', text: parts.channel }),
        h('span', { className: 'epg-search-when', text: parts.when }),
      ]);
      btn.dataset.rowId = row.id;
      btn.title = `${parts.title} · ${parts.channel} · ${parts.when}`;
      list.appendChild(btn);
    }
  }

  return {
    el,
    render,
    show: () => {
      el.hidden = false;
    },
    hide: () => {
      el.hidden = true;
      list.textContent = '';
      rowsById = new Map();
    },
    isShown: () => !el.hidden,
    firstHit: () => list.querySelector('.epg-search-hit'),
  };
}

module.exports = { createSearchView };
