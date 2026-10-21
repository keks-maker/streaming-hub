'use strict';

// DOM-Bausteine der Mediathek-Oberfläche: Bild mit Platzhalter, Folgen-/Serien-/Genre-Karten und scrollbare Reihen.
// Texte der Sender kommen ausschließlich per textContent in den DOM. Funktionen nehmen das Dokument entgegen (testbar).

const { sourceBadge, sourceColor, subtitleText, minutesText, fskText, imageSrc, initials, placeholderHue } = require('./mediathek-format.js');
const { AUTO_SVG } = require('./mediathek-download-icons.js');

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(doc, className, text, onClick, label) {
  const node = el(doc, 'button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

const STAR_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>';
const STAR_OUTLINE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>';

function setIcon(node, svg) {
  node.innerHTML = svg; // statisches SVG, keine Nutzerdaten
}

function pill(doc, text, className = '') {
  return el(doc, 'span', `mediathek-pill ${className}`.trim(), text);
}

/**
 * 16:9-Bild mit Platzhalter (Anfangsbuchstaben auf Farbverlauf), Quellen-Badge, Dauer, Regionshinweis und Fortschritt.
 * options: { imageUrl, title, sourceId, duration, geo, progress (0..1), width }
 */
function createThumb(doc, options) {
  const thumb = el(doc, 'span', 'mediathek-thumb');
  const hue = placeholderHue(options.title);
  const placeholder = el(doc, 'span', 'mediathek-thumb-placeholder', initials(options.title));
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.style.setProperty('--ph-hue', String(hue));
  thumb.appendChild(placeholder);
  const src = imageSrc(options.imageUrl, options.width || 640);
  if (src) {
    const image = el(doc, 'img', 'mediathek-thumb-img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.remove());
    image.src = src;
    thumb.appendChild(image);
  }
  if (options.sourceId) {
    const badge = pill(doc, sourceBadge(options.sourceId), 'mediathek-pill-source');
    badge.style.setProperty('--src-c', sourceColor(options.sourceId));
    thumb.appendChild(badge);
  }
  if (options.geo) thumb.appendChild(pill(doc, 'nur in DE', 'mediathek-pill-geo'));
  if (options.fskEntry) thumb.fskEntry = options.fskEntry; // Nachladen/Badge-Update (mediathek-fsk-loader.js)
  const fsk = fskText(options.fsk);
  if (fsk) thumb.appendChild(pill(doc, fsk, 'mediathek-pill-fsk')); // jede Einstufung, auch FSK 0 und 6
  const minutes = minutesText(options.duration);
  if (minutes) thumb.appendChild(pill(doc, minutes, 'mediathek-pill-duration'));
  if (typeof options.progress === 'number' && options.progress > 0) {
    const bar = el(doc, 'span', 'mediathek-progress');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `Fortschritt ${Math.round(options.progress * 100)} Prozent`);
    const fill = el(doc, 'i');
    fill.style.width = `${Math.min(100, Math.round(options.progress * 100))}%`;
    bar.appendChild(fill);
    thumb.appendChild(bar);
  }
  return thumb;
}

/**
 * Folgenkarte. options: { blocked (bool), progress, onPlay(), onInfo(), onRemove?, label (Zusatz für Screenreader) }
 * Haupt-Knopf spielt ab, der „i“-Knopf öffnet die Details.
 */
function createEntryCard(doc, entry, options = {}) {
  const card = el(doc, 'li', 'mediathek-card mediathek-entry-card');
  if (options.blocked) card.classList.add('is-blocked');
  card.dataset.entryId = entry.id || '';
  const main = el(doc, 'button', 'mediathek-card-main');
  main.type = 'button';
  const subtitle = subtitleText(entry);
  main.setAttribute('aria-label', [entry.title, subtitle, options.blocked ? 'nicht abrufbar' : 'abspielen'].filter(Boolean).join(', '));
  main.append(
    createThumb(doc, { imageUrl: entry.imageUrl, title: entry.title, sourceId: entry.sourceId, duration: entry.duration, geo: entry.regionRestricted, progress: options.progress, fsk: entry.fsk, fskEntry: entry }),
    el(doc, 'span', 'mediathek-card-title', entry.title),
    el(doc, 'span', 'mediathek-card-sub', subtitle || ' '),
  );
  if (options.blocked) {
    const lock = el(doc, 'span', 'mediathek-lock', 'Gesperrt');
    main.querySelector('.mediathek-thumb').appendChild(lock);
  }
  if (options.onPlay) main.addEventListener('click', () => options.onPlay(main));
  card.appendChild(main);
  if (options.onInfo) {
    const info = button(doc, 'mediathek-info-btn', 'i', () => options.onInfo(info), `Details zu ${entry.title}`);
    card.appendChild(info);
  }
  if (options.onRemove) {
    const remove = button(doc, 'mediathek-remove-btn', '×', () => options.onRemove(), `${entry.title} aus Weiterschauen entfernen`);
    card.appendChild(remove);
  }
  return card;
}

/** Serienkarte mit Stern (Meine Serien). options: { favorite, subscribed (Abo „Neue Folgen automatisch laden“), onOpen(), onToggleFavorite() } */
function createSeriesCard(doc, series, options = {}) {
  const card = el(doc, 'li', 'mediathek-card mediathek-series-card');
  card.dataset.seriesId = series.id;
  card.dataset.sourceId = series.sourceId;
  const main = el(doc, 'button', 'mediathek-card-main');
  main.type = 'button';
  main.setAttribute('aria-label', `${series.title}, Serie`);
  main.append(createThumb(doc, { imageUrl: series.imageUrl, title: series.title, sourceId: series.sourceId }), el(doc, 'span', 'mediathek-card-title', series.title), el(doc, 'span', 'mediathek-card-sub', 'Serie'));
  if (options.onOpen) main.addEventListener('click', () => options.onOpen(main));
  card.appendChild(main);
  if (options.onToggleFavorite) {
    const star = button(doc, 'mediathek-star-btn', '', () => options.onToggleFavorite(series), '');
    updateStar(star, series, Boolean(options.favorite));
    card.appendChild(star);
  }
  updateSubscriptionBadge(card, series, Boolean(options.subscribed));
  return card;
}

/** Abo-Symbol auf der Serienkarte (Meine Serien) ein- oder ausblenden; Screenreader-Text nennt die Serie. */
function updateSubscriptionBadge(card, series, subscribed) {
  const existing = card.querySelector('.mediathek-sub-badge');
  if (!subscribed) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const doc = card.ownerDocument;
  const badge = el(doc, 'span', 'mediathek-sub-badge');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', `${series.title}: Neue Folgen werden automatisch geladen`);
  badge.title = 'Neue Folgen werden automatisch geladen';
  setIcon(badge, AUTO_SVG);
  card.appendChild(badge);
}

function updateStar(star, series, favorite) {
  star.classList.toggle('is-on', favorite);
  star.setAttribute('aria-pressed', String(favorite));
  star.setAttribute('aria-label', favorite ? `${series.title} aus Meine Serien entfernen` : `${series.title} zu Meine Serien hinzufügen`);
  setIcon(star, favorite ? STAR_SVG : STAR_OUTLINE_SVG);
}

/** Genre-Karte (arte). options: { onOpen() } */
function createGenreCard(doc, genre, options = {}) {
  const card = el(doc, 'li', 'mediathek-card mediathek-genre-card');
  const main = el(doc, 'button', 'mediathek-card-main');
  main.type = 'button';
  main.setAttribute('aria-label', `Genre ${genre.title}`);
  main.append(createThumb(doc, { imageUrl: genre.imageUrl, title: genre.title, sourceId: genre.sourceId }), el(doc, 'span', 'mediathek-card-title', genre.title), el(doc, 'span', 'mediathek-card-sub', 'Genre'));
  if (options.onOpen) main.addEventListener('click', () => options.onOpen(main));
  card.appendChild(main);
  return card;
}

/**
 * Reihe mit Titel und waagerecht scrollbarer Liste. options: { id, title, badge (Quellen-Kürzel), moreState, canMore, onMore() }
 * Rückgabe: { section, list } – Karten gehören in `list`.
 */
function createRow(doc, options) {
  const section = el(doc, 'section', 'mediathek-row');
  if (options.id) section.dataset.row = options.id;
  const headId = `mediathekRow-${String(options.id || options.title).replace(/[^\w-]+/g, '_')}`;
  section.setAttribute('aria-labelledby', headId);
  const head = el(doc, 'h3', 'mediathek-row-title');
  head.id = headId;
  head.append(el(doc, 'span', '', options.title));
  if (options.badge) head.append(el(doc, 'span', 'mediathek-row-badge', options.badge));
  const scroller = el(doc, 'div', 'mediathek-row-scroll');
  const list = el(doc, 'ul', 'mediathek-row-list');
  scroller.appendChild(list);
  section.append(head, scroller);
  if (options.canMore) {
    const more = el(doc, 'li', 'mediathek-row-more');
    const label = options.moreState === 'loading' ? 'Lädt …' : options.moreState === 'failed' ? 'Nachladen fehlgeschlagen – erneut versuchen' : 'Mehr laden';
    const btn = button(doc, 'mediathek-more-btn', label, () => options.onMore && options.onMore(), `${options.title}: ${label}`);
    btn.disabled = options.moreState === 'loading';
    if (options.moreState === 'loading') btn.setAttribute('aria-busy', 'true');
    more.appendChild(btn);
    list.dataset.hasMore = '1';
    list.appendChild(more);
    list.moreItem = more;
  }
  return { section, list };
}

/**
 * Kartenbauer für Hub und Genre-Seite. ctx: { isBlocked(id), play(entry, series, trigger), openDetail(entry, series, trigger),
 * openSeries(series, trigger), openGenre(genre, trigger), toggleFavorite(series), isFavorite(series) }
 */
function createCardFactory(doc, ctx) {
  return {
    entry: (entry, series = null, extra = {}) =>
      createEntryCard(doc, entry, {
        blocked: ctx.isBlocked(entry.id),
        onPlay: trigger => ctx.play(entry, series, trigger),
        onInfo: trigger => ctx.openDetail(entry, series, trigger),
        ...extra,
      }),
    series: series => createSeriesCard(doc, series, { favorite: ctx.isFavorite(series), subscribed: ctx.isSubscribed ? ctx.isSubscribed(series) : false, onOpen: trigger => ctx.openSeries(series, trigger), onToggleFavorite: item => ctx.toggleFavorite(item) }),
    genre: genre => createGenreCard(doc, genre, { onOpen: trigger => ctx.openGenre(genre, trigger) }),
  };
}

/** Karte vor dem „Mehr laden“-Eintrag einfügen. */
function appendToRow(list, card) {
  if (list.moreItem) list.insertBefore(card, list.moreItem);
  else list.appendChild(card);
}

module.exports = { el, button, setIcon, pill, createThumb, createEntryCard, createSeriesCard, createGenreCard, createRow, appendToRow, createCardFactory, updateStar, updateSubscriptionBadge, PLAY_SVG, STAR_SVG, STAR_OUTLINE_SVG };
