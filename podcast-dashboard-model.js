// Podcast-Dashboard (P3): Modell von „Neue Episoden“, „Meine Abos“, Statuszeile und Leerzustand. Reine Funktionen ohne DOM
// und IPC (Muster radio-dashboard-model.js); die Ansicht setzt alle Feed-Texte ausschließlich per textContent.
// Eingabe: Abos mit Feed-Zustand (podcast:list), Episodenlisten je Abo, Player-Zustand, Katalog (podcast:catalog).

'use strict';

const { isNewEpisode, episodeItem, episodeStatus, sortEpisodeItems, normalizeSort } = require('./podcast-episode-model.js');
const { formatAgo, initialOf, plural } = require('./podcast-format.js');

const NEW_PER_SHOW = 5;
const NEW_TOTAL = 40;
const POPULAR_COUNT = 8;
const ALL_ID = '__all'; // Auswahl „Alle neuen Episoden“ (kein gültiger Podcast-ID-Wert eines Abos)
const FILTERS = ['all', 'unheard'];

const MSG_EMPTY = 'Noch keine Podcasts abonniert. Suche eine Sendung oder starte mit einer beliebten öffentlich-rechtlichen Sendung.';

function feedOf(sub, episodes) {
  return (episodes && episodes[sub.id]) || { episodes: [] };
}

/** Statuszeile: "8 Abos · 5 neue Episoden · geprüft vor 3 Min." (ohne Abos: ''). */
function statusLine({ subscriptions, newCount, now }) {
  if (!subscriptions.length) return '';
  const checked = subscriptions
    .map(sub => (sub.feed && sub.feed.lastChecked ? Date.parse(sub.feed.lastChecked) : NaN))
    .filter(Number.isFinite);
  const latest = checked.length ? new Date(Math.max(...checked)).toISOString() : null;
  const news = `${newCount} ${newCount === 1 ? 'neue Episode' : 'neue Episoden'}`;
  return `${plural(subscriptions.length, 'Abo', 'Abos')} · ${news} · geprüft ${formatAgo(latest, now)}`;
}

/** Abo-Kachel: { id, title, author, cover, initial, unheard, badgeText, error, errorText, active, ariaLabel }. */
function showTile({ sub, episodes, player, now }) {
  const feed = feedOf(sub, episodes);
  const unheard = feed.episodes.filter(episode => isNewEpisode(episode, now)).length;
  const error = (sub.feed && sub.feed.lastError) || '';
  const current = player && player.episode;
  const active = Boolean(current) && current.podcastId === sub.id && ['loading', 'playing', 'paused'].includes(player.status);
  const badgeText = unheard > 99 ? '99+' : String(unheard);
  const parts = [sub.title, sub.author, unheard ? `${unheard} ungehörte ${unheard === 1 ? 'Episode' : 'Episoden'}` : '', error ? 'Feed nicht erreichbar' : ''].filter(Boolean);
  return {
    id: sub.id,
    title: sub.title || sub.feedUrl,
    author: sub.author || '',
    cover: sub.cover || null,
    initial: initialOf(sub.title),
    unheard,
    badgeText,
    error: Boolean(error),
    errorText: error ? 'Feed nicht erreichbar' : '',
    active,
    ariaLabel: `${parts.join(', ')} – Episoden anzeigen`,
  };
}

/** „Neue Episoden“ über alle Abos: neueste zuerst, je Abo höchstens 5, insgesamt höchstens 40. Liefert { items, total }. */
function newEpisodeItems({ subscriptions, episodes, player, now, sort = 'newest' }) {
  const all = [];
  let total = 0;
  for (const sub of subscriptions) {
    const fresh = feedOf(sub, episodes).episodes.filter(episode => isNewEpisode(episode, now));
    total += fresh.length;
    fresh
      .map(episode => ({ episode, time: Date.parse(episode.pubDate) }))
      .sort((a, b) => (Number.isFinite(b.time) ? b.time : 0) - (Number.isFinite(a.time) ? a.time : 0))
      .slice(0, NEW_PER_SHOW)
      .forEach(({ episode, time }) => all.push({ time: Number.isFinite(time) ? time : 0, item: episodeItem({ podcastId: sub.id, show: sub.title, episode, fallbackCover: sub.cover, player, now }) }));
  }
  all.sort((a, b) => b.time - a.time);
  return { items: sortEpisodeItems(all.slice(0, NEW_TOTAL).map(entry => entry.item), sort), total };
}

/**
 * Kurzliste „Beliebte öffentlich-rechtliche Sendungen“: je Autor zuerst eine Sendung (Vielfalt), danach aufgefüllt; bereits
 * abonnierte Sendungen entfallen. Eintrag: { catalogId, title, author, cover, initial, genre, ariaLabel }.
 */
function popularCatalog(catalog, subscriptions, limit = POPULAR_COUNT, { includeSubscribed = false } = {}) {
  const taken = new Set((subscriptions || []).flatMap(sub => [sub.catalogId, sub.feedUrl]).filter(Boolean));
  const isTaken = entry => taken.has(entry.id) || taken.has(entry.feedUrl);
  const entries = (Array.isArray(catalog) ? catalog : [])
    .flatMap(source => (Array.isArray(source.podcasts) ? source.podcasts : []))
    .filter(entry => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && (includeSubscribed || !isTaken(entry)));
  const firstOfAuthor = [];
  const rest = [];
  const authors = new Set();
  for (const entry of entries) {
    const author = entry.author || '';
    if (authors.has(author)) rest.push(entry);
    else {
      authors.add(author);
      firstOfAuthor.push(entry);
    }
  }
  return [...firstOfAuthor, ...rest].slice(0, limit).map(entry => ({
    catalogId: entry.id,
    title: entry.name,
    author: entry.author || '',
    cover: entry.cover || null,
    initial: initialOf(entry.name),
    genre: entry.genre || '',
    subscribed: isTaken(entry),
    ariaLabel: `${entry.name}${entry.author ? `, ${entry.author}` : ''} – ${isTaken(entry) ? 'bereits abonniert' : 'abonnieren'}`,
  }));
}

