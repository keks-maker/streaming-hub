'use strict';

// Tests: epg:search (Etappe 3.1, EPG-Konzept §4 A-1) — gefaltete Suche im Main:
// EpgStore.search (Faltung, Limit, Scheiben), IPC-Validierung, Großfixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate } = require('node:timers');
const { EpgService } = require('../lib/epg/EpgService.js');
const { createEpgStore } = require('../lib/epg/EpgStore.js');
const { registerEpgIpc } = require('../lib/epg/ipc.js');
const { generateChannelSlots, channelId, MIN, DAY } = require('./helpers/epg-large-fixture.js');

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function makeStore(channelSlots, urls = { 'https://a': channelSlots }) {
  const store = createEpgStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'epg-search-')) });
  for (const [url, slots] of Object.entries(urls)) store.setSource(url, { fetchedAt: NOW, channelSlots: slots });
  return store;
}

const slot = (i, title, desc = '') => ({ start: NOW + i * HOUR, stop: NOW + (i + 1) * HOUR, title, desc });

function fixtureStore() {
  return makeStore(
    new Map([
      ['DasErste.de@HD', [slot(0, 'tagesschau', 'Nachrichten des Tages'), slot(1, 'Käse und Wein'), slot(2, 'Straße der Lieder')]],
      ['ZDF.de', [slot(0, 'Tagesschau'), slot(1, 'Kaese-Kochshow', 'Alles über Käse'), slot(2, 'KRIMI: Der Fall Müller')]],
    ]),
  );
}

test('Suche: Groß-/Kleinschreibung wird ignoriert ("Tagesschau" findet "tagesschau")', async () => {
  const store = fixtureStore();
  const { results, truncated } = await store.search(['DasErste.de', 'ZDF.de'], 'Tagesschau', NOW, NOW + DAY);
  assert.equal(truncated, false);
  assert.deepEqual(results.map(r => [r.channelKey, r.title]), [['DasErste.de', 'tagesschau'], ['ZDF.de', 'Tagesschau']]);
  assert.deepEqual(Object.keys(results[0]).sort(), ['channelKey', 'start', 'stop', 'title']);
  const upper = await store.search(['ZDF.de'], 'KRIMI', NOW, NOW + DAY);
  assert.equal(upper.results.length, 1);
});

test('Suche: Faltungsregel — "Käse" findet "kase" und "Kaese" (und umgekehrt), ß = ss', async () => {
  const store = fixtureStore();
  const keys = ['DasErste.de', 'ZDF.de'];
  for (const q of ['Käse', 'kase', 'Kaese', 'KÄSE', 'KAESE']) {
    const { results } = await store.search(keys, q, NOW, NOW + DAY);
    assert.deepEqual(results.map(r => r.title).sort(), ['Käse und Wein', 'Kaese-Kochshow'].sort(), q);
  }
  assert.equal((await store.search(keys, 'strasse', NOW, NOW + DAY)).results[0].title, 'Straße der Lieder');
  assert.equal((await store.search(keys, 'Mueller', NOW, NOW + DAY)).results[0].title, 'KRIMI: Der Fall Müller');
  assert.equal((await store.search(keys, 'Müller', NOW, NOW + DAY)).results.length, 1);
  assert.deepEqual((await store.search(keys, 'unbekanntes zeug', NOW, NOW + DAY)).results, []);
});

test('Suche: Teilstring, Titel nur standardmäßig, Beschreibung nur mit includeDesc', async () => {
  const store = fixtureStore();
  const keys = ['DasErste.de', 'ZDF.de'];
  assert.equal((await store.search(keys, 'schau', NOW, NOW + DAY)).results.length, 2);
  assert.equal((await store.search(keys, 'Nachrichten', NOW, NOW + DAY)).results.length, 0);
  const withDesc = await store.search(keys, 'Nachrichten', NOW, NOW + DAY, { includeDesc: true });
  assert.deepEqual(withDesc.results.map(r => r.title), ['tagesschau']);
  assert.ok(!('desc' in withDesc.results[0]), 'Treffer bleiben schlank');
  // Beschreibung "über Käse" gefaltet
  assert.equal((await store.search(['ZDF.de'], 'ueber kaese', NOW, NOW + DAY, { includeDesc: true })).results.length, 1);
});

