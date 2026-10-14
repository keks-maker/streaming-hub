'use strict';

// Einstellungen → Radio → Sender (R3): reines Modell der Senderverwaltung (kein DOM, kein IPC).
// Suche/Filter/Zähler, Favoriten-Reihenfolge (globale Reihenfolge wie bei LiveTV, lib/favorite-order.js) und
// Anpassungen gelieferter Sender (stationOverrides: Name, Logo-URL, Stream-URL).

const { listStations, findStation, favoriteKeys, CUSTOM_SOURCE_ID } = require('./lib/radio/radio-sources-logic.js');
const { globalFavoriteList, moveGlobalFavorite, moveGlobalFavoriteTo, globalFavoritePosition, sameEntry } = require('./lib/favorite-order.js');
const { radioStreamUrlError, radioLogoUrlError } = require('./lib/input-validation.js');

const NAME_MAX = 200;

/** Suchtext vergleichbar machen: Groß-/Kleinschreibung, Umlaute und Akzente egal (ö = o, ß = ss; „Köln“ findet „koln“). */
function fold(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stationMatches(station, foldedQuery, originalName) {
  if (!foldedQuery) return true;
  return [station.name, originalName, station.genre, station.region].some(field => fold(field).includes(foldedQuery));
}

// Original-Namen angepasster Sender: die Suche findet einen Sender auch nach seinem gelieferten Namen
function originalNames(sources) {
  const map = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const overrides = source && source.stationOverrides;
    if (!overrides) continue;
    for (const station of source.stations || []) {
      if (station && overrides[station.id] && overrides[station.id].name) map.set(`${source.id}\u0000${station.id}`, station.name);
    }
  }
  return map;
}

/**
 * Sender für die Liste. view 'all': Quellenreihenfolge der Bibliothek; 'favorites': globale Favoriten-Reihenfolge.
 * Filter: sourceId, genre, region ('' = alle), query (Name auch im Original, Genre, Region).
 */
function filterStations(sources, { view = 'all', query = '', sourceId = '', genre = '', region = '' } = {}) {
  const q = fold(query);
  const originals = q ? originalNames(sources) : new Map();
  let list = listStations(sources);
  if (view === 'favorites') list = list.filter(s => s.favorite).sort((a, b) => a.favoriteRank - b.favoriteRank);
  return list.filter(
    s =>
      (!sourceId || s.sourceId === sourceId) &&
      (!genre || s.genre === genre) &&
      (!region || s.region === region) &&
      stationMatches(s, q, originals.get(`${s.sourceId}\u0000${s.id}`)),
  );
}

/** Anzahl der Sender in der aktuellen Ansicht ohne Such-/Filtereinschränkung (Nenner des Zählers). */
function totalInView(sources, view) {
  return filterStations(sources, { view }).length;
}

/** „n von m Sendern“ bzw. „m Sender“ ohne Einschränkung. */
function countText(shown, total) {
  if (shown === total) return `${total} Sender`;
  return `${shown} von ${total} Sendern`;
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
}

/** Auswahlwerte der Filter (aus allen Sendern, damit sie nicht je nach Ansicht springen). */
function facets(sources) {
  const all = listStations(sources);
  return {
    genres: sortedUnique(all.map(s => s.genre)),
    regions: sortedUnique(all.map(s => s.region)),
    sources: (Array.isArray(sources) ? sources : []).filter(s => all.some(st => st.sourceId === s.id)).map(s => ({ id: s.id, name: s.name })),
  };
}

// ── Favoriten-Reihenfolge ──

const entryOf = station => ({ sourceId: station.sourceId, id: station.id });

/** Ghost-Favoriten ("nicht mehr in der Liste") behalten ihren Platz beim Verschieben. */
function isMovable(sources) {
  const present = new Set(listStations(sources).filter(s => !s.removed).map(s => `${s.sourceId}\u0000${s.id}`));
  return e => present.has(`${e.sourceId}\u0000${e.id}`);
}

