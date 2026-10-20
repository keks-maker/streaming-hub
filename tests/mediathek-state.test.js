'use strict';

// Tests: Meine Serien (favorites.js), Weiterschauen-Anbindung an den Verlauf (watch-progress.js, resume.js) und die Serienseiten-Logik
// (series-page.js), portiert aus MediathekFavoritesServiceTests/MediathekSeriesPageTests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediathekFavorites } = require('../lib/mediathek/favorites.js');
const { createWatchProgress } = require('../lib/mediathek/watch-progress.js');
const resume = require('../lib/mediathek/resume.js');
const { groupBySeason } = require('../lib/mediathek/entries.js');
const { seasonNumbers, orderedSeasons, chronological, playTarget } = require('../lib/mediathek/series-page.js');
const { makeEntry } = require('../lib/mediathek/util.js');

const seriesA = { id: 'a', title: 'Das Institut', sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/a' };
const seriesB = { id: 'b', title: 'Murdoch', sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/b' };

function memoryStore(initial) {
  const store = { value: initial, writes: 0 };
  return { store, read: () => store.value, write: list => { store.value = JSON.parse(JSON.stringify(list)); store.writes += 1; } };
}

test('Meine Serien: hinzufügen, entfernen, persistieren (Reihenfolge des Hinzufügens)', () => {
  const m = memoryStore([]);
  const favorites = createMediathekFavorites(m);
  assert.equal(favorites.toggle(seriesA).favorite, true);
  assert.equal(favorites.toggle(seriesB).favorite, true);
  assert.equal(favorites.isFavorite('a'), true);
  assert.deepEqual(createMediathekFavorites({ read: m.read, write: m.write }).list().map(s => s.id), ['a', 'b']);
  assert.equal(favorites.toggle(seriesA).favorite, false);
  assert.equal(favorites.isFavorite('a'), false);
  assert.deepEqual(createMediathekFavorites({ read: m.read, write: m.write }).list(), [{ ...seriesB, imageUrl: null, description: null }]);
});

test('Meine Serien: Datenformat wie Apple (sechs Felder), fremde Felder und ungültige Einträge entfallen', () => {
  const m = memoryStore([{ ...seriesA, imageUrl: 'https://x/y.jpg', description: 'D', extra: 1 }, { id: 'kaputt' }, 5, null, { ...seriesB, sourceId: 'rtl' }]);
  const favorites = createMediathekFavorites(m);
  assert.deepEqual(favorites.list(), [{ id: 'a', title: 'Das Institut', imageUrl: 'https://x/y.jpg', description: 'D', sourceId: 'ard', groupingURL: seriesA.groupingURL }]);
  assert.deepEqual(Object.keys(favorites.list()[0]), ['id', 'title', 'imageUrl', 'description', 'sourceId', 'groupingURL']);
  assert.throws(() => favorites.toggle({ id: 'x' }), /ungültig/);
  assert.equal(m.store.writes, 0);
  // unlesbare Datei: leerer Start statt Absturz
  const broken = createMediathekFavorites({ read: () => { throw new Error('kaputt'); }, write: () => {}, logger: { warn() {} } });
  assert.deepEqual(broken.list(), []);
  assert.deepEqual(createMediathekFavorites({ read: () => ({ not: 'array' }), write: () => {} }).list(), []);
});

test('Meine Serien: list() liefert Kopien', () => {
  const favorites = createMediathekFavorites(memoryStore([seriesA]));
  favorites.list()[0].title = 'verändert';
  assert.equal(favorites.list()[0].title, 'Das Institut');
});

function historyStore(initial = []) {
  const state = { history: initial };
  let clock = 0;
  return { state, progress: createWatchProgress({ load: () => state.history, save: history => { state.history = JSON.parse(JSON.stringify(history)); }, now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, clock++)) }) };
}

