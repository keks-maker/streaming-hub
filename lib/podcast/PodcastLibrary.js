'use strict';

// Persistenz-Fassade für Podcasts über den user-storage (Konzept §4):
//   podcasts        (podcasts.json)         Abos, Reihenfolge (subscriptionRank), Overrides (Name, Cover)
//   podcastState    (podcast-state.json)    Hörzustand und Feed-Metadaten (podcast-state.js)
//   podcastEpisodes (podcast-episodes.json) Episoden-Cache je Abo (höchstens 50), nur für schnellen Start/Offline-Anzeige
//   podcastSources  (podcastsources.json)   mitgelieferte Liste (nur lesen)
// Beschädigte Dateien werden wie leer behandelt (Warnung im Log), nie überschrieben, solange nichts Neues geschrieben wird.
// Eingaben werden von den IPC-Handlern vorab validiert (input-validation.js / ipc-validation.js).

const { podcastIdFromFeedUrl } = require('./podcast-ids.js');
const stateLogic = require('./podcast-state.js');
const { isUnsafeKey, sanitizeOverride, sanitizeOverrides } = require('./podcast-overrides.js');
const { catalogIndex } = require('./podcast-sources-merge.js');
const { cleanTree } = require('./shownotes-schema.js');
const { normalizePodcastSettings, applyPodcastSettingsPatch } = require('./podcast-settings.js');

const MAX_CACHED_EPISODES = 50;
const MAX_NOTES_BUDGET = 1000000; // Zeichen (JSON) der Shownotes-Bäume je Feed im Cache (neueste Episoden zuerst); Rest nur mit Klartext-Auszug
const MAX_SUBSCRIPTIONS = 1000;
const CUSTOM_SOURCE_ID = 'eigene-podcasts';
const SEARCH_SOURCE_ID = 'suche';
const SOURCE_IDS = [CUSTOM_SOURCE_ID, SEARCH_SOURCE_ID];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Begrenzt die Shownotes-Bäume im Cache: neueste Episoden zuerst, danach bleibt nur der Klartext-Auszug (die Liste selbst bleibt vollständig). */
function withNotesBudget(episodes) {
  let used = 0;
  return episodes.map(episode => {
    if (!episode || !Array.isArray(episode.notesTree) || !episode.notesTree.length) return episode;
    const size = JSON.stringify(episode.notesTree).length;
    if (used + size > MAX_NOTES_BUDGET) {
      const rest = { ...episode };
      delete rest.notesTree;
      return rest;
    }
    used += size;
    return episode;
  });
}

/** Listenansicht einer Episode: ohne Shownotes und Kapitel (die liefert getEpisodeDetails bei Bedarf), nur Merker. */
function slimEpisode(episode) {
  const { notes, notesTree, chapters, chaptersUrl, ...rest } = episode;
  return { ...rest, hasNotes: Boolean(notes) || (Array.isArray(notesTree) && notesTree.length > 0), hasChapters: Boolean(chaptersUrl) || (Array.isArray(chapters) && chapters.length > 0) };
}

class PodcastLibrary {
  /** options: userStorage ({ readJson, writeJson }), logger, now (Tests) */
  constructor({ userStorage, logger = null, now = () => new Date() } = {}) {
    if (!userStorage) throw new Error('PodcastLibrary benötigt userStorage');
    this.userStorage = userStorage;
    this.logger = logger;
    this.now = now;
  }

  read(kind, fallback) {
    try {
      return this.userStorage.readJson(kind, fallback);
    } catch (error) {
      if (this.logger) this.logger.warn(`Podcast-Daten (${kind}) konnten nicht geladen werden:`, error.message);
      return fallback;
    }
  }

  // ── mitgelieferte Liste ──

  getCatalog() {
    const sources = this.read('podcastSources', []);
    return Array.isArray(sources) ? sources.filter(source => isPlainObject(source) && Array.isArray(source.podcasts)) : [];
  }