test('Suche: Zeitfenster (Überlappung), Kanalbegrenzung, Normalisierung, unbekannte Kanäle', async () => {
  const store = fixtureStore();
  const keys = ['DasErste.de@HD', 'ZDF.de', 'gibtsnicht.de'];
  const late = await store.search(keys, 'schau', NOW + 30 * MIN, NOW + 40 * MIN);
  assert.equal(late.results.length, 2, 'laufende Sendung überlappt das Fenster');
  assert.equal((await store.search(keys, 'schau', NOW + HOUR, NOW + 2 * HOUR)).results.length, 0, 'Grenze exklusiv');
  assert.equal((await store.search(['ZDF.de'], 'schau', NOW, NOW + DAY)).results.length, 1, 'nur angegebene Kanäle');
  // Rückgabe trägt den übergebenen Schlüssel
  assert.equal((await store.search(['DasErste.de@HD'], 'schau', NOW, NOW + DAY)).results[0].channelKey, 'DasErste.de@HD');
  // zwei Schreibweisen desselben Kanals → ein Treffer
  assert.equal((await store.search(['DasErste.de@HD', 'daserste.de'], 'schau', NOW, NOW + DAY)).results.length, 1);
});

test('Suche: Treffer nach Startzeit sortiert, Limit mit truncated-Flag', async () => {
  const slots = [];
  for (let i = 0; i < 300; i += 1) slots.push(slot(i, `Show ${i}`));
  const store = makeStore(new Map([['a.de', slots.slice(150)], ['b.de', slots.slice(0, 150)]]));
  const all = await store.search(['a.de', 'b.de'], 'show', NOW, NOW + 14 * DAY, { limit: 200 });
  assert.equal(all.results.length, 200);
  assert.equal(all.truncated, true);
  assert.deepEqual(all.results.slice(0, 3).map(r => r.title), ['Show 0', 'Show 1', 'Show 2']);
  for (let i = 1; i < all.results.length; i += 1) assert.ok(all.results[i].start >= all.results[i - 1].start);
  const some = await store.search(['a.de', 'b.de'], 'show 29', NOW, NOW + 14 * DAY, { limit: 5 });
  assert.equal(some.results.length, 5);
  assert.equal(some.truncated, true); // Show 29, Show 290..299 → 11 Treffer
  const few = await store.search(['a.de'], 'show 29', NOW, NOW + 14 * DAY, { limit: 50 });
  assert.equal(few.truncated, false);
});

test('Suche: mehrere Quellen liefern keine Doppeltreffer', async () => {
  const same = () => new Map([['ZDF.de', [slot(0, 'Heute Journal')]]]);
  const store = makeStore(null, { 'https://a': same(), 'https://b': same() });
  assert.equal((await store.search(['ZDF.de'], 'journal', NOW, NOW + DAY)).results.length, 1);
});

test('Suche gibt den Event-Loop frei (Scheiben mit setImmediate)', async () => {
  const store = makeStore(generateChannelSlots({ channels: 50, days: 4, startMs: NOW }));
  let immediates = 0;
  const pump = () => {
    immediates += 1;
    if (!done) setImmediate(pump);
  };
  let done = false;
  setImmediate(pump);
  const { results } = await store.search(
    Array.from({ length: 50 }, (_, i) => channelId(i)),
    'zzzz-nichts',
    NOW,
    NOW + 4 * DAY,
    { sliceSlots: 100 },
  );
  done = true;
  assert.deepEqual(results, []);
  assert.ok(immediates > 20, `Event-Loop lief mit (${immediates} Immediates)`);
});

async function makeIpc(channelSlots) {
  const store = makeStore(channelSlots);
  const epg = new EpgService({ store, getSources: () => [], now: () => NOW, timers: { setInterval: () => 0, clearInterval: () => {} } });
  const handlers = new Map();
  const mainSender = {};
  registerEpgIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    epg,
    requireMainRenderer: e => {
      if (e?.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
  });
  return { epg, call: (channel, ...args) => handlers.get(channel)({ sender: mainSender }, ...args), handlers };
}

