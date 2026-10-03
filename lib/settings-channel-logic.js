'use strict';

// Reine Logik der Einstellungsseite "LiveTV → Sender" (Issue #4, Etappe 3).
// Keine DOM-/Electron-Abhängigkeit, daher ohne Electron unit-testbar.
// Datenformat (tvsources.json) unverändert: source.favorites (Reihenfolge = Favoritenreihenfolge),
// source.sortOrder, source.channelOverrides[chId] = { name?, tvgId?, tvgLogo?, url? }.

const { isPrivateHostname } = require('./input-validation.js');

const OVERRIDE_KEYS = ['name', 'tvgId', 'tvgLogo', 'url'];

function normEpgId(id) {
  return String(id || '')
    .replace(/@[^.@]*/g, '')
    .toLowerCase()
    .trim();
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
    const result = [];
    for (const source of sources) {
      if (allowed && !allowed.has(source.id)) continue;
      const bySource = new Map(list.filter(ch => ch.sourceId === source.id).map(ch => [ch.id, ch]));
      for (const id of Array.isArray(source.favorites) ? source.favorites : []) {
        if (bySource.has(id)) result.push(bySource.get(id));
      }
    }
    return result;
  }
  return list;
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

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Prüft Formularwerte (nur gesetzte). Liefert { field: Fehlertext } oder {}.
 * URL: http/https, keine lokalen/privaten Ziele (wie Quellen-URLs).
 * Logo: http/https oder relativer Pfad (wird gegen die Playlist-Basis aufgelöst), keine anderen Schemata.
 */
function validateOverrideChanges(changes) {
  const errors = {};
  if (changes.name !== undefined && changes.name.length > 200) errors.name = 'Name ist zu lang (max. 200 Zeichen)';
  if (changes.tvgId !== undefined && changes.tvgId.length > 200) errors.tvgId = 'tvg-id ist zu lang (max. 200 Zeichen)';
  if (changes.url !== undefined) {
    if (!isHttpUrl(changes.url)) errors.url = 'Stream-URL muss mit http:// oder https:// beginnen';
    else if (isPrivateHostname(new URL(changes.url).hostname)) {
      errors.url = 'Stream-URL darf kein lokales oder privates Ziel verwenden';
    } else if (changes.url.length > 4096) errors.url = 'Stream-URL ist zu lang';
  }
  if (changes.tvgLogo !== undefined) {
    const logo = changes.tvgLogo;
    if (/^[a-z][a-z0-9+.-]*:/i.test(logo) && !isHttpUrl(logo)) {
      errors.tvgLogo = 'Logo-URL muss mit http:// oder https:// beginnen (oder ein relativer Pfad sein)';
    } else if (logo.length > 4096) errors.tvgLogo = 'Logo-URL ist zu lang';
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
  isFav,
  filterManagedChannels,
  toggleFavoriteList,
  moveFavorite,
  moveFavoriteTo,
  mergeOverride,
  buildOverrideChanges,
  validateOverrideChanges,
  paginate,
};
