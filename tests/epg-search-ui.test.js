'use strict';

// Tests: Suche des Programmführers (Etappe 3.5, M8/P11) — Eingabe (2–80 Zeichen), Abfrageplan,
// Zusammenführung, Veraltungsschutz, Zustände, Beschreibungsschalter; Faltung/Umlaute über die
// vorhandene API (EpgStore.search + validateEpgSearch); Verdrahtung der Suche im Overlay.
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const search = require('../epg-search-model.js');
const { createEpgStore } = require('../lib/epg/EpgStore.js');
const { validateEpgSearch, EPG_SEARCH_MIN_QUERY, EPG_SEARCH_MAX_QUERY, EPG_SEARCH_MAX_CHANNELS } = require('../lib/ipc-validation.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const NOW = local(2026, 10, 5, 20, 32); // Mo 05.10.2026

test('Konstanten stimmen mit der Main-Validierung überein (2–80 Zeichen, 600 Kanäle je Aufruf)', () => {
  assert.equal(search.MIN_QUERY, EPG_SEARCH_MIN_QUERY);
  assert.equal(search.MAX_QUERY, EPG_SEARCH_MAX_QUERY);
  assert.equal(search.MAX_KEYS_PER_CALL, EPG_SEARCH_MAX_CHANNELS);
  assert.ok(search.RESULT_LIMIT <= 200);
});

test('Eingabe: leer, 1 Zeichen (zu kurz), 2–80 Zeichen; getrimmt, Steuerzeichen entfernt, auf 80 gekürzt', () => {
  assert.deepEqual(search.normalizeQuery(''), { text: '', state: 'idle' });
  assert.deepEqual(search.normalizeQuery('   '), { text: '', state: 'idle' });
  assert.deepEqual(search.normalizeQuery(undefined), { text: '', state: 'idle' });
  assert.deepEqual(search.normalizeQuery(null), { text: '', state: 'idle' });
  assert.deepEqual(search.normalizeQuery(' a '), { text: 'a', state: 'short' });
  assert.deepEqual(search.normalizeQuery('ab'), { text: 'ab', state: 'ready' });
  assert.deepEqual(search.normalizeQuery('  Tatort  '), { text: 'Tatort', state: 'ready' });
  assert.equal(search.normalizeQuery('x'.repeat(80)).state, 'ready');
  assert.equal(search.normalizeQuery('x'.repeat(80)).text.length, 80);
  assert.equal(search.normalizeQuery('x'.repeat(200)).text.length, 80, 'Eingabe wird gekürzt, nie zu lang an den Main gereicht');
  assert.equal(search.normalizeQuery('a\u0000\n').text, 'a');
  assert.equal(search.normalizeQuery('a\tb').text, 'a b');
  assert.equal(search.normalizeQuery(42).state, 'idle');
  // jede „ready“-Eingabe besteht die Validierung im Main
  for (const raw of ['ab', 'Käse', 'x'.repeat(80), ' Tatort ', 'a\tb']) {
    const q = search.normalizeQuery(raw);
    assert.equal(q.state, 'ready');
    assert.doesNotThrow(() => validateEpgSearch(['ZDF.de'], q.text, NOW, NOW + HOUR, search.RESULT_LIMIT, { includeDesc: false }), raw);
  }
});

test('Abfrageplan: Zeitraum vom ersten Tag bis Cache-Ende (max. 14 Tage), Blöcke zu 600 Kanälen, ohne Daten kein Plan', () => {
  const days = [{ startMs: local(2026, 10, 4, 5) }, { startMs: local(2026, 10, 5, 5) }];
  const keys = Array.from({ length: 1201 }, (_, i) => `k${i}`);
  const plan = search.searchPlan({ keys, days, coverageToMs: days[0].startMs + 10 * 24 * HOUR });
  assert.equal(plan.fromMs, days[0].startMs);
  assert.equal(plan.toMs, days[0].startMs + 10 * 24 * HOUR);
  assert.deepEqual(plan.chunks.map(c => c.length), [600, 600, 1]);
  assert.equal(search.searchPlan({ keys, days, coverageToMs: days[0].startMs + 30 * 24 * HOUR }).toMs, days[0].startMs + 14 * 24 * HOUR);
  assert.equal(search.searchPlan({ keys: [], days, coverageToMs: NOW }), null);
  assert.equal(search.searchPlan({ keys, days: [], coverageToMs: NOW }), null);
  assert.equal(search.searchPlan({ keys, days, coverageToMs: null }), null);
  assert.equal(search.searchPlan({ keys, days, coverageToMs: days[0].startMs }), null);
  // jeder Block besteht die Validierung
  for (const chunk of plan.chunks) assert.doesNotThrow(() => validateEpgSearch(chunk, 'ab', plan.fromMs, plan.toMs, 100, {}));
});

test('Zusammenführen: nach Start sortiert, auf das Limit begrenzt, truncated bei Überlauf oder Teilantwort', () => {
  const hit = (key, start) => ({ channelKey: key, start, stop: start + HOUR, title: 't' });
  const merged = search.mergeResults([
    { results: [hit('a', 30), hit('a', 10)], truncated: false },
    { results: [hit('b', 20)], truncated: false },
    null,
    { results: 'kaputt' },
    { results: [{ channelKey: 'x', start: 'jetzt' }] },
  ]);
  assert.deepEqual(merged.results.map(r => r.start), [10, 20, 30]);
  assert.equal(merged.truncated, false);
  const many = search.mergeResults([{ results: Array.from({ length: 150 }, (_, i) => hit('a', i)), truncated: false }], 100);
  assert.equal(many.results.length, 100);
  assert.equal(many.truncated, true);
  assert.equal(search.mergeResults([{ results: [], truncated: true }]).truncated, true);
  assert.deepEqual(search.mergeResults(undefined), { results: [], truncated: false });
});

test('Treffer → Zeilen: Sender aus der Auswahl, bekannte Zeilen (mit Genre) bevorzugt, unbekannte Sender entfallen', () => {
  const zdf = { id: 'zdf', name: 'ZDF', tvgId: 'ZDF.de' };
  const byKey = new Map([['ZDF.de', zdf]]);
  const known = new Map([['ZDF.de|1000', { id: 'ZDF.de|1000', genre: 'film', title: 'Bekannt' }]]);
  const rows = search.hitsToRows(
    [
      { channelKey: 'ZDF.de', start: 1000, stop: 2000, title: 'Egal' },
      { channelKey: 'ZDF.de', start: local(2026, 10, 6, 1), stop: local(2026, 10, 6, 2), title: 'Nachtkrimi' },
      { channelKey: 'ARD.de', start: 1, stop: 2, title: 'Fremd' },
    ],
    byKey,
    known,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Bekannt');
  assert.equal(rows[0].genre, 'film');
  assert.equal(rows[1].id, `ZDF.de|${local(2026, 10, 6, 1)}`);
  assert.equal(rows[1].channel, zdf);
  assert.equal(rows[1].night, true);
  assert.equal(rows[1].dayKey, '2026-10-05', 'Nachtsendung gehört zum Vorabend-TV-Tag');
  assert.deepEqual(search.hitsToRows(undefined, byKey), []);
});

test('Trefferzeile: Titel · Sender · Wochentag Uhrzeit (mit Datum bei weit entfernten Terminen)', () => {
  const row = { title: 'Tatort', channel: { name: 'Das Erste' }, channelKey: 'ARD.de', start: local(2026, 10, 6, 20, 15) };
  assert.deepEqual(search.hitParts(row, NOW), { title: 'Tatort', channel: 'Das Erste', when: 'Di 20:15' });
  assert.equal(search.hitWhen(local(2026, 10, 13, 20, 15), NOW), 'Di 13.10. 20:15');
  assert.equal(search.hitWhen(local(2026, 10, 5, 22, 0), NOW), 'Mo 22:00');
  assert.deepEqual(search.hitParts({ title: '', channel: {}, channelKey: 'X.de', start: NOW }, NOW).title, '(ohne Titel)');
  assert.equal(search.hitParts({ title: 't', channel: {}, channelKey: 'X.de', start: NOW }, NOW).channel, 'X.de');
});

test('Zustände: leer, zu kurz, keine Sender, ohne Cache, lädt, Fehler, keine Treffer (Titel / inkl. Beschreibung), Treffer', () => {
  const base = { queryState: 'ready', keyCount: 5, hasPlan: true, loading: false, error: '', total: 0, truncated: false, includeDesc: false };
  assert.equal(search.deriveSearchState({ ...base, queryState: 'idle' }).kind, 'idle');
  assert.match(search.deriveSearchState({ ...base, queryState: 'short' }).text, /mindestens 2 Zeichen/);
  assert.equal(search.deriveSearchState({ ...base, keyCount: 0 }).kind, 'no-channels');
  assert.equal(search.deriveSearchState({ ...base, hasPlan: false }).kind, 'empty');
  assert.equal(search.deriveSearchState({ ...base, loading: true }).kind, 'loading');
  assert.equal(search.deriveSearchState({ ...base, error: 'Main antwortet nicht' }).kind, 'error');
  assert.match(search.deriveSearchState({ ...base, error: 'Main antwortet nicht' }).text, /Main antwortet nicht/);
  const none = search.deriveSearchState(base);
  assert.equal(none.kind, 'empty');
  assert.match(none.text, /Keine Treffer in den Titeln/);
  assert.match(none.text, /Mehr/, 'Hinweis auf den Beschreibungsschalter');
  assert.match(search.deriveSearchState({ ...base, includeDesc: true }).text, /Titeln und Beschreibungen/);
  assert.deepEqual(search.deriveSearchState({ ...base, total: 3 }), { kind: 'results', text: '' });
  assert.match(search.deriveSearchState({ ...base, total: 100, truncated: true }).text, /Mehr als 100 Treffer/);
});

test('Veraltungsschutz: nur die jüngste Anfrage zählt, Schließen verwirft alle laufenden', () => {
  const counter = search.createRequestCounter();
  const first = counter.next();
  const second = counter.next();
  assert.equal(counter.isCurrent(first), false);
  assert.equal(counter.isCurrent(second), true);
  counter.cancel();
  assert.equal(counter.isCurrent(second), false, 'nach Schließen/zu kurzer Eingabe wird auch die laufende verworfen');
  assert.equal(counter.isCurrent(counter.next()), true);
});

async function makeStore() {
  const slot = (i, title, desc = '') => ({ start: NOW + i * HOUR, stop: NOW + (i + 1) * HOUR, title, desc });
  const store = createEpgStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'epg-search-ui-')) });
  store.setSource('https://a', {
    fetchedAt: NOW,
    channelSlots: new Map([
      ['ARD.de', [slot(0, 'Tagesschau', 'Nachrichten'), slot(1, 'Käse und Wein', 'Alles über Brot'), slot(2, 'Straße der Lieder')]],
      ['ZDF.de', [slot(0, 'heute', 'Hafen-Reportage'), slot(1, 'Kaese-Kochshow')]],
    ]),
  });
  return store;
}

