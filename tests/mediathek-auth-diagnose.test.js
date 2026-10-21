'use strict';

// Tests: Diagnose-Aufzeichnung. Redaktion (keine Werte, keine Token, keine Kennungen) und Aufzeichnung mit Ersatz für
// Fenster/session.webRequest/Debugger; ARD-Parameter userId für personalisierte Abrufe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { redactUrl, headerNames, summarizeJson, isRecordedHost, isItemUrl } = require('../lib/mediathek/auth/diagnose-redact.js');
const { createDiagnoseRecorder } = require('../lib/mediathek/auth/diagnose.js');
const { createArdProvider, userIdFromToken } = require('../lib/mediathek/auth/ard.js');

const SECRET = 'SECRET-TOKEN-VALUE';
const fakeJwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

test('redactUrl: nur Namen der Query-Parameter, Kennungen im Pfad ersetzt', () => {
  const parsed = redactUrl(`https://api.ardmediathek.de/page-gateway/pages/ard/item/Y3JpZDovL2Rhc2Vyc3RlLmRl?userId=${SECRET}&devicetype=pc&pin=1234`);
  assert.deepEqual(parsed.query, ['userId', 'devicetype', 'pin']);
  assert.equal(JSON.stringify(parsed).includes(SECRET), false);
  assert.equal(JSON.stringify(parsed).includes('1234'), false);
  assert.equal(redactUrl('https://accounts.ard.de/users/abcDEF123456/profile').path, '/users/<id>/profile');
  assert.equal(redactUrl('https://x.de/mediathek/uid123/lists/playhistory/items').path, '/mediathek/<id>/lists/playhistory/items');
  assert.equal(redactUrl('http://api.ardmediathek.de/x'), null);
  assert.equal(redactUrl('kein url'), null);
});

test('headerNames: nur Namen', () => {
  const names = headerNames({ 'X-Authorization': `Bearer ${SECRET}`, Cookie: 'sid=1', Accept: 'a' });
  assert.deepEqual(names, ['x-authorization', 'cookie', 'accept']);
  assert.equal(JSON.stringify(names).includes(SECRET), false);
});

test('isRecordedHost: nur Anbieter-Hosts', () => {
  const hosts = ['ardmediathek.de', 'ard.de', 'securetoken.googleapis.com'];
  assert.equal(isRecordedHost('api.ardmediathek.de', hosts), true);
  assert.equal(isRecordedHost('sso.ardmediathek.de', hosts), true);
  assert.equal(isRecordedHost('evilard.de', hosts), false);
  assert.equal(isRecordedHost('google.com', hosts), false);
  assert.equal(isItemUrl('https://api.ardmediathek.de/page-gateway/pages/ard/item/abc?embedded=true'), true);
  assert.equal(isItemUrl('https://api.ardmediathek.de/page-gateway/pages/ard/home'), false);
});

test('summarizeJson: Schlüssel bis Tiefe 4, nur erlaubte Felder mit kurzen Werten, keine sonstigen Werte', () => {
  const body = {
    title: 'Geheimer Titel',
    email: 'a@b.de',
    widgets: [{ type: 'player_ondemand', kind: 'item', mediaCollection: { embedded: { meta: { maturityContentRating: { isBlocked: true, age: 16, note: 'x'.repeat(80) }, deep: { deeper: { deepest: 1 } } } } } }],
    blockedByFsk: false,
    isGeoBlocked: 'x'.repeat(50),
    fskRating: 'FSK16',
  };
  const out = summarizeJson(body);
  const text = JSON.stringify(out);
  assert.equal(text.includes('Geheimer Titel'), false);
  assert.equal(text.includes('a@b.de'), false);
  assert.ok('widgets' in out.keys && 'title' in out.keys);
  const find = field => out.values.filter(v => v.field === field);
  assert.equal(find('isBlocked')[0].value, true);
  assert.equal(find('age')[0].value, 16);
  assert.equal(find('blockedByFsk')[0].value, false);
  assert.equal(find('fskRating')[0].value, 'FSK16');
  assert.equal(find('kind')[0].value, 'item');
  assert.equal(find('isGeoBlocked').length, 0, 'zu langer Wert entfällt');
  assert.equal(find('note').length, 0);
  assert.equal(find('type').length, 0, 'nicht erlaubtes Feld ohne Wert');
  // Tiefe 4: der fünfte Schlüssel-Level fehlt
  assert.equal(text.includes('deepest'), false);
});

