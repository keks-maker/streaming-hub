'use strict';

// Tests: arte-Token-Auffrischung (Keycloak, erfundene Fixtures, kein Netz): abgelaufen + Refresh ok, Rotation, Refresh 400 mit/ohne
// Wiederherstellung der Web-Sitzung, Netz-/Serverfehler ohne "abgelaufen", Doppelaufruf, unsichtbares Sitzungsfenster, Meldungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthStore } = require('../lib/mediathek/auth/store.js');
const { createArteProvider } = require('../lib/mediathek/auth/arte.js');
const { createMediathekAuth } = require('../lib/mediathek/auth/index.js');
const { createSilentSessionRunner } = require('../lib/mediathek/auth/silent-session.js');
const { accountNote } = require('../lib/mediathek/restrictions.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const rejected = status => Object.assign(new Error('x'), { code: 'rejected', status });
const record = over => ({ accessToken: 'alt', refreshToken: 'alt-r', expiresAt: NOW - 1000, since: NOW - 5000, state: 'ok', clientId: 'replay', ...over });

function setup({ postForm, silent = null } = {}) {
  const clock = { ms: NOW };
  const calls = [];
  const net = { postForm: async (url, fields) => { calls.push(fields); return postForm(fields); }, postJson: async () => ({}) };
  const store = createAuthStore({ file: null, safeStorage: null });
  const logs = [];
  const silentCalls = [];
  const silentRunner = silent ? { run: async provider => { silentCalls.push(provider.sender); return silent(); } } : null;
  const auth = createMediathekAuth({
    providers: { arte: createArteProvider({ net, now: () => clock.ms }) },
    store,
    loginRunner: { run: async () => ({ ok: false, code: 'cancelled' }) },
    silentRunner,
    now: () => clock.ms,
    logger: { warn: message => logs.push(message) },
  });
  store.set('arte', record());
  return { auth, store, clock, calls, logs, silentCalls };
}

test('arte: abgelaufener Token wird mit refresh_token aufgefrischt, Rotation gespeichert, Anmeldung bleibt', async () => {
  const { auth, store, calls } = setup({ postForm: () => ({ access_token: 'neu', refresh_token: 'neu-r', expires_in: 300 }) });
  assert.equal(auth.tokenUsable('arte'), false);
  assert.equal(await auth.ensureFresh('arte'), true);
  assert.equal(calls[0].scope, 'openid');
  assert.equal(calls[0].client_id, 'replay');
  assert.equal(store.get('arte').accessToken, 'neu');
  assert.equal(store.get('arte').refreshToken, 'neu-r', 'rotierter Refresh-Token gespeichert');
  assert.equal(auth.accountState('arte'), 'signedIn');
  assert.deepEqual(auth.getAuthHeaders('arte', 'https://api.arte.tv/api/player/v2/config/de/1'), { Authorization: 'Bearer neu' });
});

test('arte: Doppelaufruf teilt sich eine Auffrischung (nie zwei Refreshs mit demselben Token)', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const { auth, calls } = setup({ postForm: async () => { await gate; return { access_token: 'neu', refresh_token: 'neu-r', expires_in: 300 }; } });
  const both = Promise.all([auth.ensureFresh('arte'), auth.ensureFresh('arte')]);
  release();
  assert.deepEqual(await both, [true, true]);
  assert.equal(calls.length, 1);
});

test('arte: Refresh 400 (invalid_grant) und Sitzung der Seite vorhanden -> Datensatz erneuert, nicht abgelaufen', async () => {
  const { auth, store, silentCalls } = setup({
    postForm: () => { throw rejected(400); },
    silent: () => record({ accessToken: 'seite', refreshToken: 'seite-r', expiresAt: NOW + 300000, since: NOW }),
  });
  assert.equal(await auth.ensureFresh('arte'), true);
  assert.deepEqual(silentCalls, ['arte']);
  assert.equal(store.get('arte').accessToken, 'seite');
  assert.equal(store.get('arte').since, NOW - 5000, 'since bleibt');
  assert.equal(auth.accountState('arte'), 'signedIn');
});

test('arte: Refresh 400 und keine Sitzung mehr -> abgelaufen (Status im Log, kein Token)', async () => {
  const { auth, logs, store } = setup({ postForm: () => { throw rejected(400); }, silent: () => null });
  assert.equal(await auth.ensureFresh('arte'), false);
  assert.equal(auth.accountState('arte'), 'expired');
  assert.deepEqual(auth.refreshFailure('arte'), { kind: 'rejected', status: 400 });
  assert.ok(logs.some(line => line.includes('HTTP 400')));
  assert.ok(!logs.join('\n').includes('alt-r') && !logs.join('\n').includes('alt'.concat('-r')));
  assert.equal(store.get('arte').refreshToken, null);
});

test('arte: Refresh 400 ohne Wiederherstellungs-Runner (Testmodus) -> abgelaufen', async () => {
  const { auth } = setup({ postForm: () => { throw rejected(400); } });
  assert.equal(await auth.ensureFresh('arte'), false);
  assert.equal(auth.accountState('arte'), 'expired');
});

