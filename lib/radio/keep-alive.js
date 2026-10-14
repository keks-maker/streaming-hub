'use strict';

// Entscheidet, ob Radio die App im Tray hält, wenn das letzte Fenster schließt (window-all-closed, Konzept §2):
// nur bei aktivem Radio (spielt/lädt/pausiert), gesetzter Option "weiterspielen" (Standard an) und vorhandenem
// Tray (sonst gäbe es keine Möglichkeit, das Radio zu stoppen). Rein, damit ohne Electron testbar.

function radioKeepsAppAlive({ controller, settings, hasTray }) {
  if (!controller || typeof controller.isActive !== 'function' || !controller.isActive()) return false;
  if (!hasTray) return false;
  return !settings || settings.keepPlayingWhenClosed !== false;
}

module.exports = { radioKeepsAppAlive };
