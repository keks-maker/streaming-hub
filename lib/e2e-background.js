'use strict';

// Test-Hook STREAMING_HUB_E2E_BACKGROUND=1: E2E-Läufe zeigen Fenster ohne Fokusübernahme.
// Wirksam nur zusammen mit STREAMING_HUB_USER_DATA (isolierter Testlauf), damit ein
// Nutzer das Verhalten nicht versehentlich im Normalbetrieb aktiviert.
function isBackgroundE2E(env) {
  return Boolean(env && env.STREAMING_HUB_USER_DATA && env.STREAMING_HUB_E2E_BACKGROUND === '1');
}

// Hook-Fall: Fenster unsichtbar (Opacity 0, klickdurchlässig) und inaktiv zeigen. Das Fenster
// existiert weiterhin im Compositor, damit Rendering, Timer und Playwright-Screenshots funktionieren.
function hideVisually(win) {
  if (typeof win.setOpacity === 'function') win.setOpacity(0);
  if (typeof win.setIgnoreMouseEvents === 'function') win.setIgnoreMouseEvents(true);
}

// Fenster zeigen: im Hook-Fall unsichtbar + inaktiv (kein Fokusklau), sonst show() + focus().
function revealWindow(win, env) {
  if (isBackgroundE2E(env)) {
    hideVisually(win);
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}

// BrowserWindow-Optionen: im Hook-Fall unsichtbar erzeugen (ein Fenster mit show:true wird sofort
// aktiviert), nicht in der Taskleiste, ohne Drosselung im Hintergrund. Sonst unverändert.
function prepareWindowOptions(opts, env) {
  if (!isBackgroundE2E(env)) return opts;
  return {
    ...opts,
    show: false,
    skipTaskbar: true,
    webPreferences: { ...(opts && opts.webPreferences), backgroundThrottling: false },
  };
}

// Zeigt ein im Hook-Fall unsichtbar erzeugtes Fenster inaktiv; im Normalbetrieb ohne Wirkung
// (dort bestimmt die show-Option des Fensters selbst).
function showInactiveInHook(win, env) {
  if (!isBackgroundE2E(env)) return;
  hideVisually(win);
  win.showInactive();
}

// App-Ebene im Hook-Fall: macOS kein Dock-Icon/keine Aktivierung (Policy accessory, so früh wie möglich).
function applyBackgroundApp(app, env, platform = process.platform) {
  if (!isBackgroundE2E(env)) return;
  if (platform === 'darwin') {
    if (typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory');
    if (app.dock && typeof app.dock.hide === 'function') app.dock.hide();
  }
}

module.exports = { isBackgroundE2E, revealWindow, prepareWindowOptions, showInactiveInHook, applyBackgroundApp };
