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
const { ensureBinaries } = require('./lib/ffmpeg.js');
const { buildToolEnv, findNpmTool, describeToolProblem } = require('./lib/node-path.js');

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

/**
 * Build-Tools (npm/node) vor dem Apply auflösen — startkontext-unabhängig
 * (GUI-Start hat unter macOS nur den System-Mini-PATH). Bei Erfolg liegt in
 * toolEnv ein Environment mit dem konkreten bin-Verzeichnis am Anfang des
 * PATH; bei Misserfolg eine verständliche Fehlermeldung mit Handlungsanweisung.
 */
let toolEnv = null;

function ensureBuildTools() {
  const tools = findNpmTool();
  if (!tools) {
    const message = describeToolProblem(
      'Das In-App-Update kann nicht starten: Build-Werkzeuge (npm/node) wurden nicht gefunden.',
    );
    updaterLog('ERROR', 'ensureBuildTools: npm/node nicht gefunden');
    throw new Error(message);
  }
  updaterLog('INFO', `Build-Tools gefunden: npm=${tools.npm} node=${tools.node || '—'}`);
  toolEnv = buildToolEnv(process.env);
  return tools;
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

process.on('message', async msg => {
  if (msg.type === 'check') {
    try {
      // Maßgeblich ist die LAUFENDE App-Version (app.getVersion via main.js),
      // nicht der Checkout-Stand: Wurde der Checkout extern aktualisiert
      // (install.sh), während eine ältere Instanz läuft, darf die UI das
      // Update trotzdem anbieten — der Apply bringt Checkout + Build auf den
      // Zielstand und startet neu. Sonst zeigte die App für immer "v0.5.10"
      // an, obwohl der Checkout längst auf dem neuen Tag war.
      const currentVersion = msg.currentVersion;
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
    updaterLog('INFO', `Apply gestartet: v${msg.version}`);
    try {
      // Defense-in-Depth: Version strikt validieren, bevor sie in
      // Shell-Befehle interpoliert wird (kommt via IPC vom Renderer).
      if (!/^\d+\.\d+\.\d+$/.test(String(msg.version || ''))) {
        throw new Error('ungültige Versionsnummer: ' + msg.version);
      }

      process.send({ type: 'progress', step: 'Build-Werkzeuge prüfen…', percent: 2 });
      ensureBuildTools();
      runSync('npm --version', {
        cwd: appDir,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: toolEnv,
      });

      process.send({ type: 'progress', step: 'Aktualisierungen abrufen…', percent: 5 });
      git('fetch --tags --force origin', 60000);

      // Tag-Nachzieh-Absicherung (User-Befund 01.10.): Liegt der Ziel-Tag nach
      // dem Fetch immer noch nicht lokal vor (partieller Fetch, abweichende
      // Refspecs), gezielt nachziehen — der Checkout würde sonst ins Leere
      // laufen und die Versionsanzeige könnte auf ein altes Tag fallen.
      try {
        git(['rev-parse', '--verify', '--quiet', `v${msg.version}^{commit}`], 5000);
      } catch (_) {
        updaterLog('INFO', `Tag v${msg.version} lokal nicht gefunden — fetch --tags wird wiederholt`);
        git('fetch origin --tags --force', 60000);
      }

      // User-Daten sichern (services.json, tvsources.json, history.json)
      backupUserFiles();

      process.send({ type: 'progress', step: `Version v${msg.version} wird angewendet…`, percent: 30 });

      // Dirty-Tree-Inhalte werden bewusst durch checkout --force ersetzt.
      // User-Dateien wurden zuvor separat gesichert und danach wiederhergestellt.

      git(['checkout', '--force', `v${msg.version}`], 30000);

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

      // Kein stash/pop: lokale Codeänderungen dürfen den Apply nicht blockieren.
      // checkout --force hat den Zielstand bereits deterministisch hergestellt.

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
      runSync('npm install --include=dev --ignore-scripts', {
        cwd: appDir,
        encoding: 'utf-8',
        timeout: 180000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: toolEnv,
      });
      process.send({ type: 'progress', step: 'Laufzeitdateien werden gebaut…', percent: 85 });
      runSync('npm run build:all', {
        cwd: appDir,
        encoding: 'utf-8',
        timeout: 180000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: toolEnv,
      });
      const runtimeArtifacts = [
        ['renderer.js', 'dist/renderer.js'],
        ['packages/typed-core/src/index.ts', 'packages/typed-core/dist/index.js'],
      ];
      runtimeArtifacts.forEach(([source, output]) => {
        const sourcePath = path.join(appDir, source);
        const outputPath = path.join(appDir, output);
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).mtimeMs < fs.statSync(sourcePath).mtimeMs) {
          throw new Error(`Laufzeit-Build-Artefakt fehlt oder ist veraltet: ${output}`);
        }
      });

      // ffmpeg/ffprobe (Konzept §2.2): Nach jedem Update verifizieren — Binary
      // vorhanden + ausführbar + `ffmpeg -version` liefert Output. Läuft hier
      // mit node (ELECTRON_RUN_AS_NODE), ohne App-Start. Fehlende/desynchrone
      // Binaries werden automatisch nachgeladen (Selbstheilung), ein
      // Prüfsummen-/Netzwerkfehler bricht das Update sichtbar ab.
      process.send({ type: 'progress', step: 'ffmpeg/ffprobe werden verifiziert…', percent: 92 });
      const ffmpegResult = await ensureBinaries(appDir);
      if (!ffmpegResult.ok) {
        throw new Error(`ffmpeg/ffprobe nach Update nicht bereit: ${ffmpegResult.error}`);
      }
      updaterLog('INFO', `ffmpeg/ffprobe OK (${ffmpegResult.ffmpeg.action}/${ffmpegResult.ffprobe.action})`);

      process.send({ type: 'progress', step: 'Fertig – Neustart…', percent: 100 });
      process.send({ type: 'applied' });
    } catch (e) {
      updaterLog('ERROR', 'Apply fehlgeschlagen', e.stack || e.message);
      process.send({ type: 'applied', error: e.message });
    }
  }
});
