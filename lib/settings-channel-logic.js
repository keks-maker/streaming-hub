'use strict';

// Reine Logik der Einstellungsseite "LiveTV → Sender" (Issue #4, Etappe 3).
// Keine DOM-/Electron-Abhängigkeit, daher ohne Electron unit-testbar.
// Datenformat (tvsources.json): source.favorites (Mitgliedschaft + Reihenfolge je Quelle) und
// source.favoriteRank = { [chId]: Zahl } (globale Favoriten-Reihenfolge quellenübergreifend, siehe
// globalFavoriteList; fehlt der Rang, gilt Quellenreihenfolge + Index in favorites),
// source.sortOrder, source.channelOverrides[chId] = { name?, tvgId?, tvgLogo?, url? }.

const { channelLogoError, channelStreamUrlError } = require('./input-validation.js');

const OVERRIDE_KEYS = ['name', 'tvgId', 'tvgLogo', 'url'];

function normEpgId(id) {
  return String(id || '')
    .replace(/@[^.@]*/g, '')
    .toLowerCase()
    .trim();
}

// Beschriftung eines Senders für Screenreader/Tooltips: Name, sonst tvg-id, sonst ID.
function channelLabel(ch) {
  const candidates = ch ? [ch.name, ch.tvgId, ch.id] : [];
  const first = candidates.map(v => String(v ?? '').trim()).find(Boolean);
  return first || 'Sender';
}

function channelKey(sourceId, channelId) {
  return `${sourceId}\u0000${channelId}`;
}

function isFav(channel, sourcesById) {
  const source = sourcesById.get(channel.sourceId);
  return Boolean(source && Array.isArray(source.favorites) && source.favorites.includes(channel.id));
}

/**
 * Sichtbare Sender für die Verwaltung.
 * view 'all': Reihenfolge der Senderliste (sortOrder bereits angewandt).
 * view 'favorites': nur Favoriten, je Quelle in Favoriten-Reihenfolge (Quellen in Quellenreihenfolge).
 */
