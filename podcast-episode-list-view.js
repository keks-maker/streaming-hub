// Podcast-Oberfläche (P3): Episodenliste (Dashboard „Neue Episoden“ und Sendungsseite). Zeilen werden anhand ihres
// Schlüssels wiederverwendet: Fortschritt, Status und aktive Markierung werden ohne Neuaufbau aktualisiert (Fokus und
// Bildlauf bleiben erhalten). Alle Feed-Texte per textContent. Klick auf die Zeile öffnet das Episoden-Overlay (Shownotes,
// Kapitel); die Wiedergabe startet über den eigenen Play-/Pause-Knopf, daneben „als gehört markieren“.

'use strict';

const { createCover } = require('./podcast-cover-view.js');

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>';

const ICON_PLAY =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/></svg>';

/**
 * options: { podcasts, showShow (Sendungsname in der Zeile), onOpen(item, trigger) (Overlay), onPlay(item), onMark(item), label (aria-label der Liste) }
 * Ergebnis: { element (ul), render(items) }
 */
function createEpisodeList(doc, { podcasts, showShow = false, onOpen, onPlay, onMark, label = 'Episoden' } = {}) {
  const list = el(doc, 'ul', 'podcast-episode-list');
  list.setAttribute('aria-label', label);
  const rows = new Map(); // key → { li, ... }
  let signature = '';
  let current = [];

  function buildRow() {
    const li = el(doc, 'li', 'podcast-episode');
    const main = el(doc, 'button', 'podcast-episode-main');
    main.type = 'button';
    const cover = createCover(doc, { podcasts });
    const eq = el(doc, 'span', 'podcast-eq');
    eq.setAttribute('aria-hidden', 'true'); // Text „spielt gerade“ steht im aria-label der Zeile
    for (let i = 0; i < 3; i += 1) eq.appendChild(el(doc, 'span'));
    const text = el(doc, 'span', 'podcast-episode-text');
    const show = el(doc, 'span', 'podcast-episode-show');
    show.hidden = !showShow;
    const title = el(doc, 'span', 'podcast-episode-title');
    const metaRow = el(doc, 'span', 'podcast-episode-metarow');
    const newTag = el(doc, 'span', 'podcast-episode-new', 'Neu');
    const meta = el(doc, 'span', 'podcast-episode-meta');
    metaRow.append(newTag, meta);
    const progress = el(doc, 'span', 'podcast-progress');
    progress.setAttribute('aria-hidden', 'true');
    const bar = el(doc, 'span', 'podcast-progress-bar');
    progress.appendChild(bar);
    text.append(show, title, metaRow, progress);
    main.append(cover.element, eq, text);
    const play = el(doc, 'button', 'podcast-episode-play');
    play.type = 'button';
    const playIcon = el(doc, 'span');
    playIcon.setAttribute('aria-hidden', 'true');
    play.appendChild(playIcon);
    const mark = el(doc, 'button', 'podcast-episode-mark');
    mark.type = 'button';
    const markIcon = el(doc, 'span');
    markIcon.setAttribute('aria-hidden', 'true');
    markIcon.innerHTML = ICON_CHECK; // statisches SVG
    mark.appendChild(markIcon);
    li.append(main, play, mark);
    const row = { li, main, play, playIcon, mark, cover, show, title, meta, newTag, eq, bar, progress, item: null };
    main.addEventListener('click', () => row.item && onOpen && onOpen(row.item, main));
    play.addEventListener('click', () => row.item && onPlay && onPlay(row.item));
    mark.addEventListener('click', () => row.item && onMark && onMark(row.item));
    return row;
  }

  function patchRow(row, item) {
    row.item = item;
    const { li, main, play, mark } = row;
    li.dataset.state = item.status;
    li.dataset.podcastId = item.podcastId;
    li.dataset.episodeId = item.episodeId;
    li.classList.toggle('is-active', item.active);
    li.classList.toggle('is-playing', item.playing);
    li.classList.toggle('is-failed', item.failed);
    li.classList.toggle('is-new', item.isNew);
    row.newTag.hidden = !item.isNew;
    row.eq.title = item.playState;
    main.setAttribute('aria-label', item.ariaLabel);
    play.dataset.action = item.action;
    play.title = item.playLabel;
    play.setAttribute('aria-label', item.playLabel);
    play.classList.toggle('is-active', item.active);
    const icon = item.action === 'pause' ? ICON_PAUSE : ICON_PLAY;
    if (row.playIconKey !== icon) {
      row.playIconKey = icon;
      row.playIcon.innerHTML = icon; // statisches SVG
    }
    row.cover.update({ url: item.cover, initial: (item.show || item.title).trim().slice(0, 1).toUpperCase() });
    if (row.show.textContent !== item.show) row.show.textContent = item.show;
    if (row.title.textContent !== item.title) row.title.textContent = item.title;
    const metaText = [item.dateText, item.durationText, item.status === 'new' ? '' : item.statusText].filter(Boolean).join(' · ') + (item.failed ? ' · Wiedergabe nicht möglich' : '');
    if (row.meta.textContent !== metaText) row.meta.textContent = metaText;
    const showBar = item.progress > 0 && item.status !== 'played';
    row.progress.hidden = !showBar;
    row.bar.style.width = `${Math.round(item.progress * 100)}%`;
    mark.title = item.markLabel;
    mark.setAttribute('aria-label', `${item.title}: ${item.markLabel}`);
    mark.classList.toggle('is-played', !item.markPlayed);
    mark.setAttribute('aria-pressed', item.markPlayed ? 'false' : 'true');
  }

  function render(items) {
    current = items;
    const next = items.map(item => item.key).join('\n');
    if (next !== signature) {
      const active = doc.activeElement;
      const focusKey = active && list.contains(active) ? { key: active.closest('li') && `${active.closest('li').dataset.podcastId}\u0000${active.closest('li').dataset.episodeId}`, part: active.classList.contains('podcast-episode-mark') ? 'mark' : active.classList.contains('podcast-episode-play') ? 'play' : 'main' } : null;
      signature = next;
      const keep = new Map();
      for (const item of items) keep.set(item.key, rows.get(item.key) || buildRow());
      rows.clear();
      list.textContent = '';
      for (const item of items) {
        const row = keep.get(item.key);
        rows.set(item.key, row);
        list.appendChild(row.li);
      }
      if (focusKey && rows.has(focusKey.key)) {
        const row = rows.get(focusKey.key);
        row[focusKey.part].focus();
      }
    }
    for (const item of items) patchRow(rows.get(item.key), item);
  }

  return { element: list, render, getItems: () => current };
}

/** Startet, pausiert oder setzt eine Episode fort (Aktion des Anzeigemodells). */
function playEpisodeItem(player, item) {
  if (item.action === 'pause') return player.pause();
  if (item.action === 'resume') return player.resume();
  return player.play({ podcastId: item.podcastId, episodeId: item.episodeId });
}

module.exports = { createEpisodeList, playEpisodeItem };
