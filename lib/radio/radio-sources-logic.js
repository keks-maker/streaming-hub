'use strict';

// Reine Logik für radiosources.json (Konzept §3): Quellen mit Sendern, Favoriten (favorites + favoriteRank),
// stationOverrides {name, logo, streamUrl} und die immer vorhandene Quelle "Eigene Sender" (type "user").
// Alle Funktionen liefern neue Objekte, die Eingabe bleibt unverändert. Keine Electron-/Dateizugriffe.

const { globalFavoriteList, applyFavoriteOrder, toggleGlobalFavorite } = require('../favorite-order.js');

const CUSTOM_SOURCE_ID = 'eigene-radiosender';
const CUSTOM_SOURCE_NAME = 'Eigene Sender';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stationsOf(source) {
  return Array.isArray(source && source.stations) ? source.stations.filter(s => isPlainObject(s) && typeof s.id === 'string') : [];
}

function ensureCustomSource(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (list.some(source => source && source.id === CUSTOM_SOURCE_ID)) return list;
  return [...list, { id: CUSTOM_SOURCE_ID, name: CUSTOM_SOURCE_NAME, type: 'user', stations: [], sortOrder: [] }];
}

/** Sender mit angewendeten stationOverrides, mit Anzeige-/Wiedergabefeldern und Herkunft. */
function effectiveStation(source, station) {
  const overrides = isPlainObject(source.stationOverrides) && isPlainObject(source.stationOverrides[station.id]) ? source.stationOverrides[station.id] : {};
  const pick = key => (typeof overrides[key] === 'string' && overrides[key] ? overrides[key] : station[key]);
  return {
    sourceId: source.id,
    id: station.id,
    name: pick('name') || station.id,
    streamUrl: pick('streamUrl') || '',
    logo: pick('logo') || null,
    genre: station.genre || null,
    region: station.region || null,
    country: station.country || null,
    codec: station.codec || null,
    bitrate: station.bitrate || null,
    homepage: station.homepage || null,
    custom: source.type === 'user',
    removed: station.removed === true,
  };
}

function findStation(sources, key) {
  if (!key) return null;
  const source = (Array.isArray(sources) ? sources : []).find(s => s && s.id === key.sourceId);
  if (!source) return null;
  const station = stationsOf(source).find(s => s.id === key.stationId);
  return station ? effectiveStation(source, station) : null;
}

/** Alle Sender (Quellenreihenfolge, je Quelle laut sortOrder, Rest in Dateireihenfolge) mit Favoritenstatus. */
function listStations(sources) {
  const favorites = globalFavoriteList(sources);
  const rank = new Map(favorites.map((entry, index) => [`${entry.sourceId}\u0000${entry.id}`, index]));
  const out = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source) continue;
    const stations = stationsOf(source);
    const order = Array.isArray(source.sortOrder) ? source.sortOrder : [];
    const position = id => {
      const index = order.indexOf(id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    stations
      .map((station, index) => ({ station, index }))
      .sort((a, b) => position(a.station.id) - position(b.station.id) || a.index - b.index)
      .forEach(({ station }) => {
        const key = `${source.id}\u0000${station.id}`;
        out.push({ ...effectiveStation(source, station), favorite: rank.has(key), favoriteRank: rank.has(key) ? rank.get(key) : null });
      });
  }
  return out;
}

/** Favoriten in globaler Reihenfolge ({ sourceId, id }), nur Sender, die noch existieren (auch "entfernte"). */
function favoriteKeys(sources) {
  return globalFavoriteList(sources).filter(entry => findStation(sources, { sourceId: entry.sourceId, stationId: entry.id }));
}

function favoriteStations(sources) {
  return favoriteKeys(sources).map(entry => findStation(sources, { sourceId: entry.sourceId, stationId: entry.id }));
}

function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'sender'
  );
}

// Zufallssuffix über Web Crypto (Node und Browser), damit das Modul auch im Renderer-Bundle nutzbar bleibt
function defaultIdFactory(name) {
  const suffix = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), byte => byte.toString(16).padStart(2, '0')).join('');
  return `custom-${slug(name)}-${suffix}`;
}

function mapCustom(sources, fn) {
  return ensureCustomSource(sources).map(source => (source && source.id === CUSTOM_SOURCE_ID ? fn(source) : source));
}

/** Neuer eigener Sender (Eingabe bereits validiert). Liefert { sources, station }. */
function addCustomStation(sources, input, { idFactory = defaultIdFactory } = {}) {
  let station = null;
  const next = mapCustom(sources, source => {
    const existing = new Set(stationsOf(source).map(s => s.id));
    let id = idFactory(input.name);
    while (existing.has(id)) id = idFactory(input.name);
    station = { id, name: input.name, streamUrl: input.streamUrl };
    if (input.logo) station.logo = input.logo;
    if (input.genre) station.genre = input.genre;
    return { ...source, stations: [...stationsOf(source), station], sortOrder: [...(Array.isArray(source.sortOrder) ? source.sortOrder : []), id] };
  });
  return { sources: next, station };
}

