// v0.5.12 – Build-Tools (npm/node) startkontext-unabhängig finden
//
// Neu in v0.5.12: Bei GUI-Start (Finder/Launchpad) hat der Prozess unter macOS
// nur den System-Mini-PATH — npm/node lagen außerhalb und jedes In-App-Update
// brach mit "npm: command not found" ab (S-Klasse-Fix, Karte t_9f74c461).
// ensureBuildTools() löst npm/node jetzt über lib/node-path.js (Kandidaten-
// verzeichnisse + Login-Shell-PATH + STREAMING_HUB_NODE_DIR-Override) und
// setzt den konkreten Pfad in die PATH-Option aller runSync-Aufrufe. Der
// frühe darwin-only PATH-Ausgleich hier entfällt zugunsten dieser Auflösung.
//
// Neu in v0.4.83: restoreUserFiles() überschrieb tvsources.json nach dem Checkout
// mit dem alten Geräte-Stand → im Release enthaltene channelOverrides (z. B. MDR
// Thüringen und weitere ARD-URL-Fixes) wurden stillschweigend zurückgerollt.
// Jetzt wird tvsources.json zwischen Geräte-Stand, letztem committeten Stand und
// neuem Tag gemerged (User-Favoriten/Sortierungen/eigene Overrides bleiben,
// Release-Fixes kommen durch). services.json/history.json: Verhalten unverändert
// (Overwrite — dort überschreibt der Geräte-Stand bewusst den committed Stand).
const logger = require('./logger.js');
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { mergeTvsources } = require('./lib/tvsources-merge.js');
const os = require('os');
const { fetchReleaseCandidates, compareVersions: cmpVersions } = require('./lib/github-releases.js');

const updaterLogPath = process.env.STREAMING_HUB_UPDATER_LOG;
function updaterLog(level, message, details) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${details ? ` ${details}` : ''}\n`;
  if (updaterLogPath) {
    try { fs.mkdirSync(path.dirname(updaterLogPath), { recursive: true }); fs.appendFileSync(updaterLogPath, line); } catch (_) {}
  }
  if (level === 'ERROR') console.error(line.trim()); else console.log(line.trim());
}
function runSync(command, options) {
  updaterLog('INFO', `exec: ${command}`);
  try {
    const output = execSync(command, options);
    if (output) updaterLog('STDOUT', String(output));
    return output;
  } catch (error) {
    if (error.stdout) updaterLog('STDOUT', String(error.stdout));
    if (error.stderr) updaterLog('STDERR', String(error.stderr));
    updaterLog('ERROR', `exec fehlgeschlagen: ${command}`, error.message);
    throw error;
  }
}

const appDir = process.argv[2] || process.cwd();

// User-Dateien, die vor dem Checkout gesichert werden müssen
const userFiles = ['services.json', 'tvsources.json', 'history.json'];
// Datei, die nach dem Checkout per 3-way-Merge mit dem neuen Tag zusammengeführt wird
const mergeFile = 'tvsources.json';
const backupDir = path.join(appDir, '.update-backup');

function git(args, timeout) {
  const argv = Array.isArray(args)
    ? args
    : args.match(/"[^"]*"|'[^']*'|\S+/g).map(value => value.replace(/^['"]|['"]$/g, ''));
  updaterLog('INFO', `git: ${argv.join(' ')}`);
  try {
    const output = execFileSync('git', argv, {
      cwd: appDir,
      encoding: 'utf-8',
      timeout: timeout || 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (output) updaterLog('STDOUT', output);
    return output;
  } catch (error) {
    if (error.stdout) updaterLog('STDOUT', String(error.stdout));
    if (error.stderr) updaterLog('STDERR', String(error.stderr));
    updaterLog('ERROR', 'git fehlgeschlagen', error.message);
    throw error;
  }
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

const MAX_UPDATE_BYTES = 512 * 1024 * 1024;

async function downloadAsset(url, destination) {
  const response = await fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'Streaming-Hub' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok || !response.body) throw new Error(`Release-Asset Download ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_UPDATE_BYTES) throw new Error('Release-Asset ist zu groß');
  const file = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_UPDATE_BYTES) throw new Error('Release-Asset ist zu groß');
      if (!file.write(value)) await new Promise((resolve, reject) => { file.once('drain', resolve); file.once('error', reject); });
    }
    await new Promise((resolve, reject) => { file.once('finish', resolve); file.once('error', reject); file.end(); });
    if (declared && received !== declared) throw new Error('Unvollständiger Release-Asset-Download');
  } catch (error) {
    file.destroy();
    throw error;
  }
}

