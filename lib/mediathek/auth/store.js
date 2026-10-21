'use strict';

// Speicher der Mediathek-Konten: Zugangs-/Auffrischungs-Token je Sender Nur verschlüsselt
// (Electron safeStorage, bei macOS Schlüsselbund) in EINER Datei, atomar geschrieben (Temp-Datei + rename, Rechte 0600).
// Ist safeStorage nicht verfügbar, wird nichts persistiert: die Werte leben nur im Arbeitsspeicher (Sitzung der Partition bleibt
// davon unberührt). Kein Token verlässt dieses Modul in Logs, Fehlern oder IPC-Antworten (der Aufrufer bekommt Kopien
// nur für den Abruf im Main-Prozess).

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const FILE_VERSION = 1;
const SENDERS = ['ard', 'arte'];

function emptyData() {
  return { accounts: {} };
}

/** Prüft einen gespeicherten Kontodatensatz; unbrauchbare Felder verwerfen den Datensatz. */
function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const { accessToken, refreshToken, expiresAt, since, state, clientId } = value;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    since: Number.isFinite(since) ? since : 0,
    state: state === 'expired' ? 'expired' : 'ok',
    clientId: typeof clientId === 'string' && clientId ? clientId : null,
  };
}

/**
 * options: file (Pfad), safeStorage ({ isEncryptionAvailable, encryptString, decryptString }), fs (Tests), logger.
 * Ergebnis: { persistent, get, set, remove }
 */
function createAuthStore({ file, safeStorage = null, fs = nodeFs, logger = null }) {
  let data = emptyData();

  const encryptionAvailable = () => {
    try {
      return Boolean(safeStorage) && safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  };

  function load() {
    if (!file || !encryptionAvailable()) return;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return; // noch keine Datei
    }
    try {
      const wrapper = JSON.parse(raw);
      if (!wrapper || wrapper.v !== FILE_VERSION || typeof wrapper.enc !== 'string') throw new Error('format');
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(wrapper.enc, 'base64')));
      const next = emptyData();
      for (const sender of SENDERS) {
        const record = normalizeRecord(parsed.accounts && parsed.accounts[sender]);
        if (record) next.accounts[sender] = record;
      }
      // Ältere Dateien können ein PIN-Feld enthalten: wird ignoriert und beim nächsten Speichern verworfen
      data = next;
    } catch {
      // Unlesbar (anderer Schlüsselbund, beschädigt): als abgemeldet behandeln, Details gehören nicht ins Log
      if (logger) logger.warn('Mediathek-Konten: gespeicherte Anmeldung nicht lesbar, bitte neu anmelden.');
      data = emptyData();
    }
  }

  function persist() {
    if (!file) return;
    if (!encryptionAvailable()) return; // Klartext wird nie geschrieben
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const body = JSON.stringify({ v: FILE_VERSION, enc: safeStorage.encryptString(JSON.stringify(data)).toString('base64') });
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Aufräumen ist best effort
      }
      if (logger) logger.warn('Mediathek-Konten konnten nicht gespeichert werden.');
    }
  }

  function removeFileIfEmpty() {
    if (!file) return;
    const empty = !Object.keys(data.accounts).length;
    if (!empty) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // nichts zu löschen
    }
  }

  load();

  return {
    /** true, wenn Werte verschlüsselt auf die Platte gelangen (sonst nur Arbeitsspeicher). */
    get persistent() {
      return Boolean(file) && encryptionAvailable();
    },
    get(sender) {
      const record = data.accounts[sender];
      return record ? { ...record } : null;
    },
    set(sender, record) {
      if (!SENDERS.includes(sender)) throw new Error('Unbekannter Sender');
      const normalized = normalizeRecord(record);
      if (!normalized) throw new Error('Ungültiger Kontodatensatz');
      data.accounts[sender] = normalized;
      persist();
    },
    remove(sender) {
      delete data.accounts[sender];
      persist();
      removeFileIfEmpty();
    },

  };
}

module.exports = { createAuthStore, SENDERS };
