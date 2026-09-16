// v0.4.83 – robuster Update-Prozess mit 3-way-Merge für tvsources.json
//
// Neu in v0.4.83: restoreUserFiles() überschrieb tvsources.json nach dem Checkout
// mit dem alten Geräte-Stand → im Release enthaltene channelOverrides (z. B. MDR
// Thüringen und weitere ARD-URL-Fixes) wurden stillschweigend zurückgerollt.
// Jetzt wird tvsources.json zwischen Geräte-Stand, letztem committeten Stand und
// neuem Tag gemerged (User-Favoriten/Sortierungen/eigene Overrides bleiben,
// Release-Fixes kommen durch). services.json/history.json: Verhalten unverändert
// (Overwrite — dort überschreibt der Geräte-Stand bewusst den committed Stand).
const logger = require('./logger.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { mergeTvsources } = require('./lib/tvsources-merge.js');

const appDir = process.argv[2] || process.cwd();

// User-Dateien, die vor dem Checkout gesichert werden müssen
const userFiles = ['services.json', 'tvsources.json', 'history.json'];
// Datei, die nach dem Checkout per 3-way-Merge mit dem neuen Tag zusammengeführt wird
const mergeFile = 'tvsources.json';
const backupDir = path.join(appDir, '.update-backup');

function git(args, timeout) {
  return execSync(`git ${args}`, {
    cwd: appDir,
    encoding: 'utf-8',
    timeout: timeout || 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function backupUserFiles() {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of userFiles) {
      const src = path.join(appDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, f));
      }
    }
  } catch (e) {
    // Backup-Fehler sind nicht fatal
    logger.error('Backup fehlgeschlagen:', e.message);
  }
}

/**
 * Lesbare tvsources.json aus dem letzten Commit lesen (Merge-Base).
 * Rückgabe: geparstes Array oder null (nicht verfügbar / nicht parsbar).
 */
function readCommittedTvsources() {
  try {
    const raw = git('show HEAD:tvsources.json');
    return JSON.parse(raw);
  } catch (e) {
    logger.error('Committete tvsources.json nicht lesbar (Merge läuft als 2-way):', e.message);
    return null;
  }
}

/**
 * Schreibt den gemergten tvsources-Stand in dasselbe Format wie die App
 * (JSON.stringify mit 2 Spaces + abschließendem Newline).
 */
function writeMergedTvsources(sources) {
  fs.writeFileSync(path.join(appDir, 'tvsources.json'), JSON.stringify(sources, null, 2) + '\n', 'utf-8');
}

// JSON-Dateien nach dem Merge sichern: Falls der anschließende `git stash pop`
// zeilenbasierte Konflikt-Marker in eine dieser Dateien schreibt (bis v0.4.82
// unmöglich, weil restore dort exakt den Stash-Inhalt reproduzierte), werden sie
// aus dieser Kopie wiederhergestellt.
function snapshotMergedJson() {
  const snapDir = path.join(backupDir, '.merged-snapshot');
  try {
    fs.mkdirSync(snapDir, { recursive: true });
    for (const f of userFiles) {
      const src = path.join(appDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapDir, f));
    }
  } catch (e) {
    logger.error('Snapshot der gemergten Dateien fehlgeschlagen:', e.message);
  }
}

function restoreMergedJsonSnapshot() {
  const snapDir = path.join(backupDir, '.merged-snapshot');
  try {
    if (!fs.existsSync(snapDir)) return;
    for (const f of userFiles) {
      const snap = path.join(snapDir, f);
      if (!fs.existsSync(snap)) continue;
      try {
        JSON.parse(fs.readFileSync(snap, 'utf-8')); // nur gültige Snapshots verwenden
        fs.copyFileSync(snap, path.join(appDir, f));
      } catch (e) {
        logger.error(`Snapshot für ${f} ungültig, überspringe:`, e.message);
      }
    }
    fs.rmSync(snapDir, { recursive: true, force: true });
  } catch (e) {
    logger.error('Snapshot-Wiederherstellung fehlgeschlagen:', e.message);
  }
}

