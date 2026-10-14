// 3-way-Merge für radiosources.json beim Update (Radio, Konzept §3.3), analog tvsources-merge.js.
//
//   base = zuletzt eingearbeiteter Bundle-Stand (radiosources-base.json in userData), sonst null
//   old  = Nutzerkopie (Favoriten, Reihenfolge, stationOverrides, eigene Sender)
//   neu  = mitgelieferte radiosources.json der neuen Version
//
// Regeln:
//   - Mitgelieferte Quellen (type "bundled"): Sender ersetzt die neue Liste. favorites/favoriteRank und
//     sortOrder bleiben erhalten, wenn der Nutzer sie geändert hat (old != base), sonst gilt neu.
//   - stationOverrides pro Sender: User-Eintrag (neu angelegt/geändert) gewinnt, sonst der Stand aus neu.
//   - Favorit, dessen Sender aus der neuen Liste verschwunden ist: bleibt mit removed:true erhalten
//     ("nicht mehr in der Liste") statt still zu verschwinden. Nicht-Favoriten verschwinden.
//   - Eigene Quellen (type "user", immer "eigene-radiosender") und nur auf dem Gerät vorhandene Quellen
//     mit Nutzerdaten bleiben vollständig erhalten. NIE Datenverlust: bei Strukturfehler keepOld.
//
// Reine Funktionen, ohne Electron-/Dateizugriffe.

const { deepEqual } = require('./tvsources-merge.js');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stationsOf(source) {
  return Array.isArray(source && source.stations) ? source.stations.filter(s => isPlainObject(s) && typeof s.id === 'string') : [];
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function mergeOverrides(baseOv, oldOv, neuOv, keep) {
  const merged = {};
  for (const id of new Set([...Object.keys(neuOv), ...Object.keys(oldOv)])) {
    const userAuthored = has(oldOv, id) && (!has(baseOv, id) || !deepEqual(oldOv[id], baseOv[id]));
    let entry;
    if (userAuthored) entry = oldOv[id];
    else if (has(neuOv, id)) entry = neuOv[id];
    if (entry !== undefined && keep(id)) merged[id] = entry;
  }
  return merged;
}

function mergeBundledSource(base, old, neu, conflicts) {
  const out = { ...neu };
  const id = neu.id;

  const favoritesTouched = !deepEqual(old.favorites, base ? base.favorites : undefined) || !deepEqual(old.favoriteRank, base ? base.favoriteRank : undefined);
  if (favoritesTouched) {
    if (old.favorites !== undefined) out.favorites = old.favorites;
    else delete out.favorites;
    if (old.favoriteRank !== undefined) out.favoriteRank = old.favoriteRank;
    else delete out.favoriteRank;
  }
  if (!deepEqual(old.sortOrder, base ? base.sortOrder : undefined) && old.sortOrder !== undefined) out.sortOrder = old.sortOrder;

  // Favoriten, deren Sender nicht mehr in der Liste steht, bleiben als "removed" erhalten.
  const neuIds = new Set(stationsOf(neu).map(s => s.id));
  const oldById = new Map(stationsOf(old).map(s => [s.id, s]));
  const stations = [...stationsOf(neu)];
  const favorites = Array.isArray(out.favorites) ? out.favorites : [];
  const keepIds = new Set(favorites);
  for (const favoriteId of favorites) {
    if (neuIds.has(favoriteId)) continue;
    const previous = oldById.get(favoriteId);
    if (previous) stations.push({ ...previous, removed: true });
    else conflicts.push(`${id}: Favorit "${favoriteId}" nicht mehr in der Liste und ohne Sender-Daten – nicht markierbar`);
  }
  out.stations = stations;

  const baseOv = base && isPlainObject(base.stationOverrides) ? base.stationOverrides : {};
  const oldOv = isPlainObject(old.stationOverrides) ? old.stationOverrides : {};
  const neuOv = isPlainObject(neu.stationOverrides) ? neu.stationOverrides : {};
  const stationIds = new Set(stations.map(s => s.id));
  const overrides = mergeOverrides(baseOv, oldOv, neuOv, key => stationIds.has(key) || keepIds.has(key));
  if (Object.keys(overrides).length) out.stationOverrides = overrides;
  else delete out.stationOverrides;
  return out;
}

/** Gerätequelle ohne Gegenstück in neu: eigene Quellen bleiben, mitgelieferte nur mit Favoriten (als removed). */
function keepDeviceOnlySource(old) {
  if (old.type === 'user') return old;
  const favorites = Array.isArray(old.favorites) ? old.favorites : [];
  const kept = stationsOf(old).filter(s => favorites.includes(s.id));
  if (!kept.length) return null;
  const keptIds = new Set(kept.map(s => s.id));
  const out = { ...old, stations: kept.map(s => ({ ...s, removed: true })) };
  if (Array.isArray(old.sortOrder)) out.sortOrder = old.sortOrder.filter(id => keptIds.has(id));
  if (isPlainObject(old.stationOverrides)) {
    out.stationOverrides = Object.fromEntries(Object.entries(old.stationOverrides).filter(([key]) => keptIds.has(key)));
  }
  return out;
}

function mergeSource(base, old, neu, conflicts) {
  if (!old) return neu;
  if (!neu) return keepDeviceOnlySource(old);
  if (old.type === 'user' || neu.type === 'user') return old;
  return mergeBundledSource(base, old, neu, conflicts);
}

/**
 * Rückgabe wie mergeTvsources: { ok, value, keepOld, reason, conflicts }.
 * base/old/neu: geparstes JSON oder null.
 */
function mergeRadiosources(base, old, neu, options) {
  const warn = options && typeof options.warn === 'function' ? options.warn : function () {};
  if (old === null || old === undefined) {
    return { ok: true, value: neu, keepOld: false, reason: 'keine Geräte-Kopie vorhanden – mitgelieferter Stand übernommen' };
  }
  if (neu === null || neu === undefined) {
    return { ok: false, keepOld: true, reason: 'neue Version enthält keine radiosources.json – Geräte-Stand beibehalten' };
  }
  if (!Array.isArray(old) || !Array.isArray(neu)) {
    return { ok: false, keepOld: true, reason: 'radiosources.json hat kein Array-Format – Merge übersprungen, Geräte-Stand beibehalten' };
  }
  const baseById = new Map((Array.isArray(base) ? base : []).filter(s => s && s.id !== undefined).map(s => [s.id, s]));
  const neuById = new Map(neu.filter(s => s && s.id !== undefined).map(s => [s.id, s]));
  const conflicts = [];
  const merged = [];
  const handled = new Set();
  for (const source of old) {
    if (!source || source.id === undefined) {
      merged.push(source);
      continue;
    }
    handled.add(source.id);
    const result = mergeSource(baseById.get(source.id), source, neuById.get(source.id), conflicts);
    if (result) merged.push(result);
  }
  for (const source of neu) {
    if (source && source.id !== undefined && !handled.has(source.id)) merged.push(source);
  }
  for (const message of conflicts) warn(message);
  return { ok: true, value: merged, keepOld: false, conflicts };
}

module.exports = { mergeRadiosources };
