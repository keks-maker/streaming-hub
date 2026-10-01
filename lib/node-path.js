// v0.5.12 – Build-Tool-Auflösung für den In-App-Updater (S-Klasse-Fix, Karte t_9f74c461)
//
// Problem: updater.js startet bei GUI-Start (Finder/Launchpad) unter macOS mit
// dem System-Mini-PATH (/usr/bin:/bin:/usr/sbin:/sbin). npm liegt dort aber
// typischerweise außerhalb (User-Install unter ~/Developer/tools/node/bin,
// nvm, volta, asdf, Homebrew) → `npm --version` scheitert mit
// "/bin/sh: npm: command not found" und das In-App-Update bricht ab.
//
// Lösung: Vor jedem npm-Aufruf werden Kandidatenverzeichnisse und Login-Shell-
// PATHs (zsh -lc / bash -lc) abgesucht; der erste Fund wird als absoluter Pfad
// verwendet und das gefundene bin-Verzeichnis in die PATH-Option der
// runSync-Aufrufe gehängt. Der Mechanismus ist per Env überschreibbar:
//   STREAMING_HUB_NODE_DIR – Verzeichnis, in dem node/npm liegen (höchste
//                            Priorität, für exotische Setups)
//   STREAMING_HUB_NO_PATH_FIX=1 – Auflösung abschalten (Tests/Support)
//
// Bewusst KEINE Login-Shell als Ausführumgebung für npm selbst: Login-RCs
// (nvm lazy-load, fnm-Env) sind Seiteneffekt-lastig und machen npm-Aufrufe
// nicht-deterministisch. Wir lösen nur PFADE auf, die Ausführung bleibt
// /bin/sh mit explizitem PATH.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESOLVE_TIMEOUT_MS = 5000;
const TOOLS = ['npm', 'node'];