test('Faltung über die vorhandene API: Umlaute, ß und Groß-/Kleinschreibung finden dieselben Treffer', async () => {
  const store = await makeStore();
  const keys = ['ARD.de', 'ZDF.de'];
  for (const raw of ['KÄSE', 'kase', 'Kaese']) {
    const q = search.normalizeQuery(raw);
    const args = validateEpgSearch(keys, q.text, NOW, NOW + 24 * HOUR, search.RESULT_LIMIT, { includeDesc: false });
    const { results } = await store.search(args.channelKeys, args.query, args.fromMs, args.toMs, { limit: args.limit, includeDesc: args.includeDesc });
    assert.deepEqual(results.map(r => r.title).sort(), ['Kaese-Kochshow', 'Käse und Wein'], raw);
  }
  const strasse = await store.search(keys, 'STRASSE', NOW, NOW + 24 * HOUR);
  assert.deepEqual(strasse.results.map(r => r.title), ['Straße der Lieder']);
});

test('Beschreibungsschalter: standardmäßig nur Titel; mit includeDesc auch Beschreibungen (Auswirkung auf den Aufruf)', async () => {
  const store = await makeStore();
  const keys = ['ARD.de', 'ZDF.de'];
  assert.equal((await store.search(keys, 'hafen', NOW, NOW + 24 * HOUR, { includeDesc: false })).results.length, 0);
  assert.deepEqual((await store.search(keys, 'hafen', NOW, NOW + 24 * HOUR, { includeDesc: true })).results.map(r => r.title), ['heute']);
  // die View ruft epg:search mit includeDesc des Schalters (Standard aus) und nie ohne Optionsobjekt
  const view = read('epg-view.js');
  assert.match(view, /let searchDesc = false;/);
  assert.match(view, /api\.searchEpg\(chunk, query\.text, plan\.fromMs, plan\.toMs, fetchLimit, \{ includeDesc: searchDesc \}\)/);
  // Etappe 3.6: ohne Genre-Filter bleibt es bei RESULT_LIMIT, mit Filter werden mehr Treffer geholt und danach gefiltert
  assert.match(view, /const fetchLimit = genres\.length \? searchModel\.FILTERED_FETCH_LIMIT : searchModel\.RESULT_LIMIT;/);
  assert.match(view, /id: 'epgOptDesc'/);
  assert.match(view, /text: 'Beschreibung durchsuchen'/);
});

