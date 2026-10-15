// Podcast-Oberfläche (P3): gemeinsamer Datenspeicher der Ansichten (Dashboard, Sendungsseite, Suche). Hält Abos (mit
// Feed-Zustand) und die Episodenlisten je Abo, lädt sie über window.podcasts und aktualisiert sie auf Events
// (Abos geändert, Feed aktualisiert, Hörstatus geändert). Kein DOM. Die Ansichten abonnieren per subscribe(listener).

'use strict';

const RELOAD_DELAY_MS = 300;

/**
 * options: { podcasts (window.podcasts), logger, setTimeout/clearTimeout (Tests) }
 * snapshot(): { loaded, subscriptions, episodes: { [id]: { fetchedAt, channel, episodes } }, catalog, refreshing, loadError }
 */
function createPodcastData({ podcasts, logger = null, timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) } } = {}) {
  let subscriptions = [];
  let episodes = {};
  let catalog = [];
  let loaded = false;
  let refreshing = false;
  let loadError = '';
  let seq = 0;
  let reloadTimer = null;
  const listeners = new Set();
  const unsubscribers = [];

  const warn = (message, error) => {
    if (logger) logger.warn(`Podcast: ${message}`, error && error.message ? error.message : error || '');
  };
  const emit = () => listeners.forEach(listener => listener());

  function snapshot() {
    return { loaded, subscriptions, episodes, catalog, refreshing, loadError };
  }

  async function loadEpisodes(list, mine) {
    const entries = await Promise.all(
      list.map(async sub => {
        try {
          const feed = await podcasts.episodes(sub.id);
          return [sub.id, { fetchedAt: feed.fetchedAt || null, channel: feed.channel || null, episodes: Array.isArray(feed.episodes) ? feed.episodes : [] }];
        } catch (error) {
          warn('Episoden nicht lesbar', error);
          return [sub.id, { fetchedAt: null, channel: null, episodes: [] }];
        }
      }),
    );
    if (mine !== seq) return null;
    return Object.fromEntries(entries);
  }

  /** Lädt Abos und Episoden neu (veraltete Antworten werden verworfen). */
  async function load() {
    const mine = ++seq;
    try {
      const list = await podcasts.list();
      if (mine !== seq) return;
      const next = Array.isArray(list) ? list : [];
      const loadedEpisodes = await loadEpisodes(next, mine);
      if (!loadedEpisodes) return;
      subscriptions = next;
      episodes = loadedEpisodes;
      loadError = '';
    } catch (error) {
      if (mine !== seq) return;
      loadError = 'Abos konnten nicht geladen werden';
      warn('Abos nicht lesbar', error);
    }
    loaded = true;
    emit();
  }

  async function loadCatalog() {
    try {
      const sources = await podcasts.getCatalog();
      catalog = Array.isArray(sources) ? sources : [];
    } catch (error) {
      warn('Katalog nicht lesbar', error);
    }
    emit();
  }

  function scheduleReload() {
    if (reloadTimer) timers.clearTimeout(reloadTimer);
    reloadTimer = timers.setTimeout(() => {
      reloadTimer = null;
      load();
    }, RELOAD_DELAY_MS);
  }

  /** „Jetzt aktualisieren“: alle Feeds prüfen (erzwungen), danach neu laden. Liefert das Ergebnis des Main. */
  async function refreshAll() {
    if (refreshing) return { ok: false, error: 'Es läuft bereits eine Aktualisierung' };
    refreshing = true;
    emit();
    try {
      const result = await podcasts.refresh({ force: true });
      await load();
      return result;
    } finally {
      refreshing = false;
      emit();
    }
  }

  function patchEpisodeState({ podcastId, episodeId, state }) {
    const feed = episodes[podcastId];
    if (!feed || !state) return;
    let changed = false;
    const next = feed.episodes.map(episode => {
      if (episode.id !== episodeId) return episode;
      changed = true;
      return { ...episode, state: { ...state, duration: state.duration || (episode.state && episode.state.duration) || episode.duration || null } };
    });
    if (!changed) return;
    episodes = { ...episodes, [podcastId]: { ...feed, episodes: next } };
    emit();
  }

  unsubscribers.push(
    podcasts.onSubscriptionsChanged(() => scheduleReload()),
    podcasts.onRefreshed(() => scheduleReload()),
    podcasts.onStateChanged(payload => payload && patchEpisodeState(payload)),
  );

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    if (reloadTimer) timers.clearTimeout(reloadTimer);
    unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
    listeners.clear();
  }

  return { snapshot, load, loadCatalog, refreshAll, subscribe, dispose };
}

module.exports = { createPodcastData, RELOAD_DELAY_MS };
