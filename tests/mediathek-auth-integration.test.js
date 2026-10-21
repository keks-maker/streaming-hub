'use strict';

// Tests: Konten in Abruf und Auflösung. (1) http.js: Kopfzeilen nur für den Sender-Host, je Weiterleitungsschritt neu bestimmt,
// 401 -> "abgelaufen". (2) service.js: Jugendschutz-Sperre wird bei angemeldetem Konto einmal mit Token wiederholt (Wiedergabe
// und resolveForDownload), Meldungen für abgemeldet/angemeldet/abgelaufen. (3) DownloadService: zurückgestellte Downloads sofort
// neu auflösen. Alles mit Fixtures und Ersatz-Transport, kein Netz.

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const { createMediathekHttp } = require('../lib/mediathek/http.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { registerMediathekIpc } = require('../lib/mediathek/ipc.js');
const { createMediathekFavorites } = require('../lib/mediathek/favorites.js');
const { createWatchProgress } = require('../lib/mediathek/watch-progress.js');
const { accountNote } = require('../lib/mediathek/restrictions.js');
const { createMediathekAuth } = require('../lib/mediathek/auth/index.js');
const { createAuthStore } = require('../lib/mediathek/auth/store.js');

function createAuth(initial = {}, refresh = null) {
  const store = createAuthStore({ file: null, safeStorage: null });
  const record = sender => ({ accessToken: `${sender}-TOKEN`, refreshToken: `${sender}-REFRESH`, expiresAt: Date.now() + 3600000, since: Date.now(), state: 'ok', clientId: 'web' });
  const providers = {};
  for (const sender of ['ard', 'arte']) {
    providers[sender] = {
      sender,
      name: sender,
      partition: `persist:mediathek-${sender}`,
      tokenHosts: [sender === 'ard' ? 'api.ardmediathek.de' : 'api.arte.tv'],
      headers: r => (sender === 'ard' ? { 'X-Authorization': `Bearer ${r.accessToken}` } : { Authorization: `Bearer ${r.accessToken}` }),
      refresh: refresh || (async r => ({ ...r, accessToken: `${sender}-REFRESHED`, expiresAt: Date.now() + 3600000 })),
      login: {},
      softUnauthorized: sender === 'arte',
      personalizeUrl: sender === 'ard' ? (url, r) => `${url}${url.includes('?') ? '&' : '?'}userId=uid-of-${r.accessToken.length}` : undefined,
    };
    if (initial[sender]) store.set(sender, { ...record(sender), ...initial[sender] });
  }
  return { auth: createMediathekAuth({ providers, store, loginRunner: { run: async () => ({ ok: false, code: 'cancelled' }) } }), store };
}

function response(status, body, headers = {}) {
  return { status, headers: { get: name => headers[name.toLowerCase()] ?? null }, async arrayBuffer() { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }, body: { cancel: async () => {} } };
}

// ── http.js ──

test('HTTP: Token nur an Sender-Hosts, je Weiterleitung neu bestimmt, nie an Weiterleitungsziele fremder Hosts', async () => {
  const { auth } = createAuth({ arte: {}, ard: {} });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (url.endsWith('/hop-fremd')) return response(302, '', { location: 'https://www.arte.tv/ziel' }); // erlaubter Host, aber nicht in der Token-Liste
    if (url.endsWith('/hop-cdn')) return response(302, '', { location: 'https://api-cdn.arte.tv/ziel' });
    if (url.endsWith('/hop-zurueck')) return response(302, '', { location: 'https://api.arte.tv/ziel' });
    if (url.endsWith('/hop-anderer-sender')) return response(302, '', { location: 'https://api.ardmediathek.de/ziel' });
    return response(200, '{}');
  };
  const http = createMediathekHttp({ fetchImpl, lookup: undefined, auth });
  const headerOf = (index, name) => seen[index].headers[name];

  await http.getText('https://api.arte.tv/direkt', { auth: 'arte' });
  assert.equal(headerOf(0, 'Authorization'), 'Bearer arte-TOKEN');

  seen.length = 0;
  await http.getText('https://api.arte.tv/hop-fremd', { auth: 'arte' });
  assert.equal(seen[0].headers.Authorization, 'Bearer arte-TOKEN');
  assert.equal(seen[1].url, 'https://www.arte.tv/ziel');
  assert.equal(seen[1].headers.Authorization, undefined, 'Weiterleitungsziel ohne Token');

  seen.length = 0;
  await http.getText('https://api.arte.tv/hop-cdn', { auth: 'arte' });
  assert.equal(seen[1].headers.Authorization, undefined, 'api-cdn.arte.tv steht nicht in der Token-Liste');

  seen.length = 0;
  await http.getText('https://api.arte.tv/hop-anderer-sender', { auth: 'arte' });
  assert.equal(seen[1].url, 'https://api.ardmediathek.de/ziel');
  assert.equal(seen[1].headers.Authorization, undefined);
  assert.equal(seen[1].headers['X-Authorization'], undefined, 'Token von arte geht nie an ARD');

  seen.length = 0;
  await http.getText('https://api.ardmediathek.de/hop-fremd', { auth: 'ard' });
  assert.equal(seen[0].headers['X-Authorization'], 'Bearer ard-TOKEN');
  assert.equal(seen[1].headers['X-Authorization'], undefined);
});