function filterManagedChannels(channels, sources, { sourceIds, query = '', view = 'all' } = {}) {
  const allowed = sourceIds ? new Set(sourceIds) : null;
  const q = String(query || '')
    .toLowerCase()
    .trim();
  let list = channels.filter(ch => !allowed || allowed.has(ch.sourceId));
  if (q) {
    list = list.filter(
      ch =>
        String(ch.name || '').toLowerCase().includes(q) ||
        String(ch.tvgId || '').toLowerCase().includes(q) ||
        String(ch.group || '').toLowerCase().includes(q),
    );
  }
  if (view === 'favorites') {
    const byKey = new Map(list.map(ch => [channelKey(ch.sourceId, ch.id), ch]));
    return globalFavoriteList(sources)
      .map(e => byKey.get(channelKey(e.sourceId, e.id)))
      .filter(Boolean);
  }
  return list;
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

/** Favoriten-Reihenfolge für Dashboard/Anzeige/Zapping: Sender in globaler Reihenfolge. */
function orderFavoriteChannels(channels, sources) {
  const rank = new Map();
  globalFavoriteList(sources).forEach((e, i) => rank.set(channelKey(e.sourceId, e.id), i));
  return channels
    .filter(ch => rank.has(channelKey(ch.sourceId, ch.id)))
    .map((ch, i) => ({ ch, i, r: rank.get(channelKey(ch.sourceId, ch.id)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.ch);
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

/**
 * Setzt die favorites einer Quelle (Altpfad update-tv-source) und hält die globale Reihenfolge
 * konsistent: Die neuen Einträge belegen der Reihe nach die bisherigen Plätze dieser Quelle in
 * der globalen Liste (Überhang direkt hinter dem letzten Platz, Rest entfällt); Ränge anderer
 * Quellen bleiben relativ erhalten. Gibt neue Quellen zurück (Eingabe bleibt unverändert).
 */
function setSourceFavorites(sources, sourceId, favorites) {
  const next = [...new Set((Array.isArray(favorites) ? favorites : []).filter(f => typeof f === 'string'))];
  const list = globalFavoriteList(sources);
  const slots = [];
  list.forEach((e, i) => {
    if (e.sourceId === sourceId) slots.push(i);
  });
  const out = [];
  let k = 0;
  list.forEach((e, i) => {
    if (e.sourceId !== sourceId) {
      out.push(e);
      return;
    }
    const isLast = i === slots[slots.length - 1];
    if (k < next.length) out.push({ sourceId, id: next[k++] });
    if (isLast) while (k < next.length) out.push({ sourceId, id: next[k++] });
  });
  if (!slots.length) next.forEach(id => out.push({ sourceId, id }));
  return applyFavoriteOrder(sources, out);
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

function toggleFavoriteList(favorites, channelId) {
  const list = Array.isArray(favorites) ? [...favorites] : [];
  const idx = list.indexOf(channelId);
  if (idx === -1) list.push(channelId);
  else list.splice(idx, 1);
  return list;
}

// Verschiebt channelId um delta Positionen (-1 hoch, +1 runter), begrenzt an den Rändern.
function moveFavorite(favorites, channelId, delta) {
  const list = Array.isArray(favorites) ? [...favorites] : [];
  const from = list.indexOf(channelId);
  if (from === -1) return list;
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (to === from) return list;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

// Verschiebt channelId relativ zu den SICHTBAREN Favoriten (visibleIds = Sender, die in der
// Playlist noch existieren): Tausch mit dem nächsten sichtbaren Nachbarn in Richtung delta
// (-1 hoch, +1 runter). "Geister"-Favoriten (nicht mehr in der Playlist) behalten ihre Plätze,
// es entstehen keine Duplikate und es geht nichts verloren. Ohne sichtbaren Nachbarn: unverändert.
function moveFavoriteAmongVisible(favorites, channelId, delta, visibleIds) {
  const list = Array.isArray(favorites) ? [...favorites] : [];
  const from = list.indexOf(channelId);
  if (from === -1 || (delta !== -1 && delta !== 1)) return list;
  const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
  let to = from + delta;
  while (to >= 0 && to < list.length && !visible.has(list[to])) to += delta;
  if (to < 0 || to >= list.length) return list;
  [list[from], list[to]] = [list[to], list[from]];
  return list;
}

// Position von channelId unter den sichtbaren Favoriten (-1 = nicht enthalten) und deren Anzahl.
function visibleFavoritePosition(favorites, channelId, visibleIds) {
  const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
  const list = (Array.isArray(favorites) ? favorites : []).filter(id => visible.has(id));
  return { index: list.indexOf(channelId), count: list.length };
}

// Drag&Drop: draggedId landet an der Position von targetId (Semantik wie reorderChannel).
function moveFavoriteTo(favorites, draggedId, targetId) {
  const list = Array.isArray(favorites) ? [...favorites] : [];
  const from = list.indexOf(draggedId);
  const to = list.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return list;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

/**
 * Überschreibungen einer Quelle um die Änderungen eines Senders ergänzen.
 * changes[key] === undefined | null | '' entfernt den Schlüssel (zurück auf Original);
 * leere Einträge werden gelöscht; andere Sender und unbekannte Felder bleiben erhalten.
 * Gibt ein neues Objekt zurück (Eingabe bleibt unverändert).
 */
function mergeOverride(existing, channelId, changes) {
  const merged = { ...(existing || {}) };
  const entry = { ...(merged[channelId] || {}) };
  for (const [key, value] of Object.entries(changes || {})) {
    if (value === undefined || value === null || value === '') delete entry[key];
    else entry[key] = value;
  }
  if (Object.keys(entry).length) merged[channelId] = entry;
  else delete merged[channelId];
  return merged;
}

/**
 * Änderungen aus dem Formular ableiten. Leeres Feld = Override entfernen, Wert gleich dem
 * aktuell wirksamen Wert = keine Änderung am Override.
 * draft: { name, tvgId, tvgLogo, urlEnabled, url }
 */
function buildOverrideChanges(channel, draft) {
  const changes = {};
  const text = (key, current) => {
    const value = String(draft[key] ?? '').trim();
    if (value === '') changes[key] = undefined;
    else if (value !== String(current || '')) changes[key] = value;
  };
  text('name', channel.name);
  text('tvgId', channel.tvgId);
  text('tvgLogo', channel.tvgLogo || channel.logo);
  if (!draft.urlEnabled) changes.url = undefined;
  else {
    const url = String(draft.url ?? '').trim();
    changes.url = url === '' ? undefined : url;
  }
  return changes;
}

/**
 * Prüft Formularwerte (nur gesetzte). Liefert { field: Fehlertext } oder {}.
 * Regeln liegen in lib/input-validation.js und sind identisch zur Validierung im Main-Prozess.
 */
function validateOverrideChanges(changes) {
  const errors = {};
  if (changes.name !== undefined && changes.name.length > 200) errors.name = 'Name ist zu lang (max. 200 Zeichen)';
  if (changes.tvgId !== undefined && changes.tvgId.length > 200) errors.tvgId = 'tvg-id ist zu lang (max. 200 Zeichen)';
  if (changes.url !== undefined) {
    const error = channelStreamUrlError(changes.url);
    if (error) errors.url = error;
  }
  if (changes.tvgLogo !== undefined) {
    const error = channelLogoError(changes.tvgLogo);
    if (error) errors.tvgLogo = error;
  }
  return errors;
}

// Seitenweise Ausschnitt (page ab 0); korrigiert page in den gültigen Bereich.
function paginate(items, page, pageSize) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, page));
  return { items: items.slice(current * pageSize, (current + 1) * pageSize), page: current, pages, total: items.length };
}

module.exports = {
  OVERRIDE_KEYS,
  normEpgId,
  channelKey,
  channelLabel,
  isFav,
  filterManagedChannels,
  toggleFavoriteList,
  orderFavoriteChannels,
  globalFavoriteList,
  applyFavoriteOrder,
  setSourceFavorites,
  toggleGlobalFavorite,
  moveGlobalFavorite,
  globalFavoritePosition,
  moveGlobalFavoriteTo,
  moveFavorite,
  moveFavoriteAmongVisible,
  visibleFavoritePosition,
  moveFavoriteTo,
  mergeOverride,
  buildOverrideChanges,
  validateOverrideChanges,
  paginate,
};
