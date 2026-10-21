'use strict';

// Tests: Hub-Modell der Mediathek-Oberfläche (mediathek-hub-model.js): Filterleiste, Reihen, Nachladen, Suche mit
// Request-Token und Paging, Startseite je Quelle.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../mediathek-hub-model.js');

const entry = (id, sourceId = 'ard') => ({ id, title: `Folge ${id}`, sourceId });
const series = (id, sourceId = 'ard') => ({ id, title: `Serie ${id}`, sourceId, groupingURL: `https://api.ardmediathek.de/g/${id}` });
const section = (title, extra = {}) => ({ title, entries: [], series: [], genres: [], nextPage: null, ...extra });

/** Antwort, die erst per resolve() geliefert wird – steuert die Reihenfolge paralleler Anfragen. */
function deferred() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}

test('Filterleiste: Quellen, Meine Serien, Weiterschauen, Weitere Mediatheken; Downloads-Chip nur auf Anforderung', () => {
  const items = m.filterItems({ enabledSources: ['ard', 'zdf', 'arte'] });
  assert.deepEqual(items.map(item => item.id), ['all', 'ard', 'zdf', 'arte', 'favorites', 'resume', 'others']);
  assert.equal(m.DOWNLOADS_CHIP_ENABLED, true);
  assert.ok(!items.some(item => item.id === 'downloads'));
  assert.deepEqual(m.filterItems({ enabledSources: ['zdf'], downloads: true }).map(item => item.id), ['all', 'zdf', 'favorites', 'resume', 'downloads', 'others']);
});

test('Filterleiste: ausgeblendete Quellen fehlen, bei der Suche nur Quellen mit Trefferzahl', () => {
  const searching = m.filterItems({ enabledSources: ['ard', 'arte'], searching: true, counts: { all: 5, ard: 3, arte: 2 } });
  assert.deepEqual(searching.map(item => [item.id, item.count]), [['all', 5], ['ard', 3], ['arte', 2]]);
  assert.equal(m.resolveFilter('zdf', searching), 'all');
  assert.equal(m.resolveFilter('arte', searching), 'arte');
  assert.deepEqual(m.activeSources('arte', ['ard', 'arte']), ['arte']);
  assert.deepEqual(m.activeSources('all', ['ard', 'arte']), ['ard', 'arte']);
  assert.equal(m.searchFilter('favorites'), 'all');
  assert.equal(m.searchFilter('zdf'), 'zdf');
  assert.deepEqual(m.enabledSourceIds({ sources: { ard: true, zdf: false, arte: true } }), ['ard', 'arte']);
  assert.deepEqual(m.enabledSourceIds(null), ['ard', 'zdf', 'arte']);
});

test('Reihen: reihum gemischt, Genre-Reihe zuerst, leere Reihen entfallen', () => {
  const loaded = sections => ({ status: 'loaded', sections: sections.map(s => ({ ...s, moreState: 'idle' })) });
  const home = {
    ard: loaded([section('A1', { entries: [entry('1')] }), section('A2', { entries: [entry('2')] })]),
    zdf: loaded([section('Z1', { series: [series('z', 'zdf')] })]),
    arte: loaded([section('Leer'), section('Genres', { genres: [{ id: 'ACT', title: 'Info', sourceId: 'arte' }] })]),
  };
  const rows = m.buildRows(home, ['ard', 'zdf', 'arte']);
  assert.deepEqual(rows.map(row => row.title), ['Genres', 'A1', 'Z1', 'A2']);
  assert.equal(rows[0].sourceId, 'arte');
  assert.deepEqual(m.buildRows({ ard: { status: 'loading', sections: [] } }, ['ard']), []);
  assert.deepEqual(m.buildRows(home, ['zdf']).map(row => row.id), ['zdf-0']);
});

test('Reihen: Rubriken (ARD, ZDF) und Genres (arte) stehen ganz oben, auch bei "Alle"', () => {
  const loaded = sections => ({ status: 'loaded', sections: sections.map(s => ({ ...s, moreState: 'idle' })) });
  const genre = (id, sourceId) => ({ id, title: id, sourceId });
  const home = {
    ard: loaded([section('A1', { entries: [entry('1')] }), section('Rubriken', { genres: [genre('ard/editorial/filme', 'ard')] })]),
    zdf: loaded([section('Z1', { entries: [entry('z', 'zdf')] }), section('Rubriken', { genres: [genre('filme-104', 'zdf')] })]),
    arte: loaded([section('Genres', { genres: [genre('DOR', 'arte')] })]),
  };
  assert.deepEqual(m.buildRows(home, ['ard', 'zdf', 'arte']).map(row => `${row.sourceId}:${row.title}`), ['ard:Rubriken', 'zdf:Rubriken', 'arte:Genres', 'ard:A1', 'zdf:Z1']);
  assert.deepEqual(m.buildRows(home, ['zdf']).map(row => row.title), ['Rubriken', 'Z1']);
});

