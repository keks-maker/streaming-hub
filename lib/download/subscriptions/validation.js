'use strict';

// Schema-Prüfung der subscriptions:*-Kanäle (Eingaben aus dem Renderer sind nicht vertrauenswürdig): feste Feldlisten, unbekannte
// Felder werden abgelehnt. Serie und Optionen nutzen die Prüfung von Mediathek und Downloads.

const { validateSeries } = require('../../mediathek/validation.js');
const { OVERRIDE_KEYS, normalizeOverrides } = require('../download-settings.js');
const { ID_PATTERN } = require('./records.js');

const MODES = ['future', 'all'];

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} ist ungültig`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`Unbekanntes Feld: ${extra[0]}`);
}

function id(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error('Abo-ID ist ungültig');
  return value;
}

function overrides(value) {
  if (value === undefined || value === null) return {};
  onlyKeys(value, OVERRIDE_KEYS, 'Optionen');
  return normalizeOverrides(value);
}

function validateAdd(value) {
  onlyKeys(value, ['series', 'mode', 'overrides'], 'Anfrage');
  if (value.mode !== undefined && !MODES.includes(value.mode)) throw new Error('Modus ist ungültig');
  return { series: validateSeries(value.series), mode: value.mode || 'future', overrides: overrides(value.overrides) };
}

function validateUpdate(value) {
  onlyKeys(value, ['id', 'enabled', 'overrides'], 'Anfrage');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled ist ungültig');
  const patch = { id: id(value.id) };
  if (value.enabled !== undefined) patch.enabled = value.enabled;
  if (value.overrides !== undefined) patch.overrides = overrides(value.overrides);
  if (patch.enabled === undefined && patch.overrides === undefined) throw new Error('Keine Änderung angegeben');
  return patch;
}

function validateId(value) {
  onlyKeys(value, ['id'], 'Anfrage');
  return { id: id(value.id) };
}

function validateCheck(value) {
  if (value === undefined || value === null) return {};
  onlyKeys(value, ['id'], 'Anfrage');
  return value.id === undefined ? {} : { id: id(value.id) };
}

module.exports = { MODES, validateAdd, validateUpdate, validateId, validateCheck };
