// Podcast-Dashboard (P3): Modell von „Neue Episoden“, „Meine Abos“, Statuszeile und Leerzustand. Reine Funktionen ohne DOM
// und IPC (Muster radio-dashboard-model.js); die Ansicht setzt alle Feed-Texte ausschließlich per textContent.
// Eingabe: Abos mit Feed-Zustand (podcast:list), Episodenlisten je Abo, Player-Zustand, Katalog (podcast:catalog).

'use strict';

const { isNewEpisode, episodeItem, sortEpisodeItems, normalizeSort } = require('./podcast-episode-model.js');
const { formatAgo, initialOf, plural } = require('./podcast-format.js');

const PAGE_SIZE = 50; // Zeilen je „Mehr laden“-Schritt
const MAX_LIMIT = 5000;
const POPULAR_COUNT = 8;
const ALL_ID = '__all'; // Auswahl „Alle neuen Episoden“ (kein gültiger Podcast-ID-Wert eines Abos)
const FILTERS = ['all', 'new'];
const NEW_HELP = 'ungehört, höchstens 30 Tage alt';

const MSG_EMPTY = 'Noch keine Podcasts abonniert. Suche eine Sendung oder starte mit einer beliebten öffentlich-rechtlichen Sendung.';

function feedOf(sub, episodes) {
  return (episodes && episodes[sub.id]) || { episodes: [] };
}

/** Eine Definition von „neu“ für Zähler, Badges, Statuszeile und Listen: isNewEpisode (ungehört und höchstens 30 Tage alt, oder begonnen). */
function newCountOf(sub, episodes, now) {
  return feedOf(sub, episodes).episodes.filter(episode => isNewEpisode(episode, now)).length;
}

function newLabel(count) {
  return `${count} ${count === 1 ? 'neue Episode' : 'neue Episoden'}`;
}

function badgeOf(count) {
  return count > 99 ? '99+' : String(count);
}

/** Statuszeile: "8 Abos · 5 neue Episoden · geprüft vor 3 Min." (ohne Abos: ''). */
function statusLine({ subscriptions, newCount, now }) {
  if (!subscriptions.length) return '';
  const checked = subscriptions
    .map(sub => (sub.feed && sub.feed.lastChecked ? Date.parse(sub.feed.lastChecked) : NaN))
    .filter(Number.isFinite);
  const latest = checked.length ? new Date(Math.max(...checked)).toISOString() : null;
  const news = newLabel(newCount);
  return `${plural(subscriptions.length, 'Abo', 'Abos')} · ${news} · geprüft ${formatAgo(latest, now)}`;
}

/** Abo-Kachel: { id, title, author, cover, initial, newCount, badgeText, badgeLabel, error, errorText, active (Episode läuft/pausiert), playing (läuft), ariaLabel }. */
function showTile({ sub, episodes, player, now }) {
  const newCount = newCountOf(sub, episodes, now);
  const error = (sub.feed && sub.feed.lastError) || '';
  const current = player && player.episode;
  const active = Boolean(current) && current.podcastId === sub.id && ['loading', 'playing', 'paused'].includes(player.status);
  const playing = active && player.status !== 'paused';
  const badgeLabel = newCount ? `${newLabel(newCount)} (${NEW_HELP})` : '';
  const parts = [sub.title, sub.author, newCount ? newLabel(newCount) : '', active ? (playing ? 'spielt gerade' : 'pausiert') : '', error ? 'Feed nicht erreichbar' : ''].filter(Boolean);
  return {
    id: sub.id,
    title: sub.title || sub.feedUrl,
    author: sub.author || '',
    cover: sub.cover || null,
    initial: initialOf(sub.title),
    newCount,
    badgeText: badgeOf(newCount),
    badgeLabel,
    error: Boolean(error),
    errorText: error ? 'Feed nicht erreichbar' : '',
    active,
    playing,
    ariaLabel: `${parts.join(', ')} – Episoden anzeigen`,
  };
}

/** „Alle neuen Episoden“: alle neuen Episoden aller Abos (Definition isNewEpisode), sortiert; höchstens `limit` Zeilen. Liefert { items, total }. */
function newEpisodeItems({ subscriptions, episodes, player, now, sort = 'newest', limit = Infinity }) {
  const all = [];
  for (const sub of subscriptions) {
    for (const episode of feedOf(sub, episodes).episodes) {
      if (isNewEpisode(episode, now)) all.push(episodeItem({ podcastId: sub.id, show: sub.title, episode, fallbackCover: sub.cover, player, now }));
    }
  }
  return { items: sortEpisodeItems(all, sort).slice(0, limit), total: all.length };
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
  if (value === 'unheard') return 'new'; // frühere Bezeichnung
  return FILTERS.includes(value) ? value : 'all';
}

function normalizeLimit(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > PAGE_SIZE ? Math.min(number, MAX_LIMIT) : PAGE_SIZE;
}

