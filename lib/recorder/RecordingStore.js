// v0.5.8 – Persistenz der Aufnahme-Metadaten (Aufnahme Phase 1b, Karte t_17ee2ca5)
//
// Zwei Ebenen nach Konzept §5:
// 1. Index-Datei `<Speicherort>/Aufnahmen/recordings.json` — Pipeline-Anker
//    (Recovery, IDs, Reihenfolge). Bei Schreibproblemen degradiert der Index
//    bewusst: die Meta-Dateien sind die Wahrheit und können den Index jederzeit
//    wieder aufbauen.
// 2. Meta-Datei `<...>/<recId>/<recId>.recording.json` — die einzelne
//    Aufnahme, robust bis zum Schluss (Schreibfehler des Index dürfen die
//    Aufnahme selbst nicht torpedieren).
//
// Muster: atomare Writes (tmp + rename) analog lib/user-storage.js.

'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeMeta } = require('./meta.js');
const { libraryDir } = require('./paths.js');

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      // Original-Schreibfehler hat Vorrang
    }
    throw new Error(`JSON konnte nicht geschrieben werden (${file}): ${e.message}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/**
 * Erstellt den Store. `root` = Speicherort (Default ~/Videos/Streaming Hub).
 */
function createRecordingStore({ root, logger = console } = {}) {
  if (!root) throw new Error('RecordingStore benötigt einen Speicherort (root)');

  const log = (level, ...args) => {
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    try {
      logger[fn](`[recorder] ${args.join(' ')}`);
    } catch (_) {
      // Logger-Ausfall darf Persistenz nicht killen
    }
  };

  const library = libraryDir(root);
  const indexPath = path.join(library, 'recordings.json');

  // ── Index ──

  function readIndex() {
    try {
      const raw = readJson(indexPath);
      if (!Array.isArray(raw)) return [];
      return raw.filter(e => e && typeof e === 'object' && typeof e.id === 'string').map(normalizeMeta);
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      log('warn', `Index nicht lesbar (${e.message}) — leer behandelt, Recovery via Meta-Dateien bleibt aktiv`);
      return [];
    }
  }

  function writeIndex(list) {
    try {
      atomicWriteJson(indexPath, list);
      return true;
    } catch (e) {
      // Kein Harakiri: die Meta-Dateien sind die Wahrheit, der Index nur
      // Pipeline-Anker. Bibliothek/Recovery können jederzeit aus den
      // Meta-Dateien wieder aufgebaut werden.
      log('error', `Index-Update fehlgeschlagen (${e.message}) — Meta-Dateien bleiben maßgeblich`);
      return false;
    }
  }

  // ── Meta-Datei je Aufnahme ──

  function metaPath(recId) {
    // recId ist vom Schema her begrenzt (rec_...); Defense-in-Depth gegen
    // Pfad-Tricks: nur [A-Za-z0-9._-] im Namen.
    if (!/^rec_[A-Za-z0-9._-]+$/.test(recId)) throw new Error('Ungültige Aufnahme-ID');
    return path.join(library, recId, `${recId}.recording.json`);
  }

  function readMeta(recId) {
    let raw;
    try {
      raw = readJson(metaPath(recId));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') log('warn', `Meta nicht lesbar für ${recId}: ${e.message}`);
      return null;
    }
    try {
      return normalizeMeta(raw);
    } catch (e) {
      log('warn', `Meta invalid für ${recId}: ${e.message}`);
      return null;
    }
  }

  function writeMeta(meta) {
    const normalized = normalizeMeta(meta); // Wurf = Aufrufer-Fehler, nicht schlucken
    try {
      atomicWriteJson(metaPath(normalized.id), normalized);
      return normalized;
    } catch (e) {
      log('error', `Meta-Write fehlgeschlagen für ${normalized.id}: ${e.message}`);
      return null;
    }
  }

  // ── Recovery: remux-pending / abgebrochene Aufnahmen beim Start ──

  /**
   * Rekoverbare Aufnahmen beim App-Start: Status remux-pending (App war
   * während des Remux weg) — der nachholende Remux setzt sie auf
   * completed/failed. Zustände failed/aborted werden NICHT rekovert.
   */
  function findResumable() {
    const out = [];
    const seen = new Set();

    // 1) Index als schneller Anker
    for (const entry of readIndex()) {
      if (entry.status === 'remux-pending') {
        seen.add(entry.id);
        out.push(entry);
      }
    }

    // 2) Meta-Dateien scannen (Wahrheit) — fängt Index-Ausfälle ab
    let entries;
    try {
      entries = fs.readdirSync(library, { withFileTypes: true });
    } catch (_) {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^rec_[A-Za-z0-9._-]+$/.test(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      const meta = readMeta(entry.name);
      if (!meta) continue;
      if (meta.status === 'remux-pending') {
        seen.add(entry.name);
        out.push(meta);
      }
    }
    return out;
  }

  /**
   * Zombies: Aufnahmen mit status "recording" in den Metadaten, aber ohne
   * laufenden Job (App-Absturz zw. Meta-Write und Stop) → aborted.
   * Scannt die Meta-Dateien (Wahrheit), nicht nur den Index — ein Zombie,
   * dessen Index-Update fehlschlug, wird trotzdem erfasst.
   * Liefert die korrigierten Metadaten.
   */
  function reapOrphans(activeIds) {
    const active = new Set(activeIds);
    const reaped = [];
    let entries;
    try {
      entries = fs.readdirSync(library, { withFileTypes: true });
    } catch (_) {
      return reaped;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^rec_[A-Za-z0-9._-]+$/.test(entry.name)) continue;
      if (active.has(entry.name)) continue;
      const meta = readMeta(entry.name);
      if (!meta || meta.status !== 'recording') continue;
      const updated = { ...meta, status: 'aborted', stoppedAt: meta.stoppedAt || new Date().toISOString() };
      if (writeMeta(updated)) {
        upsertIndex(updated);
        reaped.push(updated);
      }
    }
    return reaped;
  }

  // ── Index-Verwaltung ──

  function upsertIndex(meta) {
    const list = readIndex();
    const idx = list.findIndex(e => e.id === meta.id);
    if (idx === -1) list.unshift(normalizeMeta(meta));
    else list[idx] = normalizeMeta(meta);
    writeIndex(list);
  }

  function removeFromIndex(recId) {
    const list = readIndex();
    const idx = list.findIndex(e => e.id === recId);
    if (idx !== -1) {
      list.splice(idx, 1);
      writeIndex(list);
    }
  }

  function listAll() {
    return readIndex();
  }

  return {
    root,
    library,
    indexPath,
    readIndex,
    writeIndex,
    metaPath,
    readMeta,
    writeMeta,
    findResumable,
    reapOrphans,
    upsertIndex,
    removeFromIndex,
    listAll,
  };
}

module.exports = { createRecordingStore };
