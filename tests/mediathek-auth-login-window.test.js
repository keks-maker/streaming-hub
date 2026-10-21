'use strict';

// Tests: Anmeldefenster (login-window.js) mit Ersatz für BrowserWindow/session: gehärtete webPreferences, Navigation nur auf
// https-Hosts des Anbieters, neue Fenster verweigert, Berechtigungen abgelehnt, Sitzung wird nur auf Seiten des Anbieters gelesen;
// Übernehmen-Leiste (Klick, Rückmeldung, Abbrechen) und letzter Versuch beim Schließen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLoginRunner, BAR_HEIGHT } = require('../lib/mediathek/auth/login-window.js');
const { createArteProvider } = require('../lib/mediathek/auth/arte.js');
const { createZdfProvider } = require('../lib/mediathek/auth/zdf.js');
const { createE2eLoginRunner } = require('../lib/mediathek/auth/e2e-login.js');

function setup(warnings = [], extra = {}) {
  const windows = [];
  const views = [];
  const ipcHandlers = {};
  class FakeContents {
    constructor(owner) {
      this.owner = owner;
      this.openHandler = null;
      this.events = new EventEmitter();
      this.url = '';
      this.loaded = [];
      this.sent = [];
      this.files = [];
      this.closed = false;
      this.script = () => '[]';
    }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    on(event, listener) { this.events.on(event, listener); }
    async loadURL(target) { this.loaded.push(target); this.url = target; }
    async loadFile(file) { this.files.push(file); }
    getURL() { return this.url; }
    async executeJavaScript() { return this.script(); }
    send(channel, code) { this.sent.push([channel, code]); }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; }
  }
  class FakeView {
    constructor(options) {
      this.options = options;
      this.bounds = null;
      this.webContents = new FakeContents(this);
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.children = [];
      this.contentView = { addChildView: view => this.children.push(view) };
      windows.push(this);
    }
    getContentBounds() { return { x: 0, y: 0, width: 520, height: 760 }; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const handlers = {};
  const cookieList = extra.cookies || [];
  const session = { fromPartition: partition => { handlers.partition = partition; return { cookies: { get: async () => cookieList }, setPermissionRequestHandler: fn => { handlers.permission = fn; }, setPermissionCheckHandler: fn => { handlers.check = fn; } }; } };
  const ipcMain = { on: (channel, fn) => { ipcHandlers[channel] = fn; } };
  const timers = [];
  const runner = createLoginRunner({
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    ipcMain,
    session,
    getParent: () => null,
    logger: { warn: message => warnings.push(message) },
    setTimer: fn => { const timer = { fn }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    closeDelayMs: 0,
  });
  const pageOf = win => win.children[0].webContents;
  const barOf = win => win.children[1].webContents;
  return { runner, windows, views, handlers, timers, ipcHandlers, pageOf, barOf };
}

const provider = createArteProvider({ net: {}, now: () => 1000 });
const nav = (contents, url, event = 'will-navigate') => {
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.events.emit(event, e, url);
  return e.prevented;
};
const ARTE_ENTRIES = JSON.stringify([{ key: 'oidc.user:https://id.arte.tv/auth/realms/myarte-prod:web', value: JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_at: 2000000000 }) }]);

test('Subframes: Navigation nur auf https-Hosts des Anbieters, Fremdhosts blockiert', async () => {
  const { runner, windows, pageOf } = setup();
  const pending = runner.run(provider);
  const page = pageOf(windows[0]);
  const frameNav = url => {
    const details = { url, prevented: false, preventDefault() { this.prevented = true; } };
    page.events.emit('will-frame-navigate', details);
    return details.prevented;
  };
  assert.equal(frameNav('https://www.arte.tv/de/'), false);
  for (const url of ['https://evil.example/frame', 'http://www.arte.tv/', 'https://arte.tv.evil.example/', 'javascript:alert(1)', 'data:text/html,x']) assert.equal(frameNav(url), true, url);
  windows[0].destroy();
  await pending;
});

test('Ansichten: Anbieter-Seite gehärtet ohne Preload, Leiste mit nur ihrem Preload, Berechtigungen abgelehnt, Leiste oben', async () => {
  const { runner, windows, views, handlers, pageOf, barOf } = setup();
  const pending = runner.run(provider);
  const hardened = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false };
  assert.deepEqual({ ...windows[0].options.webPreferences }, hardened);
  const [pageView, barView] = views;
  assert.deepEqual({ ...pageView.options.webPreferences }, { ...hardened, partition: 'persist:mediathek-arte' });
  assert.equal('preload' in pageView.options.webPreferences, false, 'Anbieter-Seite ohne Preload');
  assert.equal(barView.options.webPreferences.partition, 'mediathek-login-bar');
  assert.ok(barView.options.webPreferences.preload.endsWith('login-bar-preload.js'));
  assert.equal(barView.options.webPreferences.sandbox, true);
  assert.deepEqual(pageView.bounds, { x: 0, y: BAR_HEIGHT, width: 520, height: 760 - BAR_HEIGHT });
  assert.deepEqual(barView.bounds, { x: 0, y: 0, width: 520, height: BAR_HEIGHT });
  assert.equal(handlers.partition, 'persist:mediathek-arte');
  let granted = 'offen';
  handlers.permission({}, 'media', allowed => { granted = allowed; });
  assert.equal(granted, false);
  assert.equal(handlers.check(), false);
  assert.deepEqual(pageOf(windows[0]).loaded, ['https://www.arte.tv/de/']);
  assert.ok(barOf(windows[0]).files[0].endsWith('login-bar.html'));
  // Leiste: keine Navigation, keine neuen Fenster
  assert.equal(nav(barOf(windows[0]), 'https://www.arte.tv/'), true);
  assert.deepEqual(barOf(windows[0]).openHandler({ url: 'https://www.arte.tv/' }), { action: 'deny' });
  windows[0].destroy();
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
});