  // ── Abos ──

  readData() {
    const raw = this.read('podcasts', {});
    const data = isPlainObject(raw) ? raw : {};
    return {
      version: 1,
      subscriptions: (Array.isArray(data.subscriptions) ? data.subscriptions : []).filter(sub => isPlainObject(sub) && typeof sub.id === 'string' && typeof sub.feedUrl === 'string'),
      subscriptionRank: Array.isArray(data.subscriptionRank) ? data.subscriptionRank.filter(id => typeof id === 'string') : [],
      overrides: sanitizeOverrides(data.overrides),
    };
  }

  writeData(data) {
    this.userStorage.writeJson('podcasts', data);
  }

  /** Abos in Anzeigereihenfolge mit angewendeten Overrides (Name, Cover). */
  getSubscriptions() {
    const data = this.readData();
    const position = new Map(data.subscriptionRank.map((id, index) => [id, index]));
    const ordered = data.subscriptions
      .map((sub, index) => ({ sub, index }))
      .sort((a, b) => (position.has(a.sub.id) ? position.get(a.sub.id) : 1e9 + a.index) - (position.has(b.sub.id) ? position.get(b.sub.id) : 1e9 + b.index))
      .map(entry => entry.sub);
    return ordered.map(sub => this.applyOverride(sub, data.overrides[sub.id]));
  }

  applyOverride(sub, override) {
    const clean = sanitizeOverride(override);
    if (!clean) return sub;
    return { ...sub, title: clean.title || sub.title, cover: clean.cover || sub.cover, overrides: clean, original: { title: sub.title, cover: sub.cover || null } };
  }

  getSubscription(id) {
    return this.getSubscriptions().find(sub => sub.id === id) || null;
  }