/** Ändert einen eigenen Sender; null in logo/genre entfernt das Feld. Wirft bei unbekannter ID. */
function updateCustomStation(sources, stationId, patch) {
  let found = false;
  const next = mapCustom(sources, source => ({
    ...source,
    stations: stationsOf(source).map(station => {
      if (station.id !== stationId) return station;
      found = true;
      const updated = { ...station };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete updated[key];
        else updated[key] = value;
      }
      return updated;
    }),
  }));
  if (!found) throw new Error('Eigener Sender nicht gefunden');
  return next;
}

/** Löscht einen eigenen Sender samt Favoriten-/Sortier-Einträgen. */
function removeCustomStation(sources, stationId) {
  let found = false;
  const withoutStation = mapCustom(sources, source => {
    found = stationsOf(source).some(station => station.id === stationId);
    const favorites = (Array.isArray(source.favorites) ? source.favorites : []).filter(id => id !== stationId);
    const favoriteRank = isPlainObject(source.favoriteRank) ? { ...source.favoriteRank } : {};
    delete favoriteRank[stationId];
    const overrides = isPlainObject(source.stationOverrides) ? { ...source.stationOverrides } : {};
    delete overrides[stationId];
    return {
      ...source,
      stations: stationsOf(source).filter(station => station.id !== stationId),
      sortOrder: (Array.isArray(source.sortOrder) ? source.sortOrder : []).filter(id => id !== stationId),
      favorites,
      favoriteRank,
      stationOverrides: overrides,
    };
  });
  if (!found) throw new Error('Eigener Sender nicht gefunden');
  return applyFavoriteOrder(withoutStation, globalFavoriteList(withoutStation));
}

/**
 * Überschreibung (stationOverrides) eines gelieferten Senders setzen; null/leer in name, logo, streamUrl entfernt das Feld,
 * ein leeres Ergebnis entfernt den Eintrag. Eigene Sender werden über updateCustomStation geändert.
 */
function setStationOverride(sources, sourceId, stationId, patch) {
  const source = (Array.isArray(sources) ? sources : []).find(s => s && s.id === sourceId);
  if (!source || !stationsOf(source).some(station => station.id === stationId)) throw new Error('Sender nicht gefunden');
  if (source.type === 'user') throw new Error('Eigene Sender werden direkt bearbeitet');
  const overrides = isPlainObject(source.stationOverrides) ? { ...source.stationOverrides } : {};
  const next = isPlainObject(overrides[stationId]) ? { ...overrides[stationId] } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length) overrides[stationId] = next;
  else delete overrides[stationId];
  return sources.map(entry => (entry === source ? { ...source, stationOverrides: overrides } : entry));
}

/** Entfernt alle Anpassungen eines Senders (zurück auf die gelieferten Werte). */
function clearStationOverride(sources, sourceId, stationId) {
  const source = (Array.isArray(sources) ? sources : []).find(s => s && s.id === sourceId);
  if (!source || !stationsOf(source).some(station => station.id === stationId)) throw new Error('Sender nicht gefunden');
  if (!isPlainObject(source.stationOverrides) || !(stationId in source.stationOverrides)) return sources;
  const overrides = { ...source.stationOverrides };
  delete overrides[stationId];
  return sources.map(entry => (entry === source ? { ...source, stationOverrides: overrides } : entry));
}

/** Favorit setzen/entfernen (neue Favoriten ans Ende der globalen Reihenfolge). */
function setStationFavorite(sources, sourceId, stationId, favorite) {
  const list = globalFavoriteList(sources);
  const isFavorite = list.some(entry => entry.sourceId === sourceId && entry.id === stationId);
  if (favorite === isFavorite) return sources;
  if (favorite && !findStation(sources, { sourceId, stationId })) throw new Error('Sender nicht gefunden');
  return applyFavoriteOrder(sources, toggleGlobalFavorite(list, { sourceId, id: stationId }));
}

/** Globale Favoriten-Reihenfolge schreiben (list: [{ sourceId, id }], bereits validiert). */
function setFavoriteOrder(sources, list) {
  return applyFavoriteOrder(sources, list);
}

module.exports = {
  CUSTOM_SOURCE_ID,
  CUSTOM_SOURCE_NAME,
  ensureCustomSource,
  effectiveStation,
  findStation,
  listStations,
  favoriteKeys,
  favoriteStations,
  addCustomStation,
  updateCustomStation,
  removeCustomStation,
  setStationFavorite,
  setFavoriteOrder,
  setStationOverride,
  clearStationOverride,
};
