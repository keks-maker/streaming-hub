'use strict';

// Welcher Update-Pfad ist auf dieser Plattform überhaupt möglich?
// - 'appimage': Linux-AppImage (APPIMAGE gesetzt) → AppImage-Asset-Download
// - 'mac-release': macOS → GitHub-Release-ZIP mit .app (updater.js)
// - 'unsupported': alles andere (z. B. Linux/Windows aus dem Quellcode) —
//   der macOS-Updater würde dort erst nach dem Download scheitern.
function updateMode(platform = process.platform, env = process.env) {
  if (env.APPIMAGE) return 'appimage';
  if (platform === 'darwin') return 'mac-release';
  return 'unsupported';
}

module.exports = { updateMode };
