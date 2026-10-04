'use strict';

// Tests: EpgStore Cache-Format v2 (Etappe 3.2; EPG-Konzept B2, AUF-Plan T3/P18):
// Roundtrip inkl. Bild-URL-Stringtabelle, v1 weiterlesen (nichts geht verloren), defekte Dateien,
// volle Projektion in range/find/search, schlanke Projektion bleibt schlank.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEpgStore, CACHE_FILE, CACHE_VERSION } = require('../lib/epg/EpgStore.js');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'epg-v2-'));
}

const URL_A = 'https://epg.example/a.xml';
const ICON_1 = 'https://img.example.org/1.jpg';
const ICON_2 = 'https://img.example.org/2.jpg?w=300&h=200';

const FULL = {
  start: NOW,
  stop: NOW + HOUR,
  title: 'Tatort',
  desc: 'Beschreibung',
  subtitle: 'Untertitel',
  categories: ['Krimi', 'Drama'],
  icon: ICON_1,
  year: 2019,
  episode: 'S2 E3',
  credits: { director: ['Regie'], actor: ['A', 'B'], presenter: ['Mod'] },
  rating: 'FSK 12',
};
const SECOND = { ...FULL, start: NOW + HOUR, stop: NOW + 2 * HOUR, title: 'Zweiter', icon: ICON_1, credits: { director: [], actor: ['C'], presenter: [] } };
const THIRD = { ...FULL, start: NOW + 2 * HOUR, stop: NOW + 3 * HOUR, title: 'Dritter', icon: ICON_2, categories: [], episode: '', rating: '' };
const PLAIN = { start: NOW + 3 * HOUR, stop: NOW + 4 * HOUR, title: 'Schlicht', desc: '' };

function fillStore(store, url = URL_A) {
  store.setSource(url, {
    fetchedAt: NOW,
    sourceIds: ['q1'],
    channelSlots: new Map([
      ['ZDF.de', [THIRD, FULL, SECOND, PLAIN]],
      ['ARD.de', [{ ...FULL, title: 'Anderer Kanal' }]],
    ]),
  });
}

const EMPTY_EXTRAS = {
  subtitle: '',
  categories: [],
  icon: '',
  year: 0,
  episode: '',
  credits: { director: [], actor: [], presenter: [] },
  rating: '',
};

test('Zusatzfelder: setSource ergänzt fehlende Felder mit Leerwerten, range liefert die volle Projektion', () => {
  const store = createEpgStore({ dir: makeDir() });
  fillStore(store);
  const slots = store.range('ZDF.de', NOW, NOW + 5 * HOUR);
  assert.deepEqual(slots.map(s => s.title), ['Tatort', 'Zweiter', 'Dritter', 'Schlicht']);
  assert.deepEqual(slots[0], { ...FULL });
  assert.deepEqual(slots[3], { ...PLAIN, ...EMPTY_EXTRAS });
  assert.deepEqual(Object.keys(slots[0]).sort(), [
    'categories', 'credits', 'desc', 'episode', 'icon', 'rating', 'start', 'stop', 'subtitle', 'title', 'year',
  ]);
});

test('find liefert die laufende Sendung mit allen Feldern', () => {
  const store = createEpgStore({ dir: makeDir() });
  fillStore(store);
  assert.deepEqual(store.find('ZDF.de', NOW + 30 * 60 * 1000), { ...FULL });
  assert.equal(store.find('ZDF.de', NOW + 10 * HOUR), null);
});

test('Antworten sind Kopien: Verändern verändert den Cache nicht', () => {
  const store = createEpgStore({ dir: makeDir() });
  fillStore(store);
  const first = store.find('ZDF.de', NOW + 1);
  first.categories.push('Manipuliert');
  first.credits.actor.push('Manipuliert');
  first.title = 'Manipuliert';
  const again = store.find('ZDF.de', NOW + 1);
  assert.deepEqual(again.categories, ['Krimi', 'Drama']);
  assert.deepEqual(again.credits.actor, ['A', 'B']);
  assert.equal(again.title, 'Tatort');
  const empty = store.range('ZDF.de', NOW + 3 * HOUR, NOW + 4 * HOUR)[0];
  empty.categories.push('X');
  assert.deepEqual(store.range('ZDF.de', NOW + 3 * HOUR, NOW + 4 * HOUR)[0].categories, [], 'geteilte Leerwerte bleiben leer');
});

