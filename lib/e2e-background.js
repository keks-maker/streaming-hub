'use strict';

// Test-Hook STREAMING_HUB_E2E_BACKGROUND=1: E2E-Läufe zeigen Fenster ohne Fokusübernahme.
// Wirksam nur zusammen mit STREAMING_HUB_USER_DATA (isolierter Testlauf), damit ein
// Nutzer das Verhalten nicht versehentlich im Normalbetrieb aktiviert.
function isBackgroundE2E(env) {
  return Boolean(env && env.STREAMING_HUB_USER_DATA && env.STREAMING_HUB_E2E_BACKGROUND === '1');
}

// Fenster zeigen: im Hook-Fall inaktiv (kein Fokusklau), sonst show() + focus().
function revealWindow(win, env) {
  if (isBackgroundE2E(env)) {
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}

module.exports = { isBackgroundE2E, revealWindow };
