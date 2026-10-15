'use strict';

// IPC für Podcasts (Konzept §6/§7): alle podcast:*-Kanäle mit Absenderprüfung (nur Hauptfenster) und Schema-Validierung
// (ipc-validation.js). Netzwerk (Suche, Feed-Abruf) läuft im Main-Prozess, nie im Renderer. Änderungen an Abos gehen als
// Event podcast:subscriptions-changed, Aktualisierungsergebnisse als podcast:refreshed an das Hauptfenster.
// Wiedergabe (P2): podcast:play|pause|resume|stop|seek|skip|rate|volume|get-state steuern den PodcastController (optional);
// Zustand geht als Event podcast:state an das Hauptfenster, Nachrichten des Player-Hosts nur vom Player-WebContents.

const { podcastFeedUrlError } = require('../input-validation.js');
const {
  validateNoPayload,
  validatePodcastId,
  validatePodcastSearch,
  validatePodcastSubscribe,
  validatePodcastRefresh,
  validatePodcastPosition,
  validatePodcastPlayed,
  validatePodcastPlay,
  validatePodcastSeek,
  validatePodcastSkip,
  validatePodcastRate,
  normalizeRadioPlayerReport,
  validateRadioVolume,
} = require('../ipc-validation.js');
const { fetchFeed } = require('./podcast-fetch.js');
const { parseFeed } = require('./feed-parser.js');

/**
 * options: ipcMain, library (PodcastLibrary), refresher (podcast-refresh.js), search (podcast-search.js),
 * requireMainRenderer(event), sendToMain(channel, payload), feedFetch (Standard: fetchFeed, Tests), logger.
 */
function registerPodcastIpc({ ipcMain, library, refresher, search, controller = null, requireMainRenderer, sendToMain, feedFetch = fetchFeed, logger = null }) {
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

  if (controller) registerPlayerChannels({ ipcMain, controller, main, sendToMain, logger });
}

function registerPlayerChannels({ ipcMain, controller, main, sendToMain, logger }) {
  main('podcast:play', value => {
    const { podcastId, episodeId, startPosition } = validatePodcastPlay(value);
    return controller.play({ podcastId, episodeId }, startPosition);
  });
  const noPayload = (channel, action) =>
    main(channel, (...rest) => {
      validateNoPayload(rest);
      return action();
    });
  noPayload('podcast:pause', () => controller.pause());
  noPayload('podcast:resume', () => controller.resume());
  noPayload('podcast:stop', () => controller.stop());
  noPayload('podcast:get-state', () => controller.getState());
  main('podcast:seek', value => controller.seek(validatePodcastSeek(value)));
  main('podcast:skip', value => controller.skip(validatePodcastSkip(value)));
  main('podcast:rate', value => controller.setRate(validatePodcastRate(value)));
  main('podcast:volume', value => controller.setVolume(validateRadioVolume(value)));

  // Nachrichten des Player-Hosts: nur vom Player-WebContents dieses Controllers (der Radio-Player hat einen eigenen Empfänger)
  ipcMain.on('radio-player:report', (event, message) => {
    const player = controller.playerWebContents();
    if (!player || event.sender !== player) return;
    const report = normalizeRadioPlayerReport(message);
    if (!report) {
      if (logger) logger.warn('Ungültige Nachricht vom Podcast-Player verworfen');
      return;
    }
    controller.onPlayerReport(report);
  });

  controller.on('state', state => sendToMain('podcast:state', state));
  controller.on('listen-changed', payload => sendToMain('podcast:state-changed', payload));
}

module.exports = { registerPodcastIpc };
