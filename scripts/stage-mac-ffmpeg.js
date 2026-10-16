'use strict';

// Legt die zur Ziel-Architektur passenden ffmpeg/ffprobe-Binaries ins macOS-Paket.
// Das git-ignorierte Entwickler-bin/ enthält nur die Binaries EINER Architektur
// (nach dem Dev-Start die des Hosts); `files: **/*` würde sie in jedes Paket
// kopieren — der arm64-Build bekäme sonst x86_64 (Rosetta, ab macOS 28 weg).
// Darum lädt/prüft dieser Schritt je Ziel-Arch aus einem eigenen Cache
// (~/.cache/streaming-hub/ffmpeg/<arch>/bin, gepinnt über lib/ffmpeg.js) und
// ersetzt die Dateien im gepackten bin/ (Updater-Layout unverändert:
// ffmpeg, ffprobe, .ffmpeg-release, .ffmpeg-sha256.json).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureBinaries, machoArchs } = require('../lib/ffmpeg.js');

const FILES = ['ffmpeg', 'ffprobe', '.ffmpeg-release', '.ffmpeg-sha256.json'];

async function stageMacFfmpeg(appDir, arch, cacheBase) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Unbekannte Architektur: ${arch}`);
  const cacheRoot = path.join(cacheBase || path.join(os.homedir(), '.cache', 'streaming-hub', 'ffmpeg'), arch);
  fs.mkdirSync(path.join(cacheRoot, 'bin'), { recursive: true });
  const result = await ensureBinaries(cacheRoot, { arch });
  if (!result.ok) throw new Error(`ffmpeg (${arch}) nicht bereitstellbar: ${result.error}`);
  const dest = path.join(appDir, 'bin');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of FILES) fs.rmSync(path.join(dest, name), { force: true });
  for (const name of FILES) {
    const src = path.join(cacheRoot, 'bin', name);
    if (!fs.existsSync(src)) throw new Error(`${name} fehlt im ffmpeg-Cache (${arch})`);
    fs.copyFileSync(src, path.join(dest, name));
  }
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const archs = machoArchs(path.join(dest, tool));
    if (!archs || !archs.includes(arch)) {
      throw new Error(`${tool} im Paket hat nicht die Architektur ${arch}: ${archs ? archs.join(',') : 'kein Mach-O'}`);
    }
  }
  return dest;
}

module.exports = { stageMacFfmpeg };