test('Verlauf: record legt Eintrag im bestehenden Format an, Dubletten rücken nach vorn, Kappung bei 20', () => {
  const { state, progress } = historyStore([{ title: 'TV: Das Erste', serviceKey: '__tv__', serviceName: 'Das Erste', timestamp: '2026-01-01T00:00:00.000Z' }]);
  progress.record({ entry: { id: '1', title: 'Folge 1', sourceId: 'ard', imageUrl: 'https://i/1.jpg' }, series: seriesA, url: 'https://cdn/1.m3u8' });
  const first = state.history[0];
  assert.equal(first.title, 'Folge 1');
  assert.equal(first.serviceKey, 'mediathek:ard');
  assert.equal(first.serviceName, 'ARD Mediathek');
  assert.equal(first.url, 'https://cdn/1.m3u8');
  assert.equal(first.series.id, 'a');
  assert.ok(first.timestamp);
  assert.equal(state.history[1].serviceKey, '__tv__'); // andere Einträge unverändert
  progress.record({ entry: { id: '2', title: 'Folge 2', sourceId: 'ard' }, series: seriesA, url: 'https://cdn/2.m3u8' });
  progress.record({ entry: { id: '1', title: 'Folge 1', sourceId: 'ard' } });
  assert.deepEqual(state.history.slice(0, 2).map(e => e.title), ['Folge 1', 'Folge 2']);
  assert.equal(state.history[0].url, 'https://cdn/1.m3u8', 'Adresse bleibt erhalten');
  assert.equal(state.history[0].imageUrl, 'https://i/1.jpg');
  for (let i = 0; i < 30; i += 1) progress.record({ entry: { id: `x${i}`, title: `X${i}`, sourceId: 'zdf' } });
  assert.equal(state.history.length, 20);
  assert.equal(progress.entries().every(e => e.serviceKey.startsWith('mediathek:')), true);
});

test('Verlauf: Fortschritt speichern, zurücksetzen bei fast fertig, Startposition mit Rücksprung', () => {
  const { progress } = historyStore();
  assert.equal(progress.updateProgress({ sourceId: 'ard', title: 'unbekannt', position: 100, duration: 1000 }), false);
  progress.record({ entry: { id: '1', title: 'F1', sourceId: 'ard' }, url: 'https://cdn/1.m3u8' });
  assert.equal(progress.updateProgress({ sourceId: 'ard', title: 'F1', position: 300, duration: 1000 }), true);
  assert.deepEqual(progress.progress('ard', 'F1'), { position: 300, duration: 1000, start: 295 });
  progress.updateProgress({ sourceId: 'ard', title: 'F1', position: 960, duration: 1000 });
  assert.equal(progress.progress('ard', 'F1'), null);
  progress.updateProgress({ sourceId: 'ard', title: 'F1', position: 5, duration: 1000 });
  assert.equal(progress.progress('ard', 'F1'), null);
  assert.equal(progress.progress('zdf', 'F1'), null);
});

test('Resume-Regeln wie ResumeLogic (tvOS/iPad)', () => {
  assert.equal(resume.storedPosition(14, 1000), null);
  assert.equal(resume.storedPosition(15, 1000), 15);
  assert.equal(resume.storedPosition(950, 1000), null);
  assert.equal(resume.storedPosition(500, 0), null);
  assert.equal(resume.storedPosition(Infinity, 1000), null);
  assert.equal(resume.resumeStart(100, 1000), 95);
  assert.equal(resume.resumeStart(10, 1000), null);
  assert.equal(resume.resumeStart(970, 1000), null);
  assert.equal(resume.resumeStart(100, undefined), 95);
  assert.equal(resume.isResumable({ url: 'u', positionSeconds: 100, durationSeconds: 1000 }), true);
  assert.equal(resume.isResumable({ url: 'u', positionSeconds: 990, durationSeconds: 1000 }), false);
  assert.equal(resume.isResumable({ positionSeconds: 100, durationSeconds: 1000 }), false);
  assert.equal(resume.shelfKey({ series: seriesA, title: 'x' }), 'series:ard:a');
  assert.equal(resume.shelfKey({ serviceKey: 'mediathek:zdf', title: 'T' }), 'title:zdf:T');
});

