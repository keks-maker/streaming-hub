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

  // ── Meta-Datei-Migration (Karte t_f36663be, Item 1) ──
  //
  // Fertige (completed) Aufnahmen leben OHNE Job-Verzeichnis: Nach dem Remux
  // wird der rec_*-Ordner komplett geräumt (nur die MP4 bleibt im
  // Aufnahmen-Root). Die Meta-Datei wandert dafür parallel zur MP4 in den
  // Bibliotheks-Layer: <Speicherort>/Aufnahmen/<recId>.recording.json.
  // Zwischenstände (recording/remux-pending/aborted/failed) bleiben im
  // Job-Ordner — Recovery-Pfade (findResumable/hasIntermediateForm) setzen
  // die Ordner-Struktur voraus.

  // Migrierte Lage (completed): parallel zur MP4 im Bibliotheks-Root
  function migratedMetaPath(recId) {
    if (!/^rec_[A-Za-z0-9._-]+$/.test(recId)) throw new Error('Ungültige Aufnahme-ID');
    return path.join(library, `${recId}.recording.json`);
  }

  /**
   * Liest die Meta-Datei — migrierte Lage (completed) zuerst, dann der
   * Legacy-Job-Ordner-Ort. Der Doppel-Lese deckt ab:
   * - alte Aufnahmen, die noch nie migriert wurden (pre-@0.5.19);
   * - den UC-Übergang (Remux schreibt completed, räumt dann den Ordner).
   */
  function readMeta(recId) {
    for (const file of [migratedMetaPath(recId), metaPath(recId)]) {
      let raw;
      try {
        raw = readJson(file);
      } catch (e) {
        if (!e || e.code !== 'ENOENT') {
          log('warn', `Meta nicht lesbar für ${recId} (${path.basename(path.dirname(file))}): ${e.message}`);
        }
        continue;
      }
      try {
        return normalizeMeta(raw);
      } catch (e) {
        log('warn', `Meta invalid für ${recId} (${file}): ${e.message}`);
      }
    }
    return null;
  }

  function writeMeta(meta) {
    const normalized = normalizeMeta(meta); // Wurf = Aufrufer-Fehler, nicht schlucken
    // Ziel-Lage: completed → migrierter Layer (parallel zur MP4), alles
    // andere → Job-Ordner-Lage (Recovery-Vertrag).
    const target = normalized.status === 'completed' ? migratedMetaPath(normalized.id) : metaPath(normalized.id);
    try {
      atomicWriteJson(target, normalized);
      // completed im Bibliotheks-Layer: die LEGACY-Lage aufräumen, damit
      // readMeta eindeutig ist (kein Doppel-Wahrheits-Status).
      if (normalized.status === 'completed') {
        try {
          fs.rmSync(metaPath(normalized.id), { force: true });
        } catch (_) {
          // Legacy-Cleanup ist keinGate — der migrirte Write ist geschehen.
        }
      }
      return normalized;
    } catch (e) {
      log('error', `Meta-Write fehlgeschlagen für ${normalized.id}: ${e.message}`);
      return null;
    }
  }

  /**
   * Entfernt die Meta-Datei in BEIDEN Lagen (Delete-Flow, main.js).
   */
  function removeMeta(recId) {
    for (const file of [migratedMetaPath(recId), metaPath(recId)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (_) {
        // Eine Lage fehlt → weiter; Delete erhält trotzdem success
      }
    }
  }

  // ── Recovery: remux-pending / abgebrochene Aufnahmen beim Start ──

  /**
   * Rekoverbare Aufnahmen beim App-Start:
   * 1) Status remux-pending (App war während des Remux weg) — der
   *    nachholende Remux setzt sie auf completed/failed.
   * 2) Aborted-Records mit erhaltener HLS-Zwischenform (F-FB-08,
   *    t_9372a4b3): Job wurde hart gekillt (App-Absturz), der Zwischenstand
   *    ist aber da und wird nachträglich remuxt. Ohne Zwischenplaylist
   *    (leerer Job-Ordner) bleibt aborted — nichts zu holen.
   * Zustand failed wird NICHT rekovert (echter, finaler Fehler).
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
      } else if (meta.status === 'aborted' && hasIntermediateForm(entry.name)) {
        // F-FB-08: hart gekillter Job mit Inhalt — Remux nachholen
        seen.add(entry.name);
        out.push(meta);
      }
    }
    return out;
  }

  /**
   * True, wenn der Job-Ordner eine remuxbare HLS-Zwischenform enthält
   * (Playlist mit mindestens einem Segment-Eintrag; ENDLIST darf fehlen —
   * der Remux sichert sie selbst an).
   */
  function hasIntermediateForm(recId) {
    try {
      const playlistPath = path.join(library, recId, 'index.m3u8');
      if (!fs.existsSync(playlistPath)) return false;
      return /#EXTINF:/.test(fs.readFileSync(playlistPath, 'utf-8'));
    } catch (_) {
      return false;
    }
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
    migratedMetaPath,
    readMeta,
    writeMeta,
    removeMeta,
    findResumable,
    reapOrphans,
    upsertIndex,
    removeFromIndex,
    listAll,
    hasIntermediateForm,
  };
}

module.exports = { createRecordingStore };
