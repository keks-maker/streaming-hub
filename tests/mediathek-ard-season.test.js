'use strict';

// Tests: ARD-Staffel/Folge über das Staffel-Widget (ard-season.js, resolveForDownload mit Serie), Verlauf "gesehen"
// (watch-progress.js) sowie Beenden-/Tray-Entscheidungen mit Downloads (quit-guard.js, keep-alive.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const season = require('../lib/mediathek/ard-season.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { createWatchProgress } = require('../lib/mediathek/watch-progress.js');
const { buildQuitPrompt, buildDownloadsPrompt, choiceFromResponse } = require('../lib/recorder/quit-guard.js');
const { decideWindowAllClosed } = require('../lib/radio/keep-alive.js');
const { QuitCoordinator } = require('../lib/recorder/QuitCoordinator.js');

const SERIES = { id: 'GROUP1', title: 'Serie', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/GROUP1?embedded=true' };

const teaser = (id, title, aired, over = {}) => ({ id: `hash:${id}`, longTitle: title, type: 'ondemand', coreAssetType: 'EPISODE', broadcastedOn: aired, links: { target: { href: `https://api.ardmediathek.de/page-gateway/pages/ard/item/${id}?embedded=true` } }, ...over });

const GROUPING = { widgets: [{ type: 'gridlist', show: { title: 'Serie', availableSeasons: ['2', '1', 'x', '2'] }, teasers: [] }] };
const SEASON1 = { teasers: [teaser('I2', 'Zweite', '2026-01-09T20:00:00Z'), teaser('I1', 'Erste', '2026-01-02T20:00:00Z'), teaser('X1', 'Trailer', '2026-01-01T20:00:00Z', { coreAssetType: 'EXTRA_PROMO' })], pagination: { totalElements: 3 } };
const SEASON2 = { teasers: [teaser('J1', 'Staffel zwei, Folge eins', '2026-02-02T20:00:00Z')], pagination: { totalElements: 1 } };

test('availableSeasons: Zahlen aufsteigend, ohne Dubletten und Müll', () => {
  assert.deepEqual(season.availableSeasons(GROUPING), [1, 2]);
  assert.deepEqual(season.availableSeasons({}), []);
  assert.deepEqual(season.availableSeasons({ widgets: [{ show: { availableSeasons: ['2026', 0, '3'] } }] }), [3]); // Jahr und 0 sind keine Staffeln
});

test('seasonAssetUrl und episodePosition', () => {
  const url = season.seasonAssetUrl('Y3JpZDo/x', 3, 1);
  assert.match(url, /^https:\/\/api\.ardmediathek\.de\/page-gateway\/widgets\/ard\/asset\/Y3JpZDo%2Fx\?pageNumber=1&pageSize=48&embedded=true&seasoned=true&seasonNumber=3/);
  const entries = season.seasonEntries(SEASON1);
  assert.deepEqual(entries.map(entry => entry.id), ['I2', 'I1']); // Extras entfallen
  assert.equal(season.episodePosition(entries, 'I1'), 1);
  assert.equal(season.episodePosition(entries, 'I2'), 2);
  assert.equal(season.episodePosition(entries, 'nix'), null);
});

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async getText(url) {
      calls.push(url);
      const key = Object.keys(routes).find(route => url.includes(route));
      if (!key) throw Object.assign(new Error('HTTP 404'), { code: 'http', status: 404 });
      return JSON.stringify(routes[key]);
    },
  };
}

const ITEM = title => ({ widgets: [{ type: 'player_ondemand', title, mediaCollection: { embedded: { streams: [{ kind: 'main', media: [{ mimeType: 'video/mp4', url: 'https://cdn.example.invalid/a.mp4', maxVResolutionPx: 720, audios: [{ kind: 'standard', languageCode: 'deu' }] }] }] } } }] });

