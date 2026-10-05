'use strict';

// Tests: epg:range-many (Etappe 3.1, EPG-Konzept §4 A-1) — schlanke Raster-Slots für
// mehrere Kanäle: EpgStore.rangeMany, EpgService-Delegation, IPC, Großfixture.

// Volle Projektion von range()/find() seit Etappe 3.2
const FULL_KEYS = ['categories', 'credits', 'desc', 'episode', 'icon', 'rating', 'start', 'stop', 'subtitle', 'title', 'year'];
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeGenre } = require('../lib/epg/genre.js');
const { EpgService } = require('../lib/epg/EpgService.js');
const { createEpgStore, RANGE_MANY_MAX_SLOTS } = require('../lib/epg/EpgStore.js');
const { registerEpgIpc } = require('../lib/epg/ipc.js');
const { generateChannelSlots, buildXmltv, channelId, MIN, DAY } = require('./helpers/epg-large-fixture.js');

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'epg-rm-'));
}

function smallStore() {
  const store = createEpgStore({ dir: tmpDir() });
  const slots = (title, offset = 0) => [
    { start: NOW + offset, stop: NOW + offset + HOUR, title: `${title} 1`, desc: 'Lange Beschreibung' },
    { start: NOW + offset + HOUR, stop: NOW + offset + 2 * HOUR, title: `${title} 2`, desc: 'mehr' },
    { start: NOW + offset + 2 * HOUR, stop: NOW + offset + 3 * HOUR, title: `${title} 3`, desc: '' },
  ];
  store.setSource('https://a', {
    fetchedAt: NOW,
    channelSlots: new Map([
      ['DasErste.de@HD', slots('Erste')],
      ['ZDF.de', slots('ZDF', 30 * MIN)],
    ]),
  });
  return store;
}

test('rangeMany: schlanke Slots (start, stop, title, genre — kein desc), Eingabereihenfolge, Normalisierung', () => {
  const store = smallStore();
  const res = store.rangeMany(['ZDF.de', 'daserste.de', 'Unbekannt.de'], NOW, NOW + 10 * HOUR);
  assert.deepEqual(res.map(r => r.channelKey), ['ZDF.de', 'daserste.de', 'Unbekannt.de']);
  assert.equal(res[0].slots.length, 3);
  assert.equal(res[1].slots.length, 3);
  assert.deepEqual(res[2].slots, []);
  assert.deepEqual(Object.keys(res[0].slots[0]).sort(), ['genre', 'start', 'stop', 'title']);
  assert.equal(res[1].slots[0].title, 'Erste 1');
});

test('rangeMany: gleiche Überlappungsregel wie range (stop > from, start < to), sortiert, identisch zu range()', () => {
  const store = smallStore();
  const [r] = store.rangeMany(['DasErste.de'], NOW + HOUR, NOW + 2 * HOUR);
  assert.deepEqual(r.slots.map(s => s.title), ['Erste 2']);
  const [edge] = store.rangeMany(['DasErste.de'], NOW + HOUR - 1, NOW + HOUR + 1);
  assert.deepEqual(edge.slots.map(s => s.title), ['Erste 1', 'Erste 2']);
  for (const [from, to] of [[NOW - DAY, NOW + DAY], [NOW + 30 * MIN, NOW + 90 * MIN], [NOW + 10 * HOUR, NOW + 11 * HOUR]]) {
    const lean = store.rangeMany(['ZDF.de'], from, to)[0].slots;
    const full = store.range('ZDF.de', from, to).map(({ start, stop, title, categories }) => ({ start, stop, title, genre: normalizeGenre(categories) }));
    assert.deepEqual(lean, full);
  }
});

test('rangeMany: Quellen werden vereinigt, Duplikate entfernt; range() bleibt unverändert (volle Projektion)', () => {
  const store = smallStore();
  store.setSource('https://b', {
    fetchedAt: NOW,
    channelSlots: new Map([['ZDF.de', [{ start: NOW + 30 * MIN, stop: NOW + 90 * MIN, title: 'ZDF 1', desc: 'dup' }]]]),
  });
  const [r] = store.rangeMany(['ZDF.de'], NOW, NOW + 10 * HOUR);
  assert.equal(r.slots.length, 3);
  assert.deepEqual(Object.keys(store.range('ZDF.de', NOW, NOW + HOUR)[0]).sort(), FULL_KEYS);
});

test('rangeMany: Gesamtslot-Grenze wirft klaren Fehler statt still abzuschneiden', () => {
  const store = smallStore();
  assert.doesNotThrow(() => store.rangeMany(['DasErste.de', 'ZDF.de'], NOW, NOW + 10 * HOUR, { maxSlots: 6 }));
  assert.throws(() => store.rangeMany(['DasErste.de', 'ZDF.de'], NOW, NOW + 10 * HOUR, { maxSlots: 5 }), /Zu viele Sendungen \(max\. 5\)/);
  assert.equal(RANGE_MANY_MAX_SLOTS, 25000);
});

