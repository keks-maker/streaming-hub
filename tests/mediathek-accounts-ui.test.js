'use strict';

// Tests: Konten-Seite. Modell (Texte, Knöpfe), Ansicht mit Fake-DOM und Attrappe für window.mediathek.accounts, IPC
// (Absenderprüfung, Validierung, nie Token in Antworten, Event) und die Verdrahtung (Seite, Navigation, Preload-Kanäle).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describeAccount, sinceText, GENERAL_HINT } = require('../settings-mediathek-accounts-model.js');
const { createMediathekAccountsView } = require('../settings-mediathek-accounts.js');
const { registerAccountsIpc, validateSender } = require('../lib/mediathek/auth/ipc.js');
const { isValidPage } = require('../settings-view.js');
const { makeDoc } = require('./helpers/fake-dom.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function status(over = {}) {
  return {
    persistent: true,
    accounts: [
      { sender: 'arte', name: 'arte', experimental: true, state: 'signedOut', since: null },
      { sender: 'ard', name: 'ARD', experimental: true, state: 'signedOut', since: null },
      { sender: 'zdf', name: 'ZDF', experimental: true, state: 'unsupported', since: null },
    ],
    ...over,
  };
}

// ── Modell ──

test('Modell: Status, Knöpfe und Texte je Zustand', () => {
  const out = describeAccount({ sender: 'arte', name: 'arte', experimental: true, state: 'signedOut' });
  assert.deepEqual([out.statusText, out.canLogin, out.canLogout, out.canTest, out.loginLabel, out.badge], ['Nicht angemeldet', true, false, false, 'Anmelden', 'experimentell']);
  const since = Date.parse('2026-10-20T10:05:00');
  const inn = describeAccount({ sender: 'ard', name: 'ARD', experimental: true, state: 'signedIn', since });
  assert.match(inn.statusText, /^Angemeldet seit 20\.10\.2026, 10:05 Uhr$/);
  assert.deepEqual([inn.canLogin, inn.canLogout, inn.canTest, inn.statusKind], [false, true, true, 'ok']);
  const expired = describeAccount({ sender: 'ard', name: 'ARD', experimental: true, state: 'expired' });
  assert.deepEqual([expired.statusText, expired.loginLabel, expired.canLogin, expired.canLogout, expired.canTest, expired.statusKind], ['Anmeldung abgelaufen', 'Erneut anmelden', true, true, false, 'warn']);
  const zdf = describeAccount({ sender: 'zdf', name: 'ZDF', experimental: true, state: 'unsupported' });
  assert.equal(zdf.hint, 'ZDF: noch nicht unterstützt (folgt).');
  assert.deepEqual([zdf.canLogin, zdf.canLogout, zdf.canTest, zdf.supported], [false, false, false, false]);
  assert.equal(describeAccount({ sender: 'arte', name: 'arte', state: 'signedIn', since }, { busy: true }).canLogout, false, 'während eines Vorgangs gesperrt');
  assert.equal(sinceText(0), 'Angemeldet');
  assert.match(GENERAL_HINT, /Passwort[^.]*nie/);
  assert.match(GENERAL_HINT, /experimentell/);
});

// ── Ansicht ──

function makeAccounts(initial = status()) {
  const calls = [];
  let listener = null;
  const api = {
    calls,
    status: async () => initial,
    login: async sender => { calls.push(['login', sender]); initial = status({ accounts: initial.accounts.map(a => (a.sender === sender ? { ...a, state: 'signedIn', since: 1700000000000 } : a)) }); return api.loginResult || { ok: true, status: initial }; },
    logout: async sender => { calls.push(['logout', sender]); initial = status({ accounts: initial.accounts.map(a => (a.sender === sender ? { ...a, state: 'signedOut', since: null } : a)) }); return { ok: true, status: initial }; },
    test: async sender => { calls.push(['test', sender]); return api.testResult || { ok: true, code: 'valid', message: 'Anmeldung gültig.' }; },
    onChanged: cb => { listener = cb; },
    emit: next => listener(next),
  };
  return api;
}

function mount(accounts) {
  const doc = makeDoc();
  const root = doc.createElement('div');
  root.ownerDocument = doc;
  const view = createMediathekAccountsView(root, { mediathek: { accounts }, logger: { warn() {} } });
  return { root, view };
}

const button = (root, sender, action) => root.byId(`settingsMediathekAccount-${sender}-${action}`);
const statusText = root => root.byId('settingsMediathekAccountsStatus').textContent;