test('IPC epg:search: Ergebnis, Defaults, Optionen, abgelehnte Grenzfälle', async () => {
  const { call, handlers } = await makeIpc(
    new Map([['ZDF.de', [slot(0, 'Käse Show', 'Wein'), slot(1, 'Kaese Quiz')]]]),
  );
  const res = await call('epg:search', ['ZDF.de'], '  kase ', NOW, NOW + DAY);
  assert.equal(res.results.length, 2);
  assert.equal(res.truncated, false);
  assert.equal((await call('epg:search', ['ZDF.de'], 'wein', NOW, NOW + DAY)).results.length, 0);
  assert.equal((await call('epg:search', ['ZDF.de'], 'wein', NOW, NOW + DAY, 10, { includeDesc: true })).results.length, 1);

  const bad = (...args) => assert.rejects(async () => call('epg:search', ...args));
  await assert.rejects(async () => call('epg:search', Array(601).fill('x.de'), 'ab', NOW, NOW + DAY), /Zu viele Kanäle/);
  await assert.rejects(async () => call('epg:search', ['ZDF.de'], 'a', NOW, NOW + DAY), /zu kurz/);
  await assert.rejects(async () => call('epg:search', ['ZDF.de'], 'a'.repeat(81), NOW, NOW + DAY), /zu lang/);
  await assert.rejects(async () => call('epg:search', ['ZDF.de'], 'ab', NOW, NOW + 15 * DAY), /zu groß/);
  await assert.rejects(async () => call('epg:search', ['ZDF.de'], 'ab', NOW, 'x'), /Endzeit/);
  await assert.rejects(async () => call('epg:search', ['ZDF.de'], 'ab', NOW, NOW + DAY, 201), /Limit ist zu groß/);
  await bad([], 'ab', NOW, NOW + DAY);
  await assert.rejects(async () => handlers.get('epg:search')({ sender: {} }, ['ZDF.de'], 'ab', NOW, NOW + DAY), /nicht autorisiert/);
});

test('Großfixture (438 Kanäle × 10 Tage): Suche korrekt, Laufzeit gemessen', async () => {
  const big = generateChannelSlots({ startMs: NOW - DAY });
  const { epg } = await makeIpc(big);
  const keys = Array.from({ length: 438 }, (_, i) => channelId(i));
  await epg.search(keys, 'Quiz 4', NOW, NOW + 10 * DAY, { limit: 5 }); // Aufwärmen, füllt den Faltungs-Cache
  const t0 = process.hrtime.bigint();
  const warm = await epg.search(keys, 'Käse', NOW, NOW + 10 * DAY, { limit: 200 });
  const warmMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const cold = await makeIpc(big); // frischer Store: Faltungs-Cache leer
  const t1 = process.hrtime.bigint();
  const first = await cold.epg.search(keys, 'Käse', NOW, NOW + 10 * DAY, { limit: 200 });
  const coldMs = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`# search 438 Kanäle × 10 Tage: kalt ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms, ${first.results.length} Treffer (truncated=${first.truncated})`);

  assert.equal(first.results.length, 200);
  assert.equal(first.truncated, true);
  assert.deepEqual(warm.results, first.results);
  assert.ok(first.results.every(r => /^Käse /.test(r.title)));
  for (let i = 1; i < first.results.length; i += 1) assert.ok(first.results[i].start >= first.results[i - 1].start);
  // Gegenprobe: ein eindeutiger Titel (Kanal 5, erster "Käse"-Treffer im Fenster) wird gefaltet gefunden
  const target = big.get(channelId(4)).find(sl => sl.title.startsWith('Käse') && sl.stop > NOW);
  assert.ok(target, 'Fixture enthält einen Käse-Titel auf Kanal 5');
  const query = target.title.replace('Käse', 'kaese').toUpperCase();
  const one = await epg.search(keys, query, NOW, NOW + 10 * DAY, { limit: 200 });
  assert.deepEqual(one.results, [{ channelKey: channelId(4), start: target.start, stop: target.stop, title: target.title }]);
  assert.ok(coldMs < 5000, `kalte Suche zu langsam: ${coldMs} ms`);
});
