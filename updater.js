// v0.4.21 – Versionsvalidierung + appDir-Fallback
const logger = require('./logger.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appDir = process.argv[2] || process.cwd();

// User-Dateien, die vor dem Checkout gesichert werden müssen
const userFiles = ['services.json', 'tvsources.json', 'history.json'];
const backupDir = path.join(appDir, '.update-backup');

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

function restoreUserFiles() {
  for (const f of userFiles) {
    const backup = path.join(backupDir, f);
    const dest = path.join(appDir, f);
    if (fs.existsSync(backup)) {
      try {
        fs.copyFileSync(backup, dest);
      } catch (e) {
        logger.error('Restore fehlgeschlagen:', e.message);
      }
    }
  }
  // Backup-Verzeichnis aufräumen
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (e) {}
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
    const raw = execSync('git describe --tags --abbrev=0', {
      cwd: appDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return raw.replace(/^v/i, '');
  } catch (e) {
    return null;
  }
}

process.on('message', msg => {
  if (msg.type === 'check') {
    try {
      const currentVersion = getCurrentVersion() || msg.currentVersion;
      const out = execSync('git ls-remote --tags origin', {
        cwd: appDir,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
      execSync('git fetch --tags --force origin', {
        cwd: appDir,
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // User-Daten sichern (services.json, tvsources.json, history.json)
      backupUserFiles();

      process.send({ type: 'progress', step: `Version v${msg.version} wird angewendet…`, percent: 30 });

      // Nur stashen, wenn es tatsächlich lokale Änderungen gibt
      let stashed = false;
      try {
        const status = execSync('git status --porcelain', {
          cwd: appDir,
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (status.trim()) {
          execSync('git stash push --include-untracked -m "streaming-hub-update"', {
            cwd: appDir,
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          stashed = true;
        }
      } catch (e) {
        /* stash error – continue */
      }

      execSync(`git checkout --force v${msg.version}`, {
        cwd: appDir,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // User-Daten nach dem Checkout wiederherstellen (überschreibt ggf. neuere committed Versionen mit User-Daten)
      restoreUserFiles();

      // Stash anwenden (falls vorhanden und nicht durch restore überschrieben)
      if (stashed) {
        try {
          execSync('git stash pop', {
            cwd: appDir,
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (e) {
          // Konflikte möglich – Stash bleibt erhalten, User kann manuell lösen
          process.send({
            type: 'progress',
            step: '⚠ Lokale Änderungen konnten nicht automatisch übernommen werden (Konflikte). Stash bleibt erhalten: git stash pop',
            percent: 50,
          });
        }
      }

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