/** Umsortieren ist nur in der Favoritenansicht ohne Suche und Filter möglich (sonst wäre die Position mehrdeutig). */
function canReorder({ view, query, sourceId, genre, region }) {
  return view === 'favorites' && !fold(query) && !sourceId && !genre && !region;
}

function toggleFavoriteList(sources, station) {
  const list = globalFavoriteList(sources);
  return list.some(e => sameEntry(e, entryOf(station))) ? list.filter(e => !sameEntry(e, entryOf(station))) : [...list, entryOf(station)];
}

function moveFavorite(sources, station, delta) {
  return moveGlobalFavorite(globalFavoriteList(sources), entryOf(station), delta, isMovable(sources));
}

function dropFavorite(sources, dragged, target) {
  return moveGlobalFavoriteTo(globalFavoriteList(sources), dragged, target);
}

function favoritePosition(sources, station) {
  return globalFavoritePosition(globalFavoriteList(sources), entryOf(station), isMovable(sources));
}

/** Favoriten, deren Sender in der gelieferten Liste nicht mehr vorkommen. */
function removedFavorites(sources) {
  return favoriteKeys(sources).filter(k => findStation(sources, { sourceId: k.sourceId, stationId: k.id }).removed);
}

// ── Anpassungen (stationOverrides) ──

function rawStation(sources, key) {
  const source = (Array.isArray(sources) ? sources : []).find(s => s && s.id === key.sourceId);
  const station = source && (source.stations || []).find(s => s && s.id === key.stationId);
  return station ? { source, station } : null;
}

/** Entwurf für den Bearbeiten-Bereich: Originalwerte, aktuelle Anpassung und Eingabefelder. */
function overrideDraft(sources, key) {
  const raw = rawStation(sources, key);
  if (!raw) return null;
  const ov = raw.source.stationOverrides && raw.source.stationOverrides[key.stationId] ? raw.source.stationOverrides[key.stationId] : {};
  const original = { name: raw.station.name || raw.station.id, logo: raw.station.logo || '', streamUrl: raw.station.streamUrl || '' };
  const text = field => (typeof ov[field] === 'string' ? ov[field] : '');
  return {
    original,
    hasOverride: ['name', 'logo', 'streamUrl'].some(f => text(f)),
    draft: { name: text('name') || original.name, logo: text('logo') || original.logo, streamUrl: text('streamUrl') || original.streamUrl },
  };
}

/** Fehlermeldungen je Feld (leer = in Ordnung). Leere Felder bedeuten „Original verwenden“, nur Name darf nicht ungültig lang sein. */
function validateOverrideDraft(draft) {
  const errors = {};
  const name = String(draft.name || '').trim();
  if (name.length > NAME_MAX) errors.name = `Name ist zu lang (max. ${NAME_MAX} Zeichen)`;
  const logo = String(draft.logo || '').trim();
  if (logo) {
    const message = radioLogoUrlError(logo);
    if (message) errors.logo = message;
  }
  const streamUrl = String(draft.streamUrl || '').trim();
  if (streamUrl) {
    const message = radioStreamUrlError(streamUrl);
    if (message) errors.streamUrl = message;
  }
  return errors;
}

/** Patch für radio:set-override: Felder, die dem Original entsprechen oder leer sind, werden zurückgesetzt (null). */
function buildOverridePatch(draft, original) {
  const pick = field => {
    const value = String(draft[field] || '').trim();
    return value && value !== original[field] ? value : null;
  };
  return { name: pick('name'), logo: pick('logo'), streamUrl: pick('streamUrl') };
}

module.exports = {
  CUSTOM_SOURCE_ID,
  fold,
  filterStations,
  totalInView,
  countText,
  facets,
  canReorder,
  toggleFavoriteList,
  moveFavorite,
  dropFavorite,
  favoritePosition,
  removedFavorites,
  overrideDraft,
  validateOverrideDraft,
  buildOverridePatch,
};
