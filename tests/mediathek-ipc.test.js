'use strict';

// Tests: mediathek:*-IPC (lib/mediathek/ipc.js, validation.js): Absenderprüfung, Schema-Validierung, Ergebnisformen,
// Verlauf-Anbindung bei der Wiedergabe. Service-Ersatz ohne Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const { registerMediathekIpc } = require('../lib/mediathek/ipc.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { createMediathekFavorites } = require('../lib/mediathek/favorites.js');
const { createWatchProgress } = require('../lib/mediathek/watch-progress.js');
const v = require('../lib/mediathek/validation.js');

const series = { id: 'a', title: 'Das Institut', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/a?embedded=true' };
const entry = { id: 'abc', title: 'Folge (S01/E02)', sourceId: 'ard', partner: 'zdf' };

function setup({ routes = {} } = {}) {
  const handlers = new Map();
  const sent = [];
  const stored = { favorites: [], history: [] };
  const calls = [];
  const http = {
    async getText(url) {
      calls.push(url);
      const hit = Object.entries(routes).find(([key]) => url.includes(key));
      if (!hit) throw Object.assign(new Error('Server nicht gefunden'), { code: 'network' });
      return hit[1];
    },
  };
  registerMediathekIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    service: createMediathekService({ http }),
    favorites: createMediathekFavorites({ read: () => stored.favorites, write: list => { stored.favorites = JSON.parse(JSON.stringify(list)); } }),
    watchProgress: createWatchProgress({ load: () => stored.history, save: history => { stored.history = JSON.parse(JSON.stringify(history)); } }),
    requireMainRenderer: event => {
      if (event.sender !== 'main') throw new Error('Nur das Hauptfenster darf Mediathek-Kanäle nutzen');
    },
    sendToMain: (channel, payload) => sent.push([channel, payload]),
    logger: { warn() {} },
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender: 'main' }, ...args);
  return { handlers, call, sent, stored, calls };
}

test('Alle Kanäle sind registriert und verweigern fremde Absender', async () => {
  const { handlers } = setup();
  const channels = ['home', 'search', 'series', 'genre', 'load-more', 'resolve-playback', 'entry-fsk', 'favorites-get', 'favorites-toggle', 'watch-progress', 'get-progress', 'resume-list', 'get-settings', 'set-settings'].map(name => `mediathek:${name}`);
  assert.deepEqual([...handlers.keys()].sort(), channels.sort());
  for (const channel of channels) {
    assert.throws(() => handlers.get(channel)({ sender: 'webview' }, {}), /Hauptfenster/, channel);
  }
});

test('Validierung: unbekannte Felder, falsche Quellen, Längen, Adressen', async () => {
  const { call } = setup();
  assert.throws(() => call('mediathek:home', { source: 'rtl' }), /Mediathek/);
  assert.throws(() => call('mediathek:home', { source: 'ard', extra: 1 }), /Unbekanntes Feld/);
  assert.throws(() => call('mediathek:home', 'ard'));
  assert.throws(() => call('mediathek:search', { query: '', source: 'ard' }));
  assert.throws(() => call('mediathek:search', { query: '   ', source: 'ard' }));
  assert.throws(() => call('mediathek:search', { query: 'x'.repeat(201), source: 'ard' }));
  assert.throws(() => call('mediathek:search', { query: 'x', source: 'ard', page: -1 }));
  assert.throws(() => call('mediathek:search', { query: 'x', source: 'ard', page: 1.5 }));
  assert.throws(() => call('mediathek:search', { query: 'x\u0000', source: 'ard' }));
  assert.throws(() => call('mediathek:series', { series: { ...series, evil: 1 } }), /Unbekanntes Feld/);
  assert.throws(() => call('mediathek:series', { series: { ...series, sourceId: 'rtl' } }));
  assert.throws(() => call('mediathek:genre', { genre: { id: '../x', sourceId: 'arte' } }));
  assert.throws(() => call('mediathek:genre', { genre: { id: 'DOR', sourceId: 'ard' } }));
  assert.throws(() => call('mediathek:load-more', { section: { title: 'x', nextPage: 'https://evil.example/api/emac/v3/de/web/data/X/' } }));
  assert.throws(() => call('mediathek:resolve-playback', { entry: { ...entry, streamUrl: 'https://x.test/a.m3u8' } }), /Unbekanntes Feld/);
  assert.throws(() => call('mediathek:resolve-playback', { entry: { ...entry, id: '' } }));
  assert.throws(() => call('mediathek:watch-progress', { sourceId: 'ard', title: 'x', position: -1, duration: 10 }));
  assert.throws(() => call('mediathek:watch-progress', { sourceId: 'ard', title: 'x', position: 1, duration: 'zehn' }));
  assert.throws(() => call('mediathek:favorites-get', {}), /Unerwartete Eingabe/);
  assert.deepEqual(v.validateSearch({ query: ' Tatort ', source: 'zdf' }), { query: 'Tatort', source: 'zdf', page: 0 });
});

