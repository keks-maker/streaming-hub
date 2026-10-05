'use strict';

// Tests: Genre-Filter des Programmführers (Etappe 3.6) — Chips an/aus, Filterregeln (ohne Genre passt nie zu einem
// aktiven Filter), Zeilenfilter, Sitzungszustand, Genre-Nachschlagen für Suchtreffer; J&G-Zuordnung mit Filter;
// Suchzustand „kein Treffer im Genre“; Verdrahtung (kein innerHTML, Chips per Tastatur, Test-Glob).
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const f = require('../epg-genre-filter-model.js');
const { GENRES } = require('../epg-genres.js');
const jng = require('../epg-jng-model.js');
const searchModel = require('../epg-search-model.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Chip-Reihenfolge deckt genau die Genre-Gruppen der Tabelle ab (P13: Tabelle unverändert)', () => {
  assert.deepEqual([...f.ORDER].sort(), Object.keys(GENRES).sort());
  assert.deepEqual(f.ORDER, ['film', 'serie', 'news', 'sport', 'doku', 'kinder', 'show', 'musik', 'sonstiges']);
  const table = JSON.parse(read('lib/epg/genre-table.json'));
  assert.deepEqual([...table.priority].sort(), [...f.ORDER].sort());
});

test('normalizeGenres: nur bekannte Gruppen, eindeutig, in Chip-Reihenfolge', () => {
  assert.deepEqual(f.normalizeGenres(['sport', 'film', 'sport', 'quatsch', 42, null, '']), ['film', 'sport']);
  assert.deepEqual(f.normalizeGenres(new Set(['musik', 'news'])), ['news', 'musik']);
  assert.deepEqual(f.normalizeGenres('film'), []);
  assert.deepEqual(f.normalizeGenres(undefined), []);
});

test('toggleGenre: Gruppe an/aus, Original bleibt unverändert, Unbekanntes wird ignoriert', () => {
  const start = ['film'];
  assert.deepEqual(f.toggleGenre(start, 'sport'), ['film', 'sport']);
  assert.deepEqual(start, ['film']);
  assert.deepEqual(f.toggleGenre(['film', 'sport'], 'film'), ['sport']);
  assert.deepEqual(f.toggleGenre([], 'unbekannt'), []);
  assert.deepEqual(f.toggleGenre(['film'], '__proto__'), ['film']);
});

test('matchesGenre: ohne Filter passt alles; mit Filter nur die gewählten Gruppen, Sendungen ohne Genre nie', () => {
  assert.equal(f.matchesGenre([], 'film'), true);
  assert.equal(f.matchesGenre([], ''), true);
  assert.equal(f.matchesGenre(['film', 'sport'], 'sport'), true);
  assert.equal(f.matchesGenre(['film', 'sport'], 'news'), false);
  assert.equal(f.matchesGenre(['film'], ''), false);
  assert.equal(f.matchesGenre(['film'], undefined), false);
  assert.equal(f.matchesGenre(['film'], 'quatsch'), false);
  assert.equal(f.matchesGenre(['sonstiges'], 'sonstiges'), true);
});

test('filterRows: filtert Zeilen, ohne Filter dasselbe Array, Eingabe bleibt unverändert', () => {
  const rows = [{ id: 'a', genre: 'film' }, { id: 'b', genre: 'sport' }, { id: 'c', genre: '' }, null];
  assert.equal(f.filterRows(rows, []), rows);
  assert.deepEqual(f.filterRows(rows, ['film']).map(r => r.id), ['a']);
  assert.deepEqual(f.filterRows(rows, ['film', 'sport']).map(r => r.id), ['a', 'b']);
  assert.equal(rows.length, 4);
  assert.deepEqual(f.filterRows(null, ['film']), []);
});

test('chipStates/describe: Beschriftung als Text (Farbe nie alleiniger Träger)', () => {
  const states = f.chipStates(['serie']);
  assert.equal(states.length, 9);
  assert.deepEqual(states.find(s => s.genre === 'serie'), { genre: 'serie', label: 'Serie', pressed: true });
  assert.ok(states.filter(s => s.pressed).length === 1);
  assert.ok(states.every(s => s.label));
  assert.equal(f.describe(['sport', 'film']), 'Film, Sport');
  assert.equal(f.describe([]), '');
});

test('createGenreFilter: Sitzungszustand — toggle, set, clear, matches', () => {
  const filter = f.createGenreFilter();
  assert.equal(filter.isActive(), false);
  assert.equal(filter.matches('film'), true);
  assert.deepEqual(filter.toggle('sport'), ['sport']);
  assert.deepEqual(filter.toggle('film'), ['film', 'sport']);
  assert.equal(filter.isActive(), true);
  assert.equal(filter.matches('film'), true);
  assert.equal(filter.matches('news'), false);
  const copy = filter.list();
  copy.push('news');
  assert.deepEqual(filter.list(), ['film', 'sport'], 'list() liefert eine Kopie');
  assert.deepEqual(filter.set(['news', 'x']), ['news']);
  filter.clear();
  assert.equal(filter.isActive(), false);
});

