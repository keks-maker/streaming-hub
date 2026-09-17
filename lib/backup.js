'use strict';

const { remoteHttpUrl, text } = require('./input-validation.js');

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 1000;
const MAX_COLLECTION_ENTRIES = 5000;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBackup(data) {
  if (!isPlainObject(data)) return { ok: false, error: 'Backup muss ein Objekt sein' };
  if (!Array.isArray(data.services) || (!Array.isArray(data.tvSources) && !Array.isArray(data.tvsources))) {
    return { ok: false, error: 'Backup benötigt services und tvsources als Arrays' };
  }
  const tvsources = data.tvSources || data.tvsources;
  if (data.services.length > MAX_COLLECTION_ENTRIES || tvsources.length > MAX_COLLECTION_ENTRIES) {
    return { ok: false, error: 'Backup enthält zu viele Einträge' };
  }
  if (data.history !== undefined && (!Array.isArray(data.history) || data.history.length > MAX_HISTORY_ENTRIES)) {
    return { ok: false, error: 'Backup enthält einen ungültigen Verlauf' };
  }
  try {
    for (const service of data.services) {
      if (!isPlainObject(service) || typeof service.id !== 'string' || typeof service.name !== 'string') {
        return { ok: false, error: 'Backup enthält einen ungültigen Dienst' };
      }
      text(service.id, 'Dienst-ID', 200);
      text(service.name, 'Dienstname', 200);
      remoteHttpUrl(service.url, 'Dienst-URL');
    }
    for (const source of tvsources) {
      if (!isPlainObject(source) || typeof source.id !== 'string' || typeof source.name !== 'string') {
        return { ok: false, error: 'Backup enthält eine ungültige TV-Quelle' };
      }
      text(source.id, 'Quellen-ID', 200);
      text(source.name, 'Quellenname', 200);
      if (source.type === 'file') text(source.url, 'M3U-Dateipfad', 4096);
      else remoteHttpUrl(source.url, 'M3U-URL');
      if (source.epgUrl !== undefined && source.epgUrl !== null && source.epgUrl !== '') {
        remoteHttpUrl(source.epgUrl, 'EPG-URL');
      }
    }
  } catch (error) {
    return { ok: false, error: `Backup enthält ungültige URL-Daten: ${error.message}` };
  }
  return { ok: true, value: { ...data, tvsources, history: data.history || [] } };
}

function parseBackup(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BACKUP_BYTES) {
    throw new Error('Backup ist zu groß');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Backup ist kein gültiges JSON: ${error.message}`);
  }
  const result = validateBackup(data);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

module.exports = { MAX_BACKUP_BYTES, parseBackup, validateBackup };