  /**
   * Abonniert einen Feed. input: { feedUrl, title, author?, cover?, source, catalogId? }. Idempotent: ein vorhandenes Abo bleibt
   * unverändert. Liefert { subscription, added }.
   */
  subscribe(input) {
    const id = podcastIdFromFeedUrl(input.feedUrl);
    const data = this.readData();
    const existing = data.subscriptions.find(sub => sub.id === id);
    if (existing) return { subscription: existing, added: false };
    if (data.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error('Zu viele Abos');
    const subscription = {
      id,
      feedUrl: input.feedUrl,
      title: input.title || input.feedUrl,
      author: input.author || '',
      cover: input.cover || null,
      addedAt: new Date(this.now()).toISOString(),
      source: input.source,
    };
    if (input.catalogId) subscription.catalogId = input.catalogId;
    data.subscriptions.push(subscription);
    data.subscriptionRank.push(id);
    this.writeData(data);
    return { subscription, added: true };
  }

  /** Ergänzt fehlende Angaben (Titel-Platzhalter, Autor, Cover) eines selbst abonnierten Feeds aus dem Kanalkopf; Katalog-Abos bleiben unberührt. */
  fillFromChannel(id, channel) {
    if (!channel) return;
    const data = this.readData();
    const sub = data.subscriptions.find(entry => entry.id === id);
    if (!sub || sub.catalogId) return;
    const next = { ...sub };
    if ((!sub.title || sub.title === sub.feedUrl) && channel.title) next.title = channel.title;
    if (!sub.author && channel.author) next.author = channel.author;
    if (!sub.cover && channel.cover) next.cover = channel.cover;
    if (next.title === sub.title && next.author === sub.author && next.cover === sub.cover) return;
    data.subscriptions = data.subscriptions.map(entry => (entry.id === id ? next : entry));
    this.writeData(data);
  }

  /** Beendet das Abo. Hörzustand bleibt bis zur Bereinigung erhalten (erneutes Abonnieren setzt fort). Liefert true bei Änderung. */
  unsubscribe(id) {
    const data = this.readData();
    if (!data.subscriptions.some(sub => sub.id === id)) return false;
    data.subscriptions = data.subscriptions.filter(sub => sub.id !== id);
    data.subscriptionRank = data.subscriptionRank.filter(rankId => rankId !== id);
    delete data.overrides[id];
    this.writeData(data);
    const cache = this.readCache();
    if (cache.feeds[id]) {
      delete cache.feeds[id];
      this.userStorage.writeJson('podcastEpisodes', cache);
    }
    return true;
  }

  /** Neue Reihenfolge (Abo-IDs); unbekannte IDs entfallen, fehlende werden hinten angehängt. */
  setRank(order) {
    const data = this.readData();
    const known = new Set(data.subscriptions.map(sub => sub.id));
    const rank = [];
    for (const id of order) if (known.has(id) && !rank.includes(id)) rank.push(id);
    for (const sub of data.subscriptions) if (!rank.includes(sub.id)) rank.push(sub.id);
    data.subscriptionRank = rank;
    this.writeData(data);
    return this.getSubscriptions();
  }

  /** patch: { title?, cover? } (leerer String/null entfernt das Feld). */
  setOverride(id, patch) {
    const data = this.readData();
    if (!data.subscriptions.some(sub => sub.id === id)) throw new Error('Abo nicht gefunden');
    const merged = { ...(isPlainObject(data.overrides[id]) ? data.overrides[id] : {}) };
    for (const key of ['title', 'cover']) {
      if (!(key in patch)) continue;
      if (patch[key]) merged[key] = patch[key];
      else delete merged[key];
    }
    if (Object.keys(merged).length) data.overrides[id] = merged;
    else delete data.overrides[id];
    this.writeData(data);
    return this.getSubscriptions();
  }

  // ── Einstellungen (podcast-settings.json) ──

  getSettings() {
    try {
      return normalizePodcastSettings(this.userStorage.readJson('podcastSettings', {}));
    } catch (error) {
      if (this.logger) this.logger.warn('Podcast-Einstellungen konnten nicht geladen werden:', error.message);
      return normalizePodcastSettings({});
    }
  }

  /** Patch auf die gespeicherten Einstellungen (validiert); liefert die neuen Einstellungen. */
  updateSettings(patch) {
    const next = applyPodcastSettingsPatch(this.getSettings(), patch);
    this.userStorage.writeJson('podcastSettings', next);
    return next;
  }

  // ── Hörzustand ──

  getState() {
    return stateLogic.normalizeState(this.read('podcastState', {}));
  }

  mutateState(fn) {
    const before = this.getState();
    const after = fn(before);
    if (after !== before) this.userStorage.writeJson('podcastState', after);
    return after;
  }

  getEpisodeState(podcastId, episodeId) {
    return stateLogic.getEpisodeState(this.getState(), podcastId, episodeId);
  }

  savePosition(podcastId, episodeId, progress) {
    const after = this.mutateState(state => stateLogic.savePosition(state, podcastId, episodeId, progress, this.now()));
    return stateLogic.getEpisodeState(after, podcastId, episodeId);
  }

  setPlayed(podcastId, episodeId, played) {
    const after = this.mutateState(state => stateLogic.setPlayed(state, podcastId, episodeId, played, this.now()));
    return stateLogic.getEpisodeState(after, podcastId, episodeId);
  }

  getFeedMeta(podcastId) {
    return this.getState().feeds[podcastId] || { lastChecked: null, etag: null, lastModified: null, lastError: null, lastErrorAt: null };
  }

  setFeedMeta(podcastId, patch) {
    this.mutateState(state => stateLogic.setFeedMeta(state, podcastId, patch));
  }

  // ── Episoden-Cache ──

  readCache() {
    const raw = this.read('podcastEpisodes', {});
    const feeds = {};
    if (isPlainObject(raw) && isPlainObject(raw.feeds)) {
      for (const [id, entry] of Object.entries(raw.feeds)) if (!isUnsafeKey(id)) feeds[id] = entry;
    }
    return { version: 1, feeds };
  }

  setEpisodes(podcastId, { episodes, channel = null }) {
    const cache = this.readCache();
    cache.feeds[podcastId] = {
      fetchedAt: new Date(this.now()).toISOString(),
      channel,
      episodes: withNotesBudget(episodes.slice(0, MAX_CACHED_EPISODES)),
    };
    this.userStorage.writeJson('podcastEpisodes', cache);
  }

  getCachedFeed(podcastId) {
    const entry = this.readCache().feeds[podcastId];
    return isPlainObject(entry) && Array.isArray(entry.episodes) ? entry : { fetchedAt: null, channel: null, episodes: [] };
  }

  /** Episoden aus dem Cache, jede mit ihrem Hörzustand (state: { position, duration, played, updatedAt }). */
  getEpisodes(podcastId) {
    const state = this.getState();
    const feed = this.getCachedFeed(podcastId);
    return {
      fetchedAt: feed.fetchedAt,
      channel: feed.channel,
      episodes: feed.episodes.map(entry => {
        const episode = slimEpisode(entry);
        const listen = stateLogic.getEpisodeState(state, podcastId, episode.id);
        return { ...episode, state: { ...listen, duration: listen.duration || episode.duration || null } };
      }),
    };
  }

  /** Shownotes und Kapitel-Quellen einer Episode aus dem Cache: { notes (Klartext-Auszug), notesTree, chapters (inline), chaptersUrl } oder null. */
  getEpisodeDetails(podcastId, episodeId) {
    const episode = this.getCachedFeed(podcastId).episodes.find(entry => entry && entry.id === episodeId);
    if (!episode) return null;
    return {
      notes: typeof episode.notes === 'string' ? episode.notes : '',
      notesTree: cleanTree(episode.notesTree), // Cache-Datei ist nicht vertrauenswürdig: Allowlist erneut anwenden
      chapters: Array.isArray(episode.chapters) ? episode.chapters : [],
      chaptersUrl: typeof episode.chaptersUrl === 'string' ? episode.chaptersUrl : null,
    };
  }

  /** Räumt Hörzustände (>12 Monate und nicht mehr im Cache) und Metadaten/Caches entfernter Abos auf. */
  prune() {
    const subscriptions = new Set(this.readData().subscriptions.map(sub => sub.id));
    const cache = this.readCache();
    const known = (podcastId, episodeId) => {
      const entry = cache.feeds[podcastId];
      return Boolean(entry && Array.isArray(entry.episodes) && entry.episodes.some(episode => episode.id === episodeId));
    };
    const before = this.getState();
    const after = stateLogic.pruneState(before, { now: this.now(), isKnownEpisode: known, hasSubscription: id => subscriptions.has(id) });
    if (after !== before) this.userStorage.writeJson('podcastState', after);
    const staleFeeds = Object.keys(cache.feeds).filter(id => !subscriptions.has(id));
    if (staleFeeds.length) {
      for (const id of staleFeeds) delete cache.feeds[id];
      this.userStorage.writeJson('podcastEpisodes', cache);
    }
  }

  /** Katalogeintrag (mit sourceId) oder null. */
  getCatalogEntry(catalogId) {
    return catalogIndex(this.getCatalog()).get(catalogId) || null;
  }

  /** Sicherungsdaten: Abos, Hörstatus und Einstellungen (ohne Feed-Validatoren und Episoden-Cache). */
  exportBackup() {
    const data = this.readData();
    return { podcasts: data, podcastState: { version: 1, episodes: this.getState().episodes }, podcastSettings: this.getSettings() };
  }
}

module.exports = { PodcastLibrary, MAX_CACHED_EPISODES, MAX_NOTES_BUDGET, CUSTOM_SOURCE_ID, SEARCH_SOURCE_ID, SOURCE_IDS };
