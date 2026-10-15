// Podcast-Suche (P3): Eingabe mit Entprellung (500 ms), Ergebnisliste (Cover, Titel, Autor, Abo-Knopf; Klick öffnet die
// Sendungsseite als Vorschau), Trefferzahl per aria-live, Hinweis bei „später erneut“, Leer- und Fehlerzustand, und
// „Eigenen Feed hinzufügen“ (Feed prüfen → Bestätigung → Abo). Pfeiltasten wechseln zwischen Eingabe und Treffern.
// Alle Texte aus Feeds und Suchdienst per textContent.

'use strict';

const { createSearchModel, SEARCH_LIMIT } = require('./podcast-search-model.js');
const { createFeedAddModel } = require('./podcast-feed-add-model.js');
const { createCover } = require('./podcast-cover-view.js');
const { initialOf, plural } = require('./podcast-format.js');

const ICON_BACK =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** ctx: { podcasts, data, open(route), back(), announce(text), notify(text), logger, timers (Tests) } */
function createPodcastSearchView(root, ctx) {
  const { podcasts, data, open, back, announce, notify, logger, timers } = ctx;
  const doc = root.ownerDocument || document;

  const toolbar = el(doc, 'div', 'dashboard-hub-toolbar podcast-toolbar');
  const backBtn = el(doc, 'button', 'dashboard-hub-tool');
  backBtn.type = 'button';
  backBtn.id = 'podcastSearchBack';
  backBtn.setAttribute('aria-label', 'Zurück zur Podcast-Übersicht');
  const backIcon = el(doc, 'span');
  backIcon.setAttribute('aria-hidden', 'true');
  backIcon.innerHTML = ICON_BACK; // statisches SVG
  backBtn.append(backIcon, el(doc, 'span', 'dashboard-hub-tool-label', 'Zurück'));
  toolbar.appendChild(backBtn);

  const form = el(doc, 'form', 'podcast-search-form');
  form.setAttribute('role', 'search');
  const label = el(doc, 'label', 'sr-only', 'Podcasts suchen');
  const input = doc.createElement('input');
  input.type = 'search';
  input.id = 'podcastSearchInput';
  input.className = 'podcast-input';
  input.placeholder = 'Sendung oder Thema suchen';
  input.autocomplete = 'off';
  input.maxLength = 100;
  label.htmlFor = input.id;
  const submit = el(doc, 'button', 'podcast-btn podcast-btn-primary', 'Suchen');
  submit.type = 'submit';
  form.append(label, input, submit);

  const message = el(doc, 'p', 'podcast-search-message');
  message.id = 'podcastSearchCount';
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const results = el(doc, 'ul', 'podcast-result-list');
  results.id = 'podcastSearchResults';
  results.setAttribute('aria-label', 'Suchergebnisse');

  const feedSection = el(doc, 'section', 'podcast-section podcast-feed-add');
  const feedHeading = el(doc, 'h2', 'podcast-section-title', 'Eigenen Feed hinzufügen');
  feedHeading.id = 'podcastFeedHeading';
  feedSection.setAttribute('aria-labelledby', feedHeading.id);
  const feedForm = el(doc, 'form', 'podcast-search-form');
  const feedLabel = el(doc, 'label', 'sr-only', 'Feed-Adresse');
  const feedInput = doc.createElement('input');
  feedInput.type = 'url';
  feedInput.id = 'podcastFeedUrl';
  feedInput.className = 'podcast-input';
  feedInput.placeholder = 'https://example.org/podcast.xml';
  feedInput.autocomplete = 'off';
  feedInput.spellcheck = false;
  feedInput.maxLength = 2048;
  feedLabel.htmlFor = feedInput.id;
  const feedCheck = el(doc, 'button', 'podcast-btn', 'Feed prüfen');
  feedCheck.type = 'submit';
  feedCheck.id = 'podcastFeedCheck';
  feedForm.append(feedLabel, feedInput, feedCheck);
  const feedMessage = el(doc, 'p', 'podcast-search-message');
  feedMessage.id = 'podcastFeedMessage';
  feedMessage.setAttribute('role', 'status');
  feedMessage.setAttribute('aria-live', 'polite');
  const feedPreview = el(doc, 'div', 'podcast-result podcast-feed-preview');
  feedPreview.id = 'podcastFeedPreview';
  feedPreview.hidden = true;
  const feedCover = createCover(doc, { podcasts });
  const feedText = el(doc, 'span', 'podcast-result-text');
  const feedTitle = el(doc, 'span', 'podcast-show-title');
  const feedAuthor = el(doc, 'span', 'podcast-show-author');
  const feedInfo = el(doc, 'span', 'podcast-show-author');
  feedText.append(feedTitle, feedAuthor, feedInfo);
  const feedConfirm = el(doc, 'button', 'podcast-btn podcast-btn-primary', 'Abonnieren');
  feedConfirm.type = 'button';
  feedConfirm.id = 'podcastFeedConfirm';
  feedPreview.append(feedCover.element, feedText, feedConfirm);
  feedSection.append(feedHeading, feedForm, feedMessage, feedPreview);

  root.textContent = '';
  root.append(toolbar, form, message, results, feedSection);

  const report = (text, error) => {
    if (logger) logger.warn(`Podcast-Suche: ${text}`, error && error.message ? error.message : error || '');
    if (notify) notify(text);
  };

  const search = createSearchModel({
    search: term => podcasts.search({ term, limit: SEARCH_LIMIT }),
    onChange: () => render(),
    timers,
  });
  const feedAdd = createFeedAddModel({
    probe: url => podcasts.probeFeed(url),
    subscribe: async feed => {
      const reply = await podcasts.subscribe({ feedUrl: feed.feedUrl, source: 'eigene-podcasts', title: feed.title, author: feed.author || undefined });
      await data.load();
      return reply;
    },
    onChange: () => renderFeed(),
  });

  const rows = new Map(); // id → { li, main, cover, title, author, add }
  let signature = '';

  function buildRow() {
    const li = el(doc, 'li', 'podcast-result');
    const main = el(doc, 'button', 'podcast-result-main');
    main.type = 'button';
    const cover = createCover(doc, { podcasts });
    const text = el(doc, 'span', 'podcast-result-text');
    const title = el(doc, 'span', 'podcast-show-title');
    const author = el(doc, 'span', 'podcast-show-author');
    text.append(title, author);
    main.append(cover.element, text);
    const add = el(doc, 'button', 'podcast-btn');
    add.type = 'button';
    li.append(main, add);
    const row = { li, main, cover, title, author, add, result: null };
    main.addEventListener('click', () => row.result && open({ view: 'show', id: row.result.id, preview: { feedUrl: row.result.feedUrl, source: 'suche', title: row.result.title, author: row.result.author, cover: row.result.cover } }));
    add.addEventListener('click', async () => {
      const result = row.result;
      if (!result || add.getAttribute('aria-disabled') === 'true') return;
      add.setAttribute('aria-disabled', 'true');
      try {
        await podcasts.subscribe({ feedUrl: result.feedUrl, source: 'suche', title: result.title, author: result.author || undefined });
        await data.load();
        announce(`${result.title} abonniert`);
      } catch (error) {
        add.removeAttribute('aria-disabled');
        report(`Podcast: ${error && error.message ? error.message : 'Abo nicht möglich'}`, error);
      }
    });
    return row;
  }

  function render() {
    const state = search.getState();
    const subscribed = new Set(data.snapshot().subscriptions.map(sub => sub.id));
    message.textContent = state.status === 'done' || state.status === 'empty' ? state.countText + (state.status === 'empty' ? `: ${state.message}` : '') : state.message;
    message.classList.toggle('is-error', state.status === 'error' || state.status === 'rate-limited');
    results.hidden = state.results.length === 0;
    const next = state.results.map(result => result.id).join('\n');
    if (next !== signature) {
      signature = next;
      const keep = new Map(rows);
      rows.clear();
      results.textContent = '';
      for (const result of state.results) {
        const row = keep.get(result.id) || buildRow();
        rows.set(result.id, row);
        results.appendChild(row.li);
      }
    }
    for (const result of state.results) {
      const row = rows.get(result.id);
      const isSub = subscribed.has(result.id);
      row.result = result;
      row.li.dataset.podcastId = result.id;
      row.cover.update({ url: result.cover, initial: initialOf(result.title) });
      row.title.textContent = result.title;
      row.author.textContent = result.author;
      row.main.setAttribute('aria-label', `${result.title}${result.author ? `, ${result.author}` : ''} – Sendung öffnen`);
      row.add.textContent = isSub ? 'Abonniert' : 'Abonnieren';
      row.add.setAttribute('aria-label', isSub ? `${result.title} ist abonniert` : `${result.title} abonnieren`);
      row.add.classList.toggle('is-subscribed', isSub);
      if (isSub) row.add.setAttribute('aria-disabled', 'true');
      else row.add.removeAttribute('aria-disabled');
    }
  }

  function renderFeed() {
    const state = feedAdd.getState();
    feedMessage.textContent = state.message;
    feedMessage.classList.toggle('is-error', state.status === 'error');
    feedCheck.disabled = state.status === 'probing';
    feedPreview.hidden = state.status !== 'ready';
    if (state.preview) {
      feedCover.update({ url: state.preview.cover, initial: initialOf(state.preview.title) });
      feedTitle.textContent = state.preview.title;
      feedAuthor.textContent = state.preview.author;
      feedInfo.textContent = Number.isFinite(state.preview.episodeCount) ? plural(state.preview.episodeCount, 'Episode', 'Episoden') : '';
      feedConfirm.setAttribute('aria-label', `${state.preview.title} abonnieren`);
    }
  }

  input.addEventListener('input', () => search.setTerm(input.value));
  form.addEventListener('submit', event => {
    event.preventDefault();
    search.submit(input.value);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      const first = results.querySelector('.podcast-result-main');
      if (first) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      input.value = '';
      search.reset();
    }
  });
  results.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const mains = Array.from(results.querySelectorAll('.podcast-result-main'));
    const index = mains.indexOf(doc.activeElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) input.focus();
    else mains[Math.min(mains.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  });
  feedInput.addEventListener('input', () => feedAdd.setUrl(feedInput.value));
  feedForm.addEventListener('submit', event => {
    event.preventDefault();
    feedAdd.setUrl(feedInput.value);
    feedAdd.check();
  });
  feedConfirm.addEventListener('click', async () => {
    const preview = feedAdd.getState().preview;
    feedConfirm.disabled = true;
    const reply = await feedAdd.confirm();
    feedConfirm.disabled = false;
    if (reply && reply.subscription) {
      feedInput.value = '';
      announce(`${preview ? preview.title : 'Feed'} abonniert`);
      open({ view: 'show', id: reply.subscription.id });
    }
  });
  backBtn.addEventListener('click', () => back());

  /** route: { term? } – Eingabe vorbelegen und sofort suchen. */
  function enter(route = {}) {
    if (typeof route.term === 'string' && route.term.trim()) {
      input.value = route.term;
      search.setTerm(route.term);
      search.submit();
    }
    render();
    renderFeed();
    input.focus();
  }

  // Trefferzahl auch für Bildschirmleser bei Änderungen der Abos (Abonniert-Zustand) aktualisieren
  return { render, enter, focusFirst: () => input.focus() };
}

module.exports = { createPodcastSearchView };