test('Roundtrip v2: gespeichert → neu geladen identisch; Bild-URLs über Stringtabelle (Index statt URL)', async () => {
  const dir = makeDir();
  const store = createEpgStore({ dir });
  fillStore(store);
  const before = {
    zdf: store.range('ZDF.de', 0, Infinity),
    ard: store.range('ARD.de', 0, Infinity),
    desc: store.describe(),
  };
  await store.save();

  const raw = fs.readFileSync(path.join(dir, CACHE_FILE), 'utf-8');
  const file = JSON.parse(raw);
  assert.equal(file.version, 2);
  assert.equal(CACHE_VERSION, 2);
  const src = file.sources[URL_A];
  assert.deepEqual([...src.icons].sort(), [ICON_1, ICON_2].sort(), 'jede URL genau einmal in der Tabelle');
  assert.equal(raw.split(ICON_1).length - 1, 1, 'URL steht nur einmal in der Datei');
  const rows = src.channels['zdf.de'];
  assert.equal(rows.length, 4);
  assert.equal(rows[0][5], src.icons.indexOf(ICON_1), 'Index statt URL');
  assert.equal(rows[1][5], rows[0][5], 'gleiche URL → gleicher Index');
  assert.equal(rows[2][5], src.icons.indexOf(ICON_2));
  assert.equal(rows[0].length, 11, 'volle Zeile: [start, stop, title, desc, cats, iconIdx, year, episode, credits, subtitle, rating]');
  assert.deepEqual(rows[0][8], [['Regie'], ['A', 'B'], ['Mod']]);
  assert.equal(rows[3].length, 4, 'leere Felder am Zeilenende werden nicht geschrieben');

  const loaded = createEpgStore({ dir });
  assert.equal(await loaded.load(), 1);
  assert.deepEqual(loaded.range('ZDF.de', 0, Infinity), before.zdf);
  assert.deepEqual(loaded.range('ARD.de', 0, Infinity), before.ard);
  assert.deepEqual(loaded.describe(), before.desc);
  assert.equal(loaded.isLegacy(URL_A), false);

  // zweiter Roundtrip (geladen → gespeichert) ist byte-identisch
  await loaded.save();
  assert.equal(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf-8'), raw);
});

test('Stringtabelle: 1000 Slots mit derselben Bild-URL speichern die URL einmal', async () => {
  const dir = makeDir();
  const store = createEpgStore({ dir });
  const slots = Array.from({ length: 1000 }, (_, i) => ({ start: NOW + i * HOUR, stop: NOW + (i + 1) * HOUR, title: `T${i}`, desc: '', icon: ICON_1 }));
  store.setSource(URL_A, { fetchedAt: NOW, channelSlots: new Map([['A.de', slots]]) });
  await store.save();
  const raw = fs.readFileSync(path.join(dir, CACHE_FILE), 'utf-8');
  assert.equal(raw.split(ICON_1).length - 1, 1);
  const loaded = createEpgStore({ dir });
  await loaded.load();
  assert.ok(loaded.range('A.de', 0, Infinity).every(s => s.icon === ICON_1));
});

function writeV1(dir, { fetchedAt = NOW } = {}) {
  const payload = {
    version: 1,
    sources: {
      [URL_A]: {
        fetchedAt,
        sourceIds: ['q1'],
        channels: {
          'zdf.de': [
            [NOW, NOW + HOUR, 'Heute-Journal', 'Beschreibung'],
            [NOW + HOUR, NOW + 2 * HOUR, 'Zweiter', ''],
          ],
          'ard.de': [[NOW, NOW + 2 * HOUR, 'Tagesschau', 'Nachrichten']],
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(payload));
  return payload;
}

test('v1 wird weitergelesen: nichts geht verloren, neue Felder leer, Quelle als Legacy markiert', async () => {
  const dir = makeDir();
  writeV1(dir);
  const store = createEpgStore({ dir });
  assert.equal(await store.load(), 1);
  assert.equal(store.isLegacy(URL_A), true);
  assert.equal(store.hasSource(URL_A), true);
  assert.deepEqual(store.describe().map(d => [d.channelCount, d.slotCount, d.fetchedAt, d.sourceIds]), [[2, 3, NOW, ['q1']]]);
  assert.deepEqual(store.range('ZDF.de', 0, Infinity), [
    { start: NOW, stop: NOW + HOUR, title: 'Heute-Journal', desc: 'Beschreibung', ...EMPTY_EXTRAS },
    { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: 'Zweiter', desc: '', ...EMPTY_EXTRAS },
  ]);
  assert.equal(store.find('ARD.de', NOW + 1).title, 'Tagesschau');
  assert.equal(store.isLegacy('https://anderer.example/x.xml'), false);
});

test('v1: nach neuem setSource ist die Quelle nicht mehr Legacy; save schreibt v2 (kein Verwerfen davor)', async () => {
  const dir = makeDir();
  writeV1(dir);
  const store = createEpgStore({ dir });
  await store.load();
  // Solange kein Refresh lief, bleibt die Datei v1 und der Speicher nutzbar
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf-8')).version, 1);
  fillStore(store);
  assert.equal(store.isLegacy(URL_A), false);
  await store.save();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf-8')).version, 2);
});

test('v1 mit mehreren Quellen: nur die neu geladene Quelle verliert den Legacy-Status; retainOnly räumt auf', async () => {
  const dir = makeDir();
  const payload = writeV1(dir);
  payload.sources['https://epg.example/b.xml'] = payload.sources[URL_A];
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(payload));
  const store = createEpgStore({ dir });
  assert.equal(await store.load(), 2);
  fillStore(store, URL_A);
  assert.equal(store.isLegacy(URL_A), false);
  assert.equal(store.isLegacy('https://epg.example/b.xml'), true);
  store.retainOnly([URL_A]);
  assert.equal(store.isLegacy('https://epg.example/b.xml'), false);
});

test('Defekte Dateien → leerer Cache ohne Wurf (Syntaxfehler, falsche Version, falsche Struktur)', async () => {
  for (const content of [
    '{kaputt',
    '',
    'null',
    '[]',
    JSON.stringify({ version: 3, sources: {} }),
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 2, sources: 'x' }),
    JSON.stringify({ version: 2, sources: { [URL_A]: null } }),
    JSON.stringify({ version: 2, sources: { [URL_A]: { channels: 'x' } } }),
  ]) {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, CACHE_FILE), content);
    const store = createEpgStore({ dir });
    assert.equal(await store.load(), 0, JSON.stringify(content));
    assert.deepEqual(store.describe(), []);
    assert.deepEqual(store.range('ZDF.de', 0, Infinity), []);
  }
  const missing = createEpgStore({ dir: makeDir() });
  assert.equal(await missing.load(), 0);
});

