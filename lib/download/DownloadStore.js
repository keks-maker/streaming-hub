'use strict';

// Persistenz der Downloads (downloads.json im Nutzerverzeichnis): atomares Schreiben (tmp + rename) wie RecordingStore. Ein defekter
// oder unlesbarer Stand degradiert zu einer leeren Liste (die Datei wird beim nächsten Speichern ersetzt, die alte als .bak gesichert).

const fs = require('node:fs');
const path = require('node:path');
const { normalizeRecord } = require('./records.js');

function createDownloadStore({ file, logger = null }) {
  if (!file) throw new Error('DownloadStore benötigt einen Dateipfad');
  const log = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](`[download] ${message}`);
    } catch {
      // Logger-Ausfall darf die Persistenz nicht stören
    }
  };

  function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      log('warn', `downloads.json nicht lesbar (${error.message}), Liste beginnt leer`);
      try {
        fs.copyFileSync(file, `${file}.bak`);
      } catch {
        // Sicherung nicht möglich
      }
      return [];
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
    const seen = new Set();
    const records = [];
    for (const item of list) {
      const record = normalizeRecord(item);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
    return records;
  }

  /** Schreibt die Liste atomar; gibt false bei Schreibfehler zurück (der Dienst läuft weiter, der Fehler steht im Log). */
  function save(records) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, items: records }, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, file);
      return true;
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Aufräumen nicht möglich
      }
      log('error', `downloads.json konnte nicht geschrieben werden: ${error.message}`);
      return false;
    }
  }

  return { file, load, save };
}

module.exports = { createDownloadStore };
