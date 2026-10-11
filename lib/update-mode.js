'use strict';

const path = require('path');

// Welcher Update-Pfad ist auf dieser Plattform überhaupt möglich?
// - 'mac-release': macOS → GitHub-Release-ZIP mit .app (updater.js)
// - 'linux-release': Linux x64, Installation aus dem Release-tar.gz (entpacktes App-Verzeichnis,
//   Code liegt unter <Installation>/resources/app) → GitHub-Release tar.gz (updater.js)
// - 'unsupported': alles andere (z. B. Linux aus dem Quellcode/Git-Install, Windows) —
//   der Release-Updater würde dort erst nach dem Download scheitern.

// Release-Installation unter Linux: der App-Code liegt in <root>/resources/app (electron-builder, asar:false).
// Aus dem Git-Checkout (electron .) ist appDir das Repo-Verzeichnis und passt nicht.
function isLinuxReleaseLayout(appDir) {
  if (typeof appDir !== 'string' || !appDir) return false;
  const resources = path.dirname(appDir);
  return path.basename(appDir) === 'app' && path.basename(resources) === 'resources';
}

function updateMode(platform = process.platform, appDir = path.join(__dirname, '..'), arch = process.arch) {
  if (platform === 'darwin') return 'mac-release';
  if (platform === 'linux' && arch === 'x64' && isLinuxReleaseLayout(appDir)) return 'linux-release';
  return 'unsupported';
}

module.exports = { updateMode, isLinuxReleaseLayout };