function normalizeFilter(value) {
  return FILTERS.includes(value) ? value : 'all';
}

/**
 * Auswahlzustand des Dashboards (Sitzung): { selection (ALL_ID | Abo-ID), filter ('all'|'unheard'), sort }.
 * Eine Auswahl, die es nicht mehr gibt (abbestellt), fällt auf „Alle neuen Episoden“ zurück.
 */
function normalizeSelection(view, subscriptions) {
  const raw = view && typeof view === 'object' ? view : {};
  const known = (subscriptions || []).some(sub => sub.id === raw.selection);
  return { selection: known ? raw.selection : ALL_ID, filter: normalizeFilter(raw.filter), sort: normalizeSort(raw.sort) };
}

/** „Alle neuen Episoden“ als erster Eintrag der Abo-Liste: { id: ALL_ID, title, subtitle, unheard, badgeText, current, ariaLabel }. */
function allEntry({ newCount, selected }) {
  const badgeText = newCount > 99 ? '99+' : String(newCount);
  return {
    id: ALL_ID,
    title: 'Alle neuen Episoden',
    author: newCount ? `${newCount} ${newCount === 1 ? 'neue Episode' : 'neue Episoden'}` : 'Alles gehört',
    unheard: newCount,
    badgeText,
    selected,
    ariaLabel: `Alle neuen Episoden, ${newCount} ${newCount === 1 ? 'neue Episode' : 'neue Episoden'}`,
  };
}

/**
 * Rechte Spalte des Dashboards. Auswahl „alle“: die gemeinsame Liste neuer Episoden (je Abo höchstens 5, insgesamt 40).
 * Auswahl eines Abos: alle zwischengespeicherten Episoden dieses Abos (Filter „alle“ oder nur ungehörte), sortiert.
 * Ausgabe: { selection, filter, sort, isAll, showId, heading, items, total, emptyText, canOpenShow, filterVisible, hint }
 */
function episodeColumnModel({ subscriptions = [], episodes = {}, player = null, now = Date.now(), view = null } = {}) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const { selection, filter, sort } = normalizeSelection(view, subs);
  if (selection === ALL_ID) {
    const { items, total } = newEpisodeItems({ subscriptions: subs, episodes, player, now, sort });
    return { selection, filter, sort, isAll: true, showId: null, heading: 'Alle neuen Episoden', items, total, emptyText: 'Keine neuen Episoden. Alles gehört.', canOpenShow: false, filterVisible: false, hint: '' };
  }
  const sub = subs.find(entry => entry.id === selection);
  const list = feedOf(sub, episodes).episodes;
  const unheard = list.filter(episode => episodeStatus(episode) !== 'played').length;
  const picked = filter === 'unheard' ? list.filter(episode => episodeStatus(episode) !== 'played') : list;
  const items = sortEpisodeItems(
    picked.map(episode => episodeItem({ podcastId: sub.id, show: sub.title, episode, fallbackCover: sub.cover, player, now })),
    sort,
  );
  let emptyText = '';
  if (!items.length) emptyText = list.length ? 'Keine ungehörten Episoden. Alles gehört.' : 'Noch keine Episoden geladen. Mit „Jetzt aktualisieren“ prüfst du den Feed.';
  return {
    selection,
    filter,
    sort,
    isAll: false,
    showId: sub.id,
    heading: sub.title || sub.feedUrl,
    items,
    total: list.length,
    emptyText,
    canOpenShow: true,
    filterVisible: true,
    hint: filter === 'unheard' ? `${plural(unheard, 'ungehörte Episode', 'ungehörte Episoden')} von ${plural(list.length, 'Episode', 'Episoden')}` : `${plural(list.length, 'Episode', 'Episoden')}, davon ${unheard} ungehört`,
  };
}

/**
 * Modell des Podcast-Dashboards.
 * Ausgabe: { loaded, empty, statusText, newCount, newEpisodes (= column.items), column (episodeColumnModel), allEntry, shows (mit selected), popular, emptyMessage, loadError }
 */
function podcastDashboardModel({ subscriptions = [], episodes = {}, player = null, catalog = [], loaded = true, loadError = '', now = Date.now(), view = null } = {}) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const column = episodeColumnModel({ subscriptions: subs, episodes, player, now, view });
  const { total } = newEpisodeItems({ subscriptions: subs, episodes, player, now });
  return {
    loaded,
    empty: loaded && subs.length === 0,
    statusText: loaded ? statusLine({ subscriptions: subs, newCount: total, now }) : '',
    newCount: total,
    newEpisodes: column.items,
    column,
    allEntry: allEntry({ newCount: total, selected: column.selection === ALL_ID }),
    shows: subs.map(sub => ({ ...showTile({ sub, episodes, player, now }), selected: column.selection === sub.id })),
    popular: subs.length === 0 ? popularCatalog(catalog, subs) : [],
    emptyMessage: MSG_EMPTY,
    loadError,
  };
}

module.exports = { ALL_ID, FILTERS, normalizeSelection, normalizeFilter, allEntry, episodeColumnModel, NEW_PER_SHOW, NEW_TOTAL, POPULAR_COUNT, MSG_EMPTY, statusLine, showTile, newEpisodeItems, popularCatalog, podcastDashboardModel };
