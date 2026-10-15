'use strict';

// Tests: SSRF-Schutz für podcast:cover (Allowlist, Ziel-IP-Filter, Redirects, Fehler-Cache).

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedAddress, createSafeLookup, assertPublicUrl } = require('../lib/net-safety.js');
const { createCoverLoader } = require('../lib/podcast/podcast-cover.js');
const { registerPodcastIpc } = require('../lib/podcast/ipc.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(16)]);
const pub = async () => [{ address: '93.184.216.34', family: 4 }];

test('isBlockedAddress: private IPv4-Bereiche gesperrt, öffentliche erlaubt', () => {
  for (const ip of ['127.0.0.1', '127.255.0.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '169.253.0.1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('isBlockedAddress: IPv6 (Loopback, ULA, Link-Local, IPv4-mapped, NAT64, 6to4)', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '[::1]', '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1', 'kein-ip', '']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('createSafeLookup: liefert nur öffentliche Adressen, sperrt gemischte und private Auflösung', async () => {
  const run = (impl, opts = {}) => new Promise(resolve => createSafeLookup({ lookupImpl: impl })('h.test', opts, (error, a, f) => resolve({ error, a, f })));
  const ok = await run((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
  assert.equal(ok.a, '93.184.216.34');
  assert.equal(ok.f, 4);
  const all = await run((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]), { all: true });
  assert.deepEqual(all.a, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal((await run((h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]))).error.code, 'ESSRF');
  assert.equal((await run((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }]))).error.code, 'ESSRF');
  assert.equal((await run((h, o, cb) => cb(new Error('dns')))).error.message, 'dns');
});

test('assertPublicUrl: Literale, localhost und Auflösung', async () => {
  for (const url of ['http://127.0.0.1/a', 'http://[::1]/a', 'http://169.254.169.254/latest', 'http://localhost/a', 'http://localhost./a', 'http://x.localhost./a', 'http://x.localhost/a', 'http://2130706433/a', 'http://0x7f.1/a', 'http://[::ffff:127.0.0.1]/a', 'http://192.168.0.5:8080/a']) {
    await assert.rejects(assertPublicUrl(url, { resolve: pub }), { code: 'ESSRF' }, url);
  }
  await assert.rejects(assertPublicUrl('http://intern.test/a', { resolve: async () => [{ address: '10.0.0.8' }] }), { code: 'ESSRF' });
  await assert.rejects(assertPublicUrl('http://x.test/a', { resolve: async () => [] }), { code: 'ESSRF' });
  await assertPublicUrl('https://img.test/c.png', { resolve: pub });
  await assertPublicUrl('http://93.184.216.34/c.png');
});

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const { status = 200, body = PNG, headers = {} } = handler(url);
    return { status, headers: { get: name => headers[name.toLowerCase()] || null }, body: null, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  return { fetchImpl, calls };
}

test('Cover-Lader: direkte interne Ziele ohne Netzabruf abgelehnt', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({}));
  const loader = createCoverLoader({ fetchImpl, guardUrl: url => assertPublicUrl(url, { resolve: pub }) });
  for (const url of ['http://127.0.0.1/c.png', 'http://localhost:8080/c.png', 'http://[::1]/c.png', 'http://169.254.169.254/c.png', 'http://10.0.0.1/c.png']) {
    assert.equal((await loader.load(url)).ok, false, url);
  }
  assert.equal(calls.length, 0);
  assert.equal((await loader.load('https://img.test/c.png')).ok, true);
});

test('Cover-Lader: Redirect auf interne Adresse wird abgelehnt, der interne Hop nie abgerufen', async () => {
  const { fetchImpl, calls } = fakeFetch(url => (url.startsWith('https://img.test') ? { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } } : {}));
  const loader = createCoverLoader({ fetchImpl, guardUrl: url => assertPublicUrl(url, { resolve: pub }) });
  assert.equal((await loader.load('https://img.test/redir.png')).ok, false);
  assert.deepEqual(calls.map(c => c.url), ['https://img.test/redir.png']);
});

test('Cover-Lader: lookup (Adress-Pinning) wird an den Transport gereicht', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({}));
  const lookup = () => {};
  const loader = createCoverLoader({ fetchImpl, lookup, guardUrl: async () => {} });
  await loader.load('https://img.test/c.png');
  assert.equal(calls[0].opts.lookup, lookup);
});