/**
 * Prüft JSON-Dateien auf Git-Konflikt-Marker (nach stash pop) und repariert sie
 * aus dem Snapshot der gemergten Dateien.
 */
function repairConflictMarkersIfAny() {
  let found = false;
  for (const f of userFiles) {
    const dest = path.join(appDir, f);
    if (!fs.existsSync(dest)) continue;
    const content = fs.readFileSync(dest, 'utf-8');
    if (content.startsWith('<<<<<<<') || content.includes('\n<<<<<<<')) {
      found = true;
      logger.error(`Konflikt-Marker in ${f} nach stash pop erkannt`);
    }
  }
  if (found) {
    restoreMergedJsonSnapshot();
    return true;
  }
  return false;
}

/**
 * User-Dateien nach dem Checkout wiederherstellen.
 * tvsources.json: 3-way-Merge (User-Daten + Release-Fixes, siehe lib/tvsources-merge.js).
 * services.json / history.json: Overwrite wie bisher.
 */
function restoreUserFiles(onWarning) {
  const backupTvsourcesPath = path.join(backupDir, 'tvsources.json');
  const deviceTvsourcesPath = path.join(appDir, 'tvsources.json');

  const warn = [];
  let tvsourcesMerged = false;

  if (fs.existsSync(backupTvsourcesPath) && fs.existsSync(deviceTvsourcesPath)) {
    try {
      const base = readCommittedTvsources();
      const oldDevice = JSON.parse(fs.readFileSync(backupTvsourcesPath, 'utf-8'));
      const neuCommitted = JSON.parse(fs.readFileSync(deviceTvsourcesPath, 'utf-8'));

      const result = mergeTvsources(base, oldDevice, neuCommitted, {
        warn: msg => warn.push(msg),
      });

      if (result.ok) {
        writeMergedTvsources(result.value);
        tvsourcesMerged = true;
      } else {
        // Struktur-Konflikt: alte Geräte-Datei unverändert wiederherstellen (kein Datenverlust).
        fs.copyFileSync(backupTvsourcesPath, deviceTvsourcesPath);
        tvsourcesMerged = true;
        warn.push(`tvsources.json: Merge nicht möglich (${result.reason}) – Geräte-Stand beibehalten`);
      }
    } catch (e) {
      // Merge fehlgeschlagen (z. B. kaputtes JSON) → Geräte-Stand behalten, Update läuft weiter.
      logger.error('tvsources.json 3-way-Merge fehlgeschlagen:', e.message);
      try {
        fs.copyFileSync(backupTvsourcesPath, deviceTvsourcesPath);
        tvsourcesMerged = true;
      } catch (e2) {
        logger.error('tvsources.json Geräte-Stand konnte nicht wiederhergestellt werden:', e2.message);
      }
      warn.push('tvsources.json: automatischer Merge fehlgeschlagen – Geräte-Stand beibehalten');
    }
  }

  for (const f of userFiles) {
    const backup = path.join(backupDir, f);
    const dest = path.join(appDir, f);
    if (fs.existsSync(backup)) {
      if (f === mergeFile && tvsourcesMerged) continue; // bereits gemerged geschrieben
      try {
        fs.copyFileSync(backup, dest);
      } catch (e) {
        logger.error('Restore fehlgeschlagen:', e.message);
      }
    }
  }

  // Hinweis: Backup-Verzeichnis wird erst am Ende von 'apply' aufgeräumt,
  // damit der Konflikt-Marker-Snapshot den stash pop überlebt.
  if (onWarning) onWarning(warn);
}

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

function getCurrentVersion() {
  try {
    const raw = git('describe --tags --abbrev=0', 10000).trim();
    return raw.replace(/^v/i, '');
  } catch (e) {
    return null;
  }
}

