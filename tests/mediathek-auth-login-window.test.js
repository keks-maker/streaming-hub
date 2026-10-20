'use strict';

// Tests: Anmeldefenster (login-window.js) mit Ersatz für BrowserWindow/session: gehärtete webPreferences, Navigation nur auf
// https-Hosts des Anbieters, neue Fenster verweigert, Berechtigungen abgelehnt, Sitzung wird nur auf Seiten des Anbieters gelesen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLoginRunner } = require('../lib/mediathek/auth/login-window.js');
const { createArteProvider } = require('../lib/mediathek/auth/arte.js');
const { createE2eLoginRunner } = require('../lib/mediathek/auth/e2e-login.js');

function setup(warnings = []) {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.url = '';
      this.loaded = [];
      this.openHandler = null;
      this.contentsEvents = new EventEmitter();
      this.webContents = {
        setWindowOpenHandler: handler => { this.openHandler = handler; },
        on: (event, listener) => this.contentsEvents.on(event, listener),
        loadURL: async target => { this.loaded.push(target); this.url = target; },
        getURL: () => this.url,
        executeJavaScript: async () => this.script(),
      };
      this.script = () => '[]';
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const handlers = {};
  const session = { fromPartition: partition => { handlers.partition = partition; return { setPermissionRequestHandler: fn => { handlers.permission = fn; }, setPermissionCheckHandler: fn => { handlers.check = fn; } }; } };
  const timers = [];
  const runner = createLoginRunner({
    BrowserWindow: FakeWindow,
    session,
    getParent: () => null,
    logger: { warn: message => warnings.push(message) },
    setTimer: fn => { const timer = { fn }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
  });
  return { runner, windows, handlers, timers };
}

const provider = createArteProvider({ net: {}, now: () => 1000 });
const nav = (win, url) => {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  win.contentsEvents.emit('will-navigate', event, url);
  return event.prevented;
};

test('Subframes: Navigation nur auf https-Hosts des Anbieters, Fremdhosts blockiert', async () => {
  const { runner, windows } = setup();
  const pending = runner.run(provider);
  const win = windows[0];
  const frameNav = url => {
    const details = { url, prevented: false, preventDefault() { this.prevented = true; } };
    win.contentsEvents.emit('will-frame-navigate', details);
    return details.prevented;
  };
  assert.equal(frameNav('https://www.arte.tv/de/'), false);
  for (const url of ['https://evil.example/frame', 'http://www.arte.tv/', 'https://arte.tv.evil.example/', 'javascript:alert(1)', 'data:text/html,x']) assert.equal(frameNav(url), true, url);
  win.destroy();
  await pending;
});

test('Fenster: Sandbox, Context Isolation, kein Node, kein Preload, eigene persistente Partition, Berechtigungen abgelehnt', async () => {
  const { runner, windows, handlers } = setup();
  const pending = runner.run(provider);
  const prefs = windows[0].options.webPreferences;
  assert.deepEqual({ ...prefs }, { partition: 'persist:mediathek-arte', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false });
  assert.equal('preload' in prefs, false);
  assert.equal(handlers.partition, 'persist:mediathek-arte');
  let granted = 'offen';
  handlers.permission({}, 'media', allowed => { granted = allowed; });
  assert.equal(granted, false);
  assert.equal(handlers.check(), false);
  assert.deepEqual(windows[0].loaded, ['https://www.arte.tv/de/']);
  windows[0].destroy();
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
});

test('Navigation nur https auf Anbieter-Hosts; neue Fenster nie, erlaubte Ziele laden im selben Fenster', async () => {
  const { runner, windows } = setup();
  const pending = runner.run(provider);
  const win = windows[0];
  assert.equal(nav(win, 'https://id.arte.tv/auth/realms/myarte-prod/login'), false);
  assert.equal(nav(win, 'https://www.arte.tv/de/'), false);
  for (const url of ['https://evil.example/', 'http://www.arte.tv/', 'https://arte.tv.evil.example/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://accounts.google.com/o/oauth2']) assert.equal(nav(win, url), true, url);
  const redirect = { prevented: false, preventDefault() { this.prevented = true; } };
  win.contentsEvents.emit('will-redirect', redirect, 'https://evil.example/x');
  assert.equal(redirect.prevented, true);
  assert.deepEqual(win.openHandler({ url: 'https://evil.example/' }), { action: 'deny' });
  assert.deepEqual(win.openHandler({ url: 'https://www.arte.tv/de/mein-konto' }), { action: 'deny' });
  assert.equal(win.loaded.at(-1), 'https://www.arte.tv/de/mein-konto');
  assert.equal(win.loaded.includes('https://evil.example/'), false);
  win.destroy();
  await pending;
});

test('Sitzung wird nur auf Seiten des Anbieters gelesen; Erfolg schließt das Fenster und liefert den Datensatz', async () => {
  const { runner, windows, timers } = setup();
  const pending = runner.run(provider);
  const win = windows[0];
  let reads = 0;
  const entries = JSON.stringify([{ key: 'oidc.user:https://id.arte.tv/auth/realms/myarte-prod:web', value: JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_at: 2000000000 }) }]);
  win.script = () => { reads += 1; return entries; };
  win.url = 'https://id.arte.tv/auth/realms/myarte-prod/login-actions/authenticate';
  await timers[0].fn();
  assert.equal(reads, 0, 'auf der Login-Seite wird nichts gelesen');
  win.url = 'https://www.arte.tv/de/';
  await timers[0].fn();
  const result = await pending;
  assert.equal(reads, 1);
  assert.equal(result.ok, true);
  assert.equal(result.record.accessToken, 'A');
  assert.equal(win.destroyed, true);
  assert.equal(timers[0].cleared, true);
});

test('Noch keine Sitzung: weiter warten; zweiter Anmeldeversuch parallel -> busy; Schließen -> abgebrochen', async () => {
  const { runner, windows, timers } = setup();
  const pending = runner.run(provider);
  windows[0].url = 'https://www.arte.tv/de/';
  await timers[0].fn(); // script liefert []
  assert.equal(runner.isBusy(), true);
  assert.deepEqual(await runner.run(provider), { ok: false, code: 'busy' });
  windows[0].emit('closed');
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.equal(runner.isBusy(), false);
});

test('Lesefehler im Anbieter-Kontext brechen die Anmeldung nicht ab und loggen nur den Code', async () => {
  const warnings = [];
  const { runner, windows, timers } = setup(warnings);
  const pending = runner.run(provider);
  windows[0].url = 'https://www.arte.tv/de/';
  windows[0].script = () => {
    throw Object.assign(new Error('GEHEIMER-INHALT'), { code: 'script' });
  };
  await timers[0].fn();
  assert.equal(runner.isBusy(), true, 'Fenster bleibt offen');
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('GEHEIMER'));
  windows[0].destroy();
  assert.equal((await pending).ok, false);
});

test('E2E-Ersatz: "ok" liefert Fake-Datensatz, alles andere Abbruch', async () => {
  const ok = await createE2eLoginRunner('ok', () => 5000).run({ sender: 'arte' });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.since, 5000);
  assert.ok(ok.record.accessToken.startsWith('e2e-'));
  assert.deepEqual(await createE2eLoginRunner('cancel').run({ sender: 'ard' }), { ok: false, code: 'cancelled' });
});
