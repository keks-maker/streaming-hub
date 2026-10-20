'use strict';

// Serienseite: Kopf (Zurück, Abspielen/Fortsetzen/Nächste Folge, Merken), Staffelauswahl, Sortierung und Folgenliste.
// Dünne Ansicht über mediathek-series-model.js.

const { createSeriesPage } = require('./mediathek-series-model.js');
const { sourceBadge, imageSrc, subtitleText, minutesText } = require('./mediathek-format.js');
const { el, button, createThumb, setIcon, PLAY_SVG, STAR_SVG, STAR_OUTLINE_SVG } = require('./mediathek-cards.js');

const BACK_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>';

/**
 * ctx: { api, back(), play(entry, series, trigger), openDetail(entry, series, trigger), isBlocked(id), toggleFavorite(series) -> Promise<bool|null>,
 *        onFavoritesChanged(listener) -> unsubscribe, announce(text) }
 */
function createMediathekSeriesView(root, ctx) {
  const doc = root.ownerDocument || document;
  let page = null;
  let unsubscribe = null;
  let current = null;

  function enter(series) {
    if (unsubscribe) unsubscribe();
    current = series;
    page = createSeriesPage({ api: ctx.api, series });
    unsubscribe = page.subscribe(render);
    render();
    page.load();
  }

  function reload() {
    if (page) page.load();
  }

  function hero(state) {
    const series = state.series;
    const box = el(doc, 'header', 'mediathek-hero');
    const src = imageSrc(series.imageUrl, 1280);
    if (src) {
      const bg = el(doc, 'img', 'mediathek-hero-img');
      bg.alt = '';
      bg.addEventListener('error', () => bg.remove());
      bg.src = src;
      box.appendChild(bg);
    }
    const back = el(doc, 'button', 'mediathek-back');
    back.type = 'button';
    back.id = 'mediathekSeriesBack';
    back.setAttribute('aria-label', 'Zurück zu den Mediatheken');
    const icon = el(doc, 'span');
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, BACK_SVG);
    back.append(icon, el(doc, 'span', '', 'Mediatheken'));
    back.addEventListener('click', () => ctx.back());

    const text = el(doc, 'div', 'mediathek-hero-text');
    text.appendChild(el(doc, 'p', 'mediathek-eyebrow', `${sourceBadge(series.sourceId)} · SERIE`));
    const title = el(doc, 'h2', 'mediathek-hero-title', series.title);
    title.id = 'mediathekSeriesTitle';
    text.appendChild(title);
    if (series.description) text.appendChild(el(doc, 'p', 'mediathek-hero-desc', series.description));

    const actions = el(doc, 'div', 'mediathek-actions');
    const play = el(doc, 'button', 'mediathek-btn mediathek-btn-primary');
    play.type = 'button';
    play.id = 'mediathekSeriesPlay';
    const playIcon = el(doc, 'span');
    playIcon.setAttribute('aria-hidden', 'true');
    setIcon(playIcon, PLAY_SVG);
    play.append(playIcon, el(doc, 'span', '', page.playLabel()));
    const target = state.playTarget && state.playTarget.entry;
    play.disabled = !target;
    if (target) {
      play.setAttribute('aria-label', `${page.playLabel()}: ${target.title}`);
      play.addEventListener('click', () => ctx.play(target, series, play));
    }
    const fav = el(doc, 'button', 'mediathek-btn mediathek-fav-btn');
    fav.type = 'button';
    fav.id = 'mediathekSeriesFav';
    const favIcon = el(doc, 'span');
    favIcon.setAttribute('aria-hidden', 'true');
    setIcon(favIcon, state.favorite ? STAR_SVG : STAR_OUTLINE_SVG);
    fav.append(favIcon, el(doc, 'span', '', state.favorite ? 'In Meine Serien' : 'Merken'));
    fav.classList.toggle('is-on', state.favorite);
    fav.setAttribute('aria-pressed', String(state.favorite));
    fav.setAttribute('aria-label', state.favorite ? 'Aus Meine Serien entfernen' : 'Zu Meine Serien hinzufügen');
    fav.addEventListener('click', async () => {
      const result = await ctx.toggleFavorite(series);
      if (typeof result === 'boolean') page.setFavorite(result);
    });
    actions.append(play, fav);
    text.appendChild(actions);
    box.append(back, text);
    return box;
  }

  function seasonChips(state) {
    const bar = el(doc, 'div', 'mediathek-chips mediathek-season-chips');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Staffel');
    const make = (label, number) => {
      const chip = button(doc, 'mediathek-chip', label, () => {
        page.selectSeason(number);
        ctx.announce(number === null ? 'Alle Staffeln' : `Staffel ${number}`);
      });
      const on = state.selectedSeason === number;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', String(on));
      chip.dataset.season = number === null ? 'all' : String(number);
      return chip;
    };
    bar.appendChild(make('Alle', null));
    state.seasonNumbers.forEach(number => bar.appendChild(make(`Staffel ${number}`, number)));
    return bar;
  }

  function sortControl(state) {
    const group = el(doc, 'div', 'mediathek-sort');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Sortierung');
    [
      { label: 'Älteste zuerst', value: false },
      { label: 'Neueste zuerst', value: true },
    ].forEach(option => {
      const btn = button(doc, 'mediathek-seg', option.label, () => page.setSort(option.value));
      btn.dataset.sort = option.value ? 'newest' : 'oldest';
      btn.classList.toggle('is-on', state.newestFirst === option.value);
      btn.setAttribute('aria-pressed', String(state.newestFirst === option.value));
      group.appendChild(btn);
    });
    return group;
  }

  function episodeRow(entry, series) {
    const blocked = ctx.isBlocked(entry.id);
    const item = el(doc, 'li', 'mediathek-episode');
    if (blocked) item.classList.add('is-blocked');
    item.dataset.entryId = entry.id;
    const main = el(doc, 'button', 'mediathek-episode-main');
    main.type = 'button';
    const sub = subtitleText(entry);
    main.setAttribute('aria-label', [entry.title, sub, minutesText(entry.duration), blocked ? 'nicht abrufbar' : 'abspielen'].filter(Boolean).join(', '));
    const text = el(doc, 'span', 'mediathek-episode-text');
    text.append(el(doc, 'span', 'mediathek-card-title', entry.title));
    if (sub) text.appendChild(el(doc, 'span', 'mediathek-card-sub', sub));
    main.append(createThumb(doc, { imageUrl: entry.imageUrl, title: entry.title, duration: entry.duration, geo: entry.regionRestricted, width: 480 }), text);
    main.addEventListener('click', () => ctx.play(entry, series, main));
    const info = button(doc, 'mediathek-info-btn is-inline', 'i', () => ctx.openDetail(entry, series, info), `Details zu ${entry.title}`);
    item.append(main, info);
    return item;
  }

  /** Selektor des fokussierten Bedienelements, um den Fokus nach dem Neuaufbau zurückzugeben. */
  function focusSelector() {
    const active = doc.activeElement;
    if (!active || !root.contains(active)) return null;
    if (active.id) return `#${active.id}`;
    if (active.dataset.sort) return `[data-sort="${active.dataset.sort}"]`;
    if (active.dataset.season) return `[data-season="${active.dataset.season}"]`;
    const row = active.closest('[data-entry-id]');
    if (row && row.dataset.entryId) return `[data-entry-id="${CSS.escape(row.dataset.entryId)}"] .${active.className.split(' ')[0]}`;
    return null;
  }

  function render() {
    if (!page) return;
    const state = page.snapshot();
    const selector = focusSelector();
    renderContent(state);
    if (selector) {
      const target = root.querySelector(selector);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function renderContent(state) {
    root.textContent = '';
    root.setAttribute('aria-labelledby', 'mediathekSeriesTitle');
    root.appendChild(hero(state));
    if (state.status === 'loading' || state.status === 'idle') {
      const line = el(doc, 'div', 'mediathek-block mediathek-status');
      line.setAttribute('role', 'status');
      const spin = el(doc, 'span', 'mediathek-spinner');
      spin.setAttribute('aria-hidden', 'true');
      line.append(spin, el(doc, 'span', '', 'Folgen werden geladen …'));
      root.appendChild(line);
      return;
    }
    if (state.status === 'failed') {
      const box = el(doc, 'div', 'mediathek-block mediathek-error');
      box.setAttribute('role', 'alert');
      box.append(el(doc, 'span', '', `Laden fehlgeschlagen: ${state.error}`), button(doc, 'mediathek-btn', 'Erneut versuchen', () => page.load()));
      root.appendChild(box);
      return;
    }
    const total = page.total();
    const head = el(doc, 'div', 'mediathek-episodes-head');
    const title = el(doc, 'h3', 'mediathek-group-title');
    title.append(el(doc, 'span', '', 'Folgen'), el(doc, 'span', 'mediathek-group-count', String(total)));
    head.append(title, sortControl(state));
    root.appendChild(head);
    if (page.showSeasonPicker()) root.appendChild(seasonChips(state));
    if (total === 0) {
      root.appendChild(el(doc, 'p', 'mediathek-hint mediathek-empty', 'Keine Folgen verfügbar.'));
      return;
    }
    for (const season of page.visibleSeasons()) {
      const section = el(doc, 'section', 'mediathek-season');
      const heading = el(doc, 'h3', 'mediathek-season-title', season.number === null ? 'Weitere Folgen' : `Staffel ${season.number}`);
      const list = el(doc, 'ul', 'mediathek-episode-list');
      season.entries.forEach(entry => list.appendChild(episodeRow(entry, state.series)));
      section.append(heading, list);
      root.appendChild(section);
    }
  }

  return {
    enter,
    reload,
    render,
    snapshot: () => (page ? page.snapshot() : null),
    currentSeries: () => current,
    focusFirst() {
      const target = root.querySelector('#mediathekSeriesPlay:not(:disabled)') || root.querySelector('#mediathekSeriesBack');
      if (target) target.focus();
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
    /** Favorit extern geändert (z. B. aus dem Detail-Fenster). */
    setFavorite(value) {
      if (page) page.setFavorite(value);
    },
  };
}

module.exports = { createMediathekSeriesView };
