'use strict';

// Datensatz eines Serien-Abos (subscriptions.json): Normalisierung gespeicherter Daten und Ansicht für den Renderer. Rein;
// gespeicherte Daten gelten als nicht vertrauenswürdig.

const crypto = require('node:crypto');
const { normalizeOverrides } = require('../download-settings.js');
const { normalizeSeries } = require('../../mediathek/favorites.js');

const ID_PATTERN = /^sub_[A-Za-z0-9_-]{4,60}$/;
const MAX_KNOWN = 5000;
const RESULT_STATUSES = ['ok', 'offline', 'error', 'space', 'storage'];

const str = (value, max = 500) => (typeof value === 'string' && value.length <= max ? value : null);
const count = value => (Number.isInteger(value) && value >= 0 && value < 1e6 ? value : 0);
const iso = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);

function newId() {
  return `sub_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Folgen-IDs ohne Dubletten, nur Texte, höchstens MAX_KNOWN (die zuletzt hinzugekommenen bleiben). */
function normalizeKnown(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  for (const id of list) if (typeof id === 'string' && id && id.length <= 500) seen.add(id);
  const ids = [...seen];
  return ids.length > MAX_KNOWN ? ids.slice(ids.length - MAX_KNOWN) : ids;
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = RESULT_STATUSES.includes(raw.status) ? raw.status : null;
  const at = iso(raw.at);
  if (!status || !at) return null;
  return { at, status, added: count(raw.added), pending: count(raw.pending), message: str(raw.message, 300), note: str(raw.note, 300) };
}

/** Normalisiert einen gespeicherten Datensatz; null = unbrauchbar. */
function normalizeSubscription(raw) {
  if (!raw || typeof raw !== 'object' || !ID_PATTERN.test(String(raw.id))) return null;
  const series = normalizeSeries({ id: raw.seriesId, title: raw.title, imageUrl: raw.imageUrl, description: raw.description, sourceId: raw.sourceId, groupingURL: raw.groupingURL });
  if (!series) return null;
  return {
    id: raw.id,
    sourceId: series.sourceId,
    seriesId: series.id,
    title: series.title,
    imageUrl: series.imageUrl,
    description: series.description,
    groupingURL: series.groupingURL,
    createdAt: iso(raw.createdAt) || new Date(0).toISOString(),
    knownEntryIds: normalizeKnown(raw.knownEntryIds),
    lastCheckAt: iso(raw.lastCheckAt),
    lastResult: normalizeResult(raw.lastResult),
    overrides: normalizeOverrides(raw.overrides),
    enabled: raw.enabled !== false,
  };
}

/** Serie (wie in Meine Serien) eines Abos. */
const seriesOf = sub => ({ id: sub.seriesId, title: sub.title, imageUrl: sub.imageUrl, description: sub.description, sourceId: sub.sourceId, groupingURL: sub.groupingURL });

/** Ansicht für den Renderer (ohne die Liste der bekannten Folgen). note = Hinweis aus den Downloads der Serie (z. B. Geoblock). */
function toView(sub, { note = null } = {}) {
  return {
    id: sub.id,
    sourceId: sub.sourceId,
    seriesId: sub.seriesId,
    title: sub.title,
    imageUrl: sub.imageUrl,
    series: seriesOf(sub),
    enabled: sub.enabled,
    createdAt: sub.createdAt,
    lastCheckAt: sub.lastCheckAt,
    lastResult: sub.lastResult,
    overrides: sub.overrides,
    knownCount: sub.knownEntryIds.length,
    note,
  };
}

module.exports = { ID_PATTERN, MAX_KNOWN, RESULT_STATUSES, newId, normalizeKnown, normalizeSubscription, seriesOf, toView };