test('Verdrahtung: Entprellung, Anfragenzähler, Esc-Kette, Sprung mit Detail-Modal, nur Preload-API, keine HTML-Strings', () => {
  const view = read('epg-view.js');
  // entprellt, Zähler prüft nach jedem await, Schließen verwirft
  assert.match(view, /searchTimer = setTimeout\(runSearch, searchModel\.DEBOUNCE_MS\)/);
  assert.match(view, /if \(!searchRequests\.isCurrent\(id\) \|\| !isOpen\) return;/);
  assert.match(view, /function closeSearch\([^)]*\) \{[\s\S]*searchRequests\.cancel\(\);[\s\S]*searchInput\.value = '';/);
  // Esc im Eingabefeld läuft in dieselbe Kette (der globale Handler überspringt INPUT)
  assert.match(view, /event\.key === 'Escape' && event\.target && event\.target\.tagName === 'INPUT'[\s\S]*handleEscape\(\);/);
  const esc = view.slice(view.indexOf('function handleEscape()'), view.indexOf('return {', view.indexOf('function handleEscape()')));
  assert.ok(esc.indexOf('closeDetail()') < esc.indexOf('closeSearch('), 'Modal vor Suche');
  assert.ok(esc.indexOf('closeSearch(') < esc.indexOf('exitChannel()'), 'Suche vor Kanalansicht');
  assert.ok(esc.indexOf('exitChannel()') < esc.indexOf('close();'), 'Kanalansicht vor Overlay');
  // Klick: Suche schließt, Sprung im aktuellen Modus, danach das Detail-Modal
  assert.match(view, /async function pickSearchHit\(row\) \{\s*closeSearch\(\);[\s\S]*await jumpToRow\(row\);\s*if \(isOpen\) openDetail\(rowsById\.get\(row\.id\) \|\| row\);/);
  assert.match(view, /gridView\.scrollTime\(row\.start, 0\.1\)/);
  assert.match(view, /scroll\.scrollTop = Math\.max\(0, layout\.offsets\[idx\]/);
  // Suchfeld: 80 Zeichen, Platzhalter, Aufruf nur über die Preload-API
  assert.match(view, /maxlength: String\(searchModel\.MAX_QUERY\)/);
  assert.match(view, /placeholder: 'Titel suchen …'/);
  assert.ok(!/ipcRenderer|electronAPI\./.test(view), 'epg-view.js kennt nur die injizierte API');
  for (const file of ['epg-search-view.js', 'epg-search-model.js', 'epg-menu-view.js', 'epg-selection-model.js', 'epg-jng-view.js', 'epg-jng-model.js']) {
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(read(file)), `${file}: kein HTML-String`);
  }
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(view));
});