test('Cover-Lader: Fehler nur kurz gemerkt, Erfolge dauerhaft (LRU)', async () => {
  let clock = 0;
  let healthy = false;
  const { fetchImpl, calls } = fakeFetch(() => (healthy ? {} : { status: 500 }));
  const loader = createCoverLoader({ fetchImpl, guardUrl: async () => {}, now: () => clock, maxEntries: 2 });
  assert.equal((await loader.load('https://img.test/a.png')).ok, false);
  assert.equal((await loader.load('https://img.test/a.png')).ok, false);
  assert.equal(calls.length, 1, 'innerhalb 60 s kein neuer Abruf');
  healthy = true;
  clock = 61000;
  assert.equal((await loader.load('https://img.test/a.png')).ok, true);
  assert.equal(calls.length, 2);
  await loader.load('https://img.test/a.png');
  assert.equal(calls.length, 2, 'Erfolg aus dem Cache');
  await loader.load('https://img.test/b.png');
  await loader.load('https://img.test/c.png');
  const before = calls.length;
  await loader.load('https://img.test/a.png');
  assert.equal(calls.length, before + 1, 'LRU-Grenze verdrängt den ältesten Erfolg');
});

function setupCover({ subs = [], catalog = [], feeds = {}, playing = null } = {}) {
  const handlers = new Map();
  const loads = [];
  const library = {
    getSubscriptions: () => subs,
    getCatalog: () => catalog,
    getCachedFeed: id => feeds[id] || { channel: null, episodes: [] },
  };
  registerPodcastIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), on() {} },
    library,
    refresher: null,
    search: { search: async () => ({ results: [{ id: 'x', cover: 'https://itunes.test/found.jpg' }], cached: false }) },
    controller: { getState: () => ({ episode: playing }), on() {}, playerWebContents: () => null },
    coverLoader: { load: async url => (loads.push(url), { ok: true, dataUrl: 'data:image/png;base64,AAAA' }) },
    requireMainRenderer: () => {},
    sendToMain: () => {},
    feedFetch: async () => ({ text: '<rss version="2.0"><channel><title>T</title><itunes:image xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" href="http://probe.test/p.jpg"/><item><title>E</title><enclosure url="http://a.test/e.mp3" type="audio/mpeg"/><guid>g</guid></item></channel></rss>' }),
  });
  const cover = url => handlers.get('podcast:cover')({}, url);
  return { cover, loads, call: (c, ...a) => handlers.get(c)({}, ...a) };
}

test('podcast:cover Allowlist: unbekannte und interne Adressen ohne Netzabruf, bekannte Quellen werden geladen', async () => {
  const t = setupCover({
    subs: [{ id: 's1', cover: 'http://sub.test/s.jpg', overrides: { cover: 'http://override.test/o.jpg' } }],
    catalog: [{ podcasts: [{ cover: 'https://cat.test/c.jpg' }] }],
    feeds: { s1: { channel: { cover: 'http://chan.test/ch.jpg' }, episodes: [{ cover: 'http://ep.test/e.jpg' }] } },
    playing: { cover: 'http://now.test/n.jpg' },
  });
  for (const url of ['http://127.0.0.1/x', 'http://localhost/x', 'http://169.254.169.254/x', 'http://[::1]/x', 'https://fremd.test/x.png', '', null, 42]) {
    assert.deepEqual(await t.cover(url), { ok: false }, String(url));
  }
  assert.equal(t.loads.length, 0);
  for (const url of ['http://sub.test/s.jpg', 'http://override.test/o.jpg', 'https://cat.test/c.jpg', 'http://chan.test/ch.jpg', 'http://ep.test/e.jpg', 'http://now.test/n.jpg']) {
    assert.equal((await t.cover(url)).ok, true, url);
  }
  assert.equal(t.loads.length, 6);
});

test('podcast:cover Allowlist: Suchtreffer und Probe-Ergebnis werden freigeschaltet', async () => {
  const t = setupCover();
  assert.equal((await t.cover('https://itunes.test/found.jpg')).ok, false);
  await t.call('podcast:search', { term: 'Wissen' });
  assert.equal((await t.cover('https://itunes.test/found.jpg')).ok, true);
  assert.equal((await t.cover('http://probe.test/p.jpg')).ok, false);
  const probe = await t.call('podcast:probe-feed', 'https://feed.test/rss');
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal((await t.cover('http://probe.test/p.jpg')).ok, true);
});

test('allowLoopback (nur isolierte Testläufe): erlaubt ausschließlich 127/8 und ::1', async () => {
  assert.equal(isBlockedAddress('127.0.0.1', { allowLoopback: true }), false);
  assert.equal(isBlockedAddress('::1', { allowLoopback: true }), false);
  assert.equal(isBlockedAddress('169.254.169.254', { allowLoopback: true }), true);
  assert.equal(isBlockedAddress('10.0.0.1', { allowLoopback: true }), true);
  await assertPublicUrl('http://127.0.0.1:1234/c.png', { allowLoopback: true });
  await assert.rejects(assertPublicUrl('http://192.168.1.1/c.png', { allowLoopback: true }), { code: 'ESSRF' });
});
