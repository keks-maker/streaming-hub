'use strict';

// Schema-Prüfung aller downloads:*-Kanäle (Eingaben aus dem Renderer sind nicht vertrauenswürdig): feste Feldlisten, Typ- und
// Längengrenzen; unbekannte Felder werden abgelehnt. Folgen und Serien nutzen die Prüfung der Mediathek.

const { validateEntry, validateSeries } = require('../mediathek/validation.js');
const { OVERRIDE_KEYS, normalizeOverrides, DEFAULTS } = require('./download-settings.js');
const { ID_PATTERN } = require('./records.js');

const MAX_ENTRY_IDS = 500;

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} ist ungültig`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`Unbekanntes Feld: ${extra[0]}`);
}

function id(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error('Download-ID ist ungültig');
  return value;
}

function overrides(value) {
  if (value === undefined || value === null) return {};
  onlyKeys(value, OVERRIDE_KEYS, 'Optionen');
  return normalizeOverrides(value);
}

function optionalSeries(value) {
  return value === undefined || value === null ? null : validateSeries(value);
}

function validateSettingsPatch(value) {
  onlyKeys(value, Object.keys(DEFAULTS), 'Einstellungen');
  return value;
}

function validateRoot(value) {
  onlyKeys(value, ['root'], 'Anfrage');
  if (typeof value.root !== 'string' || !value.root.trim() || value.root.length > 1000) throw new Error('Speicherort ist ungültig');
  return { root: value.root };
}

function validatePlan(value) {
  onlyKeys(value, ['entry', 'series', 'overrides'], 'Anfrage');
  return { entry: validateEntry(value.entry), series: optionalSeries(value.series), overrides: overrides(value.overrides) };
}

function validateEnqueue(value) {
  return validatePlan(value);
}

function validateEnqueueMany(value) {
  onlyKeys(value, ['series', 'entryIds', 'overrides'], 'Anfrage');
  const series = validateSeries(value.series);
  if (!Array.isArray(value.entryIds) || !value.entryIds.length || value.entryIds.length > MAX_ENTRY_IDS) throw new Error('Folgenliste ist ungültig');
  const entryIds = value.entryIds.map(entryId => {
    if (typeof entryId !== 'string' || !entryId || entryId.length > 500) throw new Error('Folgen-ID ist ungültig');
    return entryId;
  });
  return { series, entryIds: [...new Set(entryIds)], overrides: overrides(value.overrides) };
}

function validateId(value) {
  onlyKeys(value, ['id'], 'Anfrage');
  return { id: id(value.id) };
}

function validateRemove(value) {
  onlyKeys(value, ['id', 'deleteFile'], 'Anfrage');
  if (value.deleteFile !== undefined && typeof value.deleteFile !== 'boolean') throw new Error('deleteFile ist ungültig');
  return { id: id(value.id), deleteFile: value.deleteFile === true };
}

module.exports = { validateSettingsPatch, validateRoot, validatePlan, validateEnqueue, validateEnqueueMany, validateId, validateRemove, MAX_ENTRY_IDS };
