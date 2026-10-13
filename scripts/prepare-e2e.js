#!/usr/bin/env node
'use strict';

// Vorbereitung für E2E-Läufe (pretest:e2e), idempotent und ohne Netz im Normalfall:
// stellt ffmpeg/ffprobe unter <Repo>/bin bereit, damit die App im Test keinen
// "Aufnahme nicht verfügbar"-Dialog zeigt und nichts nachladen muss.
// Reihenfolge: bereits gesund -> Kopie aus dem Haupt-Checkout (Worktrees haben bin/ leer,
// da gitignored) -> einmaliger Download über lib/ffmpeg.js.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkHealth, ensureBinaries } = require('../lib/ffmpeg.js');

const root = path.join(__dirname, '..');

function mainCheckoutRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    return path.dirname(common);
  } catch (_) {
    return null;
  }
}

function copyFromMain() {
  const main = mainCheckoutRoot();
  if (!main || path.resolve(main) === path.resolve(root)) return false;
  if (!checkHealth(main).ok) return false;
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  for (const name of ['ffmpeg', 'ffprobe', '.ffmpeg-release', '.ffmpeg-sha256.json']) {
    const src = path.join(main, 'bin', name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(root, 'bin', name), fs.constants.COPYFILE_FICLONE);
  }
  return checkHealth(root).ok;
}

async function main() {
  if (checkHealth(root).ok) {
    console.log('prepare-e2e: ffmpeg/ffprobe vorhanden.');
    return;
  }
  if (copyFromMain()) {
    console.log('prepare-e2e: ffmpeg/ffprobe aus dem Haupt-Checkout kopiert.');
    return;
  }
  const result = await ensureBinaries(root);
  if (!result.ok || !checkHealth(root).ok) {
    console.error(`prepare-e2e: ffmpeg/ffprobe nicht bereitstellbar: ${result.error || 'defekt'}`);
    process.exit(1);
  }
  console.log('prepare-e2e: ffmpeg/ffprobe heruntergeladen.');
}

main();
