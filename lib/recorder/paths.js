// v0.5.8 – Recorder-Pfade (Aufnahme Phase 1b, Karte t_17ee2ca5)
//
// Zentrale Pfad- und Nutzereingabe-Logik der Aufnahme-Engine:
// - Default-Speicherort `~/Videos/Streaming Hub/` (Konzept §3.4)
// - Validierung des Speicherorts (Konzept §3.4: beschreibbar? Platz?)
// - Verzeichnislayout je Aufnahme (HLS-Zwischenform isoliert je Job,
//   damit Remux-Löschen niemals Nachbarn trifft)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_RECORDINGS_DIRNAME = 'Streaming Hub';
// Minimal 64 MiB freier Platz, damit eine Aufnahme nicht beim ersten
// Fragment im Leeren endet (Konzept §3.4 "Platz-Check vor Aufnahme-Start").
const MIN_FREE_DISK_BYTES = 64 * 1024 * 1024;

/**
 * Default-Speicherort: ~/Videos/Streaming Hub/ (macOS + Linux, Konzept §3.4/§6).
 */
function defaultRecordingsRoot(homeDir) {
  return path.join(homeDir || os.homedir(), 'Videos', DEFAULT_RECORDINGS_DIRNAME);
}

/**
 * Prüft den Speicherort: existiert (oder anlegbar), beschreibbar, genug Platz.
 * Erlaubt absolute Verzeichnisse inkl. Netzwerk-Mounts (Konzept §3.4: NAS-Pfad).
 * Rückgabe: { ok, error, freeBytes } — freeBytes nur belegt, wenn ermittelbar
 * (statfs steht auf manchen Netzwerkdateisystemen nicht zuverlässig bereit).
 */
function validateStorageRoot(root) {
  if (typeof root !== 'string' || !root.trim()) {
    return { ok: false, error: 'Kein Speicherort angegeben', freeBytes: null };
  }
  let resolved;
  try {
    resolved = path.resolve(root);
  } catch (_) {
    return { ok: false, error: 'Ungültiger Speicherort', freeBytes: null };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: 'Speicherort ist kein Verzeichnis', freeBytes: null };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { ok: false, error: `Speicherort nicht zugreifbar: ${e.message}`, freeBytes: null };
    }
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (mk) {
      return { ok: false, error: `Speicherort konnte nicht angelegt werden: ${mk.message}`, freeBytes: null };
    }
  }
  const probe = path.join(resolved, `.streaming-hub-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'probe', 'utf-8');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    return { ok: false, error: `Speicherort ist nicht beschreibbar: ${e.message}`, freeBytes: null };
  }
  let freeBytes = null;
  try {
    freeBytes = fs.statfsSync(resolved).bavail * fs.statfsSync(resolved).bsize;
  } catch (_) {
    // Netzwerkdateisysteme ohne statfs-Antwort: Platz nicht verifizierbar,
    // Beschreibbarkeit (oben) ist der harte Gate.
  }
  if (freeBytes !== null && freeBytes < MIN_FREE_DISK_BYTES) {
    return { ok: false, error: `Zu wenig freier Speicherplatz (${Math.floor(freeBytes / 1024 / 1024)} MiB)`, freeBytes };
  }
  return { ok: true, error: null, freeBytes };
}

/**
 * Legt das Aufnahmeverzeichnis eines Jobs an: <root>/Aufnahmen/<recId>/
 * Die HLS-Zwischenform (index.m3u8 + *.ts) lebt isoliert in diesem Verzeichnis,
 * das fertige MP4 landet direkt daneben (in <root>/Aufnahmen/) — Konzept §2.3.
 */
function jobDir(root, recId) {
  if (!root || !recId) throw new Error('jobDir benötigt root und recId');
  // Defense-in-Depth gegen Pfad-Tricks (gleiche Whitelist wie RecordingStore).
  if (!/^rec_[A-Za-z0-9._-]+$/.test(recId)) throw new Error('Ungültige Aufnahme-ID');
  const dir = path.join(path.resolve(root), 'Aufnahmen', recId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Zielverzeichnis der fertigen MP4-Dateien (direkt unter dem Speicherort).
 */
function libraryDir(root) {
  const dir = path.join(path.resolve(root), 'Aufnahmen');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * true, wenn `file` (nach path.resolve) strikt unterhalb von `dir` liegt.
 * Schutz gegen manipulierte Meta-Dateien (outputFile zeigt außerhalb der Bibliothek).
 */
function isInsideDir(dir, file) {
  if (typeof dir !== 'string' || typeof file !== 'string') return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = {
  isInsideDir,
  DEFAULT_RECORDINGS_DIRNAME,
  MIN_FREE_DISK_BYTES,
  defaultRecordingsRoot,
  validateStorageRoot,
  jobDir,
  libraryDir,
};
