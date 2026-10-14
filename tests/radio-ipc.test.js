'use strict';

// Tests: Radio-IPC (lib/radio/ipc.js) mit Absender- und Schema-Prüfung sowie Weiterspielen bei Fenster zu (keep-alive.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerRadioIpc } = require('../lib/radio/ipc.js');
const { radioKeepsAppAlive } = require('../lib/radio/keep-alive.js');
const { RadioController } = require('../lib/radio/RadioController.js');
const { createFakeWindowClass, createFakeLibrary } = require('./helpers/radio-fakes.js');

const MAIN = { id: 'main' };
const OTHER = { id: 'webview' };

function setup({ probe } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
  const calls = [];
  const sent = [];
  const { FakeWindow, instances } = createFakeWindowClass();
  const stations = [{ sourceId: 's', id: 'a', name: 'Alpha', streamUrl: 'http://a.test/s' }];
  const fakeLibrary = createFakeLibrary({ stations, favorites: [{ sourceId: 's', id: 'a' }] });
  const store = [{ id: 'eigene-radiosender', name: 'Eigene Sender', type: 'user', stations: [{ id: 'custom-1', name: 'X', streamUrl: 'http://x.test/s' }] }];
  const library = {
    ...fakeLibrary,
    getSources: () => store,
    addCustom: input => {
      calls.push(['addCustom', input]);
      return { station: { id: 'custom-9', ...input }, sources: store };
    },
    updateCustom: (id, patch) => {
      calls.push(['updateCustom', id, patch]);
      return store;
    },
    removeCustom: id => {
      calls.push(['removeCustom', id]);
      return store;
    },
    setFavorite: (sourceId, stationId, flag) => {
      calls.push(['setFavorite', sourceId, stationId, flag]);
      return store;
    },
    setFavoriteOrder: list => {
      calls.push(['setFavoriteOrder', list]);
      return store;
    },
  };
  const controller = new RadioController({
    BrowserWindow: FakeWindow,
    library,
    resolveStream: async url => ({ streamUrl: url, kind: 'direct', via: [] }),
    readIcyTitle: async () => ({ metaint: 0 }),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  registerRadioIpc({
    ipcMain,
    controller,
    library,
    requireMainRenderer: event => {
      if (!event || event.sender !== MAIN) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: (channel, payload) => sent.push({ channel, payload }),
    probe: probe || (async url => ({ ok: true, streamUrl: url, kind: 'direct' })),
  });
  const call = async (channel, ...args) => handlers.get(channel)({ sender: MAIN }, ...args);
  return { handlers, listeners, call, calls, sent, controller, instances };
}

test('alle radio:*-Kanäle sind registriert', () => {
  const { handlers } = setup();
  const expected = ['get-sources', 'add-custom', 'update-custom', 'remove-custom', 'set-favorite', 'set-favorite-order', 'set-override', 'clear-override', 'set-settings', 'play', 'pause', 'stop', 'next', 'prev', 'set-volume', 'probe', 'get-state', 'get-settings'];
  for (const name of expected) assert.ok(handlers.has(`radio:${name}`), name);
  assert.equal(handlers.size, expected.length);
});

test('jeder Kanal lehnt fremde Absender ab', async () => {
  const { handlers } = setup();
  for (const [channel, handler] of handlers) {
    await assert.rejects(Promise.resolve().then(() => handler({ sender: OTHER })), /nicht autorisiertem/, channel);
    await assert.rejects(Promise.resolve().then(() => handler(undefined)), /nicht autorisiertem/, channel);
  }
});

test('Schema-Prüfung: ungültige Argumente erreichen Controller und Bibliothek nie', async () => {
  const { call, calls, controller } = setup();
  await assert.rejects(call('radio:add-custom', { name: 'A', streamUrl: 'file:///etc/passwd' }), /http/);
  await assert.rejects(call('radio:add-custom', { name: 'A', streamUrl: 'http://x.test/s', evil: 1 }), /Unbekanntes Feld/);
  await assert.rejects(call('radio:update-custom', 'custom-1', {}), /leer/);
  await assert.rejects(call('radio:update-custom', 42, { name: 'x' }), /ungültig/);
  await assert.rejects(call('radio:set-favorite', { sourceId: 's' }, true), /ungültig/);
  await assert.rejects(call('radio:set-favorite', { sourceId: 's', stationId: 'a' }, 'ja'), /ungültig/);
  await assert.rejects(call('radio:set-favorite-order', 'x'), /ungültig/);
  await assert.rejects(call('radio:play', 'a'), /ungültig/);
  await assert.rejects(call('radio:set-volume', 5), /Lautstärke/);
  await assert.rejects(call('radio:pause', 'extra'), /Unerwartete/);
  await assert.rejects(call('radio:get-state', 1), /Unerwartete/);
  await assert.rejects(call('radio:get-settings', 1), /Unerwartete/);
  assert.deepEqual(calls, []);
  assert.equal(controller.getState().status, 'idle');
});

test('gültige Aufrufe: Quellen-Mutationen senden radio:sources-changed', async () => {
  const { call, calls, sent } = setup();
  const added = await call('radio:add-custom', { name: ' Neu ', streamUrl: 'http://lan.test/s' });
  assert.equal(added.station.name, 'Neu');
  await call('radio:update-custom', 'custom-1', { name: 'B', logo: '' });
  await call('radio:remove-custom', 'custom-1');
  await call('radio:set-favorite', { sourceId: 's', stationId: 'a' }, true);
  await call('radio:set-favorite-order', [{ sourceId: 's', id: 'a', extra: 1 }]);
  assert.deepEqual(calls.map(c => c[0]), ['addCustom', 'updateCustom', 'removeCustom', 'setFavorite', 'setFavoriteOrder']);
  assert.deepEqual(calls[1], ['updateCustom', 'custom-1', { name: 'B', logo: null }]);
  assert.deepEqual(calls[4], ['setFavoriteOrder', [{ sourceId: 's', id: 'a' }]]);
  assert.equal(sent.filter(m => m.channel === 'radio:sources-changed').length, 5);
  assert.equal((await call('radio:get-sources')).length, 1);
});

test('Wiedergabe-Kanäle steuern den Controller, Zustand geht als radio:state an das Hauptfenster', async () => {
  const { call, sent, controller } = setup();
  const state = await call('radio:play', { sourceId: 's', stationId: 'a' });
  assert.equal(state.status, 'loading');
  assert.equal(sent.at(-1).channel, 'radio:state');
  assert.equal(sent.at(-1).payload.station.name, 'Alpha');
  await controller.connecting;
  controller.onPlayerReport({ t: 'ready' });
  controller.onPlayerReport({ t: 'playing', seq: 1 });
  assert.equal((await call('radio:get-state')).status, 'playing');
  assert.equal((await call('radio:get-settings')).volume, 0.8);
  assert.equal((await call('radio:set-volume', 0.3)).volume, 0.3);
  assert.equal((await call('radio:pause')).status, 'paused');
  assert.equal((await call('radio:play')).status, 'loading');
  assert.equal((await call('radio:stop')).status, 'idle');
  await call('radio:next');
  assert.equal(controller.getState().station.id, 'a');
  assert.equal(await call('radio:play', null).then(s => s.status), 'loading', 'play(null) = letzter Sender/fortsetzen');
});

test('Löschen des laufenden eigenen Senders stoppt die Wiedergabe', async () => {
  const handlers = new Map();
  const { FakeWindow } = createFakeWindowClass();
  const custom = { sourceId: 'eigene-radiosender', id: 'custom-1', name: 'X', streamUrl: 'http://x.test/s' };
  const library = {
    ...createFakeLibrary({ stations: [custom] }),
    removeCustom: () => [],
    getSources: () => [],
  };
  library.getStation = key => (key.sourceId === custom.sourceId && key.stationId === custom.id ? custom : null);
  const controller = new RadioController({ BrowserWindow: FakeWindow, library, resolveStream: async url => ({ streamUrl: url, kind: 'direct', via: [] }), setTimer: () => 1, clearTimer: () => {} });
  registerRadioIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f), on() {} }, controller, library, requireMainRenderer() {}, sendToMain() {} });
  await controller.play({ sourceId: 'eigene-radiosender', stationId: 'custom-1' });
  assert.equal(controller.isActive(), true);
  await handlers.get('radio:remove-custom')({ sender: MAIN }, 'custom-1');
  assert.equal(controller.getState().status, 'idle');
});

