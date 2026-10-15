'use strict';

// Einstellungen → Podcasts → Abos / Eigene Feeds: reine Logik ohne DOM (Reihenfolge, Statuszeile, Quellen, Formular-Prüfung).
// Die Abo-Liste kommt vom Main bereits in subscriptionRank-Reihenfolge (podcast:list); diese Funktionen liefern nur die neue
// Reihenfolge (IDs), die der Main über podcast:reorder speichert.

const { formatAgo } = require('./podcast-format.js');

const CUSTOM_SOURCE = 'eigene-podcasts';
const SOURCE_LABELS = Object.freeze({ [CUSTOM_SOURCE]: 'Eigener Feed', suche: 'Suche', 'oeffentlich-rechtlich': 'Öffentlich-rechtlich' });
const MAX_TITLE_LENGTH = 300;

function idsOf(subscriptions) {
  return subscriptions.map(sub => sub.id);
}

/** IDs mit `id` um `delta` Stellen verschoben (Grenzen bleiben stehen); unbekannte ID oder keine Änderung → null. */
function moveId(order, id, delta) {
  const from = order.indexOf(id);
  if (from < 0) return null;
  const to = Math.min(order.length - 1, Math.max(0, from + delta));
  if (to === from) return null;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Drag & Drop: `dragged` kommt an die Stelle von `target` (davor, wenn von unten gezogen, sonst dahinter); keine Änderung → null. */
function dropOn(order, dragged, target) {
  const from = order.indexOf(dragged);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, dragged);
  return next;
}

function isCustom(subscription) {
  return Boolean(subscription) && subscription.source === CUSTOM_SOURCE;
}

function sourceLabel(subscription) {
  return SOURCE_LABELS[subscription && subscription.source] || 'Mitgelieferte Liste';
}

/** Statuszeile je Abo: { kind: 'error'|'ok'|'pending', text }. Fehlertexte stammen aus dem Main (enthalten nie die Feed-URL). */
function feedStatus(subscription, now = Date.now()) {
  const feed = (subscription && subscription.feed) || {};
  if (feed.lastError) {
    const since = feed.lastErrorAt ? ` (${formatAgo(feed.lastErrorAt, now)})` : '';
    return { kind: 'error', text: `Fehler beim Prüfen: ${feed.lastError}${since}` };
  }
  if (feed.lastChecked) return { kind: 'ok', text: `Geprüft ${formatAgo(feed.lastChecked, now)}` };
  return { kind: 'pending', text: 'Noch nicht geprüft' };
}

/**
 * Formularprüfung für Anpassungen: Name höchstens 300 Zeichen, Cover leer oder http/https. Die endgültige Prüfung (Bild,
 * Ziel-Adresse) macht der Main; hier nur schnelle Rückmeldung. Liefert { values: { title, cover }, errors } mit Fehlertexten.
 */
function validateOverrideForm({ title = '', cover = '' } = {}) {
  const errors = {};
  const trimmedTitle = String(title).trim();
  const trimmedCover = String(cover).trim();
  if (trimmedTitle.length > MAX_TITLE_LENGTH) errors.title = `Der Name darf höchstens ${MAX_TITLE_LENGTH} Zeichen lang sein.`;
  if (trimmedCover) {
    let url;
    try {
      url = new URL(trimmedCover);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) errors.cover = 'Die Cover-Adresse muss mit http:// oder https:// beginnen.';
    else if (url.username || url.password) errors.cover = 'Die Cover-Adresse darf keine Zugangsdaten enthalten.';
    else if (/\s/.test(trimmedCover)) errors.cover = 'Die Cover-Adresse darf keine Leerzeichen enthalten.';
  }
  return { values: { title: trimmedTitle, cover: trimmedCover }, errors };
}

/** Patch für podcast:set-override: nur geänderte Felder; leer = Anpassung entfernen. null, wenn nichts zu tun ist. */
function overridePatch(subscription, values) {
  const current = (subscription && subscription.overrides) || {};
  const patch = {};
  if ((current.title || '') !== values.title) patch.title = values.title || null;
  if ((current.cover || '') !== values.cover) patch.cover = values.cover || null;
  return Object.keys(patch).length ? patch : null;
}

/** Abo-Zahl und Hinweis für die Kopfzeile der Seite. */
function summary(subscriptions) {
  const count = subscriptions.length;
  const failed = subscriptions.filter(sub => sub.feed && sub.feed.lastError).length;
  const base = count === 1 ? '1 Abo' : `${count} Abos`;
  if (!failed) return base;
  return `${base} · ${failed} mit Fehler`;
}

module.exports = { CUSTOM_SOURCE, MAX_TITLE_LENGTH, idsOf, moveId, dropOn, isCustom, sourceLabel, feedStatus, validateOverrideForm, overridePatch, summary };
