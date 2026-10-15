'use strict';

// Einstellungen → Podcasts → Eigene Feeds (P4): Feed-Adresse eingeben, „Feed prüfen“ (podcast:probe-feed) zeigt Titel, Cover
// und Episodenzahl, erst „Abonnieren“ legt das Abo an (Quelle eigene-podcasts). Darunter die eigenen Feeds mit Status und
// Abbestellen (mit Bestätigung). Zustandsmodell: podcast-feed-add-model.js (auch von der Suche genutzt). Feed-Texte per textContent.

const { createFeedAddModel } = require('./podcast-feed-add-model.js');
const subsModel = require('./settings-podcast-subs-model.js');
const { el, statusLine, setStatus, labelledField, textInput, button, focusNode, findAll, formatIpcError } = require('./settings-radio-dom.js');
const { createCover } = require('./podcast-cover-view.js');
const { initialOf, plural } = require('./podcast-format.js');

function hostOf(feedUrl) {
  try {
    return new URL(feedUrl).host;
  } catch {
    return '';
  }
}

function createPodcastFeedsView(root, { podcasts, logger = null, now = () => Date.now() } = {}) {
  const doc = root.ownerDocument || document;
  const state = { subs: [], loaded: false, confirmRemove: null, serialized: '', restoreFocus: null };

  const input = textInput(doc, { field: 'feedUrl', placeholder: 'https://example.org/podcast.xml', type: 'url' });
  input.id = 'settingsPodcastFeedUrl';
  input.maxLength = 2048;
  const check = button(doc, 'settings-action-btn', 'Feed prüfen', 'check');
  check.id = 'settingsPodcastFeedCheck';
  const form = el(doc, 'form', 'settings-chan-toolbar settings-podcast-feedform');
  form.noValidate = true;
  const field = labelledField(doc, 'Feed-Adresse', input, { hint: 'Adresse eines Podcast-Feeds (RSS), nur http oder https. Nichts wird gespeichert, bevor du bestätigst.' });
  field.classList.add('settings-podcast-feedfield');
  check.type = 'submit';
  form.append(field, check);

  const messageEl = el(doc, 'p', 'settings-field-hint settings-podcast-feedmessage');
  messageEl.id = 'settingsPodcastFeedMessage';
  messageEl.setAttribute('role', 'status');
  messageEl.setAttribute('aria-live', 'polite');

  const preview = el(doc, 'div', 'settings-chan-row settings-podcast-preview');
  preview.id = 'settingsPodcastFeedPreview';
  preview.hidden = true;
  const previewCover = createCover(doc, { podcasts, className: 'settings-podcast-cover' });
  const previewInfo = el(doc, 'div', 'settings-chan-info');
  const previewTitle = el(doc, 'div', 'settings-chan-name');
  const previewMeta = el(doc, 'div', 'settings-chan-meta');
  previewInfo.append(previewTitle, previewMeta);
  const confirm = button(doc, 'modal-btn modal-btn-save', 'Abonnieren', 'confirm');
  confirm.id = 'settingsPodcastFeedConfirm';
  const previewHead = el(doc, 'div', 'settings-chan-head');
  previewHead.append(previewCover.element, previewInfo, confirm);
  preview.appendChild(previewHead);

  const listHeading = el(doc, 'h5', 'settings-card-subtitle', 'Meine eigenen Feeds');
  const listEl = el(doc, 'div', 'settings-chan-list');
  listEl.id = 'settingsPodcastFeedList';
  listEl.setAttribute('role', 'list');
  const emptyEl = el(doc, 'p', 'settings-field-hint', 'Noch keine eigenen Feeds.');
  emptyEl.id = 'settingsPodcastFeedEmpty';
  const statusEl = statusLine(doc, 'settingsPodcastFeedStatus');
  root.textContent = '';
  root.append(form, messageEl, preview, listHeading, listEl, emptyEl, statusEl);

  const addModel = createFeedAddModel({
    probe: url => podcasts.probeFeed(url),
    subscribe: async feed => {
      const reply = await podcasts.subscribe({ feedUrl: feed.feedUrl, source: subsModel.CUSTOM_SOURCE, title: feed.title, author: feed.author || undefined });
      if (reply && reply.added === false) throw new Error('Dieser Feed ist bereits abonniert.');
      return reply;
    },
    onChange: () => renderForm(),
  });

  function renderForm() {
    const current = addModel.getState();
    if (input.value !== current.url) input.value = current.url;
    messageEl.textContent = current.message;
    messageEl.classList.toggle('error', current.status === 'error');
    check.disabled = current.status === 'probing';
    check.textContent = current.status === 'probing' ? 'Wird geprüft …' : 'Feed prüfen';
    const feed = current.status === 'ready' ? current.preview : null;
    preview.hidden = !feed;
    if (!feed) return;
    previewTitle.textContent = feed.title;
    previewCover.update({ url: feed.cover, initial: initialOf(feed.title) });
    previewMeta.textContent = '';
    if (feed.author) previewMeta.appendChild(el(doc, 'span', '', feed.author));
    if (Number.isFinite(feed.episodeCount)) previewMeta.appendChild(el(doc, 'span', '', plural(feed.episodeCount, 'Episode', 'Episoden')));
    previewMeta.appendChild(el(doc, 'span', '', hostOf(feed.feedUrl)));
  }

  input.addEventListener('input', () => addModel.setUrl(input.value));
  form.addEventListener('submit', event => {
    event.preventDefault();
    addModel.setUrl(input.value);
    addModel.check();
  });
  confirm.addEventListener('click', async () => {
    const title = (addModel.getState().preview || {}).title;
    const result = await addModel.confirm();
    if (!result) return;
    setStatus(statusEl, `✓ „${title}“ abonniert`);
    await refresh();
    focusNode(input);
  });

  // ── Liste der eigenen Feeds ──

  function ownFeeds() {
    return state.subs.filter(subsModel.isCustom);
  }

  function setSubs(next) {
    if (!Array.isArray(next)) return;
    const serialized = JSON.stringify(next);
    if (state.loaded && serialized === state.serialized) return;
    state.serialized = serialized;
    state.subs = next;
    state.loaded = true;
    if (state.confirmRemove && !ownFeeds().some(sub => sub.id === state.confirmRemove)) state.confirmRemove = null;
    renderList();
  }

  async function refresh() {
    try {
      setSubs(await podcasts.list());
    } catch (error) {
      if (logger) logger.warn('Podcast-Einstellungen: Feeds konnten nicht geladen werden', error && error.message);
      setStatus(statusEl, 'Feeds konnten nicht geladen werden', true);
    }
  }

  async function unsubscribe(sub) {
    state.confirmRemove = null;
    try {
      await podcasts.unsubscribe(sub.id);
      setSubs(await podcasts.list());
      setStatus(statusEl, `✓ „${sub.title}“ abbestellt`);
      focusNode(input);
    } catch (error) {
      setStatus(statusEl, formatIpcError(error) || 'Abbestellen nicht möglich', true);
      renderList();
    }
  }

  function buildRow(sub) {
    const row = el(doc, 'div', 'settings-chan-row settings-podcast-row');
    row.setAttribute('role', 'listitem');
    row.dataset.id = sub.id;
    const head = el(doc, 'div', 'settings-chan-head');
    const cover = createCover(doc, { podcasts, className: 'settings-podcast-cover' });
    cover.update({ url: sub.cover, initial: initialOf(sub.title) });
    const info = el(doc, 'div', 'settings-chan-info');
    info.appendChild(el(doc, 'div', 'settings-chan-name', sub.title));
    const meta = el(doc, 'div', 'settings-chan-meta');
    const host = hostOf(sub.feedUrl);
    if (host) meta.appendChild(el(doc, 'span', '', host));
    const status = subsModel.feedStatus(sub, now());
    meta.appendChild(el(doc, 'span', `settings-podcast-feedstatus ${status.kind}`, status.text));
    info.appendChild(meta);
    const actions = el(doc, 'div', 'settings-chan-actions');
    if (state.confirmRemove === sub.id) {
      const sure = button(doc, 'settings-action-btn settings-danger-btn', 'Wirklich abbestellen', 'confirm-remove');
      sure.setAttribute('aria-label', `${sub.title}: endgültig abbestellen`);
      sure.addEventListener('click', () => unsubscribe(sub));
      const keep = button(doc, 'settings-action-btn', 'Behalten', 'cancel-remove');
      keep.addEventListener('click', () => {
        state.confirmRemove = null;
        state.restoreFocus = { id: sub.id, action: 'remove' };
        renderList();
      });
      actions.append(sure, keep);
    } else {
      const remove = button(doc, 'settings-action-btn settings-danger-btn', 'Abbestellen', 'remove');
      remove.setAttribute('aria-label', `${sub.title}: abbestellen`);
      remove.addEventListener('click', () => {
        state.confirmRemove = sub.id;
        state.restoreFocus = { id: sub.id, action: 'confirm-remove' };
        renderList();
      });
      actions.appendChild(remove);
    }
    head.append(cover.element, info, actions);
    row.appendChild(head);
    return row;
  }

  function renderList() {
    const feeds = ownFeeds();
    listEl.textContent = '';
    feeds.forEach(sub => listEl.appendChild(buildRow(sub)));
    emptyEl.hidden = !state.loaded || feeds.length > 0;
    listEl.hidden = feeds.length === 0;
    const target = state.restoreFocus;
    state.restoreFocus = null;
    if (!target) return;
    const row = findAll(listEl, node => node.dataset && node.dataset.id === target.id && node.classList.contains('settings-podcast-row'))[0];
    focusNode(row && findAll(row, node => node.dataset && node.dataset.action === target.action)[0]);
  }

  const unsubscribers = [];
  if (typeof podcasts.onSubscriptionsChanged === 'function') unsubscribers.push(podcasts.onSubscriptionsChanged(list => setSubs(list)));
  renderForm();

  return {
    refresh,
    getState: () => state,
    getModel: () => addModel,
    dispose: () => unsubscribers.forEach(off => typeof off === 'function' && off()),
  };
}

module.exports = { createPodcastFeedsView };