test('home/search/series/genre/load-more: Ergebnisform und Fehler als { ok: false }', async () => {
  const { call } = setup({
    routes: {
      '/pages/ard/home': fixture('ardHomeSections'),
      '/pages/ard/search': fixture('ardSearchInstitut'),
      '/pages/ard/grouping/a': fixture('ardGroupingMurdoch'),
      '/pages/DOR/': fixture('arteGenrePage'),
      '/data/': fixture('arteMore'),
    },
  });
  const home = await call('mediathek:home', { source: 'ard' });
  assert.equal(home.ok, true);
  assert.ok(home.sections.length > 0);
  const search = await call('mediathek:search', { query: 'Das Institut', source: 'ard' });
  assert.equal(search.ok, true);
  assert.equal(search.series.length, 2);
  assert.equal(search.hasMore, true);
  const page2 = await call('mediathek:search', { query: 'Das Institut', source: 'ard', page: 1 });
  assert.deepEqual(page2.series, []);
  const result = await call('mediathek:series', { series });
  assert.equal(result.ok, true);
  assert.deepEqual(result.seasonNumbers, [10]);
  assert.equal(result.seasons[0].entries.length, 3);
  assert.equal(result.playTarget.kind, 'start');
  assert.equal(result.favorite, false);
  const genre = await call('mediathek:genre', { genre: { id: 'DOR', title: 'Dokus', sourceId: 'arte' } });
  assert.ok(genre.ok && genre.sections.length > 0);
  const row = genre.sections.find(s => s.nextPage);
  const more = await call('mediathek:load-more', { section: { title: row.title, nextPage: row.nextPage } });
  assert.ok(more.ok && more.section.title === row.title);
  const failing = await call('mediathek:home', { source: 'zdf' });
  assert.deepEqual(failing, { ok: false, error: 'Server nicht gefunden', code: 'network' });
});

test('Favoriten: get/toggle, Event mediathek:favorites-changed, Stern in series', async () => {
  const { call, sent, stored } = setup({ routes: { '/grouping/a': fixture('ardGroupingMurdoch') } });
  assert.deepEqual(await call('mediathek:favorites-get'), { ok: true, series: [] });
  const added = await call('mediathek:favorites-toggle', { series });
  assert.equal(added.favorite, true);
  assert.equal(added.series.length, 1);
  assert.equal(stored.favorites[0].id, 'a');
  assert.deepEqual(sent.at(-1), ['mediathek:favorites-changed', added.series]);
  assert.equal((await call('mediathek:series', { series })).favorite, true);
  assert.equal((await call('mediathek:favorites-toggle', { series })).favorite, false);
  assert.deepEqual(sent.at(-1), ['mediathek:favorites-changed', []]);
});

