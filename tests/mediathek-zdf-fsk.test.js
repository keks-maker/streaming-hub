'use strict';

// Tests: ZDF-Konto und Jugendschutz. Provider (Sitzung lesen/prüfen), Netz- und Hostbindung des Tokens, gemerkte PIN im Speicher,
// FSK-Ablauf (Abrufzeitraum, Konto, Altersfreigabe, PIN, Stream-Daten mit Api-Auth), Einbindung in Service/IPC/Downloads und die
// PIN-Abfrage. Alles mit Fixtures und Ersatz-Transport, kein Netz, kein Electron, kein echter Login.

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fixture } = require('./fixtures/mediathek/index.js');
const { createZdfProvider, parseSessionToken, USERINFO_URL } = require('../lib/mediathek/auth/zdf.js');
const { createAuthNet } = require('../lib/mediathek/auth/net.js');
const { createAuthStore } = require('../lib/mediathek/auth/store.js');
const { createMediathekAuth } = require('../lib/mediathek/auth/index.js');
const { createPinPrompt, validateSubmit } = require('../lib/mediathek/auth/pin-prompt.js');
const { createLoginRunner } = require('../lib/mediathek/auth/login-window.js');
const { createE2eAuthNet } = require('../lib/mediathek/auth/e2e-login.js');
const { createZdfFsk, fskContext, validPtmdUrl, windowOpen, parseAppToken, ptmdToRoot, PIN_URL, VERIFICATION_URL } = require('../lib/mediathek/zdf-fsk.js');
const { createMediathekHttp } = require('../lib/mediathek/http.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { accountNote } = require('../lib/mediathek/restrictions.js');

const SECRET_TOKEN = 'zdf-session-token-0123456789';
const NIGHT = Date.parse('2026-10-21T21:30:00Z'); // 23:30 Berlin (MESZ)
const DAY = Date.parse('2026-10-21T10:00:00Z'); // 12:00 Berlin
const PTMD_URL = 'https://api.zdf.de/tmd/2/ios_native_4/vod/ptmd/mediathek/261007_0155_sendung_dai/4';
const APP_TOKEN = 'ahBaeMeekaiy5ohsai4bee4ki6Oopoi5quailieb';
const HOME_HTML = `<html>...\\"tokens\\":{\\"videoToken\\":{\\"apiToken\\":\\"${APP_TOKEN}\\",\\"expiresAt\\":\\"2026-10-22T14:21:34+02:00\\"},\\"appToken\\":{\\"apiToken\\":\\"other0000000000000000000\\"}}...</html>`;

const PTMD = {
  attributes: { fsk: { value: 'fsk16' } },
  priorityList: [
    { formitaeten: [{ type: 'h264_aac_ts_http_m3u8_http', mimeType: 'application/x-mpegURL', qualities: [{ quality: 'auto', audio: { tracks: [{ language: 'deu', class: 'main', uri: 'https://zdfvod.akamaized.net/a/master.m3u8' }] } }] }] },
    { formitaeten: [{ type: 'h264_aac_mp4_http_na_na', mimeType: 'video/mp4', qualities: [{ quality: 'high', audio: { tracks: [{ language: 'deu', class: 'main', uri: 'https://zdfvod.akamaized.net/a_high.mp4' }, { language: 'deu', class: 'ad', uri: 'https://zdfvod.akamaized.net/a_ad.mp4' }, { class: 'main', uri: 'ftp://nein' }] } }] }] },
  ],
  captions: [{ format: 'webvtt', language: 'deu', uri: 'https://zdfvod.akamaized.net/a.vtt' }],
};

const entry = { id: 'fsk', title: 'Nachtkrimi', sourceId: 'zdf' };

function fakeAuth(over = {}) {
  const state = { account: 'signedIn', pin: null, remembered: null, cleared: 0, usable: true, fresh: 0, ...over };
  return {
    state,
    accountState: () => state.account,
    ensureFresh: async () => { state.fresh += 1; return true; },
    tokenUsable: () => state.usable,
    getAuthHeaders: (sender, url) => (url.startsWith('https://api.zdf.de/identity/') ? { Authorization: `Bearer ${SECRET_TOKEN}`, Accept: 'x' } : {}),
    getPin: () => state.pin,
    setPin: (sender, pin) => { state.remembered = pin; return true; },
    clearPin: () => { state.cleared += 1; state.pin = null; },
    canRememberPin: () => state.canRemember !== false,
  };
}

/** Ersatz für den Mediathek-HTTP: antwortet je Adressteil; merkt sich Aufrufe samt Optionen. */
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    getText: async (url, options = {}) => {
      calls.push({ url, options });
      const key = Object.keys(routes).find(candidate => url.includes(candidate));
      if (key === undefined) throw Object.assign(new Error('x'), { code: 'network' });
      const value = typeof routes[key] === 'function' ? routes[key](url, options, calls.length) : routes[key];
      if (value instanceof Error) throw value;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
}

const httpError = status => Object.assign(new Error('x'), { code: 'http', status });
const fskRoot = (over = {}) => ({ document: { id: 'x', fsk: 'fsk16', fskCheck: true, streamApiUrlFsk: PTMD_URL, ...over } });

function makeFsk({ auth = fakeAuth(), routes = {}, pinStatus = 200, askPin = async () => ({ pin: '4711', remember: false }), now = DAY, warnings = [] } = {}) {
  const http = fakeHttp({ 'www.zdf.de/': HOME_HTML, '/fsk/verification': { verified: true }, 'ptmd/mediathek': PTMD, ...routes });
  const posts = [];
  const net = { request: async (method, url, options) => { posts.push({ method, url, options }); return typeof pinStatus === 'function' ? pinStatus() : { status: pinStatus, json: null }; } };
  const prompts = [];
  const fsk = createZdfFsk({ http, auth, net, askPin: async options => { prompts.push(options); return askPin(options); }, now: () => now, logger: { warn: message => warnings.push(message) } });
  return { fsk, http, auth, posts, prompts, warnings };
}

// ── Sitzung lesen ──

test('Sitzungstoken: Zustandsspeicher vor altem Schlüssel, ungültige Werte ergeben null', () => {
  const store = value => JSON.stringify({ store: JSON.stringify(value), legacy: null });
  assert.equal(parseSessionToken(store({ state: { sessionToken: SECRET_TOKEN }, version: 1 })), SECRET_TOKEN);
  assert.equal(parseSessionToken(store({ sessionToken: SECRET_TOKEN })), SECRET_TOKEN);
  assert.equal(parseSessionToken(JSON.stringify({ store: null, legacy: SECRET_TOKEN })), SECRET_TOKEN);
  assert.equal(parseSessionToken(JSON.stringify({ store: null, legacy: JSON.stringify(SECRET_TOKEN) })), SECRET_TOKEN, 'JSON-Zeichenkette');
  assert.equal(parseSessionToken(store({ state: { sessionToken: null } })), null, 'abgemeldet');
  assert.equal(parseSessionToken(store({ state: { sessionToken: 'kurz' } })), null);
  assert.equal(parseSessionToken(store({ state: { sessionToken: 'mit Leerzeichen im Token!' } })), null);
  assert.equal(parseSessionToken(JSON.stringify({ store: '{kaputt', legacy: SECRET_TOKEN })), SECRET_TOKEN);
  assert.equal(parseSessionToken('kein json'), null);
});

test('Provider: collect prüft die Sitzung bei ZDF; anonym, 401 und fremde Seiten ergeben null', async () => {
  const calls = [];
  let status = 200;
  const net = { request: async (method, url, options) => { calls.push({ method, url, options }); return { status, json: {} }; } };
  const provider = createZdfProvider({ net, now: () => 5000 });
  const page = (url, token = SECRET_TOKEN) => ({ url, executeJavaScript: async () => JSON.stringify({ store: JSON.stringify({ state: { sessionToken: token } }), legacy: null }) });
  assert.equal(await provider.collect(page('https://evil.example/', SECRET_TOKEN)), null);
  assert.equal(calls.length, 0, 'fremde Seite: nichts gelesen, nichts gesendet');
  assert.equal(await provider.collect(page('https://www.zdf.de/', null)), null);
  assert.equal(calls.length, 0, 'ohne Token kein Abruf');
  status = 401;
  assert.equal(await provider.collect(page('https://www.zdf.de/')), null);
  status = 200;
  const record = await provider.collect(page('https://www.zdf.de/mein-zdf'));
  assert.deepEqual({ ...record, accessToken: undefined }, { accessToken: undefined, refreshToken: null, expiresAt: 5000 + 12 * 3600 * 1000, since: 5000, state: 'ok', clientId: null });
  assert.equal(record.accessToken, SECRET_TOKEN);
  assert.deepEqual([calls[1].method, calls[1].url], ['GET', USERINFO_URL]);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${SECRET_TOKEN}`);
  status = 503;
  await assert.rejects(() => provider.collect(page('https://www.zdf.de/')), error => error.code === 'http' && error.status === 503);
});

test('Provider: Ablauf aus JWT; refresh prüft die Sitzung (200 verlängert, 401 abgelehnt, 5xx Netzproblem)', async () => {
  let status = 200;
  const net = { request: async () => ({ status, json: {} }) };
  const provider = createZdfProvider({ net, now: () => 1000 });
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: 4000 })).toString('base64url')}.s`;
  const page = { url: 'https://www.zdf.de/', executeJavaScript: async () => JSON.stringify({ store: null, legacy: jwt }) };
  assert.equal((await provider.collect(page)).expiresAt, 4000000);
  const record = { accessToken: SECRET_TOKEN, refreshToken: null, expiresAt: 0, since: 7, state: 'ok', clientId: null };
  const next = await provider.refresh(record);
  assert.deepEqual([next.since, next.accessToken, next.expiresAt], [7, SECRET_TOKEN, 1000 + 12 * 3600 * 1000]);
  status = 403;
  await assert.rejects(() => provider.refresh(record), error => error.code === 'rejected');
  status = 500;
  await assert.rejects(() => provider.refresh(record), error => error.code === 'http');
  assert.deepEqual(provider.headers(record), { Authorization: `Bearer ${SECRET_TOKEN}`, Accept: 'application/vnd.de.zdf.v1.0+json' });
});

test('Hostbindung ZDF: Token nur an api.zdf.de unter /identity/ (https, exakter Host), nicht an PTMD, Seiten oder Fremde', async () => {
  const store = createAuthStore({ file: null, safeStorage: null });
  const provider = createZdfProvider({ net: { request: async () => ({ status: 200, json: {} }) } });
  const auth = createMediathekAuth({ providers: { zdf: provider }, store, loginRunner: { run: async () => ({ ok: true, record: { accessToken: SECRET_TOKEN, refreshToken: null, expiresAt: Date.now() + 3600000, since: Date.now(), state: 'ok', clientId: null } }) } });
  assert.equal(auth.accountState('zdf'), 'signedOut');
  assert.deepEqual(auth.getAuthHeaders('zdf', 'https://api.zdf.de/identity/userinfo'), {});
  await auth.login('zdf');
  assert.equal(auth.getAuthHeaders('zdf', 'https://api.zdf.de/identity/fsk/pin').Authorization, `Bearer ${SECRET_TOKEN}`);
  for (const url of ['https://api.zdf.de/content/documents/x.json', 'https://api.zdf.de/tmd/2/x', 'https://api.zdf.de/identityx', 'https://www.zdf.de/identity/', 'https://zdf-prod-futura.zdf.de/identity/x', 'http://api.zdf.de/identity/userinfo', 'https://user:pw@api.zdf.de/identity/userinfo', 'https://api.zdf.de.evil.example/identity/x', 'https://evil.example/https://api.zdf.de/identity/x']) {
    assert.deepEqual(auth.getAuthHeaders('zdf', url), {}, url);
  }
});

// ── Netz ──

test('Auth-Netz: ZDF nur unter /identity/, Authorization nur dort, Status statt Fehler bei 4xx, andere Hosts ohne Bearer', async () => {
  const seen = [];
  let reply = { status: 200, body: '{"verified":true}' };
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { status: reply.status, text: async () => reply.body }; };
  const net = createAuthNet({ fetchImpl });
  const bearer = { Authorization: `Bearer ${SECRET_TOKEN}`, Accept: 'application/vnd.de.zdf.v1.0+json', Cookie: 'x=1' };
  assert.deepEqual(await net.request('GET', 'https://api.zdf.de/identity/fsk/verification', { headers: bearer }), { status: 200, json: { verified: true } });
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${SECRET_TOKEN}`);
  assert.equal(seen[0].init.headers.Accept, 'application/vnd.de.zdf.v1.0+json');
  assert.equal('Cookie' in seen[0].init.headers, false, 'nur Authorization und Accept');
  assert.equal(seen[0].init.redirect, 'manual');
  reply = { status: 200, body: '' };
  assert.deepEqual(await net.request('POST', 'https://api.zdf.de/identity/fsk/pin', { fields: { pin: '1234' }, headers: bearer }), { status: 200, json: null }, 'Antwort ohne Körper');
  assert.equal(seen[1].init.body, 'pin=1234');
  assert.equal(seen[1].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  reply = { status: 403, body: 'nein' };
  assert.deepEqual(await net.request('POST', 'https://api.zdf.de/identity/fsk/pin', { fields: { pin: '1' }, headers: bearer }), { status: 403, json: null });
  reply = { status: 502, body: '' };
  await assert.rejects(() => net.request('GET', 'https://api.zdf.de/identity/userinfo', { headers: bearer }), error => error.code === 'http' && error.status === 502);
  reply = { status: 302, body: '' };
  await assert.rejects(() => net.request('GET', 'https://api.zdf.de/identity/userinfo', { headers: bearer }), error => error.code === 'http', 'keine Weiterleitung');
  for (const url of ['https://api.zdf.de/content/documents/x.json', 'https://api.zdf.de/', 'http://api.zdf.de/identity/userinfo', 'https://www.zdf.de/identity/userinfo']) {
    await assert.rejects(() => net.request('GET', url, { headers: bearer }), error => error.code === 'forbidden-host', url);
  }
  await assert.rejects(() => net.request('DELETE', 'https://api.zdf.de/identity/userinfo'), error => error.code === 'forbidden-host');
  seen.length = 0;
  reply = { status: 200, body: '{}' };
  await net.postForm('https://securetoken.googleapis.com/v1/token?key=k', { a: 'b' }, bearer);
  assert.equal('Authorization' in seen[0].init.headers, false, 'nie ein Bearer an Firebase');
  await net.postForm('https://id.arte.tv/auth/realms/x/token', { a: 'b' }, bearer);
  assert.equal('Authorization' in seen[1].init.headers, false);
});

// ── Speicher: gemerkte PIN ──

function fakeSafeStorage(available = true) {
  return { isEncryptionAvailable: () => available, encryptString: text => Buffer.from(`ENC:${text}`), decryptString: buffer => String(buffer).replace(/^ENC:/, '') };
}

test('Speicher: PIN nur verschlüsselt, nur zu einem Konto, geht mit dem Konto; ohne Verschlüsselung wird nichts gemerkt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdf-pin-store-'));
  try {
    const file = path.join(dir, 'auth.bin');
    const record = { accessToken: SECRET_TOKEN, refreshToken: null, expiresAt: 9, since: 1, state: 'ok', clientId: null };
    const store = createAuthStore({ file, safeStorage: fakeSafeStorage() });
    assert.equal(store.setPin('zdf', '1234'), false, 'ohne Konto keine PIN');
    store.set('zdf', record);
    assert.equal(store.setPin('zdf', '12a4'), false);
    assert.equal(store.setPin('zdf', '123'), false);
    assert.equal(store.setPin('ard', '1234'), false, 'nur ZDF');
    assert.equal(store.setPin('zdf', '1234'), true);
    assert.equal(store.getPin('zdf'), '1234');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('1234'), 'PIN steht nicht im Klartext in der Datei');
    assert.equal(createAuthStore({ file, safeStorage: fakeSafeStorage() }).getPin('zdf'), '1234', 'überlebt Neustart');
    store.clearPin('zdf');
    assert.equal(createAuthStore({ file, safeStorage: fakeSafeStorage() }).getPin('zdf'), null);
    store.setPin('zdf', '4321');
    store.remove('zdf');
    assert.equal(store.getPin('zdf'), null);
    assert.equal(fs.existsSync(file), false, 'leere Ablage wird entfernt');
    const memory = createAuthStore({ file, safeStorage: fakeSafeStorage(false) });
    memory.set('zdf', record);
    assert.equal(memory.setPin('zdf', '1234'), false, 'nicht persistent: nichts merken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Konten-Dienst: PIN nur bei angemeldetem Konto, Abmelden löscht sie; Status enthält nie PIN oder Token', async () => {
  const store = createAuthStore({ file: path.join(os.tmpdir(), `zdf-pin-svc-${process.pid}.bin`), safeStorage: fakeSafeStorage() });
  const record = { accessToken: SECRET_TOKEN, refreshToken: null, expiresAt: Date.now() + 3600000, since: Date.now(), state: 'ok', clientId: null };
  const provider = { sender: 'zdf', name: 'ZDF', partition: 'persist:mediathek-zdf', tokenHosts: ['api.zdf.de'], login: {}, headers: () => ({}), refresh: async r => r };
  const auth = createMediathekAuth({ providers: { zdf: provider }, store, loginRunner: { run: async () => ({ ok: true, record }) }, clearPartition: async () => {} });
  try {
    assert.equal(auth.setPin('zdf', '1234'), false, 'abgemeldet');
    await auth.login('zdf');
    assert.equal(auth.canRememberPin(), true);
    assert.equal(auth.setPin('zdf', '1234'), true);
    assert.equal(auth.getPin('zdf'), '1234');
    const dump = JSON.stringify(auth.status());
    assert.ok(!dump.includes('1234') && !dump.includes(SECRET_TOKEN) && !/pin/i.test(dump));
    await auth.logout('zdf');
    assert.equal(auth.getPin('zdf'), null);
    assert.equal(store.getPin('zdf'), null);
  } finally {
    fs.rmSync(`${path.join(os.tmpdir(), `zdf-pin-svc-${process.pid}.bin`)}`, { force: true });
  }
});

// ── FSK-Hilfen ──

test('Stream-Daten-Adresse: nur api.zdf.de (tmd/2, content/documents) mit höchstens profile=', () => {
  assert.equal(validPtmdUrl(PTMD_URL), PTMD_URL);
  assert.equal(validPtmdUrl('https://api.zdf.de/content/documents/vod-ard-x-106.json?profile=tmd-app'), 'https://api.zdf.de/content/documents/vod-ard-x-106.json?profile=tmd-app');
  for (const bad of ['http://api.zdf.de/tmd/2/x', 'https://evil.example/tmd/2/x', 'https://api.zdf.de.evil.example/tmd/2/x', 'https://api.zdf.de/identity/userinfo', 'https://api.zdf.de/tmd/2/x?token=1', 'https://api.zdf.de/tmd/2/../identity/x', 'https://u:p@api.zdf.de/tmd/2/x', 'https://api.zdf.de:8443/tmd/2/x', 'https://api.zdf.de/content/documents/x.json?profile=a%20b', null, 42, '']) {
    assert.equal(validPtmdUrl(bad), null, String(bad));
  }
});

test('fskContext: nur mit fskCheck; Stufe 18 vs. 16; erste gültige Stream-Adresse', () => {
  assert.equal(fskContext({ document: { fsk: 'fsk16' } }), null);
  assert.equal(fskContext({}), null);
  const sixteen = fskContext(fskRoot());
  assert.deepEqual([sixteen.rating, sixteen.required, sixteen.ptmdUrl], ['fsk16', 16, PTMD_URL]);
  assert.equal(fskContext(fskRoot({ fsk: 'fsk18' })).required, 18);
  assert.equal(fskContext(fskRoot({ fsk: 'fsk12' })).required, 16, 'Konto-Freigabe gilt ab FSK 16');
  assert.equal(fskContext(fskRoot({ streamApiUrlFsk: 'https://evil.example/x', streamApiUrlIOS: PTMD_URL })).ptmdUrl, PTMD_URL);
  assert.equal(fskContext(fskRoot({ streamApiUrlFsk: 'https://evil.example/x' })).ptmdUrl, null);
  const real = JSON.parse(fixture('zdfDocumentFskBlocked'));
  assert.equal(fskContext(real).ptmdUrl, real.document.streamApiUrlFsk);
});

test('Abrufzeitraum (Berlin): FSK 12 ab 20, 16 ab 22, 18 ab 23 Uhr bis 6 Uhr; unbekannte Stufe nie offen', () => {
  const at = iso => Date.parse(iso);
  assert.equal(windowOpen('fsk16', at('2026-10-21T19:59:00Z')), false); // 21:59 Berlin
  assert.equal(windowOpen('fsk16', at('2026-10-21T20:00:00Z')), true); // 22:00
  assert.equal(windowOpen('fsk16', at('2026-10-22T03:59:00Z')), true); // 05:59
  assert.equal(windowOpen('fsk16', at('2026-10-22T04:00:00Z')), false); // 06:00
  assert.equal(windowOpen('fsk12', at('2026-10-21T18:00:00Z')), true); // 20:00
  assert.equal(windowOpen('fsk18', at('2026-10-21T20:30:00Z')), false); // 22:30
  assert.equal(windowOpen('fsk18', NIGHT), true);
  assert.equal(windowOpen('FSK', NIGHT), false);
  assert.equal(windowOpen('fsk16', at('2026-01-15T21:00:00Z')), true, 'Winterzeit: 22:00 Berlin');
});

test('Api-Auth-Token der Seite: aus dem HTML (maskiert oder offen), Ablauf aus der Seite; ohne Token null', () => {
  const parsed = parseAppToken(HOME_HTML, DAY);
  assert.deepEqual(parsed, { token: APP_TOKEN, expiresAt: Date.parse('2026-10-22T14:21:34+02:00') });
  assert.equal(parseAppToken(`{"videoToken":{"apiToken":"${APP_TOKEN}"}}`, DAY).expiresAt, DAY + 6 * 3600 * 1000);
  assert.equal(parseAppToken(`"apiToken":"${APP_TOKEN}"`, DAY).token, APP_TOKEN);
  assert.equal(parseAppToken('<html>nichts</html>', DAY), null);
  assert.equal(parseAppToken('{"videoToken":{"apiToken":"kurz"}}', DAY), null);
});

test('Stream-Daten (PTMD) im Dokumentformat: Formitäten je Spur, Audiodeskription, Untertitel; Fremdschemata entfallen', () => {
  const root = ptmdToRoot(PTMD, fskRoot().document);
  const formats = root.document.formitaeten;
  assert.equal(formats.length, 3);
  assert.deepEqual(formats[0], { url: 'https://zdfvod.akamaized.net/a/master.m3u8', type: 'h264_aac_ts_http_m3u8_http', mimeType: 'application/x-mpegURL', quality: 'auto', class: 'main', language: 'deu' });
  assert.equal(formats[2].class, 'ad');
  assert.equal(root.document.captions.length, 1);
  assert.equal(root.document.fsk, 'fsk16');
  assert.deepEqual(ptmdToRoot({}, {}).document.formitaeten, []);
});

// ── FSK-Ablauf ──

test('Abrufzeitraum offen: Stream ohne Konto und ohne PIN (wie die Website), Api-Auth nur für api.zdf.de, kein Nutzertoken', async () => {
  const { fsk, http, prompts, posts } = makeFsk({ now: NIGHT, auth: fakeAuth({ account: 'signedOut' }) });
  const outcome = await fsk.unlock(fskRoot());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.root.document.formitaeten.length, 3);
  assert.equal(prompts.length, 0);
  assert.equal(posts.length, 0);
  const ptmdCall = http.calls.find(call => call.url === PTMD_URL);
  assert.deepEqual(ptmdCall.options.hostHeaders, { 'api.zdf.de': { 'Api-Auth': `Bearer ${APP_TOKEN}` } });
  assert.equal(ptmdCall.options.auth, undefined, 'PTMD-Abruf ohne Konto-Token');
  assert.equal(http.calls.filter(call => call.url === 'https://www.zdf.de/').length, 1);
});

test('Außerhalb des Zeitraums: abgemeldet/abgelaufen/FSK 18/ohne Altersfreigabe bleiben gesperrt (kein Stream-Abruf)', async () => {
  const out = async (over, root = fskRoot(), extra = {}) => {
    const setup = makeFsk({ auth: fakeAuth(over), ...extra });
    const outcome = await setup.fsk.unlock(root);
    return { outcome, setup };
  };
  assert.deepEqual((await out({ account: 'signedOut' })).outcome, { ok: false, account: 'signedOut' });
  assert.deepEqual((await out({ account: 'expired' })).outcome, { ok: false, account: 'expired' });
  assert.deepEqual((await out({ account: 'unsupported' })).outcome, { ok: false, account: null });
  assert.deepEqual((await out({ usable: false })).outcome, { ok: false, account: 'network' });
  const eighteen = await out({}, fskRoot({ fsk: 'fsk18' }));
  assert.deepEqual(eighteen.outcome, { ok: false, account: 'tooHigh' });
  assert.equal(eighteen.setup.http.calls.length, 0, 'FSK 18: weder Altersprüfung noch Stream-Abruf');
  const unverified = await out({}, fskRoot(), { routes: { '/fsk/verification': { verified: false } } });
  assert.deepEqual(unverified.outcome, { ok: false, account: 'notVerified' });
  assert.equal(unverified.setup.prompts.length, 0, 'keine PIN-Abfrage ohne Altersfreigabe');
  assert.ok(!unverified.setup.http.calls.some(call => call.url === PTMD_URL));
  assert.deepEqual((await out({}, fskRoot(), { routes: { '/fsk/verification': httpError(401) } })).outcome, { ok: false, account: 'expired' });
  assert.deepEqual((await out({}, fskRoot(), { routes: { '/fsk/verification': httpError(500) } })).outcome, { ok: false, account: 'error' });
  assert.deepEqual((await out({}, fskRoot(), { routes: { '/fsk/verification': Object.assign(new Error('x'), { code: 'network' }) } })).outcome, { ok: false, account: 'network' });
  assert.deepEqual((await out({}, fskRoot(), { routes: { '/fsk/verification': 'kein json' } })).outcome, { ok: false, account: 'error' });
  assert.deepEqual((await out({}, { document: { fsk: 'fsk16' } })).outcome, { ok: false, account: null }, 'ohne fskCheck nicht zuständig');
});

test('Mit Konto: Altersfreigabe -> PIN-Abfrage -> PIN-Prüfung (POST) -> Stream; PIN nur an den PIN-Aufruf', async () => {
  const warnings = [];
  const { fsk, http, prompts, posts, auth } = makeFsk({ warnings });
  const outcome = await fsk.unlock(fskRoot());
  assert.equal(outcome.ok, true);
  assert.deepEqual(prompts, [{ rating: 'fsk16', canRemember: true }]);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].method, posts[0].url, posts[0].options.fields], ['POST', PIN_URL, { pin: '4711' }]);
  assert.equal(posts[0].options.headers.Authorization, `Bearer ${SECRET_TOKEN}`);
  const verification = http.calls.find(call => call.url === VERIFICATION_URL);
  assert.equal(verification.options.auth, 'zdf');
  assert.equal(auth.state.remembered, null, 'ohne Häkchen nichts merken');
  // Reihenfolge: Prüfung vor Stream-Abruf
  const order = http.calls.map(call => call.url);
  assert.ok(order.indexOf(VERIFICATION_URL) < order.indexOf(PTMD_URL));
  // PIN und Token tauchen nirgends in Warnungen oder an anderen Aufrufen auf
  assert.ok(!JSON.stringify([warnings, http.calls]).includes('4711'));
  assert.ok(!JSON.stringify(http.calls.map(call => call.options.hostHeaders)).includes(SECRET_TOKEN));
});

test('PIN merken: Häkchen speichert nach erfolgreicher Prüfung; gemerkte PIN fragt nicht mehr', async () => {
  const first = makeFsk({ askPin: async () => ({ pin: '4711', remember: true }) });
  assert.equal((await first.fsk.unlock(fskRoot())).ok, true);
  assert.equal(first.auth.state.remembered, '4711');
  const saved = makeFsk({ auth: fakeAuth({ pin: '9876' }) });
  assert.equal((await saved.fsk.unlock(fskRoot())).ok, true);
  assert.equal(saved.prompts.length, 0);
  assert.equal(saved.posts[0].options.fields.pin, '9876');
  const noEncryption = makeFsk({ auth: fakeAuth({ canRemember: false }) });
  await noEncryption.fsk.unlock(fskRoot());
  assert.equal(noEncryption.prompts[0].canRemember, false, 'Dialog bietet "merken" nur bei verschlüsseltem Speicher an');
});

test('Falsche PIN: klare Meldung, keine Wiederholung, gemerkte falsche PIN wird verworfen, kein Stream; gesperrt bei 429', async () => {
  const wrong = makeFsk({ pinStatus: 403 });
  assert.deepEqual(await wrong.fsk.unlock(fskRoot()), { ok: false, account: 'wrongPin' });
  assert.equal(wrong.posts.length, 1, 'keine automatische Wiederholung');
  assert.equal(wrong.auth.state.remembered, null);
  assert.ok(!wrong.http.calls.some(call => call.url === PTMD_URL), 'ohne gültige PIN kein Stream-Abruf');
  const savedWrong = makeFsk({ auth: fakeAuth({ pin: '0000' }), pinStatus: 401 });
  assert.deepEqual(await savedWrong.fsk.unlock(fskRoot()), { ok: false, account: 'wrongPin' });
  assert.equal(savedWrong.auth.state.cleared, 1);
  assert.equal(savedWrong.posts.length, 1);
  const locked = makeFsk({ pinStatus: 429 });
  assert.deepEqual(await locked.fsk.unlock(fskRoot()), { ok: false, account: 'pinLocked' });
  const server = makeFsk({ pinStatus: 500 });
  assert.deepEqual(await server.fsk.unlock(fskRoot()), { ok: false, account: 'error' });
  const down = createZdfFsk({ http: fakeHttp({ '/fsk/verification': { verified: true } }), auth: fakeAuth(), net: { request: async () => { throw Object.assign(new Error('x'), { code: 'network' }); } }, askPin: async () => ({ pin: '1234', remember: false }), now: () => DAY });
  assert.deepEqual(await down.unlock(fskRoot()), { ok: false, account: 'network' });
});

test('PIN-Abfrage abgebrochen oder ungültig: pinCancelled, kein Abruf; fehlender Dialog ebenso; gleichzeitige Aufrufe teilen sich einen Dialog', async () => {
  for (const answer of [null, undefined, { pin: '12', remember: false }, { pin: 1234, remember: false }, { pin: '12a4' }]) {
    const { fsk, posts } = makeFsk({ askPin: async () => answer });
    assert.deepEqual(await fsk.unlock(fskRoot()), { ok: false, account: 'pinCancelled' }, JSON.stringify(answer));
    assert.equal(posts.length, 0);
  }
  const throwing = makeFsk({ askPin: async () => { throw new Error('boom'); } });
  assert.equal((await throwing.fsk.unlock(fskRoot())).account, 'pinCancelled');
  const none = createZdfFsk({ http: fakeHttp({ '/fsk/verification': { verified: true } }), auth: fakeAuth(), net: {}, now: () => DAY });
  assert.equal((await none.unlock(fskRoot())).account, 'pinCancelled');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const shared = makeFsk({ askPin: async () => { await gate; return { pin: '4711', remember: false }; } });
  const both = Promise.all([shared.fsk.unlock(fskRoot()), shared.fsk.unlock(fskRoot())]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [a, b] = await both;
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.equal(shared.prompts.length, 1, 'ein Dialog für beide');
});

test('Stream-Daten: abgelaufenes Seiten-Token wird einmal neu geholt; ohne Formate/Adresse noStream; Netzfehler', async () => {
  let ptmdCalls = 0;
  const retry = makeFsk({ now: NIGHT, auth: fakeAuth({ account: 'signedOut' }), routes: { 'ptmd/mediathek': () => { ptmdCalls += 1; if (ptmdCalls === 1) throw httpError(403); return PTMD; } } });
  assert.equal((await retry.fsk.unlock(fskRoot())).ok, true);
  assert.equal(retry.http.calls.filter(call => call.url === 'https://www.zdf.de/').length, 2, 'Token frisch geholt');
  ptmdCalls = -10;
  const always403 = makeFsk({ now: NIGHT, routes: { 'ptmd/mediathek': () => { throw httpError(403); } } });
  assert.deepEqual(await always403.fsk.unlock(fskRoot()), { ok: false, account: 'error' });
  assert.equal(always403.http.calls.filter(call => call.url === PTMD_URL).length, 2, 'genau eine Wiederholung');
  const empty = makeFsk({ now: NIGHT, routes: { 'ptmd/mediathek': { priorityList: [] } } });
  assert.deepEqual(await empty.fsk.unlock(fskRoot()), { ok: false, account: 'noStream' });
  const noUrl = makeFsk({ now: NIGHT });
  assert.deepEqual(await noUrl.fsk.unlock(fskRoot({ streamApiUrlFsk: undefined })), { ok: false, account: 'noStream' });
  const noToken = makeFsk({ now: NIGHT, routes: { 'www.zdf.de/': '<html></html>' } });
  assert.deepEqual(await noToken.fsk.unlock(fskRoot()), { ok: false, account: 'error' });
  const offline = makeFsk({ now: NIGHT, routes: { 'ptmd/mediathek': Object.assign(new Error('x'), { code: 'network' }) } });
  assert.deepEqual(await offline.fsk.unlock(fskRoot()), { ok: false, account: 'network' });
  const garbage = makeFsk({ now: NIGHT, routes: { 'ptmd/mediathek': 'kein json' } });
  assert.deepEqual(await garbage.fsk.unlock(fskRoot()), { ok: false, account: 'error' });
});

// ── Einbindung ──

test('http.js: hostHeaders nur für Schritte mit genau diesem Host, je Weiterleitung neu bestimmt', async () => {
  const seen = [];
  const response = (status, body = '{}', headers = {}) => ({ status, headers: { get: name => headers[name.toLowerCase()] ?? null }, async arrayBuffer() { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }, body: { cancel: async () => {} } });
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (url.endsWith('/weiter')) return response(302, '', { location: 'https://zdfvod.akamaized.net/ziel' });
    return response(200);
  };
  const http = createMediathekHttp({ fetchImpl, lookup: undefined });
  const hostHeaders = { 'api.zdf.de': { 'Api-Auth': 'Bearer T' } };
  await http.getText('https://api.zdf.de/tmd/2/x', { hostHeaders });
  assert.equal(seen[0].headers['Api-Auth'], 'Bearer T');
  await http.getText('https://api.zdf.de/weiter', { hostHeaders });
  assert.equal(seen[1].headers['Api-Auth'], 'Bearer T');
  assert.equal('Api-Auth' in seen[2].headers, false, 'nicht an das Weiterleitungsziel');
  await http.getText('https://zdf-prod-futura.zdf.de/mediathekV2/document/x', { hostHeaders });
  assert.equal('Api-Auth' in seen[3].headers, false);
  await http.getText('https://api.zdf.de/tmd/2/x');
  assert.equal('Api-Auth' in seen[4].headers, false);
});

function service(unlock) {
  const body = fixture('zdfDocumentFskBlocked');
  const http = { getText: async () => body };
  return createMediathekService({ http, zdfFsk: { unlock } });
}

test('Service Wiedergabe: freigeschaltet -> abspielbar (HLS vor MP4); sonst gesperrt mit Grund; ohne zdfFsk unverändert', async () => {
  const unlocked = await service(async () => ({ ok: true, root: ptmdToRoot(PTMD, { fsk: 'fsk16', fskCheck: true }) })).resolveStreamDetail(entry);
  assert.deepEqual(unlocked.resolution, { kind: 'playable', url: 'https://zdfvod.akamaized.net/a/master.m3u8' });
  for (const account of ['signedOut', 'wrongPin', 'pinCancelled', 'notVerified', 'tooHigh']) {
    const blocked = await service(async () => ({ ok: false, account })).resolveStreamDetail(entry);
    assert.deepEqual([blocked.resolution.kind, blocked.resolution.rating, blocked.resolution.account], ['ageRestricted', 'fsk16', account]);
  }
  const unknown = await service(async () => ({ ok: false, account: null })).resolveStreamDetail(entry);
  assert.equal(unknown.resolution.account, undefined);
  const crashed = await service(async () => { throw new Error('boom'); }).resolveStreamDetail(entry);
  assert.equal(crashed.resolution.account, 'error');
  const plain = await createMediathekService({ http: { getText: async () => fixture('zdfDocumentFskBlocked') } }).resolveStreamDetail(entry);
  assert.deepEqual(plain.resolution, { kind: 'ageRestricted', rating: 'fsk16' });
});

test('Service Download: freigeschaltet -> Varianten/Spuren/Untertitel; PIN-Fehler fehlschlagen statt zurückstellen; Konto-Fehler bleiben zurückgestellt', async () => {
  const info = await service(async () => ({ ok: true, root: ptmdToRoot(PTMD, { fsk: 'fsk16', fskCheck: true, titel: 'Nachtkrimi' }) })).resolveForDownload(entry);
  assert.equal(info.restriction, null);
  assert.ok(info.variants.length >= 2);
  assert.ok(info.audioTracks.some(track => track.kind === 'audio-description'));
  assert.equal(info.subtitles.length, 1);
  const wrong = await service(async () => ({ ok: false, account: 'wrongPin' })).resolveForDownload(entry);
  assert.deepEqual([wrong.restriction.code, wrong.restriction.account], ['unavailable', 'wrongPin']);
  assert.match(wrong.restriction.message, /Falsche ZDF-Jugendschutz-PIN/);
  const signedOut = await service(async () => ({ ok: false, account: 'signedOut' })).resolveForDownload(entry);
  assert.equal(signedOut.restriction.code, 'age', 'nach Anmeldung/Zeitraum erneut versuchen');
  assert.match(signedOut.restriction.message, /Mit ZDF-Konto freischaltbar/);
});

test('Meldungen: ZDF-Texte je Grund (Konto, Altersfreigabe auf der Website, FSK 18 nachts, PIN)', () => {
  const base = 'Dieser Beitrag ist ab FSK 16 eingestuft (Jugendschutz) und nur von 22 bis 6 Uhr abrufbar.';
  assert.equal(accountNote(base, 'signedOut', 'zdf'), `${base} Mit ZDF-Konto freischaltbar – in Einstellungen ▸ Mediatheken ▸ Konten anmelden.`);
  assert.equal(accountNote(base, 'signedOut'), `${base} Mit Konto freischaltbar – in Einstellungen ▸ Mediatheken ▸ Konten anmelden.`, 'andere Sender unverändert');
  assert.match(accountNote(base, 'notVerified', 'zdf'), /einmalig bei ZDF auf der Website/);
  assert.match(accountNote(base, 'tooHigh', 'zdf'), /FSK 18 .* 23 bis 6 Uhr/);
  assert.match(accountNote(base, 'wrongPin', 'zdf'), /^Falsche ZDF-Jugendschutz-PIN\./);
  assert.match(accountNote(base, 'pinCancelled', 'zdf'), /PIN wurde nicht eingegeben/);
  assert.match(accountNote(base, 'pinLocked', 'zdf'), /Zu viele falsche PIN/);
  assert.match(accountNote(base, 'noStream', 'zdf'), /keinen Stream/);
});

// ── Anmeldefenster ──

test('Anmeldefenster ZDF: Hosts zdf.de/ard.de/ard-zdf.de, Sammelseite nur www.zdf.de, Partition persist:mediathek-zdf', () => {
  const provider = createZdfProvider({ net: {} });
  assert.equal(provider.partition, 'persist:mediathek-zdf');
  assert.equal(provider.login.startUrl, 'https://www.zdf.de/mein-zdf');
  for (const host of ['www.zdf.de', 'zdf.de', 'accounts.ard.de', 'accounts.ard-zdf.de']) assert.equal(provider.login.isAllowedHost(host), true, host);
  for (const host of ['zdf.de.evil.example', 'evilzdf.de', 'example.com', 'api.friendlycaptcha.com']) assert.equal(provider.login.isAllowedHost(host), false, host);
  assert.equal(provider.login.isCollectPage('www.zdf.de'), true);
  assert.equal(provider.login.isCollectPage('accounts.ard.de'), false);
});

test('Anmeldefenster: Sitzung wird nur auf www.zdf.de gelesen und liefert den Datensatz', async () => {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.url = '';
      this.webContents = { setWindowOpenHandler: () => {}, on: () => {}, loadURL: async target => { this.url = target; }, getURL: () => this.url, executeJavaScript: async () => JSON.stringify({ store: JSON.stringify({ state: { sessionToken: SECRET_TOKEN } }), legacy: null }) };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const timers = [];
  const session = { fromPartition: () => ({ setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} }) };
  const runner = createLoginRunner({ BrowserWindow: FakeWindow, session, setTimer: fn => { const t = { fn }; timers.push(t); return t; }, clearTimer: () => {} });
  const provider = createZdfProvider({ net: { request: async () => ({ status: 200, json: {} }) }, now: () => 100 });
  const pending = runner.run(provider);
  assert.equal(windows[0].url, 'https://www.zdf.de/mein-zdf');
  windows[0].url = 'https://accounts.ard.de/login';
  await timers[0].fn();
  windows[0].url = 'https://www.zdf.de/mein-zdf';
  await timers[0].fn();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.record.accessToken, SECRET_TOKEN);
});

// ── PIN-Abfrage ──

test('PIN-Fenster: Eingabe wird streng geprüft', () => {
  assert.deepEqual(validateSubmit({ pin: '0042', remember: true }), { pin: '0042', remember: true });
  for (const bad of [null, [], 'x', {}, { pin: '123', remember: false }, { pin: '12345', remember: false }, { pin: '12a4', remember: false }, { pin: 1234, remember: false }, { pin: '1234' }, { pin: '1234', remember: 'ja' }, { pin: '1234', remember: false, extra: 1 }]) {
    assert.equal(validateSubmit(bad), null, JSON.stringify(bad));
  }
});

function promptSetup() {
  const windows = [];
  const handlers = {};
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.loaded = [];
      this.contentsEvents = new EventEmitter();
      this.webContents = { setWindowOpenHandler: handler => { this.openHandler = handler; }, on: (event, listener) => this.contentsEvents.on(event, listener), loadFile: async file => { this.loaded.push(file); } };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    showInactive() {}
  }
  const ipcMain = { handle: (channel, handler) => { handlers[channel] = handler; } };
  const prompt = createPinPrompt({ BrowserWindow: FakeWindow, ipcMain, getParent: () => null });
  const from = win => ({ sender: win.webContents });
  return { prompt, windows, handlers, from };
}

test('PIN-Fenster: gehärtet (Sandbox, Isolation, nur Arbeitsspeicher-Partition), Ergebnis nur vom eigenen Fenster', async () => {
  const { prompt, windows, handlers, from } = promptSetup();
  const pending = prompt.ask({ rating: 'fsk16', canRemember: true });
  const win = windows[0];
  assert.deepEqual({ ...win.options.webPreferences, preload: path.basename(win.options.webPreferences.preload) }, { partition: 'zdf-pin', preload: 'zdf-pin-preload.js', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, spellcheck: false });
  assert.match(win.loaded[0], /zdf-pin\.html$/);
  assert.deepEqual(win.openHandler({ url: 'https://x' }), { action: 'deny' });
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  win.contentsEvents.emit('will-navigate', nav);
  assert.equal(nav.prevented, true);
  const info = await handlers['mediathek:zdf-pin-init'](from(win));
  assert.equal(info.canRemember, true);
  assert.match(info.text, /FSK 16/);
  assert.equal(await handlers['mediathek:zdf-pin-init']({ sender: {} }), null, 'fremder Absender');
  assert.deepEqual(await handlers['mediathek:zdf-pin-submit']({ sender: {} }, { pin: '1234', remember: false }), { ok: false });
  assert.deepEqual(await handlers['mediathek:zdf-pin-submit'](from(win), { pin: 'abcd', remember: false }), { ok: false }, 'ungültige Eingabe lässt das Fenster offen');
  assert.equal(win.destroyed, false);
  assert.deepEqual(await prompt.ask({ rating: 'fsk16' }), null, 'zweite Abfrage parallel: keine zweite Maske');
  assert.deepEqual(await handlers['mediathek:zdf-pin-submit'](from(win), { pin: '1234', remember: true }), { ok: true });
  assert.deepEqual(await pending, { pin: '1234', remember: true });
  assert.equal(win.destroyed, true);
});

test('PIN-Fenster: Abbrechen und Schließen ergeben null; danach ist wieder eine Abfrage möglich', async () => {
  const { prompt, windows, handlers, from } = promptSetup();
  const first = prompt.ask({ rating: 'fsk16' });
  await handlers['mediathek:zdf-pin-cancel'](from(windows[0]));
  assert.equal(await first, null);
  const second = prompt.ask({ rating: 'fsk16' });
  windows[1].destroy();
  assert.equal(await second, null);
  const third = prompt.ask({ rating: 'fsk16' });
  assert.equal(windows.length, 3);
  await handlers['mediathek:zdf-pin-submit'](from(windows[2]), { pin: '0000', remember: false });
  assert.deepEqual(await third, { pin: '0000', remember: false });
});

test('E2E-Ersatznetz: ZDF-Identity antwortet ohne Netz (PIN 1234 richtig)', async () => {
  const net = createE2eAuthNet();
  assert.equal((await net.request('POST', PIN_URL, { fields: { pin: '1234' } })).status, 200);
  assert.equal((await net.request('POST', PIN_URL, { fields: { pin: '0000' } })).status, 403);
  assert.equal((await net.request('GET', USERINFO_URL)).status, 200);
});