test('Nachladen: Genre-Kacheln werden ohne Dubletten angehängt', () => {
  const base = section('Reihe', { genres: [{ id: 'a', title: 'A', sourceId: 'ard' }], nextPage: 'https://api.ardmediathek.de/page-gateway/widgets/x' });
  const merged = m.mergeSection(base, { genres: [{ id: 'a', title: 'A', sourceId: 'ard' }, { id: 'b', title: 'B', sourceId: 'ard' }], nextPage: null });
  assert.deepEqual(merged.genres.map(g => g.id), ['a', 'b']);
});

test('Nachladen: neue Seite wird ohne Dubletten angehängt, nextPage wandert weiter', () => {
  const base = { ...section('Highlights', { entries: [entry('1', 'arte'), entry('2', 'arte')], nextPage: 'https://api.arte.tv/p2' }), moreState: 'loading' };
  const merged = m.mergeSection(base, { entries: [entry('2', 'arte'), entry('3', 'arte')], series: [], nextPage: null });
  assert.deepEqual(merged.entries.map(e => e.id), ['1', '2', '3']);
  assert.equal(merged.nextPage, null);
  assert.equal(merged.moreState, 'idle');
});

test('Hub-Store: Startseiten laden, Fehler je Quelle, nur jüngste Anfrage zählt', async () => {
  const slow = deferred();
  let calls = 0;
  const api = {
    home: source => {
      calls += 1;
      if (source === 'zdf') return Promise.resolve({ ok: false, error: 'offline' });
      if (calls === 1) return slow.promise;
      return Promise.resolve({ ok: true, sections: [section('Neu', { entries: [entry('n')] })] });
    },
  };
  const store = m.createHubStore({ api });
  const first = store.loadHome('ard');
  assert.equal(store.snapshot().home.ard.status, 'loading');
  const second = store.loadHome('ard', { force: true });
  await second;
  slow.resolve({ ok: true, sections: [section('Alt', { entries: [entry('a')] })] });
  await first;
  assert.equal(store.snapshot().home.ard.sections[0].title, 'Neu', 'veraltete Antwort darf nichts überschreiben');
  await store.loadHome('zdf');
  assert.equal(store.snapshot().home.zdf.status, 'failed');
  assert.equal(store.snapshot().home.zdf.error, 'offline');
  await store.loadHome('ard');
  assert.equal(calls, 3, 'geladene Quelle wird ohne force nicht erneut abgerufen');
});

test('Hub-Store: Reihe nachladen (arte) hängt an, ein Fehler markiert die Reihe', async () => {
  let fail = false;
  const api = {
    home: async () => ({ ok: true, sections: [section('Highlights', { entries: [entry('1', 'arte')], nextPage: 'https://api.arte.tv/p2' })] }),
    loadMore: async payload => {
      assert.deepEqual(payload, { title: 'Highlights', nextPage: 'https://api.arte.tv/p2' });
      return fail ? { ok: false, error: 'x' } : { ok: true, section: section('Highlights', { entries: [entry('2', 'arte')] }) };
    },
  };
  const store = m.createHubStore({ api });
  await store.loadHome('arte');
  fail = true;
  await store.loadMoreRow('arte', 0);
  assert.equal(store.snapshot().home.arte.sections[0].moreState, 'failed');
  assert.equal(store.snapshot().home.arte.sections[0].nextPage, 'https://api.arte.tv/p2');
  fail = false;
  await store.loadMoreRow('arte', 0);
  const row = store.snapshot().home.arte.sections[0];
  assert.deepEqual(row.entries.map(e => e.id), ['1', '2']);
  assert.equal(row.nextPage, null);
  await store.loadMoreRow('arte', 0); // ohne nextPage: nichts
});

