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

// BrowserWindow-Option: im Hook-Fall unsichtbar erzeugen (ein Fenster mit show:true wird sofort aktiviert),
// danach per showInactiveInHook() zeigen.
function hiddenInHook(env) {
  return isBackgroundE2E(env) ? { show: false } : {};
}

function showInactiveInHook(win, env) {
  if (isBackgroundE2E(env)) win.showInactive();
}

module.exports = { isBackgroundE2E, revealWindow, hiddenInHook, showInactiveInHook };