test('Defekte Zeilen/Felder in v2: ungültige Zeilen entfallen, falsche Typen werden zu Leerwerten, Index außerhalb der Tabelle → kein Bild', async () => {
  const dir = makeDir();
  const rows = [
    [NOW, NOW + HOUR, 'Gut', 'D', ['Krimi', 5, '', null], 0, 2020, 'S1 E1', [['R'], ['A', 7], 'x'], 'Sub', 'FSK 0'],
    [NOW + HOUR, NOW + 2 * HOUR, 'Index weg', 'D', 'keine Liste', 99, 'x', 5, 'x', 5, null],
    [NOW + 2 * HOUR, NOW + 3 * HOUR, 'Negativ', 'D', [], -5],
    ['x', NOW, 'Kaputter Start', ''],
    [NOW, NOW + HOUR],
    'Müll',
    null,
  ];
  fs.writeFileSync(
    path.join(dir, CACHE_FILE),
    JSON.stringify({ version: 2, sources: { [URL_A]: { fetchedAt: 'x', sourceIds: [1, 'q'], icons: [ICON_1, 5, null], channels: { 'a.de': rows, 'b.de': 'x', 'c.de': [] } } } }),
  );
  const store = createEpgStore({ dir });
  assert.equal(await store.load(), 1);
  const slots = store.range('A.de', 0, Infinity);
  assert.deepEqual(slots.map(s => s.title), ['Gut', 'Index weg', 'Negativ']);
  assert.deepEqual(slots[0], {
    start: NOW, stop: NOW + HOUR, title: 'Gut', desc: 'D', subtitle: 'Sub', categories: ['Krimi'], icon: ICON_1, year: 2020,
    episode: 'S1 E1', credits: { director: ['R'], actor: ['A'], presenter: [] }, rating: 'FSK 0',
  });
  assert.deepEqual({ ...slots[1], start: 0, stop: 0 }, { start: 0, stop: 0, title: 'Index weg', desc: 'D', ...EMPTY_EXTRAS });
  assert.equal(slots[2].icon, '');
  assert.deepEqual(store.describe()[0].sourceIds, ['q']);
  assert.equal(store.describe()[0].fetchedAt, 0);
});