test('radio:probe: URL-Prüfung, Ergebnis durchgereicht, nur eine Prüfung gleichzeitig', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const { call } = setup({
    probe: async url => {
      if (url.endsWith('/slow')) await gate;
      return { ok: true, streamUrl: url, kind: 'direct' };
    },
  });
  assert.deepEqual(await call('radio:probe', 'file:///x'), { ok: false, error: 'Stream-URL muss mit http:// oder https:// beginnen' });
  assert.equal((await call('radio:probe', 'http://192.168.1.2/live')).ok, true, 'LAN erlaubt');
  const slow = call('radio:probe', 'http://x.test/slow');
  const second = await call('radio:probe', 'http://x.test/other');
  assert.equal(second.ok, false);
  assert.match(second.error, /bereits/);
  release();
  assert.equal((await slow).ok, true);
  assert.equal((await call('radio:probe', 'http://x.test/other')).ok, true);
});

test('Player-Nachrichten: nur vom Player-WebContents, nur Whitelist', async () => {
  const { listeners, controller, call, instances } = setup();
  const report = listeners.get('radio-player:report');
  await call('radio:play', { sourceId: 's', stationId: 'a' });
  await controller.connecting;
  const player = instances[0].webContents;
  report({ sender: OTHER }, { t: 'ready' });
  assert.deepEqual(instances[0].commands(), [], 'fremder Absender wird ignoriert');
  report({ sender: player }, { t: 'ready' });
  assert.equal(instances[0].commands()[0].cmd, 'play');
  report({ sender: player }, { t: 'hacked' });
  report({ sender: player }, { t: 'playing', seq: 1 });
  assert.equal(controller.getState().status, 'playing');
  report({ sender: player }, { t: 'action', action: 'stop' });
  assert.equal(controller.getState().status, 'idle');
  report({ sender: player }, { t: 'playing', seq: 1 });
  assert.equal(controller.getState().status, 'idle', 'ohne Player-Fenster kein Absender mehr');
});