test('Ansicht: Karte je Sender mit Status, Knöpfen, experimentell-Kennzeichnung; ZDF ohne Knöpfe', async () => {
  const accounts = makeAccounts();
  const { root, view } = mount(accounts);
  await view.refresh();
  const cards = root.byClass('settings-account-card');
  assert.deepEqual(cards.map(card => card.dataset.sender), ['arte', 'ard', 'zdf']);
  assert.equal(root.byId('settingsMediathekAccount-arte-state').textContent, 'Nicht angemeldet');
  assert.equal(button(root, 'arte', 'login').disabled, false);
  assert.equal(button(root, 'arte', 'logout').disabled, true);
  assert.equal(button(root, 'arte', 'test').disabled, true);
  assert.equal(root.byClass('settings-badge')[0].hidden, false);
  assert.equal(button(root, 'zdf', 'login').hidden, true);
  assert.equal(root.byId('settingsMediathekAccount-zdf-state').textContent, 'Noch nicht unterstützt (folgt)');
  assert.ok(cards[2].textContent.includes('ZDF: noch nicht unterstützt (folgt).'));
  assert.ok(root.textContent.includes('verschlüsselt gespeichert'));
  assert.equal(button(root, 'arte', 'login').getAttribute('aria-describedby'), 'settingsMediathekAccount-arte-state', 'a11y: Status beschreibt den Knopf');
  assert.equal(root.byId('settingsMediathekAccountsStatus').getAttribute('role'), 'status');
});

test('Ansicht: Anmelden, Testen, Abmelden mit Rückmeldung', async () => {
  const accounts = makeAccounts();
  const { root, view } = mount(accounts);
  await view.refresh();
  button(root, 'arte', 'login').click();
  await tick();
  await tick();
  assert.deepEqual(accounts.calls[0], ['login', 'arte']);
  assert.match(root.byId('settingsMediathekAccount-arte-state').textContent, /^Angemeldet seit /);
  assert.equal(button(root, 'arte', 'logout').disabled, false);
  assert.match(statusText(root), /Angemeldet\./);
  button(root, 'arte', 'test').click();
  await tick();
  await tick();
  assert.equal(statusText(root), 'Anmeldung gültig.');
  accounts.testResult = { ok: false, code: 'expired', message: 'Anmeldung abgelaufen. Bitte neu anmelden.' };
  button(root, 'arte', 'test').click();
  await tick();
  await tick();
  assert.equal(statusText(root), 'Anmeldung abgelaufen. Bitte neu anmelden.');
  assert.equal(root.byId('settingsMediathekAccountsStatus').classList.contains('error'), true);
  button(root, 'arte', 'logout').click();
  await tick();
  await tick();
  assert.equal(root.byId('settingsMediathekAccount-arte-state').textContent, 'Nicht angemeldet');
  assert.match(statusText(root), /Abgemeldet/);
});

test('Ansicht: abgebrochene Anmeldung zeigt die Meldung als Fehler; Änderungs-Event aktualisiert die Karten', async () => {
  const accounts = makeAccounts();
  accounts.loginResult = { ok: false, code: 'cancelled', message: 'Anmeldung abgebrochen.' };
  const { root, view } = mount(accounts);
  await view.refresh();
  button(root, 'ard', 'login').click();
  await tick();
  await tick();
  assert.equal(statusText(root), 'Anmeldung abgebrochen.');
  assert.equal(root.byId('settingsMediathekAccountsStatus').classList.contains('error'), true);
  accounts.emit(status({ accounts: status().accounts.map(a => (a.sender === 'ard' ? { ...a, state: 'expired' } : a)) }));
  assert.equal(root.byId('settingsMediathekAccount-ard-state').textContent, 'Anmeldung abgelaufen');
  assert.equal(button(root, 'ard', 'login').textContent, 'Erneut anmelden');
});

test('Ansicht: kein PIN-Feld und keine Diagnose-Aufzeichnung', async () => {
  const { root, view } = mount(makeAccounts());
  await view.refresh();
  assert.equal(root.byId('settingsMediathekAccountsPinInput'), null);
  assert.equal(root.byId('settingsMediathekAccount-ard-diagnose'), null);
});

test('Ansicht: Ladefehler wird als Fehlermeldung gezeigt', async () => {
  const accounts = makeAccounts();
  accounts.status = async () => { throw new Error("Error invoking remote method 'x': Error: kaputt"); };
  const { root, view } = mount(accounts);
  await view.refresh();
  assert.equal(root.byId('settingsMediathekAccountsStatus').classList.contains('error'), true);
});

// ── IPC ──