test('search: Standard bleibt schlank, options.full liefert die volle Projektion; rangeMany bleibt schlank', async () => {
  const store = createEpgStore({ dir: makeDir() });
  fillStore(store);
  const slim = await store.search(['ZDF.de'], 'tatort', 0, Infinity);
  assert.deepEqual(Object.keys(slim.results[0]).sort(), ['channelKey', 'start', 'stop', 'title']);
  const full = await store.search(['ZDF.de'], 'tatort', 0, Infinity, { full: true });
  assert.deepEqual(full.results, [{ channelKey: 'ZDF.de', ...FULL }]);
  full.results[0].categories.push('X');
  assert.deepEqual((await store.search(['ZDF.de'], 'tatort', 0, Infinity, { full: true })).results[0].categories, ['Krimi', 'Drama']);
  const many = store.rangeMany(['ZDF.de'], NOW, NOW + HOUR);
  assert.deepEqual(Object.keys(many[0].slots[0]).sort(), ['start', 'stop', 'title']);
});

test('Mehrere Quellen: Duplikate werden vereinigt, die volle Projektion bleibt erhalten', () => {
  const store = createEpgStore({ dir: makeDir() });
  fillStore(store, URL_A);
  fillStore(store, 'https://epg.example/b.xml');
  const slots = store.range('ZDF.de', NOW, NOW + HOUR);
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0], { ...FULL });
});

test('Parser-Slots (mit Zusatzfeldern) gehen unverändert durch setSource → save → load', async () => {
  const { XmltvStreamParser } = require('../lib/epg/xmltv-stream-parser.js');
  const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'epg-b-fields.xml'), 'utf-8');
  const channelSlots = new Map();
  const parser = new XmltvStreamParser({
    onProgramme: ({ channel, ...slot }) => {
      if (!channelSlots.has(channel)) channelSlots.set(channel, []);
      channelSlots.get(channel).push(slot);
    },
  });
  parser.write(xml);
  parser.end();
  const dir = makeDir();
  const store = createEpgStore({ dir });
  store.setSource(URL_A, { fetchedAt: NOW, channelSlots });
  const before = store.range('b1.de', 0, Infinity);
  assert.ok(before.length >= 15);
  assert.ok(before.some(s => s.icon && s.categories.length && s.credits.actor.length));
  await store.save();
  const loaded = createEpgStore({ dir });
  await loaded.load();
  assert.deepEqual(loaded.range('b1.de', 0, Infinity), before);
});