test('arte: Netz-/Serverfehler, 429/403 und Fehler des Sitzungsfensters machen NICHT "abgelaufen"', async () => {
  for (const failure of [Object.assign(new Error('x'), { code: 'network' }), Object.assign(new Error('x'), { code: 'http', status: 503 }), rejected(429), rejected(403)]) {
    const { auth, silentCalls } = setup({ postForm: () => { throw failure; }, silent: () => null });
    assert.equal(await auth.ensureFresh('arte'), false);
    assert.equal(auth.accountState('arte'), 'signedIn');
    assert.deepEqual(silentCalls, [], 'ohne Ablehnung des Tokens kein Fenster');
    assert.equal(auth.refreshFailure('arte').kind, 'network');
  }
  const { auth } = setup({ postForm: () => { throw rejected(400); }, silent: () => { throw Object.assign(new Error('x'), { code: 'fenster' }); } });
  assert.equal(await auth.ensureFresh('arte'), false);
  assert.equal(auth.accountState('arte'), 'signedIn');
});

test('arte: Doppelaufruf bei verworfenem Token startet nur ein Sitzungsfenster', async () => {
  const { auth, silentCalls } = setup({ postForm: () => { throw rejected(400); }, silent: () => new Promise(done => setTimeout(() => done(null), 10)) });
  await Promise.all([auth.ensureFresh('arte'), auth.ensureFresh('arte')]);
  assert.equal(silentCalls.length, 1);
});

test('arte: 401 der API erzwingt eine Auffrischung, die Anmeldung bleibt', async () => {
  const { auth, clock, store } = setup({ postForm: () => ({ access_token: 'neu', refresh_token: 'neu-r', expires_in: 300 }) });
  store.set('arte', record({ expiresAt: clock.ms + 300000 }));
  assert.equal(auth.tokenUsable('arte'), true);
  auth.reportUnauthorized('arte');
  assert.equal(auth.accountState('arte'), 'signedIn');
  assert.equal(auth.tokenUsable('arte'), false);
  assert.equal(await auth.ensureFresh('arte'), true);
  assert.equal(auth.tokenUsable('arte'), true);
});

// ── Sitzungsfenster ──

function fakeWindow(read) {
  const state = { destroyed: false, url: 'about:blank', loaded: [] };
  const win = { isDestroyed: () => state.destroyed, destroy: () => { state.destroyed = true; } };
  const contents = {
    loadURL: async url => { state.loaded.push(url); state.url = url; },
    getURL: () => state.url,
    isDestroyed: () => state.destroyed,
    close: () => {},
    executeJavaScript: async () => read(),
  };
  return { state, open: (_provider, _title, options) => { state.options = options; return { win, contents }; } };
}

const oidcJson = over => JSON.stringify([{ key: 'oidc.user:https://id.arte.tv/auth/realms/myarte-prod:replay', value: JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: NOW / 1000 + 300, ...over }) }]);

test('Sitzungsfenster: liest frischen Datensatz, ist unsichtbar (silent), lädt nur die Startseite und wird geschlossen', async () => {
  const fake = fakeWindow(() => oidcJson());
  const provider = createArteProvider({ net: {}, now: () => NOW });
  const runner = createSilentSessionRunner({ openProviderWindow: fake.open, now: () => NOW, pollMs: 1, timeoutMs: 50 });
  // Zeit läuft nicht: der Abbruch kommt über den Treffer
  const result = await runner.run(provider);
  assert.equal(result.accessToken, 'a');
  assert.deepEqual(fake.state.loaded, ['https://www.arte.tv/de/']);
  assert.deepEqual(fake.state.options, { silent: true });
  assert.equal(fake.state.destroyed, true);
});

test('Sitzungsfenster: nur veralteter Datensatz bzw. keine Sitzung -> null nach Zeitlimit, Fenster geschlossen', async () => {
  for (const read of [() => oidcJson({ expires_at: NOW / 1000 + 10 }), () => '[]']) {
    const fake = fakeWindow(read);
    let clock = NOW;
    const runner = createSilentSessionRunner({ openProviderWindow: fake.open, now: () => (clock += 20), pollMs: 1, timeoutMs: 100 });
    assert.equal(await runner.run(createArteProvider({ net: {}, now: () => NOW })), null);
    assert.equal(fake.state.destroyed, true);
  }
});

// ── Meldungen ──

test('Meldungen: "abgelaufen" nur mit Hinweis auf Neuanmeldung; rejected/network/error nennen HTTP-Status ohne Token', () => {
  assert.match(accountNote('Sperre.', 'rejected', 'arte', 401), /^arte akzeptiert die Anmeldung nicht \(HTTP 401\)/);
  assert.match(accountNote('Sperre.', 'rejected', 'zdf', 403), /^ZDF akzeptiert/);
  assert.match(accountNote('Sperre.', 'network', 'arte', 503), /HTTP 503/);
  assert.match(accountNote('Sperre.', 'error', 'arte', 500), /\(HTTP 500\)/);
  assert.match(accountNote('Sperre.', 'expired', 'arte'), /^Anmeldung abgelaufen/);
});