test('Suche: Genre-Nachschlagen nur für Treffer außerhalb der geladenen Zeilen', () => {
  const rows = [
    { id: 'A|100', channelKey: 'A', start: 100, stop: 200, genre: '' },
    { id: 'A|300', channelKey: 'A', start: 300, stop: 400, genre: '' },
    { id: 'B|50', channelKey: 'B', start: 50, stop: 90, genre: 'film' },
  ];
  const lookups = f.planGenreLookups(rows, id => id === 'B|50');
  assert.deepEqual(lookups, [{ key: 'A', fromMs: 100, toMs: 400 }]);
  assert.deepEqual(f.planGenreLookups(rows, () => true), []);
  const merged = f.applyLookedUpGenres(rows, new Map([['A', [{ start: 100, stop: 200, genre: 'sport' }, { start: 300, stop: 400, genre: 'kinder' }]]]));
  assert.deepEqual(merged.map(r => r.genre), ['sport', 'kinder', 'film']);
  assert.equal(rows[0].genre, '', 'Eingabe bleibt unverändert');
  const unknown = f.applyLookedUpGenres(rows, new Map());
  assert.deepEqual(unknown.map(r => r.genre), ['', '', 'film']);
  assert.equal(f.filterRows(unknown, ['film']).length, 1, 'Treffer ohne nachgeschlagenes Genre passen zu keiner Gruppe');
});

// ── Jetzt & Gleich ──

const NOW = new Date(2026, 9, 5, 20, 32).getTime();
const MIN = 60 * 1000;
const row = (id, startMin, stopMin, genre) => ({ id, start: NOW + startMin * MIN, stop: NOW + stopMin * MIN, title: id, genre });

test('J&G mit Filter: Positionen bleiben, nicht passende Zellen entfallen; Sender ohne passende Zelle fallen weg', () => {
  const channel = { key: 'A', rows: [row('laufend', -10, 30, 'news'), row('danach', 30, 90, 'sport'), row('spaeter', 90, 150, 'film')] };
  const sport = jng.assign(channel, NOW, ['sport']);
  assert.equal(sport.current, null);
  assert.equal(sport.next.id, 'danach');
  assert.equal(sport.after, null);
  assert.equal(jng.hasMatch(sport), true);
  const none = jng.assign(channel, NOW, ['musik']);
  assert.equal(jng.hasMatch(none), false);
  const plain = jng.assign(channel, NOW);
  assert.equal(plain.current.id, 'laufend');
  assert.equal(plain.after.id, 'spaeter');
  assert.equal(jng.hasMatch(jng.assign(channel, NOW, [])), true);
  assert.notEqual(jng.assignmentSig(sport), jng.assignmentSig(plain));
});

test('Suchzustand: „kein Treffer im Genre“ nennt die Gruppen und den Weg zurück', () => {
  const base = { queryState: 'ready', keyCount: 3, hasPlan: true, loading: false, error: '', total: 0, truncated: false, includeDesc: false };
  const state = searchModel.deriveSearchState({ ...base, genreText: 'Film, Sport' });
  assert.equal(state.kind, 'empty');
  assert.match(state.text, /Film, Sport/);
  assert.match(state.text, /Alle/);
  assert.match(searchModel.deriveSearchState(base).text, /Keine Treffer in den Titeln/);
  assert.equal(searchModel.deriveSearchState({ ...base, total: 4, genreText: 'Film' }).kind, 'results');
  assert.ok(searchModel.FILTERED_FETCH_LIMIT >= searchModel.RESULT_LIMIT && searchModel.FILTERED_FETCH_LIMIT <= 200);
});

// ── Verdrahtung ──

test('Verdrahtung: Chips per Tastatur (Buttons mit aria-pressed), Fremdtexte nie über HTML-Strings', () => {
  const chips = read('epg-genre-chips-view.js');
  assert.match(chips, /'aria-pressed'/);
  assert.match(chips, /h\('button'/);
  for (const file of ['epg-genre-filter-model.js', 'epg-genre-chips-view.js', 'epg-detail-model.js', 'epg-detail-view.js', 'epg-row-dom.js', 'epg-jng-view.js', 'epg-view.js']) {
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|decodeEntities/.test(read(file)), `${file}: kein HTML-String`);
  }
});

test('Verdrahtung: Filter ist Sitzungszustand (kein Setting, kein IPC), wirkt in allen Modi', () => {
  const view = read('epg-view.js');
  assert.match(view, /const genreFilter = genreModel\.createGenreFilter\(\)/);
  assert.match(view, /isDimmed: row => genreFilter\.isActive\(\) && !genreFilter\.matches\(row\.genre\)/);
  assert.match(view, /jngView\.setGenres\(genreFilter\.list\(\)\)/);
  assert.match(view, /function loadedRun\(\) \{[\s\S]*genreModel\.filterRows/);
  assert.match(view, /lookUpGenres/);
  // Sitzungszustand: close() setzt den Filter nicht zurück
  const closeFn = view.slice(view.indexOf('  function close() {'), view.indexOf('  /** Hook für die App-Hülle'));
  assert.ok(!/genreFilter\.(clear|set)/.test(closeFn));
  // kein neuer IPC-Kanal, kein Setting für den Filter
  assert.ok(!/epg:genre|genreFilter.*Settings/i.test(read('preload.js') + read('lib/epg-view-settings.js')));
});

test('Test-Glob: die neuen Testdateien laufen in npm test (tests/*.test.js)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['test:suite'], /node --test "tests\/\*\.test\.js"/);
  for (const file of ['epg-genre-filter-model.test.js', 'epg-detail-model.test.js']) assert.ok(fs.existsSync(path.join(ROOT, 'tests', file)), file);
});

test('ESLint-Renderergruppe enthält die neuen Module', () => {
  const cfg = read('eslint.config.js');
  for (const file of ['epg-genre-filter-model.js', 'epg-genre-chips-view.js', 'epg-detail-model.js', 'epg-detail-view.js']) assert.ok(cfg.includes(`'${file}'`), file);
});
