'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBackgroundE2E, revealWindow, prepareWindowOptions, applyBackgroundApp } = require('../lib/e2e-background.js');

function fakeWin() {
  const calls = [];
  return { calls, setOpacity: v => calls.push('opacity' + v), setIgnoreMouseEvents: v => calls.push('ignore' + v), show: () => calls.push('show'), focus: () => calls.push('focus'), showInactive: () => calls.push('showInactive') };
}

test('Hook nur zusammen mit STREAMING_HUB_USER_DATA wirksam', () => {
  assert.equal(isBackgroundE2E({ STREAMING_HUB_E2E_BACKGROUND: '1' }), false);
  assert.equal(isBackgroundE2E({ STREAMING_HUB_USER_DATA: '/tmp/x' }), false);
  assert.equal(isBackgroundE2E({ STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '0' }), false);
  assert.equal(isBackgroundE2E({ STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '1' }), true);
  assert.equal(isBackgroundE2E(undefined), false);
});

test('revealWindow: Produktion show+focus, Hook showInactive ohne focus', () => {
  const prod = fakeWin();
  revealWindow(prod, { STREAMING_HUB_E2E_BACKGROUND: '1' });
  assert.deepEqual(prod.calls, ['show', 'focus']);
  const hook = fakeWin();
  revealWindow(hook, { STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '1' });
  assert.deepEqual(hook.calls, ['opacity0', 'ignoretrue', 'showInactive']);
});

// Wächter: .show()/.focus()/.moveTop()/app.focus-Aufrufe in main.js und lib/ nur an geprüften Stellen.
// Neue Fenster müssen revealWindow()/showInactiveInHook() nutzen (kein Fokusklau in Testläufen); wer hier
// eine Stelle ergänzt, begründet im Kommentar, warum sie im Hook-Fall nicht vorne erscheinen kann.
test('Vordergrund-Aufrufe (.show/.focus/.moveTop) nur auf der Allowlist', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'main.js')];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(path.join(root, 'lib'));
  const allow = {
    'lib/e2e-background.js': 2, // revealWindow: show()+focus() nur außerhalb des Hook-Falls
    'lib/recorder/Notifier.js': 1, // Notification.show(): Systembenachrichtigung, aktiviert die App nicht
  };
  const pattern = /(?<![\w$])(?:[\w$.]*?)\.(show|focus|moveTop)\(\)|\bapp\.focus\(/g;
  const found = {};
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const code = fs.readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const count = (code.match(pattern) || []).length;
    if (count) found[rel] = count;
  }
  assert.deepEqual(found, allow);
});

test('prepareWindowOptions: Hook-Fall unsichtbar, ohne Drosselung; sonst unverändert', () => {
  const hook = { STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '1' };
  const opts = { width: 1, webPreferences: { sandbox: true } };
  assert.deepEqual(prepareWindowOptions(opts, hook), {
    width: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  assert.equal(prepareWindowOptions(opts, {}), opts);
});

test('applyBackgroundApp: macOS accessory + Dock verstecken nur im Hook-Fall', () => {
  const calls = [];
  const app = { setActivationPolicy: p => calls.push(p), dock: { hide: () => calls.push('hide') } };
  applyBackgroundApp(app, {}, 'darwin');
  assert.deepEqual(calls, []);
  const hook = { STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '1' };
  applyBackgroundApp(app, hook, 'linux');
  assert.deepEqual(calls, []);
  applyBackgroundApp(app, hook, 'darwin');
  assert.deepEqual(calls, ['accessory', 'hide']);
});

// Wächter: jedes new BrowserWindow(...) muss durch prepareWindowOptions laufen.
test('Jedes new BrowserWindow nutzt prepareWindowOptions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'main.js')];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(path.join(root, 'lib'));
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/new (?:this\.)?BrowserWindow\(([^)]{0,40})/g)) {
      assert.match(m[1], /^prepareWindowOptions\(/, `${path.relative(root, file)}: ${m[0]}`);
    }
  }
});