// ── Weiterspielen bei Fenster zu ──

const ctl = status => ({ isActive: () => status !== 'idle' && status !== 'error' });

test('keep-alive: nur bei aktivem Radio, vorhandenem Tray und gesetzter Option', () => {
  const settings = { keepPlayingWhenClosed: true };
  assert.equal(radioKeepsAppAlive({ controller: ctl('playing'), settings, hasTray: true }), true);
  assert.equal(radioKeepsAppAlive({ controller: ctl('loading'), settings, hasTray: true }), true);
  assert.equal(radioKeepsAppAlive({ controller: ctl('paused'), settings, hasTray: true }), true);
  assert.equal(radioKeepsAppAlive({ controller: ctl('idle'), settings, hasTray: true }), false);
  assert.equal(radioKeepsAppAlive({ controller: ctl('error'), settings, hasTray: true }), false);
  assert.equal(radioKeepsAppAlive({ controller: ctl('playing'), settings, hasTray: false }), false, 'ohne Tray wäre die App unsichtbar');
  assert.equal(radioKeepsAppAlive({ controller: ctl('playing'), settings: { keepPlayingWhenClosed: false }, hasTray: true }), false);
  assert.equal(radioKeepsAppAlive({ controller: ctl('playing'), settings: null, hasTray: true }), true, 'Standard: weiterspielen');
  assert.equal(radioKeepsAppAlive({ controller: null, settings, hasTray: true }), false);
  assert.equal(radioKeepsAppAlive({ controller: {}, settings, hasTray: true }), false);
  assert.equal(radioKeepsAppAlive({}), false);
});

test('keep-alive mit echtem Controller: spielt → ja, nach stop → nein', async () => {
  const { FakeWindow } = createFakeWindowClass();
  const library = createFakeLibrary({ stations: [{ sourceId: 's', id: 'a', name: 'A', streamUrl: 'http://a.test/s' }] });
  const controller = new RadioController({ BrowserWindow: FakeWindow, library, resolveStream: async url => ({ streamUrl: url, kind: 'direct', via: [] }), setTimer: () => 1, clearTimer: () => {} });
  const context = () => ({ controller, settings: library.getSettings(), hasTray: true });
  assert.equal(radioKeepsAppAlive(context()), false);
  await controller.play({ sourceId: 's', stationId: 'a' });
  assert.equal(radioKeepsAppAlive(context()), true);
  controller.stop();
  assert.equal(radioKeepsAppAlive(context()), false);
});