async function ipcWithStore(channelSlots) {
  const store = createEpgStore({ dir: tmpDir() });
  store.setSource('https://big', { fetchedAt: NOW, channelSlots });
  const epg = new EpgService({
    store,
    getSources: () => [],
    now: () => NOW,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  const handlers = new Map();
  const mainSender = {};
  registerEpgIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    epg,
    requireMainRenderer: e => {
      if (e?.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
  });
  return { epg, store, call: (channel, ...args) => handlers.get(channel)({ sender: mainSender }, ...args), handlers };
}

test('IPC epg:range-many: Validierung und Delegation', async () => {
  const { call, handlers } = await ipcWithStore(generateChannelSlots({ channels: 5, days: 2, startMs: NOW }));
  const res = await call('epg:range-many', [channelId(0), channelId(1)], NOW, NOW + 3 * HOUR);
  assert.equal(res.length, 2);
  assert.ok(res[0].slots.length >= 1);
  await assert.rejects(async () => call('epg:range-many', [], NOW, NOW + HOUR), /Kanalliste/);
  await assert.rejects(async () => call('epg:range-many', Array(101).fill('x.de'), NOW, NOW + HOUR), /Zu viele Kanäle/);
  await assert.rejects(async () => call('epg:range-many', ['x.de'], NOW, NOW + 15 * DAY), /zu groß/);
  await assert.rejects(async () => call('epg:range-many', ['x.de'], 'a', NOW), /Startzeit/);
  await assert.rejects(async () => handlers.get('epg:range-many')({ sender: {} }, ['x.de'], NOW, NOW + 1), /nicht autorisiert/);
});

test('Großfixture (438 Kanäle × 10 Tage): Fixture ist deterministisch, lückenlos und realistisch', () => {
  const a = generateChannelSlots({ startMs: NOW });
  const b = generateChannelSlots({ startMs: NOW });
  assert.equal(a.size, 438);
  assert.deepEqual(a.get(channelId(7)), b.get(channelId(7)));
  let total = 0;
  for (const slots of a.values()) {
    total += slots.length;
    for (let i = 1; i < slots.length; i += 1) assert.equal(slots[i].start, slots[i - 1].stop);
    assert.ok(slots[0].start === NOW && slots[slots.length - 1].stop >= NOW + 10 * DAY);
  }
  assert.ok(total > 80000 && total < 150000, `Slots gesamt ${total}`);
});

test('Großfixture: 100 Kanäle × 2 Tage — rangeMany korrekt, Antwort unter der Slot-Grenze, Laufzeit gemessen', async () => {
  const { epg } = await ipcWithStore(generateChannelSlots({ startMs: NOW - DAY }));
  const keys = Array.from({ length: 100 }, (_, i) => channelId(i * 4));
  epg.rangeMany(keys, NOW, NOW + 2 * DAY); // Aufwärmen (JIT)
  const t0 = process.hrtime.bigint();
  const res = epg.rangeMany(keys, NOW, NOW + 2 * DAY);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const total = res.reduce((n, r) => n + r.slots.length, 0);
  console.log(`# rangeMany 100 Kanäle × 2 Tage: ${ms.toFixed(1)} ms, ${total} Slots, ${JSON.stringify(res).length} Bytes JSON`);
  assert.equal(res.length, 100);
  assert.ok(total > 3000 && total < RANGE_MANY_MAX_SLOTS, `Slots ${total}`);
  for (const r of res) {
    assert.ok(r.slots[0].start <= NOW && r.slots[0].stop > NOW);
    assert.ok(r.slots[r.slots.length - 1].start < NOW + 2 * DAY);
  }
  assert.ok(ms < 1000, `rangeMany zu langsam: ${ms} ms`);
  // 100 Kanäle × 14 Tage überschreiten die Grenze realistisch → klarer Fehler
  const full = await ipcWithStore(generateChannelSlots({ channels: 100, days: 14, startMs: NOW }));
  assert.throws(() => full.epg.rangeMany(Array.from({ length: 100 }, (_, i) => channelId(i)), NOW, NOW + 14 * DAY), /Zu viele Sendungen/);
});

test('Großfixture als XMLTV durch den echten Parser: rangeMany liefert die erwarteten Slots', async () => {
  const xml = buildXmltv({ channels: 20, days: 3, startMs: NOW - DAY });
  const epg = new EpgService({
    dir: tmpDir(),
    getSources: () => [{ id: 'q', epgUrl: 'https://epg.example/x.xml' }],
    fetchImpl: async () => new Response(xml),
    validateUrl: u => u,
    now: () => NOW,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  await epg.refresh({ force: true });
  const [r] = epg.rangeMany([channelId(3)], NOW, NOW + 6 * HOUR);
  const expected = generateChannelSlots({ channels: 20, days: 3, startMs: NOW - DAY })
    .get(channelId(3))
    .filter(s => s.stop > NOW && s.start < NOW + 6 * HOUR);
  assert.deepEqual(r.slots, expected.map(({ start, stop, title }) => ({ start, stop, title, genre: '' })));
});

test('rangeMany: liefert schlank das normalisierte Genre (normalizeGenre der Kategorien), leer ohne Kategorie', () => {
  const store = createEpgStore({ dir: tmpDir() });
  const base = { stop: NOW + HOUR, desc: 'x' };
  store.setSource('https://epg.example/g.xml', {
    fetchedAt: NOW,
    channelSlots: new Map([
      [
        'G.de',
        [
          { ...base, start: NOW, title: 'Nachrichten', categories: ['Nachrichten'] },
          { ...base, start: NOW + HOUR, stop: NOW + 2 * HOUR, title: 'Ohne', categories: [] },
          { ...base, start: NOW + 2 * HOUR, stop: NOW + 3 * HOUR, title: 'Merkwürdig', categories: ['Xyzzy-unbekannt'] },
        ],
      ],
    ]),
  });
  const [r] = store.rangeMany(['G.de'], NOW, NOW + 4 * HOUR);
  assert.deepEqual(r.slots.map(s => s.genre), ['news', '', 'sonstiges']);
  assert.equal(r.slots[0].genre, normalizeGenre(['Nachrichten']));
  assert.ok(!('categories' in r.slots[0]) && !('desc' in r.slots[0]), 'keine weiteren Zusatzfelder in der schlanken Projektion');
});
