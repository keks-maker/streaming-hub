'use strict';

// Tests: Konten-Module (arte, ard) mit Fake-Netz und Fixtures, Konten-Dienst (Status, Auffrischung, Hostbindung der Kopfzeilen,
// Anmelden/Abmelden/Testen, PIN-Regeln). Kein Netz, kein Electron, kein echter Login.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthStore } = require('../lib/mediathek/auth/store.js');
const { createArteProvider, parseOidcEntries, REALM, TOKEN_ENDPOINT } = require('../lib/mediathek/auth/arte.js');
const { createArdProvider, FIREBASE_API_KEY } = require('../lib/mediathek/auth/ard.js');
const { createMediathekAuth } = require('../lib/mediathek/auth/index.js');
const { createAuthNet } = require('../lib/mediathek/auth/net.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const key = client => `oidc.user:${REALM}:${client}`;
const user = over => JSON.stringify({ access_token: 'arte-access', refresh_token: 'arte-refresh', expires_at: NOW / 1000 + 300, token_type: 'Bearer', profile: { sub: 'u' }, ...over });

function fakeNet(handlers = {}) {
  const calls = [];
  return {
    calls,
    postJson: async (url, body) => {
      calls.push({ kind: 'json', url, body });
      return handlers.postJson ? handlers.postJson(url, body) : {};
    },
    postForm: async (url, fields) => {
      calls.push({ kind: 'form', url, fields });
      return handlers.postForm ? handlers.postForm(url, fields) : {};
    },
  };
}

const rejectedError = () => Object.assign(new Error('x'), { code: 'rejected', status: 400 });
const networkError = () => Object.assign(new Error('x'), { code: 'network' });

// ── arte ──

test('arte: angemeldeter Nutzer aus oidc.user, anonyme Einträge und fremde Realms werden ignoriert', () => {
  const entries = [
    { key: key('anon-client'), value: user({ refresh_token: undefined, access_token: 'anon' }) },
    { key: 'oidc.user:https://fremd.example/realm:web', value: user({ access_token: 'fremd' }) },
    { key: key('web-client'), value: user() },
    { key: key('kaputt'), value: '{nicht json' },
  ];
  const record = parseOidcEntries(JSON.stringify(entries), NOW);
  assert.equal(record.accessToken, 'arte-access');
  assert.equal(record.refreshToken, 'arte-refresh');
  assert.equal(record.clientId, 'web-client');
  assert.equal(record.expiresAt, NOW + 300000);
  assert.equal(record.state, 'ok');
  assert.equal(parseOidcEntries('[]', NOW), null);
  assert.equal(parseOidcEntries('kein json', NOW), null);
});

test('arte: Ablauf ohne expires_at kommt aus dem JWT', () => {
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: NOW / 1000 + 900 })).toString('base64url')}.s`;
  const record = parseOidcEntries(JSON.stringify([{ key: key('c'), value: user({ expires_at: undefined, access_token: jwt }) }]), NOW);
  assert.equal(record.expiresAt, NOW + 900000);
});

test('arte: collect liest nur auf www.arte.tv (nicht auf der Login-Seite id.arte.tv)', async () => {
  const provider = createArteProvider({ net: fakeNet(), now: () => NOW });
  let reads = 0;
  const page = url => ({ url, executeJavaScript: async code => { reads += 1; assert.match(code, /oidc\.user:/); return JSON.stringify([{ key: key('c'), value: user() }]); } });
  assert.equal(await provider.collect(page('https://id.arte.tv/auth/realms/myarte-prod/login')), null);
  assert.equal(await provider.collect(page('http://www.arte.tv/de/')), null);
  assert.equal(reads, 0);
  assert.equal((await provider.collect(page('https://www.arte.tv/de/'))).accessToken, 'arte-access');
});

test('arte: Auffrischung am Token-Endpunkt mit refresh_token und client_id, Rotation wird übernommen', async () => {
  const net = fakeNet({ postForm: () => ({ access_token: 'neu', refresh_token: 'neu-r', expires_in: 600 }) });
  const provider = createArteProvider({ net, now: () => NOW });
  const next = await provider.refresh({ accessToken: 'alt', refreshToken: 'alt-r', expiresAt: 1, since: 5, state: 'ok', clientId: 'web-client' });
  assert.deepEqual(net.calls[0], { kind: 'form', url: TOKEN_ENDPOINT, fields: { grant_type: 'refresh_token', client_id: 'web-client', refresh_token: 'alt-r' } });
  assert.equal(next.accessToken, 'neu');
  assert.equal(next.refreshToken, 'neu-r');
  assert.equal(next.expiresAt, NOW + 600000);
  assert.equal(next.since, 5);
  await assert.rejects(() => provider.refresh({ accessToken: 'a', refreshToken: null, clientId: 'c' }), { code: 'rejected' });
  const empty = createArteProvider({ net: fakeNet({ postForm: () => ({}) }), now: () => NOW });
  await assert.rejects(() => empty.refresh({ accessToken: 'a', refreshToken: 'r', clientId: 'c' }), { code: 'rejected' });
});

test('arte: Kopfzeile Authorization Bearer, Token nur an api.arte.tv', () => {
  const provider = createArteProvider({ net: fakeNet() });
  assert.deepEqual(provider.headers({ accessToken: 'T' }), { Authorization: 'Bearer T' });
  assert.deepEqual(provider.tokenHosts, ['api.arte.tv']);
});

// ── ARD ──

test('ARD: Kette sso/token -> customToken -> Firebase signInWithCustomToken', async () => {
  const net = fakeNet({ postJson: () => ({ idToken: 'ID', refreshToken: 'FR', expiresIn: '3600' }) });
  const provider = createArdProvider({ net, now: () => NOW });
  const scripts = [];
  const page = { url: 'https://www.ardmediathek.de/', executeJavaScript: async code => { scripts.push(code); return 'CUSTOM'; } };
  const record = await provider.collect(page);
  assert.match(scripts[0], /sso\.ardmediathek\.de\/sso\/token/);
  assert.equal(net.calls[0].url, `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`);
  assert.deepEqual(net.calls[0].body, { token: 'CUSTOM', returnSecureToken: true });
  assert.deepEqual(record, { accessToken: 'ID', refreshToken: 'FR', expiresAt: NOW + 3600000, since: NOW, state: 'ok', clientId: null });
});

test('ARD: ohne customToken (noch nicht angemeldet) oder auf fremder Seite kein Firebase-Aufruf', async () => {
  const net = fakeNet();
  const provider = createArdProvider({ net, now: () => NOW });
  assert.equal(await provider.collect({ url: 'https://www.ardmediathek.de/', executeJavaScript: async () => null }), null);
  assert.equal(await provider.collect({ url: 'https://accounts.ard.de/', executeJavaScript: async () => 'X' }), null);
  assert.equal(net.calls.length, 0);
});

test('ARD: Auffrischung über securetoken, Kopfzeile X-Authorization', async () => {
  const net = fakeNet({ postForm: () => ({ id_token: 'ID2', refresh_token: 'FR2', expires_in: '3600' }) });
  const provider = createArdProvider({ net, now: () => NOW });
  const next = await provider.refresh({ accessToken: 'ID', refreshToken: 'FR', expiresAt: 1, since: 7, state: 'ok', clientId: null });
  assert.equal(net.calls[0].url, `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`);
  assert.deepEqual(net.calls[0].fields, { grant_type: 'refresh_token', refresh_token: 'FR' });
  assert.equal(next.accessToken, 'ID2');
  assert.equal(next.since, 7);
  assert.deepEqual(provider.headers(next), { 'X-Authorization': 'Bearer ID2' });
  assert.deepEqual(provider.tokenHosts, ['api.ardmediathek.de']);
  assert.equal(provider.pinBinding, null, 'PIN-Aufruf unbelegt: wird nie gesendet');
});

// ── Auth-Netz ──

test('Auth-Netz: nur feste https-Hosts, POST, keine Weiterleitung, Fehler ohne Adresse/Antwort', async () => {
  const seen = [];
  const net = createAuthNet({ fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 200, text: async () => '{"ok":1}' }; } });
  assert.deepEqual(await net.postJson('https://securetoken.googleapis.com/v1/token?key=K', { a: 1 }), { ok: 1 });
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.redirect, 'manual');
  for (const url of ['https://evil.example/token', 'http://id.arte.tv/x', 'https://user:pw@id.arte.tv/x', 'kein url']) await assert.rejects(() => net.postForm(url, { a: '1' }), { code: 'forbidden-host' });
  const redirecting = createAuthNet({ fetchImpl: async () => ({ status: 302, text: async () => '' }) });
  await assert.rejects(() => redirecting.postForm(TOKEN_ENDPOINT, {}), { code: 'http' });
  const denied = createAuthNet({ fetchImpl: async () => ({ status: 400, text: async () => '{"error":"invalid_grant","refresh_token":"GEHEIM"}' }) });
  await assert.rejects(
    () => denied.postForm(TOKEN_ENDPOINT, { refresh_token: 'GEHEIM' }),
    error => error.code === 'rejected' && error.status === 400 && !error.message.includes('GEHEIM') && !error.message.includes('arte')
  );
  const down = createAuthNet({ fetchImpl: async () => { throw new Error('ECONNREFUSED id.arte.tv'); } });
  await assert.rejects(() => down.postForm(TOKEN_ENDPOINT, {}), error => error.code === 'network' && !error.message.includes('arte'));
});

// ── Konten-Dienst ──

function setup(over = {}) {
  const clock = { ms: NOW };
  const store = createAuthStore({ file: null, safeStorage: null });
  const net = over.net || fakeNet({ postForm: () => ({ access_token: 'frisch', refresh_token: 'frisch-r', expires_in: 600, id_token: 'ID-frisch' }) });
  const providers = { arte: createArteProvider({ net, now: () => clock.ms }), ard: createArdProvider({ net, now: () => clock.ms }) };
  const runs = [];
  const loginRunner = { run: async provider => { runs.push(provider.sender); return over.loginResult || { ok: true, record: { accessToken: `${provider.sender}-tok`, refreshToken: `${provider.sender}-ref`, expiresAt: clock.ms + 3600000, since: clock.ms, state: 'ok', clientId: 'web' } }; } };
  const cleared = [];
  const events = [];
  const auth = createMediathekAuth({ providers, store, loginRunner, clearPartition: async partition => cleared.push(partition), http: over.http || null, now: () => clock.ms, logger: { warn: () => {} } });
  auth.on('changed', status => events.push(status));
  return { auth, store, net, clock, runs, cleared, events };
}

test('Status: Zustände je Sender, ZDF nicht unterstützt, nie Token oder PIN im Status', async () => {
  const { auth, store } = setup();
  let status = auth.status();
  assert.deepEqual(status.accounts.map(a => [a.sender, a.state]), [['arte', 'signedOut'], ['ard', 'signedOut'], ['zdf', 'unsupported']]);
  assert.equal(status.accounts[0].experimental, true);
  await auth.login('arte');
  store.setPin('1234');
  status = auth.status();
  assert.equal(status.accounts[0].state, 'signedIn');
  assert.equal(status.accounts[0].since, NOW);
  assert.deepEqual(status.pin, { supported: true, set: true, enabled: false });
  const dump = JSON.stringify(status);
  for (const secret of ['arte-tok', 'arte-ref', '1234']) assert.ok(!dump.includes(secret), secret);
});

test('Anmelden: Ergebnis des Fensters wird gespeichert, Events changed/signedIn; Abbruch und ZDF melden sauber', async () => {
  const { auth, events, runs } = setup();
  const signedIn = [];
  auth.on('signedIn', sender => signedIn.push(sender));
  const ok = await auth.login('ard');
  assert.equal(ok.ok, true);
  assert.deepEqual(signedIn, ['ard']);
  assert.equal(events.length, 1);
  const zdf = await auth.login('zdf');
  assert.deepEqual([zdf.ok, zdf.code], [false, 'unsupported']);
  assert.deepEqual(runs, ['ard'], 'für ZDF öffnet sich kein Fenster');
  const cancelled = setup({ loginResult: { ok: false, code: 'cancelled' } });
  const result = await cancelled.auth.login('arte');
  assert.deepEqual([result.ok, result.code, result.message], [false, 'cancelled', 'Anmeldung abgebrochen.']);
  assert.equal(cancelled.auth.status().accounts[0].state, 'signedOut');
});

test('Abmelden: Datensatz und Partition werden gelöscht', async () => {
  const { auth, store, cleared } = setup();
  await auth.login('arte');
  await auth.logout('arte');
  assert.equal(store.get('arte'), null);
  assert.deepEqual(cleared, ['persist:mediathek-arte']);
  assert.equal(auth.status().accounts[0].state, 'signedOut');
});

test('Hostbindung: Token nur an die Hosts des Senders (https, exakt), nie an fremde Hosts', async () => {
  const { auth } = setup();
  await auth.login('arte');
  await auth.login('ard');
  assert.deepEqual(auth.getAuthHeaders('arte', 'https://api.arte.tv/api/player/v2/config/de/X'), { Authorization: 'Bearer arte-tok' });
  assert.deepEqual(auth.getAuthHeaders('ard', 'https://api.ardmediathek.de/page-gateway/pages/ard/item/1'), { 'X-Authorization': 'Bearer ard-tok' });
  const denied = [
    ['arte', 'https://api-cdn.arte.tv/x'],
    ['arte', 'https://evil.example/api.arte.tv'],
    ['arte', 'https://api.arte.tv.evil.example/x'],
    ['arte', 'http://api.arte.tv/x'],
    ['arte', 'https://user:pw@api.arte.tv/x'],
    ['arte', 'https://www.arte.tv/x'],
    ['arte', 'https://api.ardmediathek.de/x'], // Token eines Senders nie an den Host eines anderen
    ['ard', 'https://api.arte.tv/x'],
    ['ard', 'https://sub.api.ardmediathek.de/x'],
    ['ard', 'kein url'],
    ['zdf', 'https://api.zdf.de/x'],
  ];
  for (const [sender, url] of denied) assert.deepEqual(auth.getAuthHeaders(sender, url), {}, `${sender} ${url}`);
});

test('Kopfzeilen entfallen bei abgelaufenem Token, ohne Anmeldung und nach Abmelden', async () => {
  const { auth, clock } = setup();
  assert.deepEqual(auth.getAuthHeaders('arte', 'https://api.arte.tv/x'), {});
  await auth.login('arte');
  clock.ms += 3600001;
  assert.deepEqual(auth.getAuthHeaders('arte', 'https://api.arte.tv/x'), {});
  await auth.logout('arte');
  clock.ms = NOW;
  assert.deepEqual(auth.getAuthHeaders('arte', 'https://api.arte.tv/x'), {});
});

test('Auffrischung: vor Ablauf, parallele Abrufe teilen sich eine Anfrage, Datensatz bleibt (since)', async () => {
  const { auth, clock, net, store } = setup();
  await auth.login('arte');
  assert.equal(await auth.ensureFresh('arte'), true);
  assert.equal(net.calls.length, 0, 'noch lange gültig');
  clock.ms += 3600000 - 60000; // 1 Minute vor Ablauf
  const [a, b] = await Promise.all([auth.ensureFresh('arte'), auth.ensureFresh('arte')]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(net.calls.length, 1);
  assert.equal(store.get('arte').accessToken, 'frisch');
  assert.equal(store.get('arte').since, NOW);
  assert.equal(store.get('arte').clientId, 'web');
});

test('Auffrischung abgelehnt: Status "abgelaufen", keine Kopfzeile mehr, Event; Netzfehler lässt den Status unverändert', async () => {
  const rejecting = setup({ net: fakeNet({ postForm: () => { throw rejectedError(); } }) });
  await rejecting.auth.login('arte');
  rejecting.clock.ms += 3600000 - 60000;
  assert.equal(await rejecting.auth.ensureFresh('arte'), false);
  assert.equal(rejecting.auth.accountState('arte'), 'expired');
  assert.equal(rejecting.auth.status().accounts[0].since, null);
  assert.deepEqual(rejecting.auth.getAuthHeaders('arte', 'https://api.arte.tv/x'), {});
  assert.equal(rejecting.store.get('arte').refreshToken, null);
  assert.ok(rejecting.events.length >= 2);
  const offline = setup({ net: fakeNet({ postForm: () => { throw networkError(); } }) });
  await offline.auth.login('arte');
  offline.clock.ms += 3600000 - 60000;
  assert.equal(await offline.auth.ensureFresh('arte'), true, 'Token gilt noch eine Minute');
  assert.equal(offline.auth.accountState('arte'), 'signedIn');
});

test('401 des Anbieters (reportUnauthorized) setzt "abgelaufen"; erneutes Anmelden stellt wieder her', async () => {
  const { auth } = setup();
  await auth.login('ard');
  auth.reportUnauthorized('ard');
  assert.equal(auth.accountState('ard'), 'expired');
  assert.equal(auth.isSignedIn('ard'), false);
  await auth.login('ard');
  assert.equal(auth.accountState('ard'), 'signedIn');
});

test('Freischaltung testen: gültig, abgemeldet, abgelaufen, Netzfehler; ARD zusätzlich mit personalisiertem Abruf', async () => {
  const calls = [];
  let httpOutcome = 'ok';
  const http = { getText: async (url, options) => { calls.push([url, options]); if (httpOutcome === '401') throw Object.assign(new Error('x'), { code: 'http', status: 401 }); if (httpOutcome === 'net') throw Object.assign(new Error('x'), { code: 'network' }); return '{}'; } };
  const { auth } = setup({ http });
  assert.equal((await auth.test('arte')).code, 'signedOut');
  assert.equal((await auth.test('zdf')).code, 'unsupported');
  await auth.login('arte');
  const arte = await auth.test('arte');
  assert.deepEqual([arte.ok, arte.code], [true, 'valid']);
  assert.equal(calls.length, 0, 'arte: nur Token-Gültigkeit');
  await auth.login('ard');
  assert.equal((await auth.test('ard')).ok, true);
  assert.deepEqual(calls[0], ['https://api.ardmediathek.de/page-gateway/pages/ard/home?embedded=true', { auth: 'ard' }]);
  httpOutcome = '401';
  assert.equal((await auth.test('ard')).code, 'expired');
  httpOutcome = 'net';
  assert.equal((await auth.test('ard')).code, 'network');
  auth.reportUnauthorized('arte');
  assert.equal((await auth.test('arte')).code, 'expired');
});

test('PIN: nie ohne belegten Aufruf (pinBinding), nur mit Schalter, nur angemeldet', async () => {
  const { auth, store } = setup();
  await auth.login('ard');
  auth.setPin('4321');
  auth.setPinEnabled(true);
  assert.equal(auth.getPinFor('ard', 'https://api.ardmediathek.de/anything'), null, 'ARD-Mechanik ungeklärt: keine Bindung, keine PIN');
  assert.equal(store.getPin(), '4321');
  assert.ok(!JSON.stringify(auth.status()).includes('4321'));
  // Mit (hypothetisch) belegtem Aufruf: nur bei Schalter, Treffer und Anmeldung
  const net = fakeNet();
  const bound = createArdProvider({ net });
  bound.pinBinding = { matches: url => url.startsWith('https://api.ardmediathek.de/pin') };
  const store2 = createAuthStore({ file: null, safeStorage: null });
  const auth2 = createMediathekAuth({ providers: { ard: bound }, store: store2, loginRunner: { run: async () => ({ ok: true, record: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600000, since: 1, state: 'ok' } }) } });
  await auth2.login('ard');
  auth2.setPin('4321');
  assert.equal(auth2.getPinFor('ard', 'https://api.ardmediathek.de/pin/x'), null, 'Schalter aus');
  auth2.setPinEnabled(true);
  assert.equal(auth2.getPinFor('ard', 'https://api.ardmediathek.de/pin/x'), '4321');
  assert.equal(auth2.getPinFor('ard', 'https://api.ardmediathek.de/andere'), null);
  assert.equal(auth2.getPinFor('arte', 'https://api.ardmediathek.de/pin/x'), null);
  auth2.clearPin();
  assert.equal(auth2.getPinFor('ard', 'https://api.ardmediathek.de/pin/x'), null);
});