test('Hub-Store: Weiterschauen und Meine Serien, Favoriten-Abfrage', async () => {
  const api = { getResumeList: async () => ({ ok: true, items: [{ title: 'T', sourceId: 'ard', fraction: 0.4 }] }), getFavorites: async () => ({ ok: true, series: [series('f')] }) };
  const store = m.createHubStore({ api });
  await store.loadResume();
  await store.loadFavorites();
  assert.equal(store.snapshot().resume.length, 1);
  assert.equal(store.snapshot().resumeLoaded, true);
  assert.equal(store.isFavorite(series('f')), true);
  assert.equal(store.isFavorite(series('g')), false);
  assert.deepEqual(m.resumeCard({ title: 'T', sourceId: 'ard', imageUrl: undefined, fraction: 0.4 }), { title: 'T', sourceId: 'ard', imageUrl: null, series: null, fraction: 0.4, fsk: null });
  assert.equal(m.resumeCard({ title: 'T', sourceId: 'ard', fsk: 6 }).fsk, 6);
});

test('Suche: nur die jüngste Anfrage setzt Zustand (Request-Token)', async () => {
  const pending = {};
  const api = {
    search: (query, source) => {
      pending[`${query}:${source}`] = deferred();
      return pending[`${query}:${source}`].promise;
    },
  };
  const store = m.createSearchStore({ api });
  const old = store.search('alt', ['ard']);
  const fresh = store.search('neu', ['ard']);
  pending['neu:ard'].resolve({ ok: true, series: [series('neu')], entries: [], page: 0, hasMore: false });
  await fresh;
  pending['alt:ard'].resolve({ ok: true, series: [series('alt')], entries: [], page: 0, hasMore: false });
  await old;
  const state = store.snapshot();
  assert.equal(state.query, 'neu');
  assert.deepEqual(state.series.map(s => s.id), ['neu']);
  assert.equal(state.loading, false);
});

test('Suche: leerer Begriff räumt auf und verwirft laufende Antworten', async () => {
  const wait = deferred();
  const store = m.createSearchStore({ api: { search: () => wait.promise } });
  const running = store.search('x', ['ard']);
  await store.search('   ', ['ard']);
  wait.resolve({ ok: true, series: [series('s')], entries: [], page: 0, hasMore: true });
  await running;
  assert.equal(store.snapshot().query, '');
  assert.deepEqual(store.snapshot().series, []);
  assert.equal(store.snapshot().loading, false);
  assert.equal(store.isEmpty('all'), false, 'ohne Suchbegriff gibt es keinen Leerzustand');
});

test('Suche: Paging je Quelle, Zähler, Filter, Dubletten, Teilfehler', async () => {
  const calls = [];
  const api = {
    search: async (query, source, page) => {
      calls.push([source, page]);
      if (source === 'arte') return { ok: false, error: 'arte offline' };
      if (source === 'zdf') return { ok: true, series: [], entries: [entry('z1', 'zdf')], page: 0, hasMore: false };
      return page === 0
        ? { ok: true, series: [series('s1')], entries: [entry('e1'), entry('e2')], page: 0, hasMore: true }
        : { ok: true, series: [], entries: [entry('e2'), entry('e3')], page: 1, hasMore: false };
    },
  };
  const store = m.createSearchStore({ api });
  await store.search('institut', ['ard', 'zdf', 'arte']);
  assert.equal(store.snapshot().error, null, 'ein Teilfehler ist kein Gesamtfehler');
  assert.deepEqual(store.counts(), { all: 4, ard: 3, zdf: 1, arte: 0 });
  assert.equal(store.hasMore('all'), true);
  assert.equal(store.hasMore('zdf'), false);
  await store.loadMore('zdf'); // keine weiteren Seiten bei zdf
  assert.equal(calls.filter(call => call[1] === 1).length, 0);
  await store.loadMore('all');
  assert.deepEqual(calls.filter(call => call[1] === 1), [['ard', 1]]);
  assert.deepEqual(store.results('ard').entries.map(e => e.id), ['e1', 'e2', 'e3'], 'Dublette e2 wird nicht doppelt gezeigt');
  assert.equal(store.results('zdf').entries.length, 1);
  assert.equal(store.hasMore('all'), false);
});

