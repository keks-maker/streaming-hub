'use strict';

// Genre-Seite (arte): Reihen des Genres mit Nachladen. Dünne Ansicht über mediathek-series-model.js (createGenrePage).

const { createGenrePage } = require('./mediathek-series-model.js');
const { sourceBadge } = require('./mediathek-format.js');
const { el, button, setIcon, createRow, appendToRow, createCardFactory } = require('./mediathek-cards.js');

const BACK_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>';

/** ctx: { api, back(), isFavorite, isBlocked, play, openDetail, openSeries, openGenre, toggleFavorite } */
function createMediathekGenreView(root, ctx) {
  const doc = root.ownerDocument || document;
  const cards = createCardFactory(doc, ctx);
  let page = null;
  let unsubscribe = null;

  function enter(genre) {
    if (unsubscribe) unsubscribe();
    page = createGenrePage({ api: ctx.api, genre });
    unsubscribe = page.subscribe(render);
    render();
    page.load();
  }

  function render() {
    if (!page) return;
    const state = page.snapshot();
    const hadFocus = root.contains(doc.activeElement) && doc.activeElement.id === 'mediathekGenreBack';
    root.textContent = '';
    const head = el(doc, 'header', 'mediathek-page-head');
    const back = el(doc, 'button', 'mediathek-back');
    back.type = 'button';
    back.id = 'mediathekGenreBack';
    back.setAttribute('aria-label', 'Zurück zu den Mediatheken');
    const icon = el(doc, 'span');
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, BACK_SVG);
    back.append(icon, el(doc, 'span', '', 'Mediatheken'));
    back.addEventListener('click', () => ctx.back());
    const text = el(doc, 'div', 'mediathek-page-head-text');
    text.appendChild(el(doc, 'p', 'mediathek-eyebrow', `${sourceBadge('arte')} · GENRE`));
    const title = el(doc, 'h2', 'mediathek-hero-title', state.genre.title);
    title.id = 'mediathekGenreTitle';
    text.appendChild(title);
    head.append(back, text);
    root.setAttribute('aria-labelledby', 'mediathekGenreTitle');
    root.appendChild(head);

    if (state.status === 'loading' || state.status === 'idle') {
      const line = el(doc, 'div', 'mediathek-block mediathek-status');
      line.setAttribute('role', 'status');
      const spin = el(doc, 'span', 'mediathek-spinner');
      spin.setAttribute('aria-hidden', 'true');
      line.append(spin, el(doc, 'span', '', 'Genre wird geladen …'));
      root.appendChild(line);
    } else if (state.status === 'failed') {
      const box = el(doc, 'div', 'mediathek-block mediathek-error');
      box.setAttribute('role', 'alert');
      box.append(el(doc, 'span', '', `Laden fehlgeschlagen: ${state.error}`), button(doc, 'mediathek-btn', 'Erneut versuchen', () => page.load()));
      root.appendChild(box);
    } else {
      let shown = 0;
      state.sections.forEach((section, index) => {
        if (!section.entries.length && !section.series.length && !section.genres.length) return;
        shown += 1;
        const row = createRow(doc, {
          id: `genre-${index}`,
          title: section.title,
          canMore: Boolean(section.nextPage),
          moreState: section.moreState,
          onMore: () => page.loadMore(index),
        });
        section.genres.forEach(genre => appendToRow(row.list, cards.genre(genre)));
        section.series.forEach(series => appendToRow(row.list, cards.series(series)));
        section.entries.forEach(entry => appendToRow(row.list, cards.entry(entry, null)));
        root.appendChild(row.section);
      });
      if (!shown) root.appendChild(el(doc, 'p', 'mediathek-hint mediathek-empty', 'In diesem Genre ist nichts verfügbar.'));
    }
    if (hadFocus) {
      const target = root.querySelector('#mediathekGenreBack');
      if (target) target.focus({ preventScroll: true });
    }
  }

  return {
    enter,
    render,
    focusFirst() {
      const target = root.querySelector('#mediathekGenreBack');
      if (target) target.focus();
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
}

module.exports = { createMediathekGenreView };