const ep = (title, season, episode, airedAt = null) => makeEntry({ id: title, title, sourceId: 'ard', season, episode, airedAt });
const all = () => [ep('S1E1', 1, 1), ep('S1E2', 1, 2), ep('S2E1', 2, 1), ep('S2E2', 2, 2)];

test('Serienseite: Sortierung und Staffelfilter', () => {
  const seasons = groupBySeason(all());
  assert.deepEqual(orderedSeasons(seasons).flatMap(s => s.entries).map(e => e.title), ['S1E1', 'S1E2', 'S2E1', 'S2E2']);
  assert.deepEqual(orderedSeasons(seasons, { newestFirst: true }).flatMap(s => s.entries).map(e => e.title), ['S2E2', 'S2E1', 'S1E2', 'S1E1']);
  assert.deepEqual(seasonNumbers(seasons), [1, 2]);
  assert.deepEqual(orderedSeasons(seasons, { selectedSeason: 2 }).flatMap(s => s.entries).map(e => e.title), ['S2E1', 'S2E2']);
  assert.deepEqual(orderedSeasons(seasons, { selectedSeason: 2, newestFirst: true }).flatMap(s => s.entries).map(e => e.title), ['S2E2', 'S2E1']);
  const withRest = groupBySeason([...all(), ep('Extra', null, null)]);
  assert.deepEqual(orderedSeasons(withRest).map(s => s.number), [1, 2, null]);
  assert.deepEqual(orderedSeasons(withRest, { selectedSeason: 1 }).map(s => s.number), [1]);
});

test('Serienseite: chronologische Reihenfolge, Datum als Rückfall', () => {
  const dated = groupBySeason([ep('c', null, null, '2026-03-03T00:00:00.000Z'), ep('a', null, null, '2026-01-01T00:00:00.000Z'), ep('b', null, null, '2026-02-02T00:00:00.000Z'), ep('ohne', null, null)]);
  assert.deepEqual(chronological(dated).map(e => e.title), ['a', 'b', 'c', 'ohne']);
});

test('Abspielen-Ziel: Start, Fortsetzen, nächste Folge', () => {
  const seasons = groupBySeason(all());
  const empty = historyStore().progress;
  const start = playTarget(seasons, seriesA, empty);
  assert.deepEqual([start.entry.title, start.kind, start.label], ['S1E1', 'start', 'Abspielen']);
  const { progress } = historyStore();
  progress.record({ entry: { id: 'S1E2', title: 'S1E2', sourceId: 'ard' }, series: seriesA, url: 'http://x/2.m3u8' });
  const next = playTarget(seasons, seriesA, progress);
  assert.deepEqual([next.entry.title, next.kind, next.label], ['S2E1', 'next', 'Nächste Folge']);
  const other = playTarget(seasons, seriesB, progress);
  assert.deepEqual([other.entry.title, other.kind], ['S1E1', 'start']); // Verlauf einer anderen Serie zählt nicht
});

test('Abspielen-Ziel: begonnene Folge gewinnt, Ende der Serie, leere Serie', () => {
  const seasons = groupBySeason(all());
  const { progress } = historyStore();
  progress.record({ entry: { id: 'S1E1', title: 'S1E1', sourceId: 'ard' }, series: seriesA, url: 'http://x/1.m3u8' });
  progress.updateProgress({ sourceId: 'ard', title: 'S1E1', position: 300, duration: 1000 });
  progress.record({ entry: { id: 'S2E1', title: 'S2E1', sourceId: 'ard' }, series: seriesA, url: 'http://x/3.m3u8' });
  const target = playTarget(seasons, seriesA, progress);
  assert.deepEqual([target.entry.title, target.kind, target.label], ['S1E1', 'resume', 'Fortsetzen']);
  const finished = historyStore().progress;
  finished.record({ entry: { id: 'S2E2', title: 'S2E2', sourceId: 'ard' }, series: seriesA, url: 'http://x/4.m3u8' });
  assert.equal(playTarget(seasons, seriesA, finished).kind, 'start');
  assert.equal(playTarget([], seriesA, finished), null);
});
