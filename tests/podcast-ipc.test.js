'use strict';

// Tests: Podcast-Validierung (input-/ipc-validation.js), Backup-Kompatibilität (backup.js) und die podcast:*-IPC-Kanäle
// (lib/podcast/ipc.js) mit Absenderprüfung.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { podcastFeedUrlError, radioStreamUrlError } = require('../lib/input-validation.js');
const v = require('../lib/ipc-validation.js');
const { parseBackup, validateBackup } = require('../lib/backup.js');
const { registerPodcastIpc } = require('../lib/podcast/ipc.js');
const { PodcastLibrary } = require('../lib/podcast/PodcastLibrary.js');
const { createPodcastRefresher } = require('../lib/podcast/podcast-refresh.js');
const { podcastIdFromFeedUrl } = require('../lib/podcast/podcast-ids.js');
const { createUserStorage } = require('../lib/user-storage.js');

test('podcastFeedUrlError: nur http/https ohne Zugangsdaten, Leerzeichen und Überlänge', () => {
  for (const ok of ['https://example.test/feed.xml', 'http://example.test/feed?token=abc123', 'http://192.168.1.2:8080/rss', 'https://example.test/a%20b']) {
    assert.equal(podcastFeedUrlError(ok), null, ok);
  }
  const bad = ['', null, undefined, 42, 'feed.xml', 'ftp://x.test/f', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/xml,<rss/>', '//x.test/f', 'https://u:p@x.test/f', 'https://x.test/a b', 'https://x.test/\u0007', `https://x.test/${'a'.repeat(2100)}`, 'feed://x.test/f'];
  for (const value of bad) assert.notEqual(podcastFeedUrlError(value), null, String(value));
  assert.match(podcastFeedUrlError('ftp://x.test'), /Feed-URL/);
  assert.equal(radioStreamUrlError('https://example.test/s'), null, 'Radio unverändert');
});

test('IPC-Schema: Suche, Abo, Aktualisierung, Position, Gehört', () => {
  assert.deepEqual(v.validatePodcastSearch({ term: 'Wissen', limit: 10 }), { term: 'Wissen', limit: 10 });
  assert.deepEqual(v.validatePodcastSearch({ term: 'x' }), { term: 'x' });
  for (const bad of [null, 'x', [], {}, { term: 5 }, { term: 'x', limit: 26 }, { term: 'x', limit: 0 }, { term: 'x', limit: 1.5 }, { term: 'x', extra: 1 }, { term: 'x'.repeat(501) }]) {
    assert.throws(() => v.validatePodcastSearch(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(v.validatePodcastSubscribe({ catalogId: 'deutschlandfunk-der-tag' }), { catalogId: 'deutschlandfunk-der-tag' });
  assert.deepEqual(v.validatePodcastSubscribe({ feedUrl: 'https://a.test/f', title: ' T ', cover: 'https://a.test/c.png' }), { feedUrl: 'https://a.test/f', source: 'eigene-podcasts', title: 'T', cover: 'https://a.test/c.png' });
  assert.equal(v.validatePodcastSubscribe({ feedUrl: 'https://a.test/f', source: 'suche' }).source, 'suche');
  for (const bad of [null, {}, { catalogId: 'a', feedUrl: 'https://a.test/f' }, { feedUrl: 'ftp://a.test/f' }, { feedUrl: 'https://a.test/f', source: 'oeffentlich-rechtlich' }, { feedUrl: 'https://a.test/f', cover: 'javascript:1' }, { feedUrl: 'https://a.test/f', title: 'x'.repeat(301) }, { feedUrl: 'https://a.test/f', evil: 1 }, { catalogId: '' }, { catalogId: 'a|b' }]) {
    assert.throws(() => v.validatePodcastSubscribe(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(v.validatePodcastRefresh(undefined), { force: false });
  assert.deepEqual(v.validatePodcastRefresh({ id: 'abc', force: true }), { id: 'abc', force: true });
  assert.throws(() => v.validatePodcastRefresh({ force: 'ja' }));
  assert.throws(() => v.validatePodcastRefresh('abc'));
  assert.deepEqual(v.validatePodcastPosition({ podcastId: 'p', episodeId: 'guid/mit:Zeichen', position: 12.5, duration: 600 }), { podcastId: 'p', episodeId: 'guid/mit:Zeichen', position: 12.5, duration: 600 });
  for (const bad of [{ podcastId: 'p', episodeId: 'e', position: -1 }, { podcastId: 'p', episodeId: 'e', position: NaN }, { podcastId: 'p', episodeId: 'e', position: '5' }, { podcastId: 'p', episodeId: 'e', position: 1, duration: 999999 }, { podcastId: 'p', position: 1 }, { podcastId: 'p|x', episodeId: 'e', position: 1 }, { podcastId: 'p', episodeId: 'e', position: 1, x: 1 }]) {
    assert.throws(() => v.validatePodcastPosition(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(v.validatePodcastPlayed({ podcastId: 'p', episodeId: 'e', played: true }), { podcastId: 'p', episodeId: 'e', played: true });
  assert.throws(() => v.validatePodcastPlayed({ podcastId: 'p', episodeId: 'e', played: 1 }));
});

const goodSub = url => ({ id: podcastIdFromFeedUrl(url), feedUrl: url, title: 'T', source: 'eigene-podcasts' });
const baseBackup = () => ({ services: [], tvsources: [], history: [] });

test('Backup: Podcasts optional (ältere Sicherungen gültig), Abos und Hörstatus werden geprüft', () => {
  assert.equal(validateBackup(baseBackup()).ok, true);
  assert.equal('podcasts' in validateBackup(baseBackup()).value, false);
  const full = { ...baseBackup(), podcasts: { subscriptions: [goodSub('https://a.test/feed')], subscriptionRank: [], overrides: {} }, podcastState: { episodes: { 'x|e': { position: 5, duration: 10, played: false, updatedAt: '2026-10-15T10:00:00Z' }, kaputt: 1 }, feeds: { x: { etag: 'secret' } } } };
  const result = validateBackup(full);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value.podcastState), ['version', 'episodes']);
  assert.deepEqual(Object.keys(result.value.podcastState.episodes), ['x|e'], 'nur gültiger Hörstatus, keine Feed-Validatoren');
  const bad = [
    { subscriptions: 'x' },
    { subscriptions: [{ id: 'a', title: 'T', feedUrl: 'ftp://a.test/f' }] },
    { subscriptions: [{ ...goodSub('https://a.test/feed'), id: 'falsche-id' }] },
    { subscriptions: [goodSub('https://a.test/feed'), goodSub('https://a.test/feed')] },
    { subscriptions: [{ ...goodSub('https://a.test/feed'), cover: 'javascript:1' }] },
    { subscriptions: [goodSub('https://a.test/feed')], overrides: [] },
    { subscriptions: [goodSub('https://a.test/feed')], subscriptionRank: 'x' },
  ];
  for (const podcasts of bad) assert.equal(validateBackup({ ...baseBackup(), podcasts }).ok, false, JSON.stringify(podcasts).slice(0, 60));
  assert.equal(validateBackup({ ...baseBackup(), podcastState: [] }).ok, false);
  assert.doesNotThrow(() => parseBackup(JSON.stringify(full)));
});

// ── IPC ──

function setupIpc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-podcast-ipc-'));
  const storage = createUserStorage({ userDataPath: path.join(root, 'u'), bundlePath: path.join(root, 'b') });
  fs.mkdirSync(path.join(root, 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b', 'podcastsources.json'), JSON.stringify([{ id: 'oeffentlich-rechtlich', name: 'ÖR', type: 'bundled', podcasts: [{ id: 'cat-1', name: 'Katalogsendung', author: 'DLF', feedUrl: 'https://cat.test/feed', cover: 'https://cat.test/c.jpg', genre: '' }] }]));
  const library = new PodcastLibrary({ userStorage: storage });
  const feed = fs.readFileSync(path.join(__dirname, 'fixtures', 'podcast', 'normal.xml'), 'utf8');
  const fetchCalls = [];
  const fetch = async url => {
    fetchCalls.push(url);
    return { status: 'ok', text: feed, etag: null, lastModified: null };
  };
  const handlers = new Map();
  const events = [];
  const mainSender = { id: 'main' };
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  registerPodcastIpc({
    ipcMain,
    library,
    refresher: createPodcastRefresher({ library, fetch }),
    search: { search: async (term, { limit }) => ({ results: [{ id: 'x', title: term, limit }], cached: false }) },
    requireMainRenderer: event => {
      if (event.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: (channel, payload) => events.push({ channel, payload }),
    feedFetch: fetch,
  });
  const call = async (channel, ...args) => handlers.get(channel)({ sender: mainSender }, ...args);
  return { handlers, call, events, library, fetchCalls, mainSender };
}

test('IPC: alle Kanäle sind registriert und lehnen fremde Absender ab', async () => {
  const { handlers } = setupIpc();
  const channels = ['search', 'catalog', 'list', 'subscribe', 'unsubscribe', 'episodes', 'refresh', 'probe-feed', 'set-played', 'save-position'].map(name => `podcast:${name}`);
  assert.deepEqual([...handlers.keys()].sort(), channels.sort());
  for (const channel of channels) {
    assert.throws(() => handlers.get(channel)({ sender: { id: 'webview' } }), /nicht autorisiert/, channel);
  }
});

test('IPC: Katalog-Abo übernimmt Daten aus der Liste (kein Spoofing), lädt den Feed, meldet Änderungen', async () => {
  const { call, events, fetchCalls } = setupIpc();
  assert.equal((await call('podcast:catalog'))[0].podcasts.length, 1);
  await assert.rejects(call('podcast:subscribe', { catalogId: 'unbekannt' }), /nicht in der mitgelieferten Liste/);
  const result = await call('podcast:subscribe', { catalogId: 'cat-1' });
  assert.equal(result.ok, true);
  assert.equal(result.added, true);
  assert.equal(result.subscription.title, 'Katalogsendung');
  assert.equal(result.subscription.source, 'oeffentlich-rechtlich');
  assert.equal(result.subscription.catalogId, 'cat-1');
  assert.equal(result.refresh.status, 'updated');
  assert.deepEqual(fetchCalls, ['https://cat.test/feed']);
  assert.equal(events.at(-1).channel, 'podcast:subscriptions-changed');
  const again = await call('podcast:subscribe', { catalogId: 'cat-1' });
  assert.equal(again.added, false);
  assert.equal(fetchCalls.length, 1, 'bereits abonniert: kein erneuter Abruf');
  const list = await call('podcast:list');
  assert.equal(list.length, 1);
  assert.equal(list[0].feed.lastError, null);
  assert.ok(list[0].feed.lastChecked);
  await assert.rejects(call('podcast:list', 'extra'), /Unerwartete Eingabe/);
});

test('IPC: eigener Feed prüfen, abonnieren, Episoden mit Hörzustand, Position/Gehört, Abo beenden', async () => {
  const { call, events } = setupIpc();
  const probe = await call('podcast:probe-feed', 'https://own.test/feed?token=geheim');
  assert.deepEqual([probe.ok, probe.title, probe.episodeCount], [true, 'Der & Test-Podcast', 3]);
  assert.deepEqual(await call('podcast:probe-feed', 'ftp://x.test/f'), { ok: false, error: 'Feed-URL muss mit http:// oder https:// beginnen' });
  const { subscription } = await call('podcast:subscribe', { feedUrl: 'https://own.test/feed?token=geheim' });
  assert.equal(subscription.title, 'Der & Test-Podcast', 'Titel aus dem Feed ergänzt');
  const listing = await call('podcast:episodes', subscription.id);
  assert.deepEqual(listing.episodes.map(e => e.id), ['ep-3', 'ep-2', 'ep-1']);
  const state = await call('podcast:save-position', { podcastId: subscription.id, episodeId: 'ep-3', position: 3600, duration: 3723 });
  assert.equal(state.played, true, '96,7 %');
  assert.ok(events.some(e => e.channel === 'podcast:state-changed' && e.payload.state.played));
  assert.equal((await call('podcast:episodes', subscription.id)).episodes[0].state.played, true);
  const unplayed = await call('podcast:set-played', { podcastId: subscription.id, episodeId: 'ep-3', played: false });
  assert.equal(unplayed.played, false);
  await assert.rejects(call('podcast:save-position', { podcastId: 'fremd', episodeId: 'e', position: 1 }), /Abo nicht gefunden/);
  await assert.rejects(call('podcast:episodes', 'fremd'), /Abo nicht gefunden/);
  assert.deepEqual(await call('podcast:unsubscribe', subscription.id), { ok: true, removed: true });
  assert.deepEqual(await call('podcast:unsubscribe', subscription.id), { ok: true, removed: false });
  assert.deepEqual(await call('podcast:list'), []);
});

test('IPC: Suche und Aktualisierung validieren Eingaben; Suchfehler werden als Ergebnis gemeldet', async () => {
  const { call, handlers } = setupIpc();
  assert.deepEqual((await call('podcast:search', { term: 'Wissen', limit: 5 })).results[0], { id: 'x', title: 'Wissen', limit: 5 });
  await assert.rejects(call('podcast:search', { term: 'Wissen', limit: 99 }), /Trefferzahl/);
  await assert.rejects(call('podcast:search', 'Wissen'));
  const failing = new Map();
  registerPodcastIpc({
    ipcMain: { handle: (c, fn) => failing.set(c, fn) },
    library: handlers && new PodcastLibrary({ userStorage: { readJson: (k, f) => f, writeJson() {} } }),
    refresher: null,
    search: { search: async () => { throw Object.assign(new Error('Zu viele Suchanfragen – bitte später erneut versuchen'), { code: 'rate-limited' }); } },
    requireMainRenderer: () => {},
    sendToMain: () => {},
  });
  assert.deepEqual(await failing.get('podcast:search')({}, { term: 'Wissen' }), { ok: false, error: 'Zu viele Suchanfragen – bitte später erneut versuchen', code: 'rate-limited' });
  const summary = await call('podcast:refresh');
  assert.equal(summary.ok, true);
  assert.equal((await call('podcast:refresh', { id: 'fremd' })).status, 'error');
  await assert.rejects(call('podcast:refresh', { force: 'x' }));
});
