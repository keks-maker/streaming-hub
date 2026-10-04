'use strict';

// Tests: resolveScheduledStream (aus main.js extrahiert → lib/recorder/stream-resolver.js).
// Quellen, M3U-Laden und Overrides sind injiziert — kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamResolver } = require('../lib/recorder/stream-resolver.js');

const SOURCES = [
  { id: 'q1', name: 'Quelle 1', url: 'https://q1.example/list.m3u' },
  { id: 'q2', name: 'Quelle 2', url: 'https://q2.example/list.m3u' },
];

function make({ sources = SOURCES, lists = {}, overrides = c => c, logs = [] } = {}) {
  const loads = [];
  const resolve = createStreamResolver({
    loadTvSources: () => sources,
    loadM3uChannels: async url => {
      loads.push(url);
      const list = lists[url];
      if (list instanceof Error) throw list;
      return { channels: list || [], baseUrl: '' };
    },
    applyChannelOverrides: (channels, source) => overrides(channels, source),
    describeM3uFetchError: () => 'Host nicht gefunden',
    logger: { warn: (...a) => logs.push(a.join(' ')) },
  });
  return { resolve, loads, logs };
}

const ref = over => ({ sourceId: 'q1', channelId: 'ch1', tvgId: 'ARD.de', channelName: 'Das Erste', sourceUrlSnapshot: 'https://old.example/ard.m3u8', ...over });

test('frische URL aus der Senderliste (Kanal-ID); Snapshot wird nicht benutzt', async () => {
  const { resolve, loads } = make({ lists: { 'https://q1.example/list.m3u': [{ id: 'ch1', tvgId: 'ARD.de', name: 'Das Erste HD', url: 'https://fresh.example/ard.m3u8' }] } });
  const r = await resolve(ref());
  assert.deepEqual(r, { ok: true, url: 'https://fresh.example/ard.m3u8', channelName: 'Das Erste HD' });
  assert.deepEqual(loads, ['https://q1.example/list.m3u'], 'nur die Quelle des Eintrags');
});

test('Fallback über tvg-id, wenn sich die Kanal-ID geändert hat', async () => {
  const { resolve } = make({ lists: { 'https://q1.example/list.m3u': [{ id: 'neu', tvgId: 'ARD.de', name: 'Das Erste', url: 'http://fresh.example/x' }] } });
  assert.equal((await resolve(ref())).url, 'http://fresh.example/x');
});

test('Overrides (tvsources.json) werden angewandt: überschriebene Stream-URL gewinnt', async () => {
  const { resolve } = make({
    lists: { 'https://q1.example/list.m3u': [{ id: 'ch1', name: 'A', url: 'https://orig.example/a' }] },
    overrides: channels => channels.map(c => ({ ...c, url: 'https://override.example/a' })),
  });
  assert.equal((await resolve(ref())).url, 'https://override.example/a');
});

test('Quelle existiert nicht mehr → ok:false mit lesbarer Meldung', async () => {
  const { resolve } = make({ sources: [] });
  const r = await resolve(ref());
  assert.equal(r.ok, false);
  assert.match(r.message, /TV-Quelle von „Das Erste“ existiert nicht mehr/);
});

test('Kanal nicht mehr in der Liste → ok:false', async () => {
  const { resolve } = make({ lists: { 'https://q1.example/list.m3u': [{ id: 'andere', tvgId: 'X', name: 'X', url: 'https://x.example/x' }] } });
  const r = await resolve(ref());
  assert.equal(r.ok, false);
  assert.match(r.message, /nicht mehr in der Senderliste/);
});

test('Senderliste nicht ladbar: Snapshot als Fallback (mit Log), sonst ok:false; Log ohne URL', async () => {
  const logs = [];
  const err = new Error('getaddrinfo ENOTFOUND secret-host');
  const { resolve } = make({ lists: { 'https://q1.example/list.m3u': err }, logs });
  const r = await resolve(ref());
  assert.deepEqual(r, { ok: true, url: 'https://old.example/ard.m3u8', channelName: 'Das Erste' });
  assert.ok(logs.some(l => l.includes('Host nicht gefunden')));
  assert.ok(!logs.some(l => l.includes('secret-host') || l.includes('q1.example')));
  const none = await resolve(ref({ sourceUrlSnapshot: '' }));
  assert.equal(none.ok, false);
  assert.match(none.message, /Senderliste konnte nicht geladen werden/);
});

test('ohne sourceId werden alle Quellen durchsucht; nur http(s)-URLs gelten', async () => {
  const { resolve, loads } = make({
    lists: {
      'https://q1.example/list.m3u': [{ id: 'ch1', name: 'A', url: 'file:///etc/passwd' }],
      'https://q2.example/list.m3u': [{ id: 'ch1', name: 'A', url: 'https://q2.example/a.m3u8' }],
    },
  });
  const r = await resolve(ref({ sourceId: '' }));
  assert.equal(r.url, 'https://q2.example/a.m3u8');
  assert.equal(loads.length, 2);
});
