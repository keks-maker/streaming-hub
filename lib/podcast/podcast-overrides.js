'use strict';

// Nutzer-Anpassungen (Name, Cover) je Abo: Felder müssen Strings sein, das Cover nur http/https ohne Zugangsdaten.
// Ungültige Felder werden verworfen (nie der ganze Import abgelehnt); Schlüssel sind ausschließlich gültige Podcast-IDs.

const { podcastFeedUrlError } = require('../input-validation.js');

const MAX_TITLE_LENGTH = 300;
const PODCAST_ID_PATTERN = /^[0-9a-f]{1,200}$/i;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** true für Schlüssel, die als Objekt-Schlüssel den Prototyp verändern könnten. */
function isUnsafeKey(key) {
  return UNSAFE_KEYS.has(key);
}

function hasControlChars(value) {
  return [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** Bereinigtes Override { title?, cover? } oder null, wenn kein gültiges Feld übrig bleibt. */
function sanitizeOverride(override) {
  if (!isPlainObject(override)) return null;
  const result = {};
  if (typeof override.title === 'string') {
    const title = override.title.trim();
    if (title && title.length <= MAX_TITLE_LENGTH && !hasControlChars(title)) result.title = title;
  }
  if (typeof override.cover === 'string' && override.cover && !podcastFeedUrlError(override.cover)) result.cover = override.cover;
  return Object.keys(result).length ? result : null;
}

/** Bereinigte Override-Map: nur gültige Podcast-IDs als Schlüssel, nur gültige Felder. */
function sanitizeOverrides(overrides) {
  const result = {};
  if (!isPlainObject(overrides)) return result;
  for (const [id, override] of Object.entries(overrides)) {
    if (isUnsafeKey(id) || !PODCAST_ID_PATTERN.test(id)) continue;
    const clean = sanitizeOverride(override);
    if (clean) result[id] = clean;
  }
  return result;
}

module.exports = { isUnsafeKey, sanitizeOverride, sanitizeOverrides };