function setup() {
  const handlers = {};
  const written = {};
  const win = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  const bodies = new Map();
  const contents = {
    loadURL: async url => { contents.url = url; },
    debugger: {
      attach: () => {},
      isAttached: () => true,
      detach: () => {},
      on: (event, fn) => debuggerEvents.on(event, fn),
      sendCommand: async (command, params) => (command === 'Network.getResponseBody' ? bodies.get(params.requestId) : {}),
    },
  };
  const webRequest = new Proxy({}, { get: (_t, name) => (...args) => { handlers[name] = args[args.length - 1]; } });
  const fsFake = { mkdirSync: () => {}, writeFileSync: (file, data) => { written.file = file; written.data = data; }, renameSync: (from, to) => { written.final = to; } };
  const recorder = createDiagnoseRecorder({
    openProviderWindow: () => ({ win, contents, ses: { webRequest } }),
    file: '/tmp/diagnose-ard.json',
    now: () => 1000,
    fsImpl: fsFake,
  });
  return { recorder, handlers, written, win, contents, debuggerEvents, bodies };
}

test('Aufzeichnung: nur Anbieter-Hosts, nur Namen, Item-Struktur, Datei beim Schließen', async () => {
  const { recorder, handlers, written, win, debuggerEvents, bodies } = setup();
  const provider = createArdProvider({ net: {} });
  const pending = recorder.run(provider);
  await new Promise(resolve => setImmediate(resolve));
  const itemUrl = `https://api.ardmediathek.de/page-gateway/pages/ard/item/abc?userId=${SECRET}&devicetype=pc`;
  handlers.onBeforeSendHeaders({ id: 1, url: itemUrl, method: 'get', requestHeaders: { 'X-Authorization': `Bearer ${SECRET}`, Cookie: SECRET } }, () => {});
  handlers.onCompleted({ id: 1, statusCode: 200, responseHeaders: { 'set-cookie': [SECRET] } });
  handlers.onBeforeSendHeaders({ id: 2, url: 'https://tracker.example.com/p?x=1', method: 'GET', requestHeaders: {} }, () => {});
  handlers.onCompleted({ id: 2, statusCode: 200 });
  bodies.set('r1', { body: JSON.stringify({ mediaCollection: { meta: { maturityContentRating: { isBlocked: true, age: 16 } } }, title: SECRET }), base64Encoded: false });
  debuggerEvents.emit('message', {}, 'Network.responseReceived', { requestId: 'r1', response: { url: itemUrl, mimeType: 'application/json' } });
  await new Promise(resolve => setImmediate(resolve));
  debuggerEvents.emit('message', {}, 'Network.loadingFinished', { requestId: 'r1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorder.isBusy(), true);
  win.emit('closed');
  const result = await pending;
  assert.deepEqual([result.ok, result.file, result.entries], [true, '/tmp/diagnose-ard.json', 1]);
  assert.equal(written.final, '/tmp/diagnose-ard.json');
  assert.equal(written.data.includes(SECRET), false, 'kein Token/Wert in der Datei');
  const saved = JSON.parse(written.data);
  assert.equal(saved.requests[0].host, 'api.ardmediathek.de');
  assert.deepEqual(saved.requests[0].query, ['userId', 'devicetype']);
  assert.ok(saved.requests[0].requestHeaders.includes('x-authorization'));
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].values.find(v => v.field === 'isBlocked').value, true);
  assert.equal(recorder.isBusy(), false);
});

test('ARD: userId aus dem idToken nur für api.ardmediathek.de', () => {
  const provider = createArdProvider({ net: {} });
  const record = { accessToken: fakeJwt({ user_id: 'uid1234567' }) };
  assert.equal(userIdFromToken(record.accessToken), 'uid1234567');
  assert.equal(provider.personalizeUrl('https://api.ardmediathek.de/page-gateway/pages/ard/item/abc?devicetype=pc', record), 'https://api.ardmediathek.de/page-gateway/pages/ard/item/abc?devicetype=pc&userId=uid1234567');
  assert.equal(provider.personalizeUrl('https://example.com/a', record), 'https://example.com/a');
  assert.equal(provider.personalizeUrl('https://api.ardmediathek.de/x', { accessToken: 'kaputt' }), 'https://api.ardmediathek.de/x');
  assert.equal(userIdFromToken(fakeJwt({ user_id: 'bad id!' })), null);
});
