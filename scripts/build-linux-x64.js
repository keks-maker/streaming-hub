'use strict';
/**
 * Baut das Linux-(x64-)Release von Streaming Hub (Cross-Build, auch auf macOS moeglich).
 *
 *   npm run build:linux            Bauen, Paketinhalt pruefen, tar.gz nach release/upload/ legen
 *   npm run build:linux -- --dir   nur entpacktes Verzeichnis (kein Archiv, kein Upload-Artefakt)
 *
 * Format: entpacktes App-Verzeichnis (asar:false wie auf macOS) als tar.gz, nur linux-x64. Das Archiv
 * enthaelt genau ein Top-Level-Verzeichnis (Programm `streaming-hub`, chrome-sandbox, resources/app/ ...).
 * Voraussetzungen: gh (Download des castlabs-Electron linux-x64), gebautes Renderer-Bundle (npm run build:all).
 * EVS/VMP-Signierung entfaellt: castlabs verlangt sie nur fuer macOS und Windows, die Widevine-CDM
 * wird unter Linux ohne VMP-Signatur geladen (scripts/evs-afterPack.js ueberspringt Linux).
 * Ausgabe liegt in release-linux/; das Upload-Asset heisst nach lib/github-releases.js
 * Streaming.Hub-X.Y.Z-linux-x64.tar.gz.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ASSET_NAME } = require('../lib/github-releases.js');

const root = path.join(__dirname, '..');
const output = 'release-linux';
const dirOnly = process.argv.includes('--dir');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

function ensureElectronDist(electronVersion) {
  if (process.env.CASTLABS_ELECTRON_DIST) return process.env.CASTLABS_ELECTRON_DIST;
  const tag = `v${electronVersion}`;
  const dist = path.join(os.homedir(), '.cache', 'streaming-hub', 'electron', `${tag}-linux-x64`);
  if (fs.existsSync(path.join(dist, 'electron'))) return dist;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castlabs-electron-linux-'));
  try {
    const zip = `electron-${tag}-linux-x64.zip`;
    console.log(`[linux] Lade ${zip} von castlabs/electron-releases ...`);
    run('gh', ['release', 'download', tag, '-R', 'castlabs/electron-releases', '-p', zip, '-D', tmp]);
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    // unzip/ditto erhalten Modus-Bits und Symlinks; ditto nur auf macOS vorhanden.
    if (process.platform === 'darwin') run('ditto', ['-x', '-k', path.join(tmp, zip), dist]);
    else run('unzip', ['-q', path.join(tmp, zip), '-d', dist]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(dist, 'electron'))) throw new Error(`electron-Programm fehlt in ${dist}`);
  return dist;
}

// Prueft das entpackte Verzeichnis (linux-unpacked) auf ein startfaehiges, vollstaendiges Layout.
function verifyUnpacked(unpacked) {
  const exe = path.join(unpacked, 'streaming-hub');
  if (!fs.existsSync(exe)) throw new Error('Programm streaming-hub fehlt');
  if ((fs.statSync(exe).mode & 0o111) === 0) throw new Error('streaming-hub ist nicht ausfuehrbar');
  const head = Buffer.alloc(20);
  const fd = fs.openSync(exe, 'r');
  fs.readSync(fd, head, 0, 20, 0);
  fs.closeSync(fd);
  // ELF-Magic, 64 Bit, little endian, e_machine = 0x3E (x86-64)
  if (head.toString('latin1', 1, 4) !== 'ELF' || head[4] !== 2 || head.readUInt16LE(18) !== 0x3e) {
    throw new Error('streaming-hub ist kein x86-64-ELF-Programm');
  }
  for (const rel of ['chrome-sandbox', 'resources/app/main.js', 'resources/app/package.json', 'resources/app/updater.js', 'libffmpeg.so', 'resources/app/lib/update-mode.js']) {
    if (!fs.existsSync(path.join(unpacked, rel))) throw new Error(`${rel} fehlt im Paket`);
  }
  for (const rel of ['resources/app/bin/ffmpeg', 'resources/app/bin/ffprobe', 'resources/app/release-linux', 'resources/app/release-x64', 'resources/app/release']) {
    if (fs.existsSync(path.join(unpacked, rel))) throw new Error(`${rel} darf nicht im Linux-Paket liegen`);
  }
}

function main() {
  const version = require('../package.json').version;
  const electronVersion = require('electron/package.json').version;
  const dist = ensureElectronDist(electronVersion);
  const args = ['electron-builder', '--linux', dirOnly ? 'dir' : 'tar.gz', '--x64', `-c.directories.output=${output}`, `-c.electronDist=${dist}`];
  fs.rmSync(path.join(root, output), { recursive: true, force: true });
  run('npx', args);

  const unpacked = path.join(root, output, 'linux-unpacked');
  verifyUnpacked(unpacked);
  console.log('[linux] Paketlayout geprueft (ELF x86-64, chrome-sandbox, resources/app, kein macOS-ffmpeg)');
  if (dirOnly) { console.log(`[linux] --dir: App unter ${unpacked}`); return; }

  const built = fs.readdirSync(path.join(root, output)).filter(name => name.endsWith('.tar.gz'));
  if (built.length !== 1) throw new Error(`Genau ein tar.gz erwartet, gefunden: ${built.join(', ') || 'keins'}`);
  const uploadDir = path.join(root, 'release', 'upload');
  fs.mkdirSync(uploadDir, { recursive: true });
  const target = path.join(uploadDir, ASSET_NAME(version, 'linux-x64'));
  fs.copyFileSync(path.join(root, output, built[0]), target);
  console.log(`[linux] Upload-Asset: ${target} (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`);
}

try { main(); } catch (error) { console.error(`[linux] FEHLER: ${error.message}`); process.exit(1); }