function findAppBundle(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) return candidate;
    if (entry.isDirectory()) {
      const nested = findAppBundle(candidate);
      if (nested) return nested;
    }
  }
  return null;
}

function installMacBundle(bundle, supportDir) {
  const applications = path.join(os.homedir(), 'Applications');
  const wrapper = path.join(applications, 'Streaming Hub.app');
  fs.mkdirSync(applications, { recursive: true });
  fs.rmSync(wrapper, { recursive: true, force: true });
  fs.cpSync(bundle, wrapper, { recursive: true });
  const resources = path.join(wrapper, 'Contents', 'Resources');
  const appLink = path.join(resources, 'app');
  fs.mkdirSync(resources, { recursive: true });
  fs.rmSync(appLink, { recursive: true, force: true });
  fs.symlinkSync(supportDir, appLink, 'dir');
  updaterLog('INFO', `Release-App installiert: ${wrapper}; Resources/app -> ${supportDir}`);
}

process.on('message', async msg => {
  if (msg.type === 'check') {
    try {
      const candidates = await fetchReleaseCandidates();
      const latest = candidates[candidates.length - 1] || null;
      const currentVersion = String(msg.currentVersion || '');
      process.send({ type: 'result', latest: latest?.version || null, hasUpdate: !!latest && cmpVersions(latest.version, currentVersion) > 0 });
    } catch (e) {
      process.send({ type: 'result', error: e.message });
    }
  } else if (msg.type === 'apply') {
    updaterLog('INFO', `Release-Apply gestartet: v${msg.version}`);
    let zipPath;
    let extractDir;
    try {
      if (!/^\d+\.\d+\.\d+$/.test(String(msg.version || ''))) throw new Error('ungültige Versionsnummer: ' + msg.version);
      const candidates = await fetchReleaseCandidates();
      const release = candidates.find(candidate => candidate.version === msg.version);
      if (!release) throw new Error(`Kein gültiger GitHub-Release für v${msg.version} gefunden`);
      backupUserFiles();
      process.send({ type: 'progress', step: 'Release-Asset wird heruntergeladen…', percent: 15 });
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-update-'));
      zipPath = path.join(tempRoot, release.asset.name);
      extractDir = path.join(tempRoot, 'extract');
      fs.mkdirSync(extractDir);
      await downloadAsset(release.asset.browserDownloadUrl, zipPath);
      process.send({ type: 'progress', step: 'Release-App wird installiert…', percent: 70 });
      runSync(`unzip -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(extractDir)}`, { timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'] });
      const bundle = findAppBundle(extractDir);
      if (!bundle) throw new Error('Release-Asset enthält keine macOS-App (.app)');
      installMacBundle(bundle, appDir);
      restoreUserFiles();
      fs.rmSync(backupDir, { recursive: true, force: true });
      process.send({ type: 'progress', step: 'Fertig – Neustart…', percent: 100 });
      process.send({ type: 'applied' });
    } catch (e) {
      updaterLog('ERROR', 'Release-Apply fehlgeschlagen', e.stack || e.message);
      process.send({ type: 'applied', error: e.message });
    } finally {
      if (zipPath) fs.rmSync(path.dirname(zipPath), { recursive: true, force: true });
    }
  }
});