test('Wiedergabe: frisch aufgelöst, Verlauf geschrieben, Startposition aus gespeichertem Fortschritt', async () => {
  const { call, stored, calls } = setup({ routes: { '/pages/zdf/item/abc': fixture('ardItemMurdochGeoWithStreams') } });
  const first = await call('mediathek:resolve-playback', { entry, series });
  assert.equal(first.ok, true);
  assert.equal(first.resolution.kind, 'playable');
  assert.equal(first.regionRestricted, true);
  assert.equal(first.startPosition, null);
  assert.equal(first.webUrl, 'https://www.ardmediathek.de/video/abc');
  assert.equal(stored.history[0].serviceKey, 'mediathek:ard');
  assert.equal(stored.history[0].url, first.resolution.url);
  assert.equal(stored.history[0].series.id, 'a');
  assert.deepEqual(await call('mediathek:watch-progress', { sourceId: 'ard', title: entry.title, position: 600, duration: 2000 }), { ok: true });
  assert.deepEqual((await call('mediathek:get-progress', { sourceId: 'ard', title: entry.title })).progress, { position: 600, duration: 2000, start: 595 });
  const again = await call('mediathek:resolve-playback', { entry, series });
  assert.equal(again.startPosition, 595);
  assert.equal(stored.history.length, 1);
  assert.equal(calls.filter(url => url.includes('/item/abc')).length, 2, 'Adresse wird nie aus dem Verlauf wiederverwendet');
});

test('Wiedergabe: Sperren liefern Meldung, schreiben keinen Verlauf', async () => {
  const routes = { '/item/fsk': fixture('ardItemInstitutFskBlocked'), '/item/geo': JSON.stringify({ widgets: [{ mediaCollection: { embedded: { isGeoBlocked: true, streams: [] } } }] }), '/item/none': fixture('ardItemNoMedia') };
  const { call, stored } = setup({ routes });
  const fsk = await call('mediathek:resolve-playback', { entry: { ...entry, id: 'fsk' } });
  assert.equal(fsk.resolution.kind, 'ageRestricted');
  assert.match(fsk.message, /FSK 16.*22 bis 6 Uhr/);
  assert.match((await call('mediathek:resolve-playback', { entry: { ...entry, id: 'geo' } })).message, /Geoblock/);
  assert.match((await call('mediathek:resolve-playback', { entry: { ...entry, id: 'none' } })).message, /nicht verfügbar/);
  assert.deepEqual(stored.history, []);
});

test('Leere Folgenliste (FSK tagsüber): Erklärung statt leerer Meldung; Konto liefert die Liste', async () => {
  const { call } = setup({ routes: { '/grouping/a': '{"widgets":[]}' } });
  const empty = await call('mediathek:series', { series });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.seasons, []);
  assert.match(empty.emptyNote, /ab 22 Uhr \(FSK 16\) bzw\. 23 Uhr \(FSK 18\)/);
  assert.ok(!/Konto/.test(empty.emptyNote)); // ohne Konto-Unterstützung kein Hinweis
  assert.equal(empty.emptyConnect, false, 'ohne Konto-Unterstützung kein Knopf "Konto verbinden"');

  const urls = [];
  const http = { getText: async (url) => { urls.push(url); return url.includes('userId=u1') ? fixture('ardGroupingMurdoch') : '{"widgets":[]}'; } };
  const auth = { accountState: () => 'signedIn', ensureFresh: async () => {}, tokenUsable: () => true, personalizeUrl: (sender, url) => `${url}&userId=u1` };
  const service = createMediathekService({ http, auth });
  const retried = await service.retryEmptySeries(series);
  assert.equal(retried.account, 'unlocked');
  assert.equal(retried.entries.length, 3);
  assert.ok(urls[0].includes('userId=u1'));
  const signedOut = createMediathekService({ http, auth: { ...auth, accountState: () => 'signedOut' } });
  assert.deepEqual(await signedOut.retryEmptySeries(series), { entries: [], account: 'signedOut' });
  const other = await signedOut.retryEmptySeries({ ...series, sourceId: 'arte' });
  assert.equal(other.account, 'signedOut');
});