test('Navigation nur https auf Anbieter-Hosts; neue Fenster nie, erlaubte Ziele laden im selben Fenster', async () => {
  const { runner, windows, pageOf } = setup();
  const pending = runner.run(provider);
  const page = pageOf(windows[0]);
  assert.equal(nav(page, 'https://id.arte.tv/auth/realms/myarte-prod/login'), false);
  assert.equal(nav(page, 'https://www.arte.tv/de/'), false);
  for (const url of ['https://evil.example/', 'http://www.arte.tv/', 'https://arte.tv.evil.example/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://accounts.google.com/o/oauth2']) assert.equal(nav(page, url), true, url);
  assert.equal(nav(page, 'https://evil.example/x', 'will-redirect'), true);
  assert.deepEqual(page.openHandler({ url: 'https://evil.example/' }), { action: 'deny' });
  assert.deepEqual(page.openHandler({ url: 'https://www.arte.tv/de/mein-konto' }), { action: 'deny' });
  assert.equal(page.loaded.at(-1), 'https://www.arte.tv/de/mein-konto');
  assert.equal(page.loaded.includes('https://evil.example/'), false);
  windows[0].destroy();
  await pending;
});

test('Sitzung wird nur auf Seiten des Anbieters gelesen; Erfolg schließt das Fenster und liefert den Datensatz', async () => {
  const { runner, windows, timers, pageOf } = setup();
  const pending = runner.run(provider);
  const page = pageOf(windows[0]);
  let reads = 0;
  page.script = () => { reads += 1; return ARTE_ENTRIES; };
  page.url = 'https://id.arte.tv/auth/realms/myarte-prod/login-actions/authenticate';
  await timers[0].fn();
  assert.equal(reads, 0, 'auf der Login-Seite wird nichts gelesen');
  page.url = 'https://www.arte.tv/de/';
  await timers[0].fn();
  const result = await pending;
  assert.equal(reads, 1);
  assert.equal(result.ok, true);
  assert.equal(result.record.accessToken, 'A');
  assert.equal(windows[0].destroyed, true);
  assert.equal(timers[0].cleared, true);
  assert.equal(page.closed, true, 'Ansichten werden freigegeben');
});

test('Noch keine Sitzung: weiter warten; zweiter Anmeldeversuch parallel -> busy; Schließen -> abgebrochen', async () => {
  const { runner, windows, timers, pageOf } = setup();
  const pending = runner.run(provider);
  pageOf(windows[0]).url = 'https://www.arte.tv/de/';
  await timers[0].fn(); // script liefert []
  assert.equal(runner.isBusy(), true);
  assert.deepEqual(await runner.run(provider), { ok: false, code: 'busy' });
  windows[0].emit('closed');
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.equal(runner.isBusy(), false);
});

test('Lesefehler im Anbieter-Kontext brechen die Anmeldung nicht ab und loggen nur den Code', async () => {
  const warnings = [];
  const { runner, windows, timers, pageOf } = setup(warnings);
  const pending = runner.run(provider);
  const page = pageOf(windows[0]);
  page.url = 'https://www.arte.tv/de/';
  page.script = () => {
    throw Object.assign(new Error('GEHEIMER-INHALT'), { code: 'script' });
  };
  await timers[0].fn();
  assert.equal(runner.isBusy(), true, 'Fenster bleibt offen');
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('GEHEIMER'));
  windows[0].destroy();
  assert.equal((await pending).ok, false);
});

test('Leiste: Klick prüft sofort; ohne Anmeldung Rückmeldung "none" und Fenster bleibt, mit Anmeldung "found" und Übernahme', async () => {
  const { runner, windows, pageOf, barOf, ipcHandlers } = setup();
  const pending = runner.run(provider);
  const page = pageOf(windows[0]);
  const bar = barOf(windows[0]);
  page.url = 'https://www.arte.tv/de/';
  await ipcHandlers['mediathek:login-accept']({ sender: bar });
  assert.deepEqual(bar.sent.map(entry => entry[1]), ['checking', 'none']);
  assert.equal(runner.isBusy(), true);
  // Ereignisse fremder Absender (Anbieter-Seite) werden ignoriert
  page.script = () => ARTE_ENTRIES;
  await ipcHandlers['mediathek:login-accept']({ sender: page });
  assert.equal(runner.isBusy(), true);
  await ipcHandlers['mediathek:login-accept']({ sender: bar });
  assert.deepEqual(bar.sent.map(entry => entry[1]).slice(-2), ['checking', 'found']);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.record.accessToken, 'A');
});