process.on('message', msg => {
  if (msg.type === 'check') {
    try {
      const currentVersion = getCurrentVersion() || msg.currentVersion;
      const out = git('ls-remote --tags origin', 15000);
      const tags = new Set();
      for (const line of out.split('\n')) {
        const m = line.match(/refs\/tags\/v?(\d+\.\d+\.\d+)/);
        if (m) tags.add(m[1]);
      }
      const sorted = [...tags].sort(cmpVersions);
      const latest = sorted[sorted.length - 1] || null;
      process.send({
        type: 'result',
        latest,
        hasUpdate: latest ? cmpVersions(latest, currentVersion) > 0 : false,
      });
    } catch (e) {
      process.send({ type: 'result', error: e.message });
    }
  } else if (msg.type === 'apply') {
    try {
      // Defense-in-Depth: Version strikt validieren, bevor sie in
      // Shell-Befehle interpoliert wird (kommt via IPC vom Renderer).
      if (!/^\d+\.\d+\.\d+$/.test(String(msg.version || ''))) {
        throw new Error('ungültige Versionsnummer: ' + msg.version);
      }

      process.send({ type: 'progress', step: 'Aktualisierungen abrufen…', percent: 5 });
      git('fetch --tags --force origin', 60000);

      // User-Daten sichern (services.json, tvsources.json, history.json)
      backupUserFiles();

      process.send({ type: 'progress', step: `Version v${msg.version} wird angewendet…`, percent: 30 });

      // Nur stashen, wenn es tatsächlich lokale Änderungen gibt
      let stashed = false;
      try {
        const status = git('status --porcelain', 5000);
        if (status.trim()) {
          git('stash push --include-untracked -m "streaming-hub-update"', 15000);
          stashed = true;
        }
      } catch (e) {
        /* stash error – continue */
      }

      git(`checkout --force v${msg.version}`, 30000);

      // User-Daten nach dem Checkout wiederherstellen:
      //  - tvsources.json: 3-way-Merge (User-Favoriten/Overrides + Release-Fixes)
      //  - services.json/history.json: Overwrite wie bisher
      //  - Merge-Warnungen (z. B. Struktur-Konflikt) erscheinen als eigener Progress-Step
      restoreUserFiles(warnings => {
        for (const w of warnings) {
          process.send({
            type: 'progress',
            step: `⚠ ${w}`,
            percent: 50,
          });
        }
      });

      // Gemergten JSON-Stand sichern, bevor der zeilenbasierte stash pop laufen kann
      snapshotMergedJson();

      // Stash anwenden (falls vorhanden und nicht durch restore überschrieben)
      if (stashed) {
        try {
          git('stash pop', 15000);
        } catch (e) {
          // Konflikte möglich – Stash bleibt erhalten, User kann manuell lösen
          process.send({
            type: 'progress',
            step: '⚠ Lokale Änderungen konnten nicht automatisch übernommen werden (Konflikte). Stash bleibt erhalten: git stash pop',
            percent: 50,
          });
        }
      }

      // stash pop kann zeilenbasierte Konflikt-Marker in die JSON-Dateien schreiben →
      // gemergten Stand wiederherstellen (nur falls Marker vorhanden sind)
      if (repairConflictMarkersIfAny()) {
        process.send({
          type: 'progress',
          step: '⚠ Konflikt-Marker durch lokale Änderungen erkannt – gemergte Dateien wiederhergestellt',
          percent: 50,
        });
      }

      // Aufgeräumt wird erst jetzt: Backup + Snapshot haben ihren Zweck erfüllt
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch (e) {}

      process.send({ type: 'progress', step: 'Abhängigkeiten werden installiert…', percent: 65 });
      execSync('npm install --ignore-scripts', {
        cwd: appDir,
        encoding: 'utf-8',
        timeout: 180000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      process.send({ type: 'progress', step: 'Fertig – Neustart…', percent: 100 });
      process.send({ type: 'applied' });
    } catch (e) {
      process.send({ type: 'applied', error: e.message });
    }
  }
});
