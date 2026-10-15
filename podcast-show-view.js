// Podcast-Sendungsseite (P3): Kopf mit Cover, Titel, Autor, Beschreibung (nur Text), Abo-/Abbestellen-Knopf und
// „alle als gehört“; darunter die Episodenliste (begrenzt, „Mehr laden“) und der Fehlerhinweis bei kaputtem Feed. Ohne Abo
// (Vorschau aus der Suche oder der Feed-Prüfung) zeigt die Seite nur den Kopf. Alle Feed-Texte per textContent.

'use strict';

const { podcastShowModel, PAGE_SIZE } = require('./podcast-show-model.js');
const { createEpisodeList, playEpisodeItem } = require('./podcast-episode-list-view.js');
const { createCover } = require('./podcast-cover-view.js');

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ICON_BACK =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>';

/** ctx: { podcasts, data, getPlayer(), now(), back(), home(), announce(text), notify(text), logger } */
function createPodcastShowView(root, ctx) {
  const { podcasts, data, getPlayer, now, back, home, announce, notify, logger } = ctx;
  const doc = root.ownerDocument || document;

  const toolbar = el(doc, 'div', 'dashboard-hub-toolbar podcast-toolbar');
  const backBtn = el(doc, 'button', 'dashboard-hub-tool');
  backBtn.type = 'button';
  backBtn.id = 'podcastShowBack';
  const backIcon = el(doc, 'span');
  backIcon.setAttribute('aria-hidden', 'true');
  backIcon.innerHTML = ICON_BACK; // statisches SVG
  backBtn.append(backIcon, el(doc, 'span', 'dashboard-hub-tool-label', 'Zurück'));
  backBtn.setAttribute('aria-label', 'Zurück zur Podcast-Übersicht');
  toolbar.appendChild(backBtn);

  const head = el(doc, 'header', 'podcast-show-head');
  const cover = createCover(doc, { podcasts, className: 'podcast-cover-large' });
  const headText = el(doc, 'div', 'podcast-show-head-text');
  const title = el(doc, 'h2', 'podcast-show-heading');
  title.id = 'podcastShowTitle';
  const author = el(doc, 'p', 'podcast-show-head-author');
  const description = el(doc, 'p', 'podcast-show-description');
  const actions = el(doc, 'div', 'podcast-show-actions');
  const subscribeBtn = el(doc, 'button', 'podcast-btn podcast-btn-primary');
  subscribeBtn.type = 'button';
  subscribeBtn.id = 'podcastSubscribe';
  const markAll = el(doc, 'button', 'podcast-btn', 'Alle als gehört markieren');
  markAll.type = 'button';
  markAll.id = 'podcastMarkAll';
  actions.append(subscribeBtn, markAll);
  const checked = el(doc, 'p', 'podcast-show-checked');
  headText.append(title, author, description, actions, checked);
  head.append(cover.element, headText);

  const feedError = el(doc, 'p', 'podcast-error');
  feedError.id = 'podcastFeedError';
  feedError.setAttribute('role', 'alert');
  const previewNote = el(doc, 'p', 'podcast-section-empty');
  previewNote.id = 'podcastPreviewNote';

  const listSection = el(doc, 'section', 'podcast-section');
  const listHeading = el(doc, 'h3', 'podcast-section-title', 'Episoden');
  listHeading.id = 'podcastEpisodesHeading';
  listSection.setAttribute('aria-labelledby', listHeading.id);
  const list = createEpisodeList(doc, {
    podcasts,
    label: 'Episoden',
    onPlay: item => run(() => playEpisodeItem(podcasts.player, item), 'Wiedergabe nicht möglich'),
    onMark: item => markEpisode(item),
  });
  list.element.id = 'podcastEpisodeList';
  const listEmpty = el(doc, 'p', 'podcast-section-empty');
  listEmpty.id = 'podcastEpisodesEmpty';
  const more = el(doc, 'button', 'podcast-btn');
  more.type = 'button';
  more.id = 'podcastMore';
  listSection.append(listHeading, list.element, listEmpty, more);

  root.textContent = '';
  root.append(toolbar, head, feedError, previewNote, listSection);

  let podcastId = null;
  let preview = null;
  let limit = PAGE_SIZE;
  let busy = false;

  const report = (message, error) => {
    if (logger) logger.warn(`Podcast-Sendung: ${message}`, error && error.message ? error.message : error || '');
    if (notify) notify(message);
  };
  async function run(fn, message) {
    try {
      await fn();
    } catch (error) {
      report(`Podcast: ${error && error.message ? error.message : message}`, error);
    }
  }
  async function markEpisode(item) {
    await run(async () => {
      await podcasts.setPlayed({ podcastId: item.podcastId, episodeId: item.episodeId, played: item.markPlayed });
      announce(item.markPlayed ? `${item.title} als gehört markiert` : `${item.title} als ungehört markiert`);
    }, 'Status nicht änderbar');
  }

  function model() {
    const snap = data.snapshot();
    const subscription = snap.subscriptions.find(sub => sub.id === podcastId) || null;
    return podcastShowModel({ id: podcastId, subscription, feed: snap.episodes[podcastId] || null, preview, player: getPlayer(), limit, now: now(), loading: !snap.loaded });
  }

  function render() {
    if (!podcastId) return null;
    const m = model();
    cover.update({ url: m.cover, initial: m.initial });
    title.textContent = m.title;
    author.textContent = m.author;
    author.hidden = !m.author;
    description.textContent = m.description; // nur Text
    description.hidden = !m.description;
    subscribeBtn.textContent = m.subscribeLabel;
    subscribeBtn.setAttribute('aria-label', m.subscribeAria);
    subscribeBtn.disabled = busy;
    subscribeBtn.classList.toggle('podcast-btn-danger', m.subscribed);
    subscribeBtn.classList.toggle('podcast-btn-primary', !m.subscribed);
    markAll.hidden = !m.subscribed;
    markAll.disabled = !m.canMarkAll;
    checked.textContent = m.checkedText;
    checked.hidden = !m.checkedText;
    feedError.textContent = m.errorText;
    feedError.hidden = !m.errorText;
    previewNote.textContent = m.previewNote;
    previewNote.hidden = m.subscribed;
    listSection.hidden = !m.subscribed;
    listEmpty.textContent = m.emptyText;
    listEmpty.hidden = !m.emptyText;
    more.hidden = !m.hasMore;
    more.textContent = m.moreLabel;
    list.element.hidden = m.episodes.length === 0;
    list.render(m.episodes);
    return m;
  }

  subscribeBtn.addEventListener('click', async () => {
    const m = model();
    busy = true;
    render();
    try {
      if (m.subscribed) {
        await podcasts.unsubscribe(podcastId);
        await data.load();
        announce(`${m.title} abbestellt`);
        home();
      } else if (preview && preview.feedUrl) {
        await podcasts.subscribe({ feedUrl: preview.feedUrl, source: preview.source || 'suche', title: preview.title, author: preview.author || undefined, cover: preview.cover || undefined });
        await data.load();
        announce(`${m.title} abonniert`);
      } else if (preview && preview.catalogId) {
        await podcasts.subscribe({ catalogId: preview.catalogId });
        await data.load();
        announce(`${m.title} abonniert`);
      }
    } catch (error) {
      report(`Podcast: ${error && error.message ? error.message : 'Aktion nicht möglich'}`, error);
    } finally {
      busy = false;
      render();
    }
  });

  markAll.addEventListener('click', async () => {
    const m = model();
    const snap = data.snapshot();
    const feed = snap.episodes[podcastId];
    const unplayed = feed ? feed.episodes.filter(episode => !(episode.state && episode.state.played)) : [];
    markAll.disabled = true;
    await run(async () => {
      for (const episode of unplayed) await podcasts.setPlayed({ podcastId, episodeId: episode.id, played: true });
      announce(`Alle Episoden von ${m.title} als gehört markiert`);
    }, 'Status nicht änderbar');
  });

  more.addEventListener('click', () => {
    limit += PAGE_SIZE;
    render();
  });
  backBtn.addEventListener('click', () => back());

  /** Zeigt die Sendung. route: { id, preview? } – preview { feedUrl|catalogId, title, author, cover, description, episodeCount }. */
  function enter(route) {
    if (route.id !== podcastId) limit = PAGE_SIZE;
    podcastId = route.id;
    preview = route.preview || null;
    render();
    enrichPreview(route.id);
  }

  // Vorschau ohne Abo: Beschreibung und Episodenzahl aus dem Feed nachladen (nur Lesen, abonniert wird nichts)
  async function enrichPreview(id) {
    if (!preview || !preview.feedUrl || preview.description || typeof podcasts.probeFeed !== 'function') return;
    const current = preview;
    try {
      const reply = await podcasts.probeFeed(current.feedUrl);
      if (!reply || !reply.ok || preview !== current || podcastId !== id) return;
      preview = { ...current, description: reply.description || '', episodeCount: reply.episodeCount, cover: current.cover || reply.cover || null, author: current.author || reply.author || '' };
      render();
    } catch {
      /* Vorschau bleibt ohne Beschreibung */
    }
  }

  return { render, enter, focusFirst: () => (subscribeBtn.disabled ? backBtn : subscribeBtn).focus(), getId: () => podcastId };
}

module.exports = { createPodcastShowView };
