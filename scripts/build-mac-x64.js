'use strict';
/**
 * Baut das Intel-(x64-)Release von Streaming Hub auf einem Apple-Silicon-Mac (Cross-Build).
 *
 *   npm run build:mac:x64            Bauen, EVS/codesign/Mach-O pruefen, ZIP nach release/upload/ legen
 *   npm run build:mac:x64 -- --dir   nur .app (kein ZIP, kein Upload-Artefakt) – Smoke-Test des Ablaufs
 *
 * Voraussetzungen: EVS-venv (EVS_PYTHON, Default ~/evs-venv/bin/python3), gh (fuer den Download des
 * castlabs-Electron-x64), gebautes Renderer-Bundle (npm run build:all, wie beim arm64-Build).
 * Der arm64-Build (npm run build:mac) bleibt unveraendert. Ausgabe liegt in release-x64/ (NICHT unter
 * release/ verschachteln); das Upload-Asset heisst nach lib/github-releases.js Streaming.Hub-X.Y.Z-mac-x64.zip.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ASSET_NAME } = require('../lib/github-releases.js');

const root = path.join(__dirname, '..');
const dirOnly = process.argv.includes('--dir');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

function ensureElectronDist(electronVersion) {
  if (process.env.CASTLABS_ELECTRON_DIST) return process.env.CASTLABS_ELECTRON_DIST;
  const tag = `v${electronVersion}`;
  const dist = path.join(os.homedir(), '.cache', 'streaming-hub', 'electron', `${tag}-darwin-x64`);
  if (fs.existsSync(path.join(dist, 'Electron.app'))) return dist;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castlabs-electron-x64-'));
  try {
    const zip = `electron-${tag}-darwin-x64.zip`;
    console.log(`[x64] Lade ${zip} von castlabs/electron-releases …`);
    run('gh', ['release', 'download', tag, '-R', 'castlabs/electron-releases', '-p', zip, '-D', tmp]);
    fs.mkdirSync(dist, { recursive: true });
    run('ditto', ['-x', '-k', path.join(tmp, zip), dist]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(dist, 'Electron.app'))) throw new Error(`Electron.app fehlt in ${dist}`);
  return dist;
}

function main() {
  if (process.platform !== 'darwin') throw new Error('build:mac:x64 laeuft nur auf macOS');
  const version = require('../package.json').version;
  const electronVersion = require('electron/package.json').version;
  const output = 'release-x64';
  const py = process.env.EVS_PYTHON || path.join(os.homedir(), 'evs-venv', 'bin', 'python3');
  if (!fs.existsSync(py)) throw new Error(`EVS_PYTHON nicht gefunden: ${py}`);
  const env = { ...process.env, EVS_PYTHON: py };

  const dist = ensureElectronDist(electronVersion);
  const args = ['electron-builder', '--mac', ...(dirOnly ? ['--dir'] : ['zip']), '--x64', `-c.directories.output=${output}`, `-c.electronDist=${dist}`];
  // Ausgabe nicht unter release/ (dort liegen arm64-Artefakte; package.json schliesst beide Ordner aus den App-Dateien aus).
  fs.rmSync(path.join(root, output), { recursive: true, force: true });
  run('npx', args, { env });

  const appOutDir = path.join(root, output, 'mac');
  const app = path.join(appOutDir, 'Streaming Hub.app');
  run(py, ['-m', 'castlabs_evs.vmp', 'verify-pkg', appOutDir], { env });
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const info = execFileSync('file', ['-b', path.join(app, 'Contents', 'MacOS', 'Streaming Hub')], { encoding: 'utf8' });
  if (!/Mach-O/.test(info) || !info.includes('x86_64')) throw new Error(`Hauptprogramm ist kein x86_64-Mach-O: ${info.trim()}`);
  if (fs.existsSync(path.join(app, 'Contents', 'Resources', 'app', output))) throw new Error(`${output}/ ist im App-Paket gelandet`);
  console.log(`[x64] Hauptprogramm: ${info.trim()}`);

  if (dirOnly) { console.log(`[x64] --dir: App unter ${app}`); return; }
  const built = path.join(root, output, `Streaming Hub-${version}-mac.zip`);
  if (!fs.existsSync(built)) throw new Error(`Build-Artefakt fehlt: ${built}`);
  const uploadDir = path.join(root, 'release', 'upload');
  fs.mkdirSync(uploadDir, { recursive: true });
  const target = path.join(uploadDir, ASSET_NAME(version, 'darwin-x64'));
  fs.copyFileSync(built, target);
  console.log(`[x64] Upload-Asset: ${target} (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`);
}

try { main(); } catch (error) { console.error(`[x64] FEHLER: ${error.message}`); process.exit(1); }
