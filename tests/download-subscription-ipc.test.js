'use strict';

// Tests: IPC der Serien-Abos (subscriptions/ipc.js, validation.js): Hauptfenster-Pflicht, Schema-Prüfung, Kanäle, Ereignis,
// Preload-Whitelist und Verdrahtung im Main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerSubscriptionIpc } = require('../lib/download/subscriptions/ipc.js');
const v = require('../lib/download/subscriptions/validation.js');

const SERIES = { id: 'SER1', title: 'Serie', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/SER1?embedded=true' };
const ID = 'sub_abcd1234';

function setup() {
  const handlers = new Map();
  const calls = [];
  const sent = [];
  const main = {};
  const service = Object.assign(new EventEmitter(), {
    list: () => ({ ok: true, items: [] }),
    add: async input => (calls.push(['add', input]), { ok: true, item: { id: ID } }),
    update: (id, patch) => (calls.push(['update', id, patch]), { ok: true }),
    remove: id => (calls.push(['remove', id]), { ok: true }),
    checkNow: async id => (calls.push(['checkNow', id]), { ok: true, checked: 1, added: 0 }),
  });
  registerSubscriptionIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    service,
    requireMainRenderer: event => {
      if (event !== main) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: (channel, payload) => sent.push([channel, payload]),
  });
  const invoke = (channel, ...args) => handlers.get(channel)(main, ...args);
  return { handlers, invoke, calls, sent, service, main };
}

test('Alle Kanäle sind registriert und verlangen das Hauptfenster', async () => {
  const { handlers, invoke } = setup();
  assert.deepEqual([...handlers.keys()].sort(), ['subscriptions:add', 'subscriptions:check-now', 'subscriptions:list', 'subscriptions:remove', 'subscriptions:update']);
  for (const [channel, handler] of handlers) assert.throws(() => handler({}, channel === 'subscriptions:list' ? undefined : {}), /nicht autorisiert/, channel);
  assert.deepEqual(invoke('subscriptions:list'), { ok: true, items: [] });
});

test('list: Nutzlast wird abgelehnt', () => {
  const { invoke } = setup();
  assert.throws(() => invoke('subscriptions:list', { x: 1 }));
});

test('add: Serie und Modus werden geprüft, Standardmodus ist „future“, Optionen normalisiert', async () => {
  const { invoke, calls } = setup();
  await invoke('subscriptions:add', { series: SERIES, overrides: { maxHeight: '720' } });
  assert.deepEqual(calls[0], ['add', { series: SERIES, mode: 'future', overrides: { maxHeight: '720' } }]);
  await invoke('subscriptions:add', { series: SERIES, mode: 'all' });
  assert.equal(calls[1][1].mode, 'all');
  assert.throws(() => invoke('subscriptions:add', { series: SERIES, mode: 'alles' }), /Modus/);
  assert.throws(() => invoke('subscriptions:add', { series: { ...SERIES, sourceId: 'evil' } }));
  assert.throws(() => invoke('subscriptions:add', { series: SERIES, extra: 1 }), /Unbekanntes Feld/);
  assert.throws(() => invoke('subscriptions:add', { series: SERIES, overrides: { storageRoot: '/etc' } }), /Unbekanntes Feld/);
  assert.throws(() => invoke('subscriptions:add', null));
});

test('update: ID, Typen und mindestens eine Änderung', async () => {
  const { invoke, calls } = setup();
  await invoke('subscriptions:update', { id: ID, enabled: false });
  assert.deepEqual(calls[0], ['update', ID, { enabled: false }]);
  await invoke('subscriptions:update', { id: ID, overrides: {} });
  assert.deepEqual(calls[1], ['update', ID, { overrides: {} }]);
  assert.throws(() => invoke('subscriptions:update', { id: ID }), /Keine Änderung/);
  assert.throws(() => invoke('subscriptions:update', { id: ID, enabled: 'ja' }), /enabled/);
  assert.throws(() => invoke('subscriptions:update', { id: '../x', enabled: true }), /Abo-ID/);
});

test('remove und check-now: ID-Prüfung; check-now ohne ID prüft alle', async () => {
  const { invoke, calls } = setup();
  await invoke('subscriptions:remove', { id: ID });
  await invoke('subscriptions:check-now', {});
  await invoke('subscriptions:check-now', { id: ID });
  await invoke('subscriptions:check-now');
  assert.deepEqual(calls, [['remove', ID], ['checkNow', undefined], ['checkNow', ID], ['checkNow', undefined]]);
  assert.throws(() => invoke('subscriptions:remove', { id: 'x' }), /Abo-ID/);
  assert.throws(() => invoke('subscriptions:check-now', { id: 5 }), /Abo-ID/);
  assert.throws(() => invoke('subscriptions:check-now', { foo: 1 }), /Unbekanntes Feld/);
});

test('Ereignis changed des Dienstes geht als subscriptions:changed an das Hauptfenster', () => {
  const { service, sent } = setup();
  service.emit('changed', { ok: true, items: [{ id: ID }] });
  assert.deepEqual(sent, [['subscriptions:changed', { ok: true, items: [{ id: ID }] }]]);
});

test('validateAdd/validateUpdate: reine Prüfung', () => {
  assert.equal(v.validateAdd({ series: SERIES }).mode, 'future');
  assert.deepEqual(v.validateCheck(undefined), {});
});

test('Preload-Whitelist und Verdrahtung im Main', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const preload = read('preload.js');
  for (const channel of ['subscriptions:list', 'subscriptions:add', 'subscriptions:update', 'subscriptions:remove', 'subscriptions:check-now', 'subscriptions:changed']) assert.ok(preload.includes(`'${channel}'`), channel);
  const main = read('main.js');
  assert.match(main, /registerSubscriptionIpc\(/);
  assert.match(main, /subscriptionService\.stop\(\)/);
  assert.match(main, /onSettingsChanged: \(\) => subscriptionService && subscriptionService\.reschedule\(\)/);
  assert.match(read('renderer.js'), /window\.downloads\.subscriptions\.onChanged\(payload => subscriptionsStore\.applyEvent\(payload\)\)/);
});