test('HTTP: ohne auth-Option keine Konto-Kopfzeilen, auch wenn angemeldet; User-Agent und Accept bleiben', async () => {
  const { auth } = createAuth({ ard: {} });
  const seen = [];
  const http = createMediathekHttp({ fetchImpl: async (url, init) => { seen.push(init.headers); return response(200, '{}'); }, lookup: undefined, auth });
  await http.getText('https://api.ardmediathek.de/x');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['Accept', 'User-Agent']);
});

test('HTTP: Token wird vor dem Abruf aufgefrischt; 401 bei arte erzwingt Auffrischung statt sofort "abgelaufen"', async () => {
  const { auth, store } = createAuth({ arte: { expiresAt: Date.now() + 30000 } });
  const seen = [];
  let status = 200;
  const http = createMediathekHttp({ fetchImpl: async (url, init) => { seen.push(init.headers.Authorization); return response(status, '{}'); }, lookup: undefined, auth });
  await http.getText('https://api.arte.tv/x', { auth: 'arte' });
  assert.equal(seen[0], 'Bearer arte-REFRESHED');
  assert.equal(store.get('arte').accessToken, 'arte-REFRESHED');
  status = 401;
  await assert.rejects(http.getText('https://api.arte.tv/x', { auth: 'arte' }), { code: 'http', status: 401 });
  assert.equal(auth.accountState('arte'), 'signedIn', 'Anmeldung bleibt, Token gilt lokal als abgelaufen');
  assert.equal(auth.tokenUsable('arte'), false);
  status = 200;
  await http.getText('https://api.arte.tv/y', { auth: 'arte' });
  assert.equal(seen.at(-1), 'Bearer arte-REFRESHED', 'beim nächsten Abruf wird aufgefrischt');
});

// ── service.js: Wiedergabe ──

