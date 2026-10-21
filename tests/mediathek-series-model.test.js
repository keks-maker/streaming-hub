'use strict';

// Tests: Serienseite und Genre-Seite (mediathek-series-model.js): Laden mit Token, Staffelfilter, Sortierung,
// Beschriftung des Abspielen-Knopfs (Fortsetzen / Nächste Folge / Abspielen), Genre-Nachladen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeriesPage, createGenrePage } = require('../mediathek-series-model.js');
const { groupBySeason } = require('../lib/mediathek/entries.js');
const { seasonNumbers, playTarget } = require('../lib/mediathek/series-page.js');

const series = { id: 's', title: 'Murdoch', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/s' };
const ep = (id, season, episode, extra = {}) => ({ id, title: `Folge ${id}`, sourceId: 'ard', season, episode, airedAt: null, ...extra });
const seasons = groupBySeason([ep('a', 1, 1), ep('b', 1, 2), ep('c', 2, 1), ep('d', 2, 2), ep('x', null, null)]);

function apiFor(result) {
  return { series: async () => ({ ok: true, seasons, seasonNumbers: seasonNumbers(seasons), playTarget: result.playTarget || null, favorite: false }) };
}

test('Serie laden: Staffeln, Staffelauswahl nur bei mehr als einer Staffel', async () => {
  const page = createSeriesPage({ api: apiFor({}), series });
  assert.equal(page.snapshot().status, 'idle');
  await page.load();
  assert.equal(page.snapshot().status, 'loaded');
  assert.deepEqual(page.snapshot().seasonNumbers, [1, 2]);
  assert.equal(page.showSeasonPicker(), true);
  assert.equal(page.total(), 5);

  const single = createSeriesPage({ api: { series: async () => ({ ok: true, seasons: groupBySeason([ep('a', 1, 1)]), seasonNumbers: [1], playTarget: null, favorite: true }) }, series });
  await single.load();
  assert.equal(single.showSeasonPicker(), false);
  assert.equal(single.snapshot().favorite, true);
});

test('Staffelfilter und Sortierung', async () => {
  const page = createSeriesPage({ api: apiFor({}), series });
  await page.load();
  assert.deepEqual(page.visibleSeasons().map(s => s.number), [1, 2, null], 'Standard: älteste zuerst, Folgen ohne Staffel zuletzt');
  page.selectSeason(2);
  assert.deepEqual(page.visibleSeasons().map(s => [s.number, s.entries.map(e => e.id)]), [[2, ['c', 'd']]]);
  assert.equal(page.total(), 2);
  page.selectSeason(9); // unbekannte Staffel wird ignoriert
  assert.equal(page.snapshot().selectedSeason, 2);
  page.setSort(true);
  assert.deepEqual(page.visibleSeasons()[0].entries.map(e => e.id), ['d', 'c'], 'neueste zuerst auch innerhalb der Staffel');
  page.selectSeason(null);
  assert.deepEqual(page.visibleSeasons().map(s => s.number), [2, 1, null]);
});

test('Staffelauswahl bleibt nach erneutem Laden nur erhalten, wenn die Staffel noch existiert', async () => {
  let calls = 0;
  const api = { series: async () => ((calls += 1), { ok: true, seasons: calls === 1 ? seasons : groupBySeason([ep('a', 1, 1), ep('b', 1, 2)]), seasonNumbers: calls === 1 ? [1, 2] : [1], playTarget: null, favorite: false }) };
  const page = createSeriesPage({ api, series });
  await page.load();
  page.selectSeason(2);
  await page.load();
  assert.equal(page.snapshot().selectedSeason, null);
});

test('Abspielen-Knopf: Beschriftung folgt dem Ziel (Erste / Fortsetzen / Nächste Folge)', async () => {
  const none = new Map();
  const watch = entries => ({ lastUnfinishedEpisode: () => entries.unfinished || null, entries: () => entries.seen || [] });
  const labels = [];
  for (const history of [watch({}), watch({ unfinished: { title: 'Folge b' } }), watch({ seen: [{ title: 'Folge a', url: 'https://x', series: { id: 's', sourceId: 'ard' } }] })]) {
    const target = playTarget(seasons, series, history);
    const page = createSeriesPage({ api: { series: async () => ({ ok: true, seasons, seasonNumbers: [1, 2], playTarget: target, favorite: false }) }, series });
    await page.load();
    labels.push([page.playLabel(), page.snapshot().playTarget.entry.id]);
  }
  assert.deepEqual(labels, [['Abspielen', 'a'], ['Fortsetzen', 'b'], ['Nächste Folge', 'b']]);
  assert.equal(none.size, 0);
  const empty = createSeriesPage({ api: { series: async () => ({ ok: true, seasons: [], seasonNumbers: [], playTarget: null, favorite: false }) }, series });
  await empty.load();
  assert.equal(empty.snapshot().playTarget, null);
  assert.equal(empty.playLabel(), 'Abspielen');
});

test('Serie: Fehler, Wiederholen, veraltete Antwort wird verworfen', async () => {
  let attempt = 0;
  const first = {};
  first.promise = new Promise(done => (first.resolve = done));
  const api = {
    series: () => {
      attempt += 1;
      if (attempt === 1) return first.promise;
      if (attempt === 2) return Promise.resolve({ ok: false, error: 'nicht erreichbar' });
      return Promise.resolve({ ok: true, seasons, seasonNumbers: [1, 2], playTarget: null, favorite: false });
    },
  };
  const page = createSeriesPage({ api, series });
  const slow = page.load();
  await page.load();
  first.resolve({ ok: true, seasons, seasonNumbers: [1, 2], playTarget: null, favorite: false });
  await slow;
  assert.equal(page.snapshot().status, 'failed', 'die veraltete erste Antwort darf den Fehlerzustand nicht überschreiben');
  assert.equal(page.snapshot().error, 'nicht erreichbar');
  await page.load();
  assert.equal(page.snapshot().status, 'loaded');
});

test('Merken: Zustand der Serienseite ist umschaltbar', async () => {
  const page = createSeriesPage({ api: apiFor({}), series });
  await page.load();
  const seen = [];
  page.subscribe(() => seen.push(page.snapshot().favorite));
  page.setFavorite(true);
  page.setFavorite(false);
  assert.deepEqual(seen, [true, false]);
});

test('Genre-Seite: Reihen laden und nachladen', async () => {
  const genre = { id: 'DOR', title: 'Dokus', imageUrl: null, sourceId: 'arte' };
  const api = {
    genre: async () => ({ ok: true, sections: [{ title: 'Neu', entries: [{ id: '1', title: 'Eins', sourceId: 'arte' }], nextPage: 'https://api.arte.tv/n2' }, { title: 'Leer' }] }),
    loadMore: async payload => (payload.nextPage === 'https://api.arte.tv/n2' ? { ok: true, section: { title: 'Neu', entries: [{ id: '2', title: 'Zwei', sourceId: 'arte' }], series: [], nextPage: null } } : { ok: false, error: 'x' }),
  };
  const page = createGenrePage({ api, genre });
  await page.load();
  assert.equal(page.snapshot().status, 'loaded');
  assert.equal(page.snapshot().sections.length, 2);
  await page.loadMore(0);
  assert.deepEqual(page.snapshot().sections[0].entries.map(e => e.id), ['1', '2']);
  assert.equal(page.snapshot().sections[0].nextPage, null);
  await page.loadMore(1); // keine nextPage: nichts

  const failing = createGenrePage({ api: { genre: async () => ({ ok: false, error: 'offline' }) }, genre });
  await failing.load();
  assert.equal(failing.snapshot().status, 'failed');
  assert.equal(failing.snapshot().error, 'offline');
});

test('ARD-Serie seitenweise: Nachladen hängt Folgen an, Fortschritt, Fehler mit Wiederholung, veraltete Antworten entfallen', async () => {
  const calls = [];
  let fail = true;
  const all = [ep('a', null, null), ep('b', null, null), ep('c', null, null), ep('d', null, null)];
  const api = {
    series: async (_series, options) => {
      calls.push(options);
      const pages = options.pages || 1;
      if (pages > 1 && fail) {
        fail = false;
        return { ok: false, error: 'HTTP 503' };
      }
      const shown = all.slice(0, pages * 2);
      const seasons = groupBySeason(shown);
      return { ok: true, seasons, seasonNumbers: seasonNumbers(seasons), playTarget: null, favorite: false, hasMore: shown.length < all.length, progress: { loaded: shown.length, total: all.length }, availableSeasons: null };
    },
  };
  const page = createSeriesPage({ api, series });
  await page.load();
  assert.equal(page.total(), 2);
  assert.equal(page.canLoadMore(), true);
  assert.deepEqual(page.snapshot().progress, { loaded: 2, total: 4 });
  await page.loadMore(); // Fehler: Liste bleibt, Meldung gesetzt
  assert.equal(page.snapshot().moreError, 'HTTP 503');
  assert.equal(page.total(), 2);
  assert.equal(page.snapshot().loadingMore, false);
  await page.loadMore();
  assert.equal(page.snapshot().moreError, null);
  assert.equal(page.total(), 4);
  assert.equal(page.canLoadMore(), false);
  assert.deepEqual(calls.map(c => c.pages), [1, 5, 5]);
});

test('ARD-Staffelwahl über availableSeasons: Staffel wird komplett nachgeladen, Alle zeigt wieder die Liste, Fehler mit Wiederholung', async () => {
  const baseSeasons = groupBySeason([ep('a', null, null), ep('b', null, null)]);
  let seasonFails = true;
  const api = {
    series: async (_series, options) => {
      if (options.season) {
        if (seasonFails) {
          seasonFails = false;
          return { ok: false, error: 'kaputt' };
        }
        return { ok: true, seasons: groupBySeason([ep('s2a', options.season, 1), ep('s2b', options.season, 2)]), seasonNumbers: [1, 2, 3], favorite: false };
      }
      return { ok: true, seasons: baseSeasons, seasonNumbers: [1, 2, 3], playTarget: null, favorite: false, hasMore: true, progress: { loaded: 2, total: 99 }, availableSeasons: [1, 2, 3] };
    },
  };
  const page = createSeriesPage({ api, series });
  await page.load();
  assert.equal(page.showSeasonPicker(), true, 'Staffeln stehen schon vor dem Laden bereit');
  assert.equal(page.canLoadMore(), true);
  page.selectSeason(2);
  assert.equal(page.snapshot().seasonStatus, 'loading');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.snapshot().seasonStatus, 'failed');
  await page.retrySeason();
  assert.equal(page.snapshot().seasonStatus, 'idle');
  assert.deepEqual(page.visibleSeasons().map(s => [s.number, s.entries.map(e => e.id)]), [[2, ['s2a', 's2b']]]);
  assert.equal(page.canLoadMore(), false, 'eine komplett geladene Staffel braucht kein Nachladen');
  assert.deepEqual(page.loadedSeasons().flatMap(s => s.entries.map(e => e.id)).sort(), ['a', 'b', 's2a', 's2b'], 'Download-Auswahl sieht Liste und geladene Staffeln');
  page.selectSeason(null);
  assert.deepEqual(page.visibleSeasons().flatMap(s => s.entries.map(e => e.id)), ['a', 'b']);
  assert.equal(page.canLoadMore(), true);
  page.selectSeason(2); // aus dem Zwischenspeicher, kein erneuter Abruf
  assert.equal(page.snapshot().seasonStatus, 'idle');
  assert.equal(page.total(), 2);
});