test('Suche: Fehler aller Quellen, Leerzustand und Fehler beim Nachladen', async () => {
  const failing = m.createSearchStore({ api: { search: async () => ({ ok: false, error: 'kein Netz' }) } });
  await failing.search('x', ['ard', 'zdf']);
  assert.equal(failing.snapshot().error, 'kein Netz');
  assert.equal(failing.isEmpty('all'), false, 'bei Fehler zeigt die Ansicht den Fehler, nicht „keine Treffer“');

  const empty = m.createSearchStore({ api: { search: async () => ({ ok: true, series: [], entries: [], page: 0, hasMore: false }) } });
  await empty.search('nichts', ['ard']);
  assert.equal(empty.isEmpty('all'), true);

  let second = false;
  const paged = m.createSearchStore({
    api: { search: async (q, s, page) => (page === 0 ? { ok: true, series: [], entries: [entry('1')], page: 0, hasMore: true } : ((second = true), { ok: false, error: 'x' })) },
  });
  await paged.search('a', ['ard']);
  await paged.loadMore('all');
  assert.equal(second, true);
  assert.equal(paged.snapshot().moreFailed, true);
  assert.equal(paged.snapshot().loadingMore, false);
  assert.equal(paged.hasMore('all'), true, 'nach einem Fehler bleibt Wiederholen möglich');
});

test('Suche: veraltetes Nachladen wird verworfen, wenn inzwischen neu gesucht wurde', async () => {
  const more = deferred();
  const api = {
    search: async (query, source, page) => {
      if (page === 1) return more.promise;
      return { ok: true, series: [], entries: [entry(`${query}1`)], page: 0, hasMore: query === 'alt' };
    },
  };
  const store = m.createSearchStore({ api });
  await store.search('alt', ['ard']);
  const loading = store.loadMore('all');
  await store.search('neu', ['ard']);
  more.resolve({ ok: true, series: [], entries: [entry('spät')], page: 1, hasMore: false });
  await loading;
  assert.deepEqual(store.snapshot().entries.map(e => e.id), ['neu1']);
});

test('safeCall fängt Ausnahmen und ungültige Antworten', async () => {
  assert.deepEqual(await m.safeCall(async () => { throw new Error('IPC kaputt'); }), { ok: false, error: 'IPC kaputt', code: 'error' });
  assert.equal((await m.safeCall(async () => undefined)).ok, false);
  assert.equal((await m.safeCall(async () => ({ ok: true }))).ok, true);
});

test('Folge für IPC: nur erlaubte Felder, streamUrl entfällt', () => {
  const { entryForIpc } = m;
  const cleaned = entryForIpc({ id: 'a', title: 'T', sourceId: 'ard', streamUrl: null, season: 2, evil: 1, subtitle: undefined });
  assert.deepEqual(cleaned, { id: 'a', title: 'T', sourceId: 'ard', season: 2 });
  const { validateEntry } = require('../lib/mediathek/validation.js');
  assert.doesNotThrow(() => validateEntry(entryForIpc({ ...validateEntry({ id: 'a', title: 'T', sourceId: 'ard' }) })));
});

test('Weitere Mediatheken: Chip nur bei eigenen Weblink-Diensten, Standard-ARD/ZDF/arte zählen nicht', () => {
  const defaults = [{ id: 'ard', group: 'mediathek', url: 'https://www.ardmediathek.de/' }, { id: 'zdf', group: 'mediathek', url: 'https://www.zdf.de/' }, { id: 'arte', group: 'mediathek', url: 'https://www.arte.tv/de/' }, { id: 'netflix', group: 'streaming' }];
  assert.deepEqual(m.otherMediathekServices(defaults), []);
  const withCustom = [...defaults, { id: '3sat-1700000000000', group: 'mediathek' }];
  assert.deepEqual(m.otherMediathekServices(withCustom).map(svc => svc.id), ['3sat-1700000000000']);
  assert.deepEqual(m.otherMediathekServices(null), []);
  // Randfall: Standardeintrag gelöscht, eigener Dienst „ARD“ (id 'ard') mit anderer URL bleibt sichtbar
  const ownArd = [{ id: 'ard', group: 'mediathek', url: 'https://example.org/ard' }, { id: 'zdf', group: 'mediathek', url: 'https://www.zdf.de/' }];
  assert.deepEqual(m.otherMediathekServices(ownArd).map(svc => svc.url), ['https://example.org/ard']);
  const ids = hasOthers => m.filterItems({ enabledSources: ['ard'], hasOthers }).map(item => item.id);
  assert.ok(!ids(m.otherMediathekServices(defaults).length > 0).includes('others'));
  assert.ok(ids(m.otherMediathekServices(withCustom).length > 0).includes('others'));
});
