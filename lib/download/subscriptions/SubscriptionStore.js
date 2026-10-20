'use strict';

// Persistenz der Serien-Abos (subscriptions.json im Nutzerverzeichnis), Muster DownloadStore/RecordingStore: atomares Schreiben
// (tmp + rename); ein defekter Stand degradiert zu einer leeren Liste (die alte Datei bleibt als .bak erhalten).

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSubscription } = require('./records.js');

function createSubscriptionStore({ file, logger = null }) {
  if (!file) throw new Error('SubscriptionStore benötigt einen Dateipfad');
  const log = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](`[abo] ${message}`);
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
      log('warn', `subscriptions.json nicht lesbar (${error.message}), Liste beginnt leer`);
      try {
        fs.copyFileSync(file, `${file}.bak`);
      } catch {
        // Sicherung nicht möglich
      }
      return [];
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
    const seen = new Set();
    const result = [];
    for (const item of list) {
      const sub = normalizeSubscription(item);
      const key = sub && `${sub.sourceId}:${sub.seriesId}`;
      if (!sub || seen.has(sub.id) || seen.has(key)) continue;
      seen.add(sub.id);
      seen.add(key);
      result.push(sub);
    }
    return result;
  }

  /** Schreibt die Liste atomar; false bei Schreibfehler (der Dienst läuft weiter, der Fehler steht im Log). */
  function save(subscriptions) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, items: subscriptions }, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, file);
      return true;
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Aufräumen nicht möglich
      }
      log('error', `subscriptions.json konnte nicht geschrieben werden: ${error.message}`);
      return false;
    }
  }

  return { file, load, save };
}

module.exports = { createSubscriptionStore };
