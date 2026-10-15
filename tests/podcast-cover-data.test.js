'use strict';

// Tests: Cover-Lader im Main (http-Cover als data:-URL, nur Bilder, Limits, Cache) und Datenspeicher der Oberfläche
// (Laden, Events, Hörstatus-Patch, veraltete Antworten).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoverLoader } = require('../lib/podcast/podcast-cover.js');
const { resolveCoverSource } = require('../podcast-cover-view.js');
const { createPodcastData } = require('../podcast-data.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(16)]);

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const { status = 200, body = PNG, headers = {} } = handler(url);
    return { status, headers: { get: name => headers[name.toLowerCase()] || null }, body: null, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  return { fetchImpl, calls };
}

test('Cover-Lader: http-Bild wird als data:-URL geliefert und zwischengespeichert', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({}));
  const loader = createCoverLoader({ fetchImpl, guardUrl: async () => {} });
  const first = await loader.load('http://img.test/c.png');
  assert.equal(first.ok, true);
  assert.match(first.dataUrl, /^data:image\/png;base64,/);
  await loader.load('http://img.test/c.png');
  assert.equal(calls.length, 1);
});

test('Cover-Lader: Nicht-Bilder, Fehlerstatus, zu große Dateien und ungültige Adressen liefern ok:false', async () => {
  const html = Buffer.from('<html>kein Bild</html>');
  const big = Buffer.concat([PNG, Buffer.alloc(2000)]);
  const { fetchImpl } = fakeFetch(url => (url.includes('html') ? { body: html } : url.includes('404') ? { status: 404 } : url.includes('big') ? { body: big } : {}));
  const loader = createCoverLoader({ fetchImpl, maxBytes: 1000, guardUrl: async () => {} });
  assert.equal((await loader.load('http://img.test/html')).ok, false);
  assert.equal((await loader.load('http://img.test/404')).ok, false);
  assert.equal((await loader.load('http://img.test/big')).ok, false);
  assert.equal((await loader.load('ftp://img.test/c.png')).ok, false);
  assert.equal((await loader.load('http://u:p@img.test/c.png')).ok, false);
  assert.equal((await loader.load('')).ok, false);
});

test('Cover-Auflösung im Renderer: https direkt, http über den Main, sonst null', async () => {
  const calls = [];
  const podcasts = { getCover: async url => (calls.push(url), { ok: true, dataUrl: 'data:image/png;base64,AAAA' }) };
  assert.equal(await resolveCoverSource(podcasts, 'https://a.test/c.png'), 'https://a.test/c.png');
  assert.equal(calls.length, 0);
  assert.equal(await resolveCoverSource(podcasts, 'http://a.test/c.png'), 'data:image/png;base64,AAAA');
  assert.equal(await resolveCoverSource(podcasts, 'javascript:alert(1)'), null);
  assert.equal(await resolveCoverSource({ getCover: async () => ({ ok: true, dataUrl: 'javascript:1' }) }, 'http://a.test/c.png'), null);
  assert.equal(await resolveCoverSource({ getCover: async () => { throw new Error('x'); } }, 'http://a.test/c.png'), null);
});

function fakePodcasts() {
  const handlers = {};
  const on = name => cb => ((handlers[name] = cb), () => delete handlers[name]);
  const api = {
    subs: [{ id: 'a', title: 'A', feed: {} }],
    episodes: { a: [{ id: 'e1', title: 'E1', state: { position: 0, played: false } }] },
    list: async () => api.subs,
    episodesCalls: 0,
    episodesFn: async id => {
      api.episodesCalls += 1;
      return { fetchedAt: 'x', channel: null, episodes: api.episodes[id] || [] };
    },
    getCatalog: async () => [{ id: 'cat', podcasts: [] }],
    refresh: async () => ({ ok: true, failed: 0 }),
    onSubscriptionsChanged: on('subs'),
    onRefreshed: on('refreshed'),
    onStateChanged: on('state'),
    handlers,
  };
  api.episodes_ = api.episodesFn;
  return { ...api, episodes: api.episodesFn, _api: api };
}

test('Datenspeicher: lädt Abos und Episoden, patcht den Hörstatus ohne Neuladen, lädt auf Abo-Events neu', async () => {
  const fake = fakePodcasts();
  fake._api.subs = [{ id: 'a', title: 'A', feed: {} }];
  const timers = { fired: [], setTimeout: fn => (timers.fired.push(fn), 1), clearTimeout: () => {} };
  const data = createPodcastData({ podcasts: fake, timers });
  let changes = 0;
  data.subscribe(() => (changes += 1));
  assert.equal(data.snapshot().loaded, false);
  await data.load();
  const snap = data.snapshot();
  assert.equal(snap.loaded, true);
  assert.equal(snap.subscriptions.length, 1);
  assert.equal(snap.episodes.a.episodes.length, 1);
  assert.equal(fake._api.episodesCalls, 1);
  fake.handlers.state({ podcastId: 'a', episodeId: 'e1', state: { position: 0, played: true, duration: null } });
  assert.equal(data.snapshot().episodes.a.episodes[0].state.played, true);
  assert.equal(fake._api.episodesCalls, 1);
  fake.handlers.subs([]);
  fake.handlers.refreshed({});
  assert.equal(timers.fired.length, 2);
  await data.loadCatalog();
  assert.equal(data.snapshot().catalog.length, 1);
  assert.ok(changes >= 3);
  data.dispose();
  assert.equal(fake.handlers.subs, undefined);
});

test('Datenspeicher: Ladefehler wird gemeldet, „Jetzt aktualisieren“ lädt danach neu und sperrt Doppelklick', async () => {
  const fake = fakePodcasts();
  fake.list = async () => {
    throw new Error('kaputt');
  };
  const data = createPodcastData({ podcasts: fake });
  await data.load();
  assert.equal(data.snapshot().loadError, 'Abos konnten nicht geladen werden');
  assert.equal(data.snapshot().loaded, true);
  const ok = fakePodcasts();
  const second = createPodcastData({ podcasts: ok });
  const first = second.refreshAll();
  assert.equal((await second.refreshAll()).ok, false);
  assert.equal((await first).ok, true);
  assert.equal(second.snapshot().refreshing, false);
  assert.equal(second.snapshot().loaded, true);
});