test('resolveForDownload: ARD-Staffel und Folge über Staffel-Widgets, ein Abruf je Staffel (Cache)', async () => {
  const http = fakeHttp({ '/item/I1': ITEM('Erste'), '/item/J1': ITEM('Staffel zwei, Folge eins'), '/item/I2': ITEM('Zweite'), '/pages/ard/grouping/GROUP1': GROUPING, 'seasonNumber=1': SEASON1, 'seasonNumber=2': SEASON2 });
  const service = createMediathekService({ http });
  const first = await service.resolveForDownload({ id: 'I1', title: 'Erste', sourceId: 'ard' }, { series: SERIES });
  assert.deepEqual([first.season, first.episode], [1, 1]);
  const second = await service.resolveForDownload({ id: 'I2', title: 'Zweite', sourceId: 'ard' }, { series: SERIES });
  assert.deepEqual([second.season, second.episode], [1, 2]);
  const other = await service.resolveForDownload({ id: 'J1', title: 'Staffel zwei, Folge eins', sourceId: 'ard' }, { series: SERIES });
  assert.deepEqual([other.season, other.episode], [2, 1]);
  const seasonCalls = http.calls.filter(url => url.includes('seasoned=true'));
  assert.equal(seasonCalls.length, 2); // Staffel 1 und 2 je einmal
  assert.equal(http.calls.filter(url => url.includes('/grouping/GROUP1')).length, 1);
});

test('resolveForDownload: Titel-Regex hat Vorrang, ohne Serie/bei Fehlern bleibt es bei null', async () => {
  const http = fakeHttp({ '/item/I1': ITEM('Erste (S03/E07)'), '/item/X': ITEM('Ohne'), '/pages/ard/grouping/GROUP1': GROUPING, 'seasonNumber=1': SEASON1 });
  const service = createMediathekService({ http });
  const regex = await service.resolveForDownload({ id: 'I1', title: 'Erste (S03/E07)', sourceId: 'ard' }, { series: SERIES });
  assert.deepEqual([regex.season, regex.episode], [3, 7]);
  assert.equal(http.calls.filter(url => url.includes('seasoned=true')).length, 0);
  const noSeries = await service.resolveForDownload({ id: 'X', title: 'Ohne', sourceId: 'ard' });
  assert.deepEqual([noSeries.season, noSeries.episode], [null, null]);
  const broken = createMediathekService({ http: fakeHttp({ '/item/X': ITEM('Ohne') }) }); // Grouping nicht erreichbar
  const fallback = await broken.resolveForDownload({ id: 'X', title: 'Ohne', sourceId: 'ard' }, { series: SERIES });
  assert.deepEqual([fallback.season, fallback.episode], [null, null]);
  const foreign = createMediathekService({ http: fakeHttp({ '/item/X': ITEM('Ohne') }) });
  const zdfSeries = { ...SERIES, sourceId: 'zdf' };
  assert.equal((await foreign.resolveForDownload({ id: 'X', title: 'Ohne', sourceId: 'ard' }, { series: zdfSeries })).season, null);
  const evil = { ...SERIES, groupingURL: 'https://evil.example.com/page-gateway/pages/ard/grouping/G' };
  assert.equal((await foreign.resolveForDownload({ id: 'X', title: 'Ohne', sourceId: 'ard' }, { series: evil })).season, null);
});

test('Verlauf: "gesehen" nur nach vollständigem Ansehen, bleibt nach Zurücksetzen der Position', () => {
  let history = [];
  const watch = createWatchProgress({ load: () => history, save: value => { history = value; } });
  const entry = { sourceId: 'ard', title: 'Folge 1', id: 'E1', imageUrl: null };
  watch.record({ entry, url: 'file:///x.mp4' });
  assert.equal(watch.isWatched('ard', 'Folge 1'), false);
  watch.updateProgress({ sourceId: 'ard', title: 'Folge 1', position: 600, duration: 1800 });
  assert.equal(watch.isWatched('ard', 'Folge 1'), false);
  watch.updateProgress({ sourceId: 'ard', title: 'Folge 1', position: 1790, duration: 1800 });
  assert.equal(watch.isWatched('ard', 'Folge 1'), true);
  assert.equal(history[0].positionSeconds, null);
  assert.equal(watch.isWatched('zdf', 'Folge 1'), false);
});