function ipcSetup() {
  const handlers = new Map();
  const sent = [];
  const listeners = {};
  const calls = [];
  const fakeStatus = { persistent: true, accounts: [] };
  const auth = {
    status: () => fakeStatus,
    login: async sender => { calls.push(['login', sender]); return { ok: true, status: fakeStatus }; },
    logout: async sender => { calls.push(['logout', sender]); return { ok: true, status: fakeStatus }; },
    test: async sender => { calls.push(['test', sender]); return { ok: true, code: 'valid', message: 'ok' }; },
    on: (event, fn) => { listeners[event] = fn; },
  };
  registerAccountsIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    auth,
    requireMainRenderer: event => { if (event.sender !== 'main') throw new Error('nicht autorisiert'); },
    sendToMain: (channel, payload) => sent.push([channel, payload]),
  });
  return { handlers, sent, listeners, calls, call: (channel, ...args) => handlers.get(channel)({ sender: 'main' }, ...args) };
}

test('IPC: alle Kanäle nur für das Hauptfenster, Event wird weitergereicht', async () => {
  const { handlers, listeners, sent } = ipcSetup();
  const channels = ['status', 'login', 'logout', 'test'].map(name => `mediathek:accounts-${name}`);
  assert.deepEqual([...handlers.keys()].sort(), channels.sort());
  for (const channel of channels) assert.throws(() => handlers.get(channel)({ sender: 'webview' }, {}), /nicht autorisiert/, channel);
  listeners.changed({ accounts: [] });
  assert.deepEqual(sent, [['mediathek:accounts-changed', { accounts: [] }]]);
});

test('IPC: Validierung und Ergebnisse (Zustände, nie Token)', async () => {
  const { call, calls } = ipcSetup();
  assert.equal((await call('mediathek:accounts-status')).ok, true);
  assert.throws(() => call('mediathek:accounts-status', { x: 1 }), /Unerwartete Eingabe/);
  for (const bad of [undefined, null, 'arte', {}, { sender: 'rtl' }, { sender: 'arte', extra: 1 }, { sender: ['arte'] }]) assert.throws(() => call('mediathek:accounts-login', bad), undefined, JSON.stringify(bad));
  await call('mediathek:accounts-login', { sender: 'arte' });
  await call('mediathek:accounts-login', { sender: 'zdf' }); // wird vom Dienst als "nicht unterstützt" beantwortet
  await call('mediathek:accounts-logout', { sender: 'ard' });
  await call('mediathek:accounts-test', { sender: 'ard' });
  assert.deepEqual(calls, [['login', 'arte'], ['login', 'zdf'], ['logout', 'ard'], ['test', 'ard']]);
  assert.equal(validateSender({ sender: 'ard' }), 'ard');
});

// ── Verdrahtung ──

test('Verdrahtung: Seite, Navigation, Renderer und Preload-Whitelist', () => {
  const html = read('index.html');
  assert.match(html, /data-settings-page="mediathek-accounts"/);
  assert.match(html, /id="settingsMediathekAccountsRoot"/);
  assert.ok(isValidPage('mediathek-accounts'));
  assert.match(read('renderer.js'), /page === 'mediathek-accounts'\) settingsMediathekAccountsView\.refresh\(\)/);
  const preload = read('preload.js');
  for (const channel of ['status', 'login', 'logout', 'test']) assert.ok(preload.includes(`'mediathek:accounts-${channel}'`), channel);
  assert.ok(preload.includes("radioListener('mediathek:accounts-changed')"));
  const block = preload.slice(preload.indexOf('accounts: {'), preload.indexOf('accounts: {') + 900);
  assert.ok(!/token|password|passwort/i.test(block), 'keine Token-/Passwort-Kanäle im Preload');
});

test('Sicherheit: Anmeldefenster-Modul ohne Preload/Bridge und ohne Passwortverarbeitung', () => {
  const login = read('lib/mediathek/auth/login-window.js');
  assert.ok(!/preload\s*:/.test(login));
  assert.ok(!/nodeIntegration:\s*true|sandbox:\s*false|contextIsolation:\s*false/.test(login));
  for (const file of ['lib/mediathek/auth/index.js', 'lib/mediathek/auth/ard.js', 'lib/mediathek/auth/arte.js', 'lib/mediathek/auth/login-window.js', 'lib/mediathek/auth/store.js']) {
    assert.ok(!/console\.(log|info|debug)/.test(read(file)), `${file}: keine Konsolenausgabe`);
    assert.ok(!/logger\.\w+\([^)]*(accessToken|refreshToken|customToken|idToken|\.pin\b)/.test(read(file)), `${file}: Token nicht im Log`);
  }
});
