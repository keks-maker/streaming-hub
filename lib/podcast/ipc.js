'use strict';

// IPC für Podcasts (Konzept §6/§7): alle podcast:*-Kanäle mit Absenderprüfung (nur Hauptfenster) und Schema-Validierung
// (ipc-validation.js). Netzwerk (Suche, Feed-Abruf) läuft im Main-Prozess, nie im Renderer. Änderungen an Abos gehen als
// Event podcast:subscriptions-changed, Aktualisierungsergebnisse als podcast:refreshed an das Hauptfenster.
// Noch ohne Wiedergabe: Player-Anbindung (PodcastController) folgt in P3.

const { podcastFeedUrlError } = require('../input-validation.js');
const {
  validateNoPayload,
  validatePodcastId,
  validatePodcastSearch,
  validatePodcastSubscribe,
  validatePodcastRefresh,
  validatePodcastPosition,
  validatePodcastPlayed,
} = require('../ipc-validation.js');
const { fetchFeed } = require('./podcast-fetch.js');
const { parseFeed } = require('./feed-parser.js');

/**
 * options: ipcMain, library (PodcastLibrary), refresher (podcast-refresh.js), search (podcast-search.js),
 * requireMainRenderer(event), sendToMain(channel, payload), feedFetch (Standard: fetchFeed, Tests), logger.
 */
function registerPodcastIpc({ ipcMain, library, refresher, search, requireMainRenderer, sendToMain, feedFetch = fetchFeed, logger = null }) {
  const main = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event);
      return handler(...args);
    });
  };
  const requireSubscription = id => {
    if (!library.getSubscription(id)) throw new Error('Abo nicht gefunden');
  };
  const withMeta = sub => ({ ...sub, feed: library.getFeedMeta(sub.id) });
  const listSubscriptions = () => library.getSubscriptions().map(withMeta);
  const broadcastSubscriptions = () => {
    const list = listSubscriptions();
    sendToMain('podcast:subscriptions-changed', list);
    return list;
  };

  main('podcast:search', async value => {
    const { term, limit } = validatePodcastSearch(value);
    try {
      const { results, cached } = await search.search(term, { limit });
      return { ok: true, results, cached };
    } catch (error) {
      if (error && error.code === 'network' && logger) logger.warn('Podcast-Suche fehlgeschlagen:', error.message);
      return { ok: false, error: error.message || 'Suche fehlgeschlagen', code: (error && error.code) || 'error' };
    }
  });

  main('podcast:catalog', (...rest) => {
    validateNoPayload(rest);
    return library.getCatalog();
  });

  main('podcast:list', (...rest) => {
    validateNoPayload(rest);
    return listSubscriptions();
  });

  main('podcast:subscribe', async value => {
    const input = validatePodcastSubscribe(value);
    let subscribeInput = input;
    if (input.catalogId) {
      const entry = library.getCatalogEntry(input.catalogId);
      if (!entry) throw new Error('Eintrag nicht in der mitgelieferten Liste');
      subscribeInput = { feedUrl: entry.feedUrl, title: entry.name, author: entry.author, cover: entry.cover, source: entry.sourceId, catalogId: entry.id };
    }
    const { subscription, added } = library.subscribe(subscribeInput);
    const refresh = added ? await refresher.refreshOne(subscription.id, { force: true }) : null;
    broadcastSubscriptions();
    return { ok: true, added, subscription: withMeta(library.getSubscription(subscription.id) || subscription), refresh };
  });

  main('podcast:unsubscribe', id => {
    const removed = library.unsubscribe(validatePodcastId(id));
    broadcastSubscriptions();
    return { ok: true, removed };
  });

  main('podcast:episodes', id => {
    const podcastId = validatePodcastId(id);
    const subscription = library.getSubscription(podcastId);
    if (!subscription) throw new Error('Abo nicht gefunden');
    return { subscription: withMeta(subscription), ...library.getEpisodes(podcastId) };
  });

  let refreshingAll = false;
  main('podcast:refresh', async value => {
    const { id, force } = validatePodcastRefresh(value);
    if (id) {
      const result = await refresher.refreshOne(id, { force });
      sendToMain('podcast:refreshed', { results: [result] });
      return { ok: true, ...result };
    }
    if (refreshingAll) return { ok: false, error: 'Es läuft bereits eine Aktualisierung' };
    refreshingAll = true;
    try {
      const summary = await refresher.refreshAll({ force });
      sendToMain('podcast:refreshed', { results: summary.results });
      return { ok: true, ...summary };
    } finally {
      refreshingAll = false;
    }
  });

  let probing = false;
  main('podcast:probe-feed', async url => {
    const error = podcastFeedUrlError(url);
    if (error) return { ok: false, error };
    if (probing) return { ok: false, error: 'Es läuft bereits eine Prüfung' };
    probing = true;
    try {
      const response = await feedFetch(url);
      const parsed = parseFeed(response.text);
      const { title, author, cover, description } = parsed.channel;
      return { ok: true, title, author, cover, description, episodeCount: parsed.totalItems - parsed.skipped, skipped: parsed.skipped };
    } catch (failure) {
      return { ok: false, error: failure.message || 'Feed konnte nicht gelesen werden' }; // Meldungen enthalten nie die URL
    } finally {
      probing = false;
    }
  });

  main('podcast:set-played', value => {
    const { podcastId, episodeId, played } = validatePodcastPlayed(value);
    requireSubscription(podcastId);
    const state = library.setPlayed(podcastId, episodeId, played);
    sendToMain('podcast:state-changed', { podcastId, episodeId, state });
    return state;
  });

  main('podcast:save-position', value => {
    const { podcastId, episodeId, position, duration } = validatePodcastPosition(value);
    requireSubscription(podcastId);
    const before = library.getEpisodeState(podcastId, episodeId);
    const state = library.savePosition(podcastId, episodeId, { position, duration });
    if (state.played !== before.played) sendToMain('podcast:state-changed', { podcastId, episodeId, state });
    return state;
  });
}

module.exports = { registerPodcastIpc };