test('Beenden-Dialog mit Downloads: nur Downloads, Planung plus Downloads, nichts', () => {
  assert.equal(buildQuitPrompt({ entries: [], nowMs: 0 }), null);
  const only = buildQuitPrompt({ entries: [], nowMs: 0, activeDownloads: 2 });
  assert.equal(only.entryId, null);
  assert.match(only.options.message, /2 Mediathek-Downloads/);
  assert.deepEqual(only.options.buttons, ['Im Hintergrund behalten', 'Trotzdem beenden']);
  assert.match(buildDownloadsPrompt(1).options.message, /ein Mediathek-Download/);
  const entries = [{ id: 'sch_a', channelId: 'c', channelName: 'Das Erste', title: 'Tagesschau', epgStart: '2026-10-05T20:15:00+02:00', epgStop: '2026-10-05T20:30:00+02:00', state: 'scheduled' }];
  const both = buildQuitPrompt({ entries, nowMs: Date.parse('2026-10-05T12:00:00+02:00'), activeDownloads: 3 });
  assert.match(both.options.message, /Aufnahme geplant/);
  assert.match(both.options.detail, /3 Mediathek-Downloads/);
  assert.equal(choiceFromResponse(1), 'quit');
});

test('QuitCoordinator: Quit mit laufenden Downloads fragt nach; "Trotzdem beenden" beendet', async () => {
  const asked = [];
  let quit = 0;
  const coordinator = new QuitCoordinator({ app: { quit: () => { quit += 1; } }, askDialog: async (win, options) => { asked.push(options.message); return { response: 1 }; }, getEntries: () => [], getActiveDownloads: () => 2 });
  let prevented = 0;
  assert.equal(coordinator.handleBeforeQuit({ preventDefault: () => { prevented += 1; } }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 1);
  assert.match(asked[0], /2 Mediathek-Downloads/);
  assert.equal(quit, 1);
  const idle = new QuitCoordinator({ app: { quit() {} }, askDialog: async () => ({ response: 0 }), getEntries: () => [], getActiveDownloads: () => 0 });
  assert.equal(idle.handleBeforeQuit({ preventDefault() {} }), false);
});

test('Fenster zu: laufende Downloads halten die App im Tray (nur mit Tray), Aufnahmen haben Vorrang', () => {
  const none = { activeJobs: () => [] };
  assert.deepEqual(decideWindowAllClosed({ recorder: none, scheduler: null, downloads: { active: 2, hasTray: true } }), { quit: false, reason: 'downloads' });
  assert.deepEqual(decideWindowAllClosed({ recorder: none, scheduler: null, downloads: { active: 2, hasTray: false } }), { quit: true, reason: null });
  assert.deepEqual(decideWindowAllClosed({ recorder: none, scheduler: null, downloads: { active: 0, hasTray: true } }), { quit: true, reason: null });
  assert.deepEqual(decideWindowAllClosed({ recorder: { activeJobs: () => [1] }, scheduler: null, downloads: { active: 2, hasTray: true } }), { quit: false, reason: 'recording' });
  assert.deepEqual(decideWindowAllClosed({ recorder: none, scheduler: null }), { quit: true, reason: null });
});

test('hasMorePages: nur bei mehr Elementen als die bisherigen Seiten fassen, höchstens 4 Seiten', () => {
  assert.equal(season.hasMorePages({ pagination: { totalElements: 48 } }, 0), false);
  assert.equal(season.hasMorePages({ pagination: { totalElements: 49 } }, 0), true);
  assert.equal(season.hasMorePages({ pagination: { totalElements: 49 } }, 1), false);
  assert.equal(season.hasMorePages({ pagination: { totalElements: 9999 } }, 3), false);
  assert.equal(season.hasMorePages({}, 0), false);
});
