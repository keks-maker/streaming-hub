'use strict';

// Entscheidet, ob Radio die App im Tray hält, wenn das letzte Fenster schließt (window-all-closed, Konzept §2):
// nur bei aktivem Radio bzw. aktiver Podcast-Episode (spielt/lädt/pausiert; gleiche Option "weiterspielen"), gesetzter Option "weiterspielen" (Standard an) und vorhandenem
// Tray (sonst gäbe es keine Möglichkeit, das Radio zu stoppen). Rein, damit ohne Electron testbar.

function radioKeepsAppAlive({ controller, settings, hasTray }) {
  if (!controller || typeof controller.isActive !== 'function' || !controller.isActive()) return false;
  if (!hasTray) return false;
  return !settings || settings.keepPlayingWhenClosed !== false;
}

/**
 * Entscheidung bei window-all-closed (Rein, ohne Electron): Vorrang haben laufende Aufnahmen, dann anstehende
 * Planungen, dann Radio (nur mit Tray und Option "weiterspielen"). Liefert { quit, reason } mit
 * reason 'recording' | 'schedule' | 'radio' | 'podcast' | null (null = App beenden).
 */
function decideWindowAllClosed({ recorder, scheduler, radio, podcast }) {
  if (recorder && recorder.activeJobs().length > 0) return { quit: false, reason: 'recording' };
  if (scheduler && scheduler.hasPendingSchedules()) return { quit: false, reason: 'schedule' };
  if (radioKeepsAppAlive(radio || {})) return { quit: false, reason: 'radio' };
  if (radioKeepsAppAlive(podcast || {})) return { quit: false, reason: 'podcast' };
  return { quit: true, reason: null };
}

module.exports = { radioKeepsAppAlive, decideWindowAllClosed };