test('Leiste: Klick abseits der Anbieter-Seite wechselt zur Startseite und prüft dort erneut', async () => {
  const { runner, windows, pageOf, barOf, ipcHandlers } = setup();
  const pending = runner.run(provider);
  const page = pageOf(windows[0]);
  page.url = 'https://id.arte.tv/auth/realms/myarte-prod/login-actions/authenticate';
  page.script = () => ARTE_ENTRIES;
  await ipcHandlers['mediathek:login-accept']({ sender: barOf(windows[0]) });
  assert.equal(page.loaded.at(-1), 'https://www.arte.tv/de/');
  assert.equal((await pending).ok, true);
});

test('Leiste: Abbrechen beendet ohne letzten Versuch', async () => {
  const { runner, windows, pageOf, barOf, ipcHandlers } = setup();
  const pending = runner.run(provider);
  let reads = 0;
  pageOf(windows[0]).url = 'https://www.arte.tv/de/';
  pageOf(windows[0]).script = () => { reads += 1; return ARTE_ENTRIES; };
  await ipcHandlers['mediathek:login-cancel']({ sender: pageOf(windows[0]) });
  assert.equal(runner.isBusy(), true, 'fremder Absender wirkt nicht');
  await ipcHandlers['mediathek:login-cancel']({ sender: barOf(windows[0]) });
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.equal(reads, 0);
});

test('Schließen durch den Nutzer: einmaliger letzter Versuch übernimmt eine vorhandene Anmeldung, sonst abgebrochen', async () => {
  const first = setup();
  let pending = first.runner.run(provider);
  first.pageOf(first.windows[0]).url = 'https://www.arte.tv/de/';
  first.pageOf(first.windows[0]).script = () => ARTE_ENTRIES;
  const closeEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  first.windows[0].emit('close', closeEvent);
  assert.equal(closeEvent.prevented, true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.record.accessToken, 'A');

  const second = setup();
  pending = second.runner.run(provider);
  second.pageOf(second.windows[0]).url = 'https://www.arte.tv/de/';
  second.windows[0].emit('close', { preventDefault() {} });
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.equal(second.windows[0].destroyed, true);
});

test('ZDF: Cookies der Partition werden dem Provider als Kandidaten geliefert, Übernehmen auf Unterseite', async () => {
  const requests = [];
  const net = { request: async (method, url, options) => { requests.push(options.headers.Authorization); return { status: options.headers.Authorization === 'Bearer cookie-token-valid-1' ? 200 : 401, json: {} }; } };
  const zdf = createZdfProvider({ net, now: () => 1000 });
  const cookies = [{ name: 'other', value: 'x', domain: 'evil.example' }, { name: 'zdf_session', value: 'cookie-token-valid-1', domain: '.zdf.de' }];
  const { runner, windows, pageOf, barOf, ipcHandlers } = setup([], { cookies });
  const pending = runner.run(zdf);
  pageOf(windows[0]).url = 'https://www.zdf.de/serien/x';
  await ipcHandlers['mediathek:login-accept']({ sender: barOf(windows[0]) });
  const result = await pending;
  assert.equal(result.record.accessToken, 'cookie-token-valid-1');
  assert.deepEqual(requests, ['Bearer cookie-token-valid-1'], 'fremde Cookies werden nicht herangezogen');
});

test('ZDF: nichts gefunden -> einmal zu Mein ZDF navigieren und erneut prüfen', async () => {
  const net = { request: async () => ({ status: 200, json: {} }) };
  const zdf = createZdfProvider({ net, now: () => 1000 });
  const { runner, windows, pageOf, barOf, ipcHandlers } = setup();
  const pending = runner.run(zdf);
  const page = pageOf(windows[0]);
  page.url = 'https://www.zdf.de/';
  page.loadURL = async target => { page.loaded.push(target); page.url = target; page.script = () => JSON.stringify([{ key: 'local-user-data', value: JSON.stringify({ state: { sessionToken: 'session-token-0001' } }) }]); };
  page.script = () => '[]';
  await ipcHandlers['mediathek:login-accept']({ sender: barOf(windows[0]) });
  assert.equal(page.loaded.at(-1), 'https://www.zdf.de/mein-zdf');
  assert.equal((await pending).record.accessToken, 'session-token-0001');
});

test('E2E-Ersatz: "ok" liefert Fake-Datensatz, alles andere Abbruch', async () => {
  const ok = await createE2eLoginRunner('ok', () => 5000).run({ sender: 'arte' });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.since, 5000);
  assert.ok(ok.record.accessToken.startsWith('e2e-'));
  assert.deepEqual(await createE2eLoginRunner('cancel').run({ sender: 'ard' }), { ok: false, code: 'cancelled' });
});