function uniqueDirs(dirs) {
  const seen = new Set();
  return dirs.filter(dir => {
    if (!dir || !path.isAbsolute(dir) || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

function compareVersionsDesc(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** nvm-Installationen: default-Alias zuerst, danach neuere Versionen. */
function nvmVersionDirs(home) {
  const nvmDir = String(process.env.NVM_DIR || path.join(home, '.nvm')).trim();
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  if (!fs.existsSync(versionsDir)) return [];
  const dirs = [];
  try {
    const alias = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf-8').trim();
    if (alias) dirs.push(path.join(versionsDir, alias, 'bin'));
  } catch (_) {
    // kein default-Alias → nur Versionssortierung
  }
  for (const entry of fs.readdirSync(versionsDir).sort(compareVersionsDesc)) {
    dirs.push(path.join(versionsDir, entry, 'bin'));
  }
  return dirs;
}

/** Verzeichnis-Kandidaten in Prioritätsreihenfolge (plattformübergreifend). */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [];

  // Env-Override hat absolute Priorität (für exotische Setups).
  const override = String(process.env.STREAMING_HUB_NODE_DIR || '').trim();
  if (override) dirs.push(override);

  if (process.platform === 'darwin') {
    dirs.push(
      path.join(home, 'Developer', 'tools', 'node', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.asdf', 'shims'),
    );
    dirs.push(...nvmVersionDirs(home));
  } else if (process.platform === 'win32') {
    dirs.push(path.join(home, 'AppData', 'Roaming', 'npm'), 'C:\\Program Files\\nodejs');
  } else {
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/snap/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
    );
    dirs.push(...nvmVersionDirs(home));
  }

  return uniqueDirs(dirs);
}

/** Prüft, ob dir/name existiert, eine ausführbare Datei ist und zurückgibt. */
function findExecutableFile(dir, name) {
  if (!dir) return null;
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const candidate = path.join(dir, fileName);
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    if (!fs.statSync(candidate).isFile()) return null;
    return candidate;
  } catch (_) {
    return null;
  }
}

let loginShellEntriesCache = null;

/**
 * PATH einer Login-Shell auflösen (zsh -lc / bash -lc): erfasst setup-lastige
 * Systeme (nvm lazy-load in .zshrc, fnm, brew shellenv), die keine festen
 * Verzeichnis-Kandidaten haben. Wird pro Prozess nur einmal aufgerufen.
 */
function loginShellPathEntries() {
  if (loginShellEntriesCache) return loginShellEntriesCache;
  const loginFlag = '-lc';
  const shells =
    process.platform === 'darwin'
      ? ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash']
      : ['/bin/bash', '/usr/bin/bash'];
  for (const shellPath of shells) {
    if (!fs.existsSync(shellPath)) continue;
    try {
      const out = execFileSync(shellPath, [loginFlag, 'printf %s "$PATH"'], {
        timeout: RESOLVE_TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const entries = String(out)
        .split(path.delimiter)
        .map(entry => entry.trim())
        .filter(Boolean);
      if (entries.length) {
        loginShellEntriesCache = entries;
        return entries;
      }
    } catch (_) {
      // Timeout/Fehler → nächste Shell probieren
    }
  }
  loginShellEntriesCache = [];
  return loginShellEntriesCache;
}

/**
 * Findet npm (und node) unabhängig vom Startkontext.
 * Rückgabe: { npm, node } mit absoluten Pfaden — oder null, wenn npm nicht
 * auffindbar ist (Aufrufer entscheidet über Fehlermeldung/Abbruch).
 */
function findNpmTool() {
  if (String(process.env.STREAMING_HUB_NO_PATH_FIX || '').trim() === '1') return null;

  const tools = {};
  for (const tool of TOOLS) {
    for (const dir of candidateDirs()) {
      const found = findExecutableFile(dir, tool);
      if (found) {
        tools[tool] = found;
        break;
      }
    }
  }

  if (!tools.npm || !tools.node) {
    const shellEntries = loginShellPathEntries();
    for (const tool of TOOLS) {
      if (tools[tool]) continue;
      for (const dir of shellEntries) {
        const found = findExecutableFile(dir, tool);
        if (found) {
          tools[tool] = found;
          break;
        }
      }
    }
  }

  // Letzter Ausweg für node: neben der laufenden Runtime suchen (Electron/
  // ELECTRON_RUN_AS_NODE-Bundle) — npm liegt dort erfahrungsgemäß nicht, aber
  // der Fallback kostet nichts und rettet den Fall "nur node gefunden".
  if (!tools.node) tools.node = findExecutableFile(path.dirname(process.execPath), 'node');

  if (!tools.npm) return null;
  return tools;
}

/**
 * Erzeugt das Environment für runSync/exec-Aufrufe: das gefundene
 * bin-Verzeichnis wird an den Anfang des PATH gehängt (dedupliziert).
 */
function buildToolEnv(baseEnv) {
  const env = { ...baseEnv };
  const tools = findNpmTool();
  if (!tools) return env;
  const parts = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  const binDirs = [...new Set(TOOLS.map(tool => (tools[tool] ? path.dirname(tools[tool]) : null)).filter(Boolean))];
  for (const binDir of binDirs) {
    if (!seen.has(binDir)) {
      parts.unshift(binDir);
      seen.add(binDir);
    }
  }
  env.PATH = parts.join(path.delimiter);
  return env;
}

/** Verständliche Fehlermeldung mit Handlungsanweisung für den Update-Dialog. */
function describeToolProblem(problem) {
  const hint = [
    'npm wurde auf diesem System nicht gefunden. Das In-App-Update benötigt Node.js/npm, um Abhängigkeiten zu installieren und die App zu bauen.',
    '',
    'Behebung (eine Option genügt):',
    '1. Node.js installieren – z. B. mit dem Install-Skript des Streaming-Hub (install.sh) oder von https://nodejs.org',
    '2. Liegt npm an einem besonderen Ort, die Umgebungsvariable STREAMING_HUB_NODE_DIR auf das bin-Verzeichnis setzen (z. B. ~/Developer/tools/node/bin)',
  ].join('\n');
  return problem ? `${problem}\n\n${hint}` : hint;
}

module.exports = { candidateDirs, findNpmTool, loginShellPathEntries, buildToolEnv, describeToolProblem };