function routedHttp(routes) {
  const calls = [];
  return {
    calls,
    async getText(url, options = {}) {
      calls.push({ url, auth: options.auth || null });
      const mode = options.auth ? 'auth' : 'anon';
      const hit = Object.entries(routes).find(([key]) => url.includes(key));
      if (!hit) throw Object.assign(new Error('Server nicht gefunden'), { code: 'network' });
      const value = hit[1][mode] ?? hit[1].anon;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const ARD_ENTRY = { id: 'FSKITEM', title: 'Die Hölle wartet', sourceId: 'ard', partner: 'ard' };
const ARD_ROUTE = '/pages/ard/item/FSKITEM';

test('Wiedergabe ARD: abgemeldet -> Hinweis "Mit Konto freischaltbar", kein zweiter Abruf', async () => {
  const { auth } = createAuth();
  const http = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked') } });
  const detail = await createMediathekService({ http, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.equal(detail.resolution.kind, 'ageRestricted');
  assert.equal(detail.resolution.account, 'signedOut');
  assert.equal(http.calls.length, 1);
});

test('Wiedergabe ARD: angemeldet und vom Anbieter freigegeben -> abspielbar (zweiter Abruf mit Konto)', async () => {
  const { auth } = createAuth({ ard: {} });
  const http = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItem') } });
  const detail = await createMediathekService({ http, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.equal(detail.resolution.kind, 'playable');
  assert.deepEqual(http.calls.map(call => call.auth), [null, 'ard']);
});

test('Wiedergabe ARD: angemeldet, aber weiter gesperrt -> "Auch mit Konto gesperrt"; 401 trotz Auffrischung -> abgelehnt (HTTP 401)', async () => {
  const { auth } = createAuth({ ard: {} });
  const blocked = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItemInstitutFskBlocked') } });
  const still = await createMediathekService({ http: blocked, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.deepEqual([still.resolution.kind, still.resolution.account], ['ageRestricted', 'blocked']);
  const unauthorized = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: Object.assign(new Error('x'), { code: 'http', status: 401 }) } });
  const expired = await createMediathekService({ http: unauthorized, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.deepEqual([expired.resolution.kind, expired.resolution.account, expired.resolution.accountStatus], ['ageRestricted', 'rejected', 401]); // Token trotz Auffrischung abgelehnt (Fake-HTTP meldet nicht an das Konto)
  const offline = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: Object.assign(new Error('x'), { code: 'network' }) } });
  assert.equal((await createMediathekService({ http: offline, auth }).resolveStreamDetail(ARD_ENTRY)).resolution.account, 'error');
});

test('Wiedergabe: abgelaufenes Konto wird nicht erneut versucht; ZDF bleibt ohne Konto-Hinweis; ohne auth unverändert', async () => {
  const { auth } = createAuth({ ard: { state: 'expired', refreshToken: null } });
  const http = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked') } });
  const detail = await createMediathekService({ http, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.equal(detail.resolution.account, 'expired');
  assert.equal(http.calls.length, 1);
  const zdfHttp = routedHttp({ '/document/ZDFFSK': { anon: JSON.stringify({ document: { fskCheck: true, fsk: 'FSK16', formitaeten: [] } }) } });
  const zdf = await createMediathekService({ http: zdfHttp, auth }).resolveStreamDetail({ id: 'ZDFFSK', title: 'Z', sourceId: 'zdf' });
  assert.equal(zdf.resolution.account, undefined);
  const plain = await createMediathekService({ http }).resolveStreamDetail(ARD_ENTRY);
  assert.deepEqual(plain.resolution, { kind: 'ageRestricted', rating: 'FSK16' });
});

test('IPC resolve-playback: Meldungen je Konto-Zustand', async () => {
  const run = async (initial, routes) => {
    const { auth } = createAuth(initial);
    const handlers = new Map();
    registerMediathekIpc({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      service: createMediathekService({ http: routedHttp(routes), auth }),
      favorites: createMediathekFavorites({ read: () => [], write: () => {} }),
      watchProgress: createWatchProgress({ load: () => [], save: () => {} }),
      requireMainRenderer: () => {},
      sendToMain: () => {},
      logger: { warn() {} },
    });
    return handlers.get('mediathek:resolve-playback')({ sender: 'main' }, { entry: { id: 'FSKITEM', title: 'Die Hölle wartet', sourceId: 'ard', partner: 'ard' } });
  };
  const anon = { [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItemInstitutFskBlocked') } };
  const signedOut = await run({}, anon);
  assert.match(signedOut.message, /nur von 22 bis 6 Uhr abrufbar\. Mit Konto freischaltbar – in Einstellungen ▸ Mediatheken ▸ Konten anmelden\.$/);
  const blocked = await run({ ard: {} }, anon);
  assert.match(blocked.message, /^Auch mit Konto gesperrt: Dieser Beitrag ist ab FSK 16 eingestuft/);
  const expired = await run({ ard: { state: 'expired', refreshToken: null } }, anon);
  assert.match(expired.message, /^Anmeldung abgelaufen – in Einstellungen ▸ Mediatheken ▸ Konten neu anmelden\./);
  const unlocked = await run({ ard: {} }, { [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItem') } });
  assert.equal(unlocked.resolution.kind, 'playable');
  assert.equal(unlocked.message, null);
});

test('Wiedergabe ARD: der Wiederholungsabruf mit Konto trägt userId, der anonyme Abruf nicht', async () => {
  const { auth } = createAuth({ ard: {} });
  const http = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItem') } });
  await createMediathekService({ http, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.equal(http.calls.length, 2);
  assert.ok(!http.calls[0].url.includes('userId='));
  assert.match(http.calls[1].url, /[?&]userId=uid-of-/);
});

test('Wiedergabe ARD: Token abgelaufen und Auffrischung scheitert am Netz -> eigener Hinweis, kein Abruf ohne Kopfzeile, Status ohne Fehlalarm', async () => {
  const { auth } = createAuth({ ard: { expiresAt: Date.now() - 1000 } }, async () => { throw Object.assign(new Error('x'), { code: 'network' }); });
  const http = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItem') } });
  const detail = await createMediathekService({ http, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.equal(detail.resolution.kind, 'ageRestricted');
  assert.equal(detail.resolution.account, 'network');
  assert.equal(http.calls.length, 1, 'nur der anonyme Abruf, kein Retry ohne Header');
  assert.equal(auth.accountState('ard'), 'signedIn');
  assert.equal(auth.status().accounts.find(a => a.sender === 'ard').refreshFailed, true);
  assert.match(accountNote('Gesperrt.', 'network'), /^Konto konnte nicht aktualisiert werden \(Netzwerk\) – später erneut versuchen\./);
  assert.ok(!/Auch mit Konto gesperrt/.test(accountNote('Gesperrt.', 'network')));
});

test('Wiedergabe ARD: Token abgelaufen und Refresh abgelehnt -> "Anmeldung abgelaufen"', async () => {
  const { auth } = createAuth({ ard: { expiresAt: Date.now() - 1000 } }, async () => { throw Object.assign(new Error('x'), { code: 'rejected' }); });
  const http = routedHttp({ [ARD_ROUTE]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItem') } });
  const detail = await createMediathekService({ http, auth }).resolveStreamDetail(ARD_ENTRY);
  assert.equal(detail.resolution.account, 'expired');
  assert.equal(http.calls.length, 1);
});

// ── service.js: Download-Auflösung ──

test('resolveForDownload ARD: gesperrt -> mit Konto freigeschaltet (Varianten, keine Sperre); sonst Meldungen mit Konto-Hinweis', async () => {
  const entry = { id: 'ARDITEM', title: 'Folge', sourceId: 'ard', partner: 'ard' };
  const route = '/pages/ard/item/ARDITEM';
  const withAccount = createAuth({ ard: {} }).auth;
  const unlockedHttp = routedHttp({ [route]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('dl-ard-item') } });
  const unlocked = await createMediathekService({ http: unlockedHttp, auth: withAccount }).resolveForDownload(entry);
  assert.equal(unlocked.restriction, null);
  assert.ok(unlocked.variants.length > 0);
  assert.deepEqual(unlockedHttp.calls.map(call => call.auth), [null, 'ard']);

  const blockedHttp = routedHttp({ [route]: { anon: fixture('ardItemInstitutFskBlocked'), auth: fixture('ardItemInstitutFskBlocked') } });
  const blocked = await createMediathekService({ http: blockedHttp, auth: withAccount }).resolveForDownload(entry);
  assert.equal(blocked.restriction.code, 'age');
  assert.equal(blocked.restriction.account, 'blocked');
  assert.match(blocked.restriction.message, /^Auch mit Konto gesperrt: /);
  assert.equal(blocked.restriction.rating, 'FSK16', 'Zurückstellung bleibt möglich');

  const signedOut = await createMediathekService({ http: blockedHttp, auth: createAuth().auth }).resolveForDownload(entry);
  assert.match(signedOut.restriction.message, /Mit Konto freischaltbar – in Einstellungen ▸ Mediatheken ▸ Konten anmelden\.$/);

  const plain = await createMediathekService({ http: blockedHttp }).resolveForDownload(entry);
  assert.ok(!/Konto/.test(plain.restriction.message), 'ohne Konten-Modul unverändert');
});

test('resolveForDownload arte: Sperre mit Konto freigeschaltet, Token geht nur an den Player-Abruf, nicht an die Master-Playlist', async () => {
  const { auth } = createAuth({ arte: {} });
  const masterUrl = JSON.parse(fixture('dl-arte-player')).data.attributes.streams[0].url;
  const http = routedHttp({ '/config/de/AGE': { anon: fixture('dl-arte-age'), auth: fixture('dl-arte-player') }, [masterUrl]: { anon: fixture('dl-arte-master.m3u8') } });
  const info = await createMediathekService({ http, auth }).resolveForDownload({ id: 'AGE', title: 'Nachtfilm', sourceId: 'arte' });
  assert.equal(info.restriction, null);
  assert.ok(info.variants.length > 0);
  const masterCalls = http.calls.filter(call => call.url === masterUrl);
  assert.ok(masterCalls.length > 0);
  assert.ok(masterCalls.every(call => call.auth === null), 'Playlist-Abruf ohne Konto');
});

test('resolveForDownload arte: abgelaufener Token + Auffrischung per Server-/Netzfehler -> "network" ohne "abgelaufen"; Sperrhinweis nur weil nicht freigeschaltet', async () => {
  const refresh = async () => { throw Object.assign(new Error('x'), { code: 'http', status: 503 }); };
  const { auth } = createAuth({ arte: { expiresAt: Date.now() - 1000 } }, refresh);
  const http = routedHttp({ '/config/de/AGE': { anon: fixture('dl-arte-age'), auth: fixture('dl-arte-player') } });
  const info = await createMediathekService({ http, auth }).resolveForDownload({ id: 'AGE', title: 'Nachtfilm', sourceId: 'arte' });
  assert.equal(info.restriction.account, 'network');
  assert.doesNotMatch(info.restriction.message, /Anmeldung abgelaufen/);
  assert.match(info.restriction.message, /HTTP 503/);
  assert.equal(auth.accountState('arte'), 'signedIn');
});

test('resolveForDownload arte: 401 trotz Token -> eine Auffrischung, Wiederholung gelingt (freigeschaltet)', async () => {
  let refreshed = 0;
  const { auth } = createAuth({ arte: {} }, async r => { refreshed += 1; return { ...r, accessToken: 'arte-NEU', expiresAt: Date.now() + 3600000 }; });
  const masterUrl = JSON.parse(fixture('dl-arte-player')).data.attributes.streams[0].url;
  let tries = 0;
  const base = routedHttp({ '/config/de/AGE': { anon: fixture('dl-arte-age'), auth: fixture('dl-arte-player') }, [masterUrl]: { anon: fixture('dl-arte-master.m3u8') } });
  const http = { calls: base.calls, getText: async (url, options) => { if (options && options.auth === 'arte' && tries++ === 0) { auth.reportUnauthorized('arte'); throw Object.assign(new Error('x'), { code: 'http', status: 401 }); } return base.getText(url, options); } };
  const info = await createMediathekService({ http, auth }).resolveForDownload({ id: 'AGE', title: 'Nachtfilm', sourceId: 'arte' });
  assert.equal(info.restriction, null);
  assert.equal(refreshed, 1);
});

test('resolveForDownload arte: 401 auch nach Auffrischung -> "arte akzeptiert die Anmeldung nicht (HTTP 401)", nicht "abgelaufen"', async () => {
  const { auth } = createAuth({ arte: {} });
  const base = routedHttp({ '/config/de/AGE': { anon: fixture('dl-arte-age'), auth: fixture('dl-arte-player') } });
  const http = { calls: base.calls, getText: async (url, options) => { if (options && options.auth === 'arte') { auth.reportUnauthorized('arte'); throw Object.assign(new Error('x'), { code: 'http', status: 401 }); } return base.getText(url, options); } };
  const info = await createMediathekService({ http, auth }).resolveForDownload({ id: 'AGE', title: 'Nachtfilm', sourceId: 'arte' });
  assert.equal(info.restriction.account, 'rejected');
  assert.match(info.restriction.message, /^arte akzeptiert die Anmeldung nicht \(HTTP 401\)/);
  assert.equal(auth.accountState('arte'), 'signedIn');
});

// ── DownloadService ──

const { DownloadService } = require('../lib/download/DownloadService.js');
const { createDownloadStore } = require('../lib/download/DownloadStore.js');
const { normalizeDownloadSettings } = require('../lib/download/download-settings.js');

test('DownloadService.retryAgeScheduledNow: zurückgestellte (Alter) Downloads des Senders sofort einreihen, andere bleiben', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-dl-'));
  try {
    const clock = { ms: Date.parse('2026-10-20T12:00:00+02:00') };
    const timers = [];
    const resolver = {
      async resolveForDownload(entry) {
        return { source: entry.sourceId, variants: [], audioTracks: [], subtitles: [], restriction: { code: 'age', rating: 'FSK16', message: 'gesperrt', retryAt: null }, availableUntil: null, season: null, episode: null, broadcastDate: null, seriesTitle: null, title: entry.title, durationSeconds: null, isExtra: false };
      },
    };
    const service = new DownloadService({
      store: createDownloadStore({ file: path.join(dir, 'downloads.json'), logger: null }),
      resolver,
      getSettings: () => normalizeDownloadSettings({}).settings,
      getRecordingRoot: () => dir,
      getReserveBytes: () => 0,
      getRecordingActive: () => 0,
      notifier: { notify() {} },
      now: () => clock.ms,
      setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimer: timer => { timer.cleared = true; },
      freeBytes: () => 100 * 1024 ** 3,
      logger: null,
    });
    service.start();
    const mk = (id, sourceId) => service.enqueue({ entry: { id, title: `Folge ${id}`, subtitle: null, description: '', imageUrl: null, duration: 60, sourceId, airedAt: null, partner: 'ard', season: 1, episode: 1, regionRestricted: false, originalVersionId: null, audioDescriptionId: null, availableUntil: null }, series: null });
    const a = mk('A1', 'ard');
    const b = mk('B1', 'arte');
    for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.get(a.id).status, 'scheduled');
    assert.equal(service.get(b.id).status, 'scheduled');
    resolver.resolveForDownload = async entry => ({ source: entry.sourceId, variants: [], audioTracks: [], subtitles: [], restriction: { code: 'unavailable', message: 'weg' }, availableUntil: null, title: entry.title });
    assert.equal(service.retryAgeScheduledNow(['ard']), 1);
    for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([service.get(a.id).status, service.get(a.id).errorCode], ['failed', 'unavailable'], 'ARD-Download wurde sofort neu aufgelöst');
    assert.equal(service.get(b.id).status, 'scheduled', 'arte bleibt zurückgestellt');
    assert.equal(service.retryAgeScheduledNow([]), 1, 'ohne Angabe alle Sender');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