/**
 * Auswahlzustand des Dashboards (Sitzung): { selection (ALL_ID | Abo-ID), filter ('all'|'new'), sort, limit (Zeilen, Vielfaches von 50) }.
 * Eine Auswahl, die es nicht mehr gibt (abbestellt), fällt auf „Alle neuen Episoden“ zurück.
 */
function normalizeSelection(view, subscriptions) {
  const raw = view && typeof view === 'object' ? view : {};
  const known = (subscriptions || []).some(sub => sub.id === raw.selection);
  return { selection: known ? raw.selection : ALL_ID, filter: normalizeFilter(raw.filter), sort: normalizeSort(raw.sort), limit: normalizeLimit(raw.limit) };
}

/** „Alle neuen Episoden“ als erster Eintrag der Abo-Liste: { id: ALL_ID, title, author (Untertitel), newCount, badgeText, badgeLabel, selected, ariaLabel }. */
function allEntry({ newCount, selected }) {
  return {
    id: ALL_ID,
    title: 'Alle neuen Episoden',
    author: newCount ? newLabel(newCount) : 'Alles gehört',
    newCount,
    badgeText: badgeOf(newCount),
    badgeLabel: newCount ? `${newLabel(newCount)} (${NEW_HELP})` : '',
    selected,
    ariaLabel: `Alle neuen Episoden, ${newLabel(newCount)}`,
  };
}

/**
 * Rechte Spalte des Dashboards. Auswahl „alle“: alle neuen Episoden (Zähler = Zahl der Zeilen, in Schritten von 50 nachladbar).
 * Auswahl eines Abos: alle zwischengespeicherten Episoden (Filter „alle“) oder nur die neuen, sortiert; Kopfzeile „2 neue · 35 Episoden“.
 * Ausgabe: { selection, filter, sort, limit, isAll, showId, heading, items, total (Zeilen der Liste ohne Kappung bei „alle“: neue; Abo: Episoden),
 *            rows (Zeilen nach Filter), newCount, hasMore, moreLabel, emptyText, canOpenShow, filterVisible, hint }
 */
function episodeColumnModel({ subscriptions = [], episodes = {}, player = null, now = Date.now(), view = null } = {}) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const { selection, filter, sort, limit } = normalizeSelection(view, subs);
  const more = rows => ({ hasMore: rows > limit, moreLabel: `Mehr laden (${Math.max(0, rows - limit)} weitere)` });
  if (selection === ALL_ID) {
    const { items, total } = newEpisodeItems({ subscriptions: subs, episodes, player, now, sort, limit });
    return { selection, filter, sort, limit, isAll: true, showId: null, heading: 'Alle neuen Episoden', items, total, rows: total, newCount: total, ...more(total), emptyText: 'Keine neuen Episoden. Alles gehört.', canOpenShow: false, filterVisible: false, hint: total ? newLabel(total) : '' };
  }
  const sub = subs.find(entry => entry.id === selection);
  const list = feedOf(sub, episodes).episodes;
  const newCount = list.filter(episode => isNewEpisode(episode, now)).length;
  const picked = filter === 'new' ? list.filter(episode => isNewEpisode(episode, now)) : list;
  const sorted = sortEpisodeItems(
    picked.map(episode => episodeItem({ podcastId: sub.id, show: sub.title, episode, fallbackCover: sub.cover, player, now })),
    sort,
  );
  const items = sorted.slice(0, limit);
  let emptyText = '';
  if (!items.length) emptyText = list.length ? 'Keine neuen Episoden in diesem Abo. „Alle Episoden“ zeigt die übrigen.' : 'Noch keine Episoden geladen. Mit „Jetzt aktualisieren“ prüfst du den Feed.';
  return {
    selection,
    filter,
    sort,
    limit,
    isAll: false,
    showId: sub.id,
    heading: sub.title || sub.feedUrl,
    items,
    total: list.length,
    rows: sorted.length,
    newCount,
    ...more(sorted.length),
    emptyText,
    canOpenShow: true,
    filterVisible: true,
    hint: `${newCount} neue · ${plural(list.length, 'Episode', 'Episoden')}`,
  };
}

/**
 * Modell des Podcast-Dashboards.
 * Ausgabe: { loaded, empty, statusText, newCount, newEpisodes (= column.items), column (episodeColumnModel), allEntry, shows (mit selected), popular, emptyMessage, loadError }
 */
function podcastDashboardModel({ subscriptions = [], episodes = {}, player = null, catalog = [], loaded = true, loadError = '', now = Date.now(), view = null } = {}) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const column = episodeColumnModel({ subscriptions: subs, episodes, player, now, view });
  const total = subs.reduce((sum, sub) => sum + newCountOf(sub, episodes, now), 0);
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

module.exports = { ALL_ID, FILTERS, PAGE_SIZE, NEW_HELP, normalizeSelection, normalizeFilter, allEntry, episodeColumnModel, POPULAR_COUNT, MSG_EMPTY, statusLine, showTile, newEpisodeItems, popularCatalog, podcastDashboardModel };
