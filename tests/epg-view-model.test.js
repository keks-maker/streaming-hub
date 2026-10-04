'use strict';

// Tests: epg-view-model.js (Etappe 3.3, Design B2) — DOM-freies Zustandsmodell des
// Programmführers: Tage, Zeilen, Layout/Virtualisierung, Scroll-Ziele, Toggle, Zustände,
// Ansichtszustand (moduswechsel-fähig). TV-Tag-Tests laufen in Europe/Berlin.
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../epg-view-model.js');
const grid = require('../lib/epg-grid.js');
const { MAX_AHEAD_MS } = require('../lib/recorder/Scheduler.js');
const { generateChannelSlots, channelId } = require('./helpers/epg-large-fixture.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

// Mo 05.10.2026 20:32 (Europe/Berlin)
const NOW = local(2026, 10, 5, 20, 32);

// ── Konstanten ──

test('Planungsgrenze entspricht der Scheduler-Grenze des Main (8 Tage)', () => {
  assert.equal(model.PLAN_MAX_AHEAD_MS, MAX_AHEAD_MS);
});

// ── Tage der Tagesleiste ──

test('planDays: Gestern nur mit Daten davor, Heute, Morgen, Wochentage, 7 TV-Tage ab heute', () => {
  const coverageToMs = NOW + 10 * 24 * HOUR;
  const withYesterday = model.planDays({ nowMs: NOW, coverageFromMs: NOW - 20 * HOUR, coverageToMs });
  assert.deepEqual(
    withYesterday.map(d => d.label),
    ['Gestern', 'Heute', 'Morgen', 'Mi 7.10.', 'Do 8.10.', 'Fr 9.10.', 'Sa 10.10.', 'So 11.10.'],
  );
  assert.equal(withYesterday[1].isToday, true);
  assert.equal(withYesterday[0].key, '2026-10-04');
  // Cache beginnt erst heute 05:00 → kein Gestern
  const noYesterday = model.planDays({ nowMs: NOW, coverageFromMs: local(2026, 10, 5, 5, 0), coverageToMs });
  assert.deepEqual(noYesterday.map(d => d.label).slice(0, 2), ['Heute', 'Morgen']);
  assert.equal(noYesterday.length, 7);
  // ohne bekannten Beginn: kein Gestern
  assert.equal(model.planDays({ nowMs: NOW, coverageFromMs: null, coverageToMs })[0].label, 'Heute');
});

test('planDays: endet mit dem Cache und liefert ohne Abdeckung nichts', () => {
  const days = model.planDays({ nowMs: NOW, coverageFromMs: NOW - HOUR, coverageToMs: local(2026, 10, 7, 12, 0) });
  assert.deepEqual(days.map(d => d.label), ['Heute', 'Morgen', 'Mi 7.10.']);
  assert.deepEqual(model.planDays({ nowMs: NOW, coverageFromMs: null, coverageToMs: null }), []);
});

test('planDays: vor 05:00 gilt noch der Vorabend als „Heute“ (TV-Tag)', () => {
  const night = local(2026, 10, 6, 1, 30); // Di 01:30 gehört zum TV-Tag von Mo 05.10.
  const days = model.planDays({ nowMs: night, coverageFromMs: night - 2 * HOUR, coverageToMs: night + 10 * 24 * HOUR });
  const today = days.find(d => d.isToday);
  assert.equal(today.key, '2026-10-05');
  assert.equal(days[0].label, 'Heute'); // Cache beginnt nach 05:00 des Vorabends → kein Gestern
  assert.equal(days[1].label, 'Morgen');
  assert.equal(days[1].key, '2026-10-06');
});

test('planDays: Sommerzeitumstellung (25-h-Tag) bleibt 7 aufeinanderfolgende TV-Tage', () => {
  const now = local(2026, 10, 24, 12, 0); // Sa; Umstellung in der Nacht auf So 25.10.
  const days = model.planDays({ nowMs: now, coverageFromMs: null, coverageToMs: now + 12 * 24 * HOUR });
  assert.equal(days.length, 7);
  assert.equal((days[0].endMs - days[0].startMs) / HOUR, 25); // Sa 24.10. 05:00 → So 25.10. 05:00
  for (let i = 1; i < days.length; i += 1) assert.equal(days[i].startMs, days[i - 1].endMs);
});

test('Beschriftungen: Tab-Label, Überschrift, Kalenderlabel, Dauer, Nacht', () => {
  const [today] = model.planDays({ nowMs: NOW, coverageFromMs: null, coverageToMs: NOW + 5 * 24 * HOUR });
  assert.equal(model.dayTabLabel(today), 'Heute');
  assert.equal(model.dayHeading(today), 'Heute · Mo 05.10.');
  assert.equal(model.calendarLabel(local(2026, 10, 6, 1, 0)), 'Di 06.10.');
  assert.equal(model.clock(local(2026, 10, 5, 9, 5)), '09:05');
  assert.equal(model.durationMinutes(NOW, NOW + 45 * MIN), 45);
  assert.equal(model.isNightStart(local(2026, 10, 6, 1, 0)), true);
  assert.equal(model.isNightStart(local(2026, 10, 6, 4, 59)), true);
  assert.equal(model.isNightStart(local(2026, 10, 6, 5, 0)), false);
  assert.equal(model.formatDetailTime(local(2026, 10, 5, 20, 15), local(2026, 10, 5, 21, 0)), '20:15–21:00');
  // Nachtsendung im Detail mit Kalenderdatum
  assert.equal(model.formatDetailTime(local(2026, 10, 6, 1, 0), local(2026, 10, 6, 2, 0)), 'Di 06.10. 01:00–02:00');
});

// ── Senderauswahl ──

test('selectChannels: nur Favoriten (EPG-E3), je normalisierter tvgId einer, nur Sender mit EPG-Schlüssel', () => {
  const channels = [
    { id: 'a', name: 'A', tvgId: 'ard@hd.de', fav: true },
    { id: 'a2', name: 'A zweite Quelle', tvgId: 'ard.de', fav: true },
    { id: 'b', name: 'B', tvgId: 'zdf.de', fav: false },
    { id: 'c', name: 'C', tvgId: '', fav: true },
    { id: 'd', name: 'D', fav: true },
    { id: 'e', name: 'E', tvgId: 'x'.repeat(201), fav: true },
    { id: 'f', name: 'F', tvgId: 'ctl\u0007.de', fav: true },
  ];
  const isFavorite = ch => ch.fav;
  const favs = model.selectChannels({ channels, isFavorite, showAll: false });
  assert.deepEqual(favs.map(c => c.key), ['ard@hd.de']);
  const all = model.selectChannels({ channels, isFavorite, showAll: true });
  assert.deepEqual(all.map(c => c.key), ['ard@hd.de', 'zdf.de']);
  assert.deepEqual(model.selectChannels({ channels: null, isFavorite, showAll: true }), []);
  assert.equal(model.epgChannelKey({ tvgId: '  rtl.de ' }), 'rtl.de');
});

test('chunkKeys: höchstens 100 Kanäle je epg:range-many-Aufruf', () => {
  const keys = Array.from({ length: 438 }, (_, i) => `k${i}`);
  const chunks = model.chunkKeys(keys);
  assert.deepEqual(chunks.map(c => c.length), [100, 100, 100, 100, 38]);
  assert.deepEqual(chunks.flat(), keys);
});

// ── Zeilen eines TV-Tags ──

function rowsFor(day, slotsByChannel) {
  const channelByKey = new Map();
  const results = Object.entries(slotsByChannel).map(([key, slots]) => {
    channelByKey.set(key, { id: key, name: key.toUpperCase(), tvgId: key });
    return { channelKey: key, slots };
  });
  return model.buildDayRows(day, results, channelByKey);
}

test('buildDayRows: nach Start sortiert, Nachtsendung beim Vorabend (Badge), Tagesgrenze 05:00', () => {
  const [today, tomorrow] = model.planDays({ nowMs: NOW, coverageFromMs: null, coverageToMs: NOW + 5 * 24 * HOUR });
  const slot = (h, m, mins, title) => ({ start: local(2026, 10, 5, h, m), stop: local(2026, 10, 5, h, m) + mins * MIN, title });
  const night = { start: local(2026, 10, 6, 1, 0), stop: local(2026, 10, 6, 2, 0), title: 'Nachtkrimi' };
  const nextMorning = { start: local(2026, 10, 6, 5, 0), stop: local(2026, 10, 6, 6, 0), title: 'Frühmagazin' };
  const slots = { 'a.de': [slot(20, 15, 60, 'Film'), slot(8, 0, 30, 'Morgen'), night, nextMorning], 'b.de': [slot(20, 15, 30, 'Quiz')] };
  const rows = rowsFor(today, slots);
  assert.deepEqual(rows.map(r => r.title), ['Morgen', 'Film', 'Quiz', 'Nachtkrimi']);
  const nightRow = rows.find(r => r.title === 'Nachtkrimi');
  assert.equal(nightRow.night, true);
  assert.equal(nightRow.dayKey, today.key);
  assert.equal(rows.find(r => r.title === 'Film').night, false);
  // gleicher Start: Reihenfolge der Sender (Eingabereihenfolge) bleibt stabil
  assert.equal(rows[1].channelKey, 'a.de');
  assert.equal(rows[2].channelKey, 'b.de');
  // 05:00 des nächsten TV-Tags gehört zum nächsten Tag
  assert.deepEqual(rowsFor(tomorrow, slots).map(r => r.title), ['Frühmagazin']);
});

test('buildDayRows: Entities bleiben unverändert (kein Doppel-Decode), Duplikate/ungültige Slots entfallen', () => {
  const [today] = model.planDays({ nowMs: NOW, coverageFromMs: null, coverageToMs: NOW + 5 * 24 * HOUR });
  const start = local(2026, 10, 5, 21, 0);
  const rows = rowsFor(today, {
    'a.de': [
      { start, stop: start + HOUR, title: 'Tom &amp;lt; Jerry' },
      { start, stop: start + HOUR, title: 'Doppelt' },
      { start: NaN, stop: 1, title: 'kaputt' },
      null,
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Tom &amp;lt; Jerry');
});

test('markerSlot: Kanalbezug für matchMarkers; Marker aus Planung und laufender Aufnahme', () => {
  const [today] = model.planDays({ nowMs: NOW, coverageFromMs: null, coverageToMs: NOW + 5 * 24 * HOUR });
  const start = local(2026, 10, 5, 21, 0);
  const rows = rowsFor(today, { 'ard.de': [{ start, stop: start + HOUR, title: 'Film' }] });
  assert.deepEqual(model.markerSlot(rows[0]), { start, stop: start + HOUR, channelKey: 'ard.de', channelId: 'ard.de', tvgId: 'ard.de' });
  const schedules = [{ id: 'sch_1', state: 'scheduled', channelId: 'ard.de', tvgId: 'ard.de', epgStart: new Date(start).toISOString(), epgStop: new Date(start + HOUR).toISOString() }];
  assert.deepEqual(grid.matchMarkers([model.markerSlot(rows[0])], schedules, [], NOW), [{ state: 'scheduled', ids: ['sch_1'] }]);
});

// ── Layout / Virtualisierung ──

function dayDataFor(slotsByChannel, nowMs = NOW, coverageToMs = NOW + 5 * 24 * HOUR) {
  const days = model.planDays({ nowMs, coverageFromMs: nowMs - 20 * HOUR, coverageToMs });
  const channelByKey = new Map();
  const results = Object.entries(slotsByChannel).map(([key, slots]) => {
    channelByKey.set(key, { id: key, name: key, tvgId: key });
    return { channelKey: key, slots };
  });
  return days.map(day => ({ day, rows: model.buildDayRows(day, results, channelByKey) }));
}

test('buildLayout: Tag-Köpfe, „Jetzt“-Trennlinie vor der ersten späteren Sendung, feste Höhen', () => {
  const at = (d, h, m) => local(2026, 10, d, h, m);
  const slots = {
    'a.de': [
      { start: at(5, 18, 0), stop: at(5, 20, 0), title: 'Vorher' },
      { start: at(5, 20, 0), stop: at(5, 21, 0), title: 'Läuft' },
      { start: at(5, 21, 0), stop: at(5, 22, 0), title: 'Danach' },
      { start: at(6, 6, 0), stop: at(6, 7, 0), title: 'Morgen' },
    ],
  };
  const data = dayDataFor(slots).filter(d => d.day.key >= '2026-10-05').slice(0, 2);
  const layout = model.buildLayout(data, NOW);
  const types = layout.items.map(i => (i.type === 'row' ? i.row.title : i.type));
  assert.deepEqual(types, ['day', 'Vorher', 'Läuft', 'now', 'Danach', 'day', 'Morgen']);
  assert.equal(layout.nowIndex, 3);
  const expectTotal = 2 * model.DAY_HEIGHT + model.NOW_HEIGHT + 4 * model.ROW_HEIGHT;
  assert.equal(layout.total, expectTotal);
  assert.equal(layout.offsets[1], model.DAY_HEIGHT);
  assert.equal(layout.offsets[4], model.DAY_HEIGHT + 2 * model.ROW_HEIGHT + model.NOW_HEIGHT);
  assert.equal(layout.dayIndex.get('2026-10-06'), 5);
  // Schlüssel eindeutig und auffindbar
  assert.equal(new Set(layout.items.map(i => i.key)).size, layout.count);
  assert.equal(layout.indexOfKey('now'), 3);
  assert.equal(layout.indexOfKey('r:nicht-da'), -1);
});

test('buildLayout: „Jetzt“ ohne spätere Sendung steht am Ende des Tages; ohne passenden Tag gibt es keine Linie', () => {
  const at = (d, h, m) => local(2026, 10, d, h, m);
  const data = dayDataFor({ 'a.de': [{ start: at(5, 18, 0), stop: at(5, 20, 0), title: 'Vorher' }] }).filter(d => d.day.key === '2026-10-05');
  const layout = model.buildLayout(data, NOW);
  assert.deepEqual(layout.items.map(i => i.type), ['day', 'row', 'now']);
  const tomorrowOnly = dayDataFor({}).filter(d => d.day.key === '2026-10-06');
  assert.equal(model.buildLayout(tomorrowOnly, NOW).nowIndex, -1);
  assert.equal(model.buildLayout([], NOW).count, 0);
  assert.equal(model.buildLayout([], NOW).total, 0);
});

test('itemIndexAt/visibleItems: Binärsuche über die Offsets, geklemmt', () => {
  const slots = { 'a.de': [] };
  const base = local(2026, 10, 5, 5, 0);
  for (let i = 0; i < 100; i += 1) slots['a.de'].push({ start: base + i * 10 * MIN, stop: base + (i + 1) * 10 * MIN, title: `S${i}` });
  const data = dayDataFor(slots).filter(d => d.day.key === '2026-10-05');
  const layout = model.buildLayout(data, NOW);
  assert.equal(model.itemIndexAt(layout, -50), 0);
  assert.equal(model.itemIndexAt(layout, 0), 0);
  assert.equal(model.itemIndexAt(layout, model.DAY_HEIGHT - 1), 0);
  assert.equal(model.itemIndexAt(layout, model.DAY_HEIGHT), 1);
  assert.equal(model.itemIndexAt(layout, layout.total + 500), layout.count - 1);
  for (const y of [0, 123, 999, 2500, layout.total - 1]) {
    const i = model.itemIndexAt(layout, y);
    assert.ok(layout.offsets[i] <= y && y < layout.offsets[i + 1], `y=${y}`);
  }
  const vis = model.visibleItems(layout, 500, 400, 100);
  assert.ok(layout.offsets[vis.from] <= 400);
  assert.ok(layout.offsets[vis.to - 1] < 1000 && layout.offsets[vis.to] >= 1000);
  assert.ok(vis.to - vis.from <= 20);
  assert.deepEqual(model.visibleItems(layout, 0, 100, 0).from, 0);
  assert.equal(model.visibleItems(layout, layout.total + 10_000, 400, 0).to, layout.count);
  assert.deepEqual(model.visibleItems({ count: 0 }, 0, 400, 0), { from: 0, to: 0 });
});

test('Großfixture (438 Kanäle × 10 Tage): Layout bleibt schnell, Fenster enthält nur wenige Items', () => {
  const startMs = local(2026, 10, 4, 5, 0);
  const slotMap = generateChannelSlots({ channels: 438, days: 10, startMs, seed: 3 });
  const channelByKey = new Map();
  const results = [];
  for (const [key, slots] of slotMap) {
    channelByKey.set(key, { id: key, name: key, tvgId: key });
    results.push({ channelKey: key, slots });
  }
  const days = model.planDays({ nowMs: NOW, coverageFromMs: startMs, coverageToMs: startMs + 10 * 24 * HOUR });
  const t0 = Date.now();
  const dayData = days.map(day => ({ day, rows: model.buildDayRows(day, results, channelByKey) }));
  const layout = model.buildLayout(dayData, NOW);
  const t1 = Date.now();
  assert.ok(layout.rowIndex.length >= 100_000 / 4, `Zeilen: ${layout.rowIndex.length}`);
  assert.ok(t1 - t0 < 3000, `Aufbau dauerte ${t1 - t0} ms`);
  const jump = model.scrollTopForNow(layout, 700, model.NOW_ANCHOR_RATIO, 34);
  const t2 = Date.now();
  const vis = model.visibleItems(layout, jump, 700, 400);
  assert.ok(Date.now() - t2 < 50);
  assert.ok(vis.to - vis.from < 60, `Fensterbreite ${vis.to - vis.from}`);
  assert.ok(layout.nowIndex >= vis.from && layout.nowIndex < vis.to);
});

// ── Scroll-Ziele ──

test('scrollTopForNow: Jetzt-Linie bei 40 % der Viewporthöhe (mit Kopfhöhe), null ohne Linie, nie negativ', () => {
  const data = dayDataFor({ 'a.de': [{ start: local(2026, 10, 5, 21, 0), stop: local(2026, 10, 5, 22, 0), title: 'X' }] }).filter(d => d.day.key === '2026-10-05');
  const layout = model.buildLayout(data, NOW);
  const nowTop = layout.offsets[layout.nowIndex];
  assert.equal(model.scrollTopForNow(layout, 0), Math.max(0, nowTop));
  assert.equal(model.scrollTopForNow(layout, 1000), Math.max(0, nowTop - 400));
  assert.equal(model.scrollTopForNow(layout, 1000, 0.4, 34), Math.max(0, nowTop + 34 - 400));
  assert.equal(model.scrollTopForNow(layout, 100_000), 0);
  assert.equal(model.scrollTopForNow(model.buildLayout([], NOW), 600), null);
});

test('scrollTopForDay/scrollTopForTime/activeDayKeyAt/anchorTimeAt: Tageswechsel, Zeitanker, Tab folgt Scroll', () => {
  const at = (d, h, m) => local(2026, 10, d, h, m);
  const slots = {
    'a.de': [
      { start: at(5, 6, 0), stop: at(5, 7, 0), title: 'A1' },
      { start: at(5, 21, 0), stop: at(5, 22, 0), title: 'A2' },
      { start: at(6, 6, 0), stop: at(6, 7, 0), title: 'B1' },
      { start: at(6, 7, 0), stop: at(6, 8, 0), title: 'B2' },
    ],
  };
  const data = dayDataFor(slots).filter(d => d.day.key === '2026-10-05' || d.day.key === '2026-10-06');
  const layout = model.buildLayout(data, NOW);
  const topB = model.scrollTopForDay(layout, '2026-10-06');
  assert.equal(layout.items[model.itemIndexAt(layout, topB)].type, 'day');
  assert.equal(model.scrollTopForDay(layout, '2026-12-24'), null);
  // Tab folgt Scrollposition: am Tagesbeginn schon der neue Tag, davor der alte
  assert.equal(model.activeDayKeyAt(layout, topB), '2026-10-06');
  assert.equal(model.activeDayKeyAt(layout, topB - 5), '2026-10-05');
  assert.equal(model.activeDayKeyAt(layout, 0), '2026-10-05');
  assert.equal(model.activeDayKeyAt(model.buildLayout([], NOW), 0), null);
  // Zeitanker
  assert.equal(model.scrollTopForTime(layout, at(6, 7, 0)), layout.offsets[layout.rowIndex[3]]);
  assert.equal(model.scrollTopForTime(layout, at(9, 0, 0)), layout.offsets[layout.rowIndex[3]]); // geklemmt auf die letzte Zeile
  assert.equal(model.scrollTopForTime(model.buildLayout([], NOW), 1), null);
  assert.equal(model.anchorTimeAt(layout, topB + 1), at(6, 6, 0));
  assert.equal(model.anchorTimeAt(layout, 0), at(5, 6, 0));
  assert.equal(model.anchorTimeAt(layout, layout.total + 100), at(6, 7, 0));
  // Anker → Scroll → Anker (Moduswechsel verliert die Position nicht)
  const anchor = model.anchorTimeAt(layout, layout.offsets[layout.rowIndex[2]]);
  assert.equal(model.anchorTimeAt(layout, model.scrollTopForTime(layout, anchor)), anchor);
});

test('resolveActiveDay: gewählter Tag bleibt bei geklemmtem scrollTop aktiv, Scrollen hebt die Bindung auf', () => {
  const at = (d, h) => local(2026, 10, d, h, 0);
  const slots = { 'a.de': [{ start: at(5, 6), stop: at(5, 7), title: 'A' }, { start: at(6, 6), stop: at(6, 7), title: 'B' }] };
  const data = dayDataFor(slots).filter(d => d.day.key === '2026-10-05' || d.day.key === '2026-10-06');
  const layout = model.buildLayout(data, NOW);
  // Liste nicht scrollbar: Klick auf „Morgen“ bleibt bei scrollTop 0 → ohne Pin würde „Heute“ aktiv
  assert.equal(model.activeDayKeyAt(layout, 0), '2026-10-05');
  const pin = { key: '2026-10-06', top: 0 };
  assert.deepEqual(model.resolveActiveDay(layout, 0, pin), { key: '2026-10-06', pin });
  assert.deepEqual(model.resolveActiveDay(layout, 1, pin), { key: '2026-10-06', pin });
  // weggescrollt: Tab folgt wieder, Pin entfällt
  const topB = model.scrollTopForDay(layout, '2026-10-06');
  assert.deepEqual(model.resolveActiveDay(layout, topB + 50, { key: '2026-10-05', top: 0 }), { key: '2026-10-06', pin: null });
  assert.deepEqual(model.resolveActiveDay(layout, 0, null), { key: '2026-10-05', pin: null });
});

test('rowPhase: vergangen, läuft (Fortschritt, noch N min), kommend', () => {
  const row = { start: NOW - 30 * MIN, stop: NOW + 30 * MIN };
  assert.deepEqual(model.rowPhase(row, NOW), { phase: 'now', progress: 0.5, minutesLeft: 30 });
  assert.deepEqual(model.rowPhase({ start: NOW + MIN, stop: NOW + 2 * MIN }, NOW), { phase: 'future', progress: 0, minutesLeft: null });
  assert.deepEqual(model.rowPhase({ start: NOW - 2 * MIN, stop: NOW - MIN }, NOW), { phase: 'past', progress: 1, minutesLeft: null });
});

// ── Aufnahme-Toggle ──

test('toggleState: Aufnehmen ↔ Abbrechen ↔ Stoppen; laufend/vorbei bleiben „Aufnehmen“ (Meldung beim Klick)', () => {
  const future = { start: NOW + HOUR, stop: NOW + 2 * HOUR };
  assert.deepEqual(model.toggleState({ row: future, marker: null, nowMs: NOW }), {
    kind: 'record', label: '● Aufnehmen', disabled: false, hint: '', verdict: 'future',
  });
  assert.equal(model.toggleState({ row: future, marker: { state: 'scheduled', ids: ['sch_1'] }, nowMs: NOW }).label, '✕ Aufnahme abbrechen');
  assert.equal(model.toggleState({ row: future, marker: { state: 'scheduled', ids: ['sch_1'] }, nowMs: NOW }).kind, 'cancel');
  const stop = model.toggleState({ row: future, marker: { state: 'recording', ids: ['rec_1'] }, nowMs: NOW });
  assert.deepEqual([stop.kind, stop.label], ['stop', '■ Aufnahme stoppen']);
  const running = model.toggleState({ row: { start: NOW - HOUR, stop: NOW + HOUR }, marker: null, nowMs: NOW });
  assert.deepEqual([running.kind, running.disabled, running.verdict], ['record', false, 'running']);
  const past = model.toggleState({ row: { start: NOW - 3 * HOUR, stop: NOW - HOUR }, marker: null, nowMs: NOW });
  assert.deepEqual([past.kind, past.disabled, past.verdict], ['record', false, 'past']);
});

test('toggleState: P9 — mehr als 8 Tage voraus: deaktiviert mit Hinweis; genau 8 Tage noch planbar', () => {
  const edge = { start: NOW + 8 * 24 * HOUR, stop: NOW + 8 * 24 * HOUR + HOUR };
  assert.equal(model.toggleState({ row: edge, marker: null, nowMs: NOW }).disabled, false);
  const far = { start: NOW + 8 * 24 * HOUR + MIN, stop: NOW + 8 * 24 * HOUR + HOUR };
  const state = model.toggleState({ row: far, marker: null, nowMs: NOW });
  assert.equal(state.disabled, true);
  assert.equal(state.hint, 'Planung nur bis 8 Tage im Voraus');
  assert.equal(state.kind, 'record');
  // bereits geplant/laufend bleibt bedienbar, auch wenn die Sendung weit voraus liegt
  assert.equal(model.toggleState({ row: far, marker: { state: 'scheduled', ids: ['sch_1'] }, nowMs: NOW }).disabled, false);
});

test('resolveMarkerTargets: Planungs-IDs zum Absagen, Aufnahme-IDs zum Stoppen, Titel für die Rückfrage', () => {
  const schedules = [
    { id: 'sch_1', title: 'Film + Folge', state: 'scheduled' },
    { id: 'sch_2', title: 'Krimi', state: 'recording', recId: 'rec_77' },
    { id: 'sch_3', title: 'Ohne recId', state: 'recording' },
  ];
  assert.deepEqual(model.resolveMarkerTargets({ state: 'scheduled', ids: ['sch_1', 'sch_9'] }, schedules), {
    scheduleIds: ['sch_1'], recIds: [], titles: ['Film + Folge'],
  });
  assert.deepEqual(model.resolveMarkerTargets({ state: 'recording', ids: ['sch_2', 'rec_5', 'rec_5'] }, schedules), {
    scheduleIds: [], recIds: ['rec_77', 'rec_5'], titles: ['Krimi'],
  });
  assert.deepEqual(model.resolveMarkerTargets({ state: 'recording', ids: ['sch_3'] }, schedules).recIds, []);
  assert.deepEqual(model.resolveMarkerTargets(null, schedules), { scheduleIds: [], recIds: [], titles: [] });
});

test('confirmCopy: Abbrechen mit Rückfrage, Stoppen immer mit Rückfrage; Fremdtext wird bereinigt', () => {
  assert.deepEqual(model.confirmCopy('cancel', 'Film'), {
    message: 'Geplante Aufnahme „Film“ abbrechen?', yes: 'Ja, abbrechen', no: 'Behalten',
  });
  const stop = model.confirmCopy('stop', 'Tatort‮\nNachtschatten');
  assert.equal(stop.message, 'Laufende Aufnahme „Tatort Nachtschatten“ stoppen? Die bisher aufgenommene Zeit bleibt erhalten.');
  assert.deepEqual([stop.yes, stop.no], ['Ja, stoppen', 'Weiter aufnehmen']);
  assert.match(model.confirmCopy('cancel', '').message, /„Aufnahme“/);
});

// ── Anzeigezustand ──

const okStatus = { refreshing: false, sources: [{ configured: true, lastError: null }] };
const base = { status: okStatus, loadError: '', loading: false, channelCount: 5, hasFavorites: true, showAll: false, rowCount: 100, hasDays: true };

test('deriveViewState: bereit, lädt, leer, Fehler, Quelle ohne EPG, keine Favoriten (P14), kein Programm', () => {
  assert.equal(model.deriveViewState(base).kind, 'ready');
  assert.equal(model.deriveViewState({ ...base, loading: true }).kind, 'loading');
  assert.equal(model.deriveViewState({ ...base, status: { ...okStatus, refreshing: true }, hasDays: false }).kind, 'loading');
  const empty = model.deriveViewState({ ...base, hasDays: false });
  assert.deepEqual([empty.kind, empty.action], ['empty', 'refresh']);
  const failed = model.deriveViewState({ ...base, hasDays: false, status: { sources: [{ configured: true, lastError: 'HTTP 503' }] } });
  assert.match(failed.text, /HTTP 503/);
  const err = model.deriveViewState({ ...base, loadError: 'Abruf fehlgeschlagen' });
  assert.deepEqual([err.kind, err.action, err.text], ['error', 'refresh', 'Abruf fehlgeschlagen']);
  const noSource = model.deriveViewState({ ...base, status: { sources: [{ configured: false }] }, hasDays: false });
  assert.deepEqual([noSource.kind, noSource.action], ['no-source', null]);
  assert.equal(model.deriveViewState({ ...base, status: { sources: [] }, hasDays: false }).kind, 'no-source');
  const noFav = model.deriveViewState({ ...base, hasFavorites: false, channelCount: 0, rowCount: 0 });
  assert.deepEqual([noFav.kind, noFav.action], ['no-favorites', 'show-all']);
  // mit „Alle Sender“ gibt es das Favoriten-Hinweisbild nicht mehr
  assert.notEqual(model.deriveViewState({ ...base, hasFavorites: false, showAll: true }).kind, 'no-favorites');
  const nothing = model.deriveViewState({ ...base, rowCount: 0 });
  assert.deepEqual([nothing.kind, nothing.action], ['no-programmes', 'show-all']);
  assert.equal(model.deriveViewState({ ...base, rowCount: 0, showAll: true }).action, 'refresh');
});

test('deriveViewState: Fehler hat Vorrang; ohne Status (noch nichts geladen) ist nichts „Quelle ohne EPG“', () => {
  assert.equal(model.deriveViewState({ ...base, status: { sources: [] }, loadError: 'x' }).kind, 'error');
  assert.equal(model.deriveViewState({ ...base, status: null, loading: true }).kind, 'loading');
});

// ── Ansichtszustand ──

test('createViewState: Standard Liste; Moduswechsel Liste ↔ Raster ändert nur den Modus (kein Zustandsverlust)', () => {
  const state = model.createViewState();
  assert.equal(state.mode, 'list');
  assert.equal(state.showAll, false);
  state.setDay('2026-10-07');
  state.setAnchor(local(2026, 10, 7, 20, 15));
  state.select('a.de|123');
  state.setShowAll(true);
  const before = state.snapshot();
  assert.equal(state.setMode('grid'), true);
  assert.equal(state.mode, 'grid');
  assert.deepEqual({ ...state.snapshot(), mode: 'list' }, before);
  assert.equal(state.setMode('list'), true);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(state.setMode('galerie'), false);
  assert.equal(state.mode, 'list');
  state.setAnchor(NaN);
  assert.equal(state.anchorMs, null);
  state.select('');
  assert.equal(state.selectedRowId, null);
  assert.equal(model.createViewState({ mode: 'grid', dayKey: 'x', anchorMs: 5, showAll: true }).mode, 'grid');
  assert.equal(model.createViewState({ mode: 'unbekannt' }).mode, 'list');
});

// ── Struktur: kein innerHTML mit Fremdtext, kein tvEpgIndex ──

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Neuer Code: kein innerHTML, kein tvEpgIndex, kein decodeEntities', () => {
  for (const file of ['epg-view.js', 'epg-view-model.js']) {
    const src = read(file);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), `${file}: innerHTML verboten`);
    assert.ok(!/tvEpgIndex/.test(src), `${file}: kein Renderer-Datenweg`);
    assert.ok(!/decodeEntities/.test(src), `${file}: Main-Texte sind schon dekodiert`);
  }
});

test('Kanal-Schlüssel der Großfixture sind abfragbar', () => {
  assert.equal(model.epgChannelKey({ tvgId: channelId(0) }), 'sender001.de');
});
