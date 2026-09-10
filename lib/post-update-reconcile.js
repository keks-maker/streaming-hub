// Nach-Update-Reconciliation (v0.4.83): holt den tvsources-3-way-Merge nach,
// wenn ein Update mit dem ALTEN Updater (v0.4.82 und älter, blinder Overwrite)
// oder einem abgebrochenen Apply durchgeführt wurde.
//
// Signal: .update-state.json speichert die beim letzten Start gesehene Version.
// Gibt es beim Start eine HÖHERE aktuelle Version (oder noch ein .update-backup
// eines abgebrochenen Applies), wurde gerade aktualisiert → einmalig mergen:
//   base = committete tvsources.json des Vorgänger-Tags (git show v<last>:…)
//   old  = Geräte-Stand vor dem Apply (.update-backup-Kopie, sonst aktuelle Datei)
//   neu  = committete tvsources.json der neuen Version (git show HEAD:…)
//
// Der Merge ist idempotent: Läuft der neue Updater bereits mit 3-way-Merge, ist
// das Ergebnis identisch und der erneute Merge ändert nichts. Lief der Legacy-
// Overwrite, stellt der Merge die Release-URL-Fixes wieder her und bewahrt die
// User-Daten. Reine Node-APIs, kein Electron → headless testbar.
//
// Fehler-Policy: Bei Fehlschlag bleiben Backup UND State-Datei unverändert →
// der Versuch wird beim nächsten Start wiederholt (Logs weisen darauf hin).
// Nur nach erfolgreichem Merge (oder wenn nichts zu tun war) werden Backup
// gelöscht und der State aktualisiert. NIE Datenverlust.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../logger.js');
const { mergeTvsources } = require('./tvsources-merge.js');

const STATE_FILE = '.update-state.json';
const BACKUP_DIR = '.update-backup';

function cmpVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0,
      vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function parseJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function gitShow(appDir, ref, file) {
  return execSync(`git show ${ref}:${file}`, {
    cwd: appDir,
    encoding: 'utf-8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function writeState(appDir, version) {
  try {
    fs.writeFileSync(path.join(appDir, STATE_FILE), JSON.stringify({ lastVersion: version }, null, 2) + '\n', 'utf-8');
  } catch (e) {
    logger.error('Update-State konnte nicht geschrieben werden:', e.message);
  }
}

/**
 * Führt die Nach-Update-Reconciliation aus. Idempotent; blockiert den Start nie.
 * @param {string} appDir  App-Verzeichnis (Git-Clone)
 * @param {string} currentVersion  aktuell laufende Version (app.getVersion())
 * @returns {{merged: boolean, reason: string}}
 */
function reconcilePostUpdate(appDir, currentVersion) {
  const statePath = path.join(appDir, STATE_FILE);
  const backupDir = path.join(appDir, BACKUP_DIR);
  const backupTvsources = path.join(backupDir, 'tvsources.json');
  const deviceTvsources = path.join(appDir, 'tvsources.json');

  const state = parseJsonFile(statePath);
  const lastVersion = state && typeof state.lastVersion === 'string' ? state.lastVersion : null;
  const hasBackup = fs.existsSync(backupTvsources);
  const wasUpdate = Boolean(lastVersion && currentVersion && cmpVersions(currentVersion, lastVersion) > 0);

  let outcome = 'noop'; // nichts zu tun
  let reason = 'kein Update seit dem letzten Start';

  try {
    if (!hasBackup && !wasUpdate) {
      return { merged: false, reason };
    }
    if (!fs.existsSync(deviceTvsources)) {
      outcome = 'failed';
      reason = 'keine tvsources.json vorhanden';
      logger.warn('Nach-Update-Reconciliation übersprungen:', reason);
      return { merged: false, reason };
    }

    logger.info(`Nach-Update-Reconciliation: ${lastVersion || '(unbekannt)'} → ${currentVersion}`);

    // old: Geräte-Stand vor dem Apply — Backup hat Vorrang (die aktuelle Datei könnte
    // bereits der neue committete Stand eines abgebrochenen Applies sein). Ist die
    // Backup-Kopie unlesbar, fällt der Merge auf den aktuellen Datei-Stand zurück.
    let old = null;
    if (hasBackup) {
      old = parseJsonFile(backupTvsources);
      if (old === null) {
        logger.warn('Backup-Kopie von tvsources.json unlesbar – verwende aktuellen Geräte-Stand als Merge-Grundlage');
      }
    }
    if (old === null) old = parseJsonFile(deviceTvsources);
    if (old === null) {
      outcome = 'failed';
      reason = 'Geräte-Stand nicht lesbar';
      logger.warn('tvsources-Geräte-Stand nicht lesbar – Merge übersprungen, Retry beim nächsten Start');
      return { merged: false, reason };
    }

    // base: committeter Stand der Vorgänger-Version; neu: committeter Stand der aktuellen.
    let base = null;
    let neu = null;
    try {
      if (lastVersion) base = JSON.parse(gitShow(appDir, `v${lastVersion}`, 'tvsources.json'));
      neu = JSON.parse(gitShow(appDir, 'HEAD', 'tvsources.json'));
    } catch (e) {
      logger.warn('Committete tvsources-Referenzen nicht lesbar:', e.message);
    }
    if (neu === null) neu = parseJsonFile(deviceTvsources); // letzter Fallback: Datei-Stand
    if (neu === null) {
      outcome = 'failed';
      reason = 'neue Version nicht lesbar';
      logger.warn('Neue committete tvsources nicht lesbar – Merge übersprungen, Retry beim nächsten Start');
      return { merged: false, reason };
    }

    const result = mergeTvsources(base, old, neu);
    if (result.ok) {
      fs.writeFileSync(deviceTvsources, JSON.stringify(result.value, null, 2) + '\n', 'utf-8');
      outcome = 'merged';
      reason = 'merge ausgeführt';
      logger.info('tvsources.json Nach-Update-Merge abgeschlossen (User-Daten + Release-Fixes)');
      return { merged: true, reason };
    }
    outcome = 'failed';
    reason = result.reason;
    logger.warn('tvsources.json Merge nicht möglich:', result.reason, '– Retry beim nächsten Start');
    return { merged: false, reason };
  } finally {
    // Nach erfolgreichem Merge das Backup entfernen; bei Fehlschlag bleibt es
    // für den Retry beim nächsten Start liegen. State ebenfalls nur dann
    // schreiben, wenn nichts mehr offen ist (sonst würde der Retry verhindert).
    if (outcome === 'merged' && hasBackup) {
      try {
        fs.rmSync(path.join(appDir, BACKUP_DIR), { recursive: true, force: true });
      } catch (e) {}
    }
    if (outcome === 'merged' || outcome === 'noop') {
      writeState(appDir, currentVersion);
    }
  }
}

module.exports = { reconcilePostUpdate, cmpVersions, STATE_FILE };
