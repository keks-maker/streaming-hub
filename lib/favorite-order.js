'use strict';

// Globale Favoriten-Reihenfolge über mehrere Quellen (gemeinsam für LiveTV und Radio).
// Aus settings-channel-logic.js herausgelöst, Verhalten unverändert. Datenformat je Quelle:
// source.id, source.favorites (Mitgliedschaft + Reihenfolge je Quelle), source.favoriteRank = { [id]: Zahl }.
// Keine DOM-/Electron-Abhängigkeit.

function channelKey(sourceId, channelId) {
  return `${sourceId}\u0000${channelId}`;
}

/**
 * Globale Favoriten-Reihenfolge über alle Quellen: Liste von { sourceId, id } (inkl. Favoriten,
 * die in der Playlist nicht mehr existieren). Sortierung: Einträge mit source.favoriteRank nach
 * Rang; Einträge ohne Rang (Altbestand/Migration, neu per Altpfad) danach in Quellenreihenfolge
 * + Index in source.favorites. Ohne jeden Rang ist das exakt die bisher angezeigte Reihenfolge.
 */
function globalFavoriteList(sources) {
  const entries = [];
  const seen = new Set();
  (Array.isArray(sources) ? sources : []).forEach((source, si) => {
    const ranks = source && source.favoriteRank && typeof source.favoriteRank === 'object' ? source.favoriteRank : {};
    (Array.isArray(source && source.favorites) ? source.favorites : []).forEach((id, fi) => {
      const key = channelKey(source.id, id);
      if (seen.has(key)) return;
      seen.add(key);
      const rank = Number.isFinite(ranks[id]) ? ranks[id] : null;
      entries.push({ sourceId: source.id, id, rank, si, fi });
    });
  });
  entries.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    if (a.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    return a.si - b.si || a.fi - b.fi;
  });
  return entries.map(({ sourceId, id }) => ({ sourceId, id }));
}

/**
 * Schreibt eine globale Reihenfolge in die Quellen (neue Objekte, Eingabe bleibt unverändert):
 * list ist maßgeblich für Mitgliedschaft und Reihenfolge. Je Quelle wird favorites in der
 * Reihenfolge der Liste gesetzt (Abwärtskompatibilität) und favoriteRank = globaler Index.
 * Einträge unbekannter Quellen und Duplikate werden verworfen; Quellen ohne Einträge verlieren
 * favorites/favoriteRank.
 */
function applyFavoriteOrder(sources, list) {
  const ids = new Set(sources.map(s => s.id));
  const seen = new Set();
  const clean = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.id !== 'string' || !ids.has(e.sourceId)) continue;
    const key = channelKey(e.sourceId, e.id);
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ sourceId: e.sourceId, id: e.id });
  }
  return sources.map(source => {
    const favorites = [];
    const favoriteRank = {};
    clean.forEach((e, i) => {
      if (e.sourceId !== source.id) return;
      favorites.push(e.id);
      favoriteRank[e.id] = i;
    });
    return { ...source, favorites, favoriteRank };
  });
}

function sameEntry(a, b) {
  return Boolean(a && b) && a.sourceId === b.sourceId && a.id === b.id;
}

/** Favorit setzen/entfernen in der globalen Liste (neue Favoriten ans Ende). */
function toggleGlobalFavorite(list, entry) {
  const base = Array.isArray(list) ? list : [];
  return base.some(e => sameEntry(e, entry))
    ? base.filter(e => !sameEntry(e, entry))
    : [...base, { sourceId: entry.sourceId, id: entry.id }];
}

/**
 * Tauscht entry mit dem nächsten SICHTBAREN Nachbarn in Richtung delta (-1 hoch, +1 runter),
 * quellenübergreifend. isVisible(e): Sender existiert in der Playlist; "Geister" behalten ihren Platz.
 */
function moveGlobalFavorite(list, entry, delta, isVisible = () => true) {
  const out = Array.isArray(list) ? [...list] : [];
  const from = out.findIndex(e => sameEntry(e, entry));
  if (from === -1 || (delta !== -1 && delta !== 1)) return out;
  let to = from + delta;
  while (to >= 0 && to < out.length && !isVisible(out[to])) to += delta;
  if (to < 0 || to >= out.length) return out;
  [out[from], out[to]] = [out[to], out[from]];
  return out;
}

// Position von entry unter den sichtbaren Favoriten (-1 = nicht enthalten) und deren Anzahl.
function globalFavoritePosition(list, entry, isVisible = () => true) {
  const visible = (Array.isArray(list) ? list : []).filter(isVisible);
  return { index: visible.findIndex(e => sameEntry(e, entry)), count: visible.length };
}

// Drag&Drop quellenübergreifend: dragged landet an der Position von target.
function moveGlobalFavoriteTo(list, dragged, target) {
  const out = Array.isArray(list) ? [...list] : [];
  const from = out.findIndex(e => sameEntry(e, dragged));
  const to = out.findIndex(e => sameEntry(e, target));
  if (from === -1 || to === -1 || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

module.exports = {
  channelKey,
  globalFavoriteList,
  applyFavoriteOrder,
  sameEntry,
  toggleGlobalFavorite,
  moveGlobalFavorite,
  globalFavoritePosition,
  moveGlobalFavoriteTo,
};
