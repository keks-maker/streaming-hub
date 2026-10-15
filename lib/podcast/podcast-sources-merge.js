'use strict';

// Abgleich der Abos mit der mitgelieferten Liste (podcastsources.json) beim Update (Konzept §4, Muster
// radiosources-merge.js). Anders als bei Radio liegen die Nutzerdaten (Abos, Reihenfolge, Overrides, Hörstatus) nicht in der
// Katalogdatei, sondern getrennt in podcasts.json/podcast-state.json; die Katalogdatei wird nie vom Nutzer verändert und
// braucht deshalb keinen 3-way-Merge. Was beim Update zu tun bleibt, ist die Pflege der Abos aus dem Katalog:
//   - Abo mit catalogId: Name, Autor, Cover und Feed-URL aus der neuen Liste übernehmen. Ändert sich die Feed-URL, ändert sich
//     die Abo-ID (Hash der URL): Reihenfolge, Overrides und Hörstatus wandern auf die neue ID (idMap alt -> neu).
//   - Abo, dessen Eintrag aus der Liste verschwunden ist: bleibt erhalten, markiert mit removed:true ("nicht mehr in der Liste").
//   - Eigene und per Suche abonnierte Feeds bleiben unberührt. NIE Datenverlust; idempotent.
// Reine Funktionen ohne Datei- und Electron-Zugriffe.

const { podcastIdFromFeedUrl } = require('./podcast-ids.js');
const { deepEqual } = require('../tvsources-merge.js');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Alle Katalogeinträge aller mitgelieferten Quellen als Map catalogId -> Eintrag (mit sourceId). */
function catalogIndex(sources) {
  const index = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!isPlainObject(source) || source.type === 'user' || !Array.isArray(source.podcasts)) continue;
    for (const entry of source.podcasts) {
      if (isPlainObject(entry) && typeof entry.id === 'string' && typeof entry.feedUrl === 'string') index.set(entry.id, { ...entry, sourceId: source.id });
    }
  }
  return index;
}

function safeId(feedUrl) {
  try {
    return podcastIdFromFeedUrl(feedUrl);
  } catch {
    return null;
  }
}

/**
 * data: Inhalt von podcasts.json ({ subscriptions, subscriptionRank, overrides }), catalog: geparste podcastsources.json.
 * Rückgabe: { data (neu), idMap, changed }.
 */
function reconcileSubscriptions(data, catalog) {
  const index = catalogIndex(catalog);
  const subscriptions = Array.isArray(data && data.subscriptions) ? data.subscriptions : [];
  const idMap = {};
  const seen = new Set();
  const next = [];
  for (const sub of subscriptions) {
    if (!isPlainObject(sub) || typeof sub.id !== 'string') continue;
    let updated = sub;
    if (typeof sub.catalogId === 'string') {
      const entry = index.get(sub.catalogId);
      if (!entry) {
        updated = sub.removed === true ? sub : { ...sub, removed: true };
      } else {
        const newId = safeId(entry.feedUrl);
        if (newId) {
          updated = { ...sub, id: newId, feedUrl: entry.feedUrl, title: entry.name || sub.title, author: entry.author || '', cover: entry.cover || null };
          delete updated.removed;
          if (newId !== sub.id) idMap[sub.id] = newId;
        }
      }
    }
    if (seen.has(updated.id)) continue; // Zusammenfall zweier Abos auf dieselbe Feed-URL: das erste bleibt
    seen.add(updated.id);
    next.push(updated);
  }
  const mapId = id => idMap[id] || id;
  const rank = [];
  for (const id of Array.isArray(data && data.subscriptionRank) ? data.subscriptionRank : []) {
    const mapped = mapId(id);
    if (seen.has(mapped) && !rank.includes(mapped)) rank.push(mapped);
  }
  const overrides = {};
  const sourceOverrides = isPlainObject(data && data.overrides) ? data.overrides : {};
  for (const [id, value] of Object.entries(sourceOverrides)) {
    const mapped = mapId(id);
    if (seen.has(mapped) && (mapped === id || !has(overrides, mapped))) overrides[mapped] = value;
  }
  const result = { ...(isPlainObject(data) ? data : {}), subscriptions: next, subscriptionRank: rank, overrides };
  return { data: result, idMap, changed: !deepEqual(result, data) };
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

module.exports = { reconcileSubscriptions, catalogIndex };
