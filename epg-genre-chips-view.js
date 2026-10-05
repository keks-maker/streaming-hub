// Genre-Chips der Schnellfilter-Leiste (Etappe 3.6, F3): „Alle“ + eine Schaltfläche je Genre-Gruppe.
//
// Reine DOM-Sicht: der Zustand liegt in epg-genre-filter-model.js (epg-view.js). Jeder Chip ist ein Button mit
// aria-pressed (Tastatur: Tab, Leertaste/Enter); aktive Chips tragen ein ✕ und lassen sich damit direkt wieder
// entfernen. Die Farbe (Punkt, data-g) ist nie alleiniger Träger: der Name steht als Text im Chip.

'use strict';

const filterModel = require('./epg-genre-filter-model.js');
const { h } = require('./epg-dom.js');
const { genreLabel } = require('./epg-genres.js');

/** deps: onToggle(genre), onClear() */
function createGenreChips(deps) {
  const allBtn = h('button', { className: 'epg-chip epg-chip-all', id: 'epgGenreAll', type: 'button', text: 'Alle', attrs: { title: 'Alle Genres zeigen (Filter aufheben)' } });
  const chips = new Map();
  const nodes = [allBtn];
  for (const genre of filterModel.ORDER) {
    const label = genreLabel(genre);
    const x = h('span', { className: 'epg-chip-x', text: '✕', attrs: { 'aria-hidden': 'true' } });
    const btn = h('button', { className: 'epg-chip', type: 'button', attrs: { 'aria-pressed': 'false' } }, [
      h('span', { className: 'epg-chip-dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { className: 'epg-chip-label', text: label }),
      x,
    ]);
    btn.id = `epgGenre_${genre}`;
    btn.dataset.genre = genre;
    btn.dataset.g = genre;
    btn.title = `Nur ${label} zeigen`;
    btn.addEventListener('click', () => {
      if (typeof deps.onToggle === 'function') deps.onToggle(genre);
    });
    chips.set(genre, { btn, label });
    nodes.push(btn);
  }
  allBtn.addEventListener('click', () => {
    if (typeof deps.onClear === 'function') deps.onClear();
  });
  const el = h('div', { className: 'epg-genre-chips', id: 'epgGenreChips', attrs: { role: 'group', 'aria-label': 'Genre filtern' } }, nodes);

  /** Zustand zeichnen: genres = aktive Gruppen. */
  function render(genres) {
    const active = new Set(genres);
    allBtn.setAttribute('aria-pressed', String(active.size === 0));
    allBtn.classList.toggle('active', active.size === 0);
    for (const [genre, { btn, label }] of chips) {
      const on = active.has(genre);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('active', on);
      btn.title = on ? `Filter ${label} entfernen` : `Nur ${label} zeigen`;
    }
  }

  render([]);

  return {
    el,
    render,
    setHidden: value => {
      el.hidden = !!value;
    },
    chipElement: genre => (chips.get(genre) ? chips.get(genre).btn : null),
  };
}

module.exports = { createGenreChips };
