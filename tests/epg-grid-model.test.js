'use strict';

// Tests: epg-grid-model.js (Etappe 3.3, T-B) — Raster-Modell: Achse, Zoom, Blockgeometrie,
// Ruler-Marken, Zeit-Buckets/Nachladen, Slot-Speicher, Zeitanker über Zoom und Moduswechsel.
// TV-Tag-Tests laufen in Europe/Berlin.
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const gm = require('../epg-grid-model.js');
const vm = require('../epg-view-model.js');
const grid = require('../lib/epg-grid.js');
const { generateChannelSlots } = require('./helpers/epg-large-fixture.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const NOW = local(2026, 10, 5, 20, 32);
const days = vm.planDays({ nowMs: NOW, coverageFromMs: NOW - 20 * HOUR, coverageToMs: NOW + 10 * 24 * HOUR });
const coverageToMs = NOW + 10 * 24 * HOUR;
const axis = gm.axisFor({ days, coverageToMs });

test('Konstanten: Zeilenhöhe 64, Senderspalte 150, Zoom 3/5/8 (Standard 5), Mindestbreite 28', () => {
  assert.equal(gm.ROW_HEIGHT, 64);
  assert.equal(gm.CHANNEL_COL_WIDTH, 150);
  assert.deepEqual(gm.ZOOMS, [3, 5, 8]);
  assert.equal(gm.DEFAULT_ZOOM, 5);
  assert.equal(gm.MIN_BLOCK_WIDTH, 28);
  assert.equal(gm.NOW_RATIO, 0.25);
  assert.equal(gm.isZoom(8), true);
  assert.equal(gm.isZoom(4), false);
  assert.equal(gm.isZoom('5'), false);
});

test('axisFor: vom Vortag (soweit Daten) bis coverageToMs; ohne Tage/Abdeckung null; begrenzt auf 14 Tage', () => {
  assert.equal(axis.originMs, days[0].startMs);
  assert.equal(days[0].label, 'Gestern');
  assert.equal(axis.endMs, coverageToMs);
  assert.equal(gm.axisFor({ days: [], coverageToMs }), null);
  assert.equal(gm.axisFor({ days, coverageToMs: null }), null);
  assert.equal(gm.axisFor({ days, coverageToMs: days[0].startMs }), null);
  assert.equal(gm.axisFor({ days, coverageToMs: days[0].startMs + 40 * 24 * HOUR }).endMs, days[0].startMs + gm.MAX_AXIS_MS);
  const noYesterday = vm.planDays({ nowMs: NOW, coverageFromMs: null, coverageToMs });
  assert.equal(gm.axisFor({ days: noYesterday, coverageToMs }).originMs, noYesterday[0].startMs);
});

test('Zeit ↔ px: Breite je Zoom, Umkehrung, scrollLeft nie negativ', () => {
  for (const zoom of gm.ZOOMS) {
    assert.equal(gm.axisWidth(axis, zoom), ((axis.endMs - axis.originMs) / MIN) * zoom);
    const t = axis.originMs + 123 * MIN;
    assert.equal(gm.timeForX(axis, gm.xForTime(axis, t, zoom), zoom), t);
  }
  assert.equal(gm.scrollLeftForTime(axis, axis.originMs - HOUR, 5), 0);
  assert.equal(gm.scrollLeftForTime(axis, axis.originMs + 60 * MIN, 5), 300);
});

test('scrollLeftForNow: „jetzt“ steht ein Viertel der Zeitflächenbreite vom linken Rand', () => {
  const viewportW = 1000;
  const left = gm.scrollLeftForNow(axis, NOW, 5, viewportW);
  assert.equal(Math.round(gm.xForTime(axis, NOW, 5) - left), 250);
  assert.equal(gm.scrollLeftForNow(axis, axis.originMs + MIN, 5, viewportW), 0);
});

test('Zoom hält den Zeitanker: gleiche Zeit am linken Rand bei 3, 5 und 8 px/min', () => {
  const anchor = local(2026, 10, 6, 21, 15);
  for (const from of gm.ZOOMS) {
    for (const to of gm.ZOOMS) {
      const left = gm.scrollLeftForTime(axis, anchor, from);
      const time = gm.timeForX(axis, left, from);
      const leftNew = gm.scrollLeftForTime(axis, time, to);
      assert.ok(Math.abs(gm.timeForX(axis, leftNew, to) - anchor) < MIN, `${from}→${to}`);
    }
  }
});

test('anchorFromScrollLeft: bleibt stehen, solange die Ansicht dort steht (kein Rundungsdrift beim Moduswechsel)', () => {
  const anchor = local(2026, 10, 6, 21, 15) + 17 * 1000;
  const left = gm.scrollLeftForTime(axis, anchor, 3);
  assert.equal(gm.anchorFromScrollLeft(anchor, left, axis, 3), anchor);
  assert.equal(gm.anchorFromScrollLeft(anchor, left + 1, axis, 3), anchor);
  const moved = gm.anchorFromScrollLeft(anchor, left + 600, axis, 3);
  assert.equal(moved, gm.timeForX(axis, left + 600, 3));
  assert.equal(gm.anchorFromScrollLeft(null, 300, axis, 5), gm.timeForX(axis, 300, 5));
});

test('dayKeyAtTime: Tag der Tagesleiste am linken Rand, sonst null (TV-Tag 05:00)', () => {
  assert.equal(gm.dayKeyAtTime(days, local(2026, 10, 5, 4, 59)), '2026-10-04');
  assert.equal(gm.dayKeyAtTime(days, local(2026, 10, 5, 5, 0)), '2026-10-05');
  assert.equal(gm.dayKeyAtTime(days, local(2026, 10, 6, 1, 0)), '2026-10-05');
  assert.equal(gm.dayKeyAtTime(days, local(2026, 12, 24, 12, 0)), null);
});

test('blockGeometry: Lücke, Mindestbreite 28 px (schmal = nur Farbfläche), Breite nie unter 2', () => {
  const start = axis.originMs + 60 * MIN;
  const long = gm.blockGeometry({ start, stop: start + 60 * MIN }, axis, 5);
  assert.deepEqual(long, { left: 300, width: 298, narrow: false });
  const edge = gm.blockGeometry({ start, stop: start + 6 * MIN }, axis, 5); // 30 px − 2 = 28
  assert.equal(edge.width, 28);
  assert.equal(edge.narrow, false);
  const narrow = gm.blockGeometry({ start, stop: start + 5 * MIN }, axis, 5); // 25 − 2 = 23
  assert.equal(narrow.narrow, true);
  assert.equal(gm.blockGeometry({ start, stop: start }, axis, 5).width, 2);
  // Zoom verändert die Schmalheit: 10 min = 30 px bei 3, 80 px bei 8
  assert.equal(gm.blockGeometry({ start, stop: start + 9 * MIN }, axis, 3).narrow, true);
  assert.equal(gm.blockGeometry({ start, stop: start + 9 * MIN }, axis, 8).narrow, false);
});

test('blockTooltip: voller Titel, Zeit, Dauer und (falls vorhanden) Genre als Text', () => {
  const row = { title: 'Ein sehr langer Titel einer Sendung', start: local(2026, 10, 5, 20, 15), stop: local(2026, 10, 5, 21, 0) };
  assert.equal(gm.blockTooltip(row, vm.clock), 'Ein sehr langer Titel einer Sendung\n20:15–21:00 · 45 min');
  assert.match(gm.blockTooltip({ ...row, title: '' }, vm.clock), /^\(ohne Titel\)/);
  assert.equal(gm.blockTooltip({ ...row, genre: 'film' }, vm.clock), 'Ein sehr langer Titel einer Sendung\n20:15–21:00 · 45 min · Genre: Film');
  assert.equal(gm.blockTooltip({ ...row, genre: 'unbekannt' }, vm.clock), 'Ein sehr langer Titel einer Sendung\n20:15–21:00 · 45 min');
});

test('gridRowsFor: nur Sender mit EPG in der Reihenfolge der Auswahl', () => {
  const entries = ['a.de', 'b.de', 'c.de'].map(key => ({ key, channel: { id: key } }));
  assert.deepEqual(gm.gridRowsFor(entries, new Set(['c.de', 'a.de'])).map(e => e.key), ['a.de', 'c.de']);
  assert.deepEqual(gm.gridRowsFor(entries, new Set()), []);
  assert.deepEqual(gm.gridRowsFor(null, new Set(['a.de'])), []);
});

test('rulerMarks: Stundenmarken ohne Tagesbeginn, Tagesgrenzen 05:00 beschriftet', () => {
  const marks = gm.rulerMarks(axis, 5);
  assert.equal(marks.days[0].label, 'So 04.10. · 05:00');
  assert.equal(marks.days[1].label, 'Mo 05.10. · 05:00');
  assert.equal(marks.days[0].left, 0);
  assert.equal(marks.days[1].left, gm.xForTime(axis, local(2026, 10, 5, 5, 0), 5));
  assert.ok(marks.hours.every(m => new Date(m.ms).getHours() !== grid.TV_DAY_START_HOUR));
  assert.equal(marks.hours[0].label, '06:00');
  assert.ok(marks.hours.every(m => /^\d\d:00$/.test(m.label)));
  // ~ 24 Marken je Tag minus den Tagesbeginn
  const perDay = marks.hours.length / marks.days.length;
  assert.ok(perDay > 22 && perDay < 24.5, `Marken je Tag: ${perDay}`);
});

test('rulerMarks: Sommerzeitumstellung (25-h-Tag): wiederholte Stunde 02:00 wird nur einmal beschriftet', () => {
  const dayList = vm.planDays({ nowMs: local(2026, 10, 24, 12, 0), coverageFromMs: null, coverageToMs: local(2026, 11, 5, 0, 0) });
  const ax = gm.axisFor({ days: dayList, coverageToMs: dayList[0].endMs });
  const marks = gm.rulerMarks(ax, 5);
  assert.equal(marks.days.length, 1);
  assert.equal(marks.hours.length, 23); // 25 h − Tagesbeginn − doppelt vorkommende Stunde
  assert.equal(new Set(marks.hours.map(m => m.label)).size, 23);
});

test('bucketsFor/neededFetches: nur fehlende (Bucket, Kanal)-Paare, höchstens 100 Kanäle je Abruf, auf die Achse begrenzt', () => {
  const from = axis.originMs + 7 * HOUR;
  const to = from + 13 * HOUR;
  const buckets = gm.bucketsFor(from, to, axis);
  assert.ok(buckets.length >= 3 && buckets.length <= 4);
  assert.ok(buckets[0] <= from && buckets[buckets.length - 1] < to);
  assert.deepEqual(gm.bucketsFor(axis.endMs + HOUR, axis.endMs + 2 * HOUR, axis), []);
  assert.ok(gm.bucketsFor(axis.originMs - 30 * HOUR, axis.originMs + HOUR, axis).every(b => b + gm.BUCKET_MS > axis.originMs));
  const keys = Array.from({ length: 250 }, (_, i) => `k${i}`);
  const loaded = new Set();
  const first = gm.neededFetches({ fromMs: from, toMs: to, axis, keys, loaded });
  assert.equal(first.length, buckets.length * 3); // 100 + 100 + 50 je Bucket
  assert.ok(first.every(c => c.keys.length <= 100));
  assert.equal(first[0].toMs - first[0].fromMs, gm.BUCKET_MS);
  for (const call of first) for (const key of call.keys) loaded.add(gm.loadedKey(call.bucket, key));
  assert.deepEqual(gm.neededFetches({ fromMs: from, toMs: to, axis, keys, loaded }), []);
  // neue Zeilen nach vertikalem Scrollen: nur die neuen Kanäle
  const more = gm.neededFetches({ fromMs: from, toMs: to, axis, keys: [...keys, 'neu'], loaded });
  assert.equal(more.length, buckets.length);
  assert.deepEqual(more[0].keys, ['neu']);
});

test('createSlotStore: dedupliziert über Bucket-Grenzen, sortiert, Fenster inkl. hineinragender Sendungen', () => {
  const store = gm.createSlotStore();
  const entry = { key: 'a.de', channel: { id: 'a.de', name: 'A' } };
  const t = local(2026, 10, 5, 20, 0);
  const slots = [
    { start: t + 2 * HOUR, stop: t + 3 * HOUR, title: 'C' },
    { start: t, stop: t + HOUR, title: 'A' },
    { start: t + HOUR, stop: t + 2 * HOUR, title: 'B' },
  ];
  store.ingest(entry, slots);
  store.ingest(entry, [slots[1], { start: NaN, stop: 1, title: 'kaputt' }, null]); // zweiter Abruf, gleiche Sendung
  const all = store.window('a.de', t - HOUR, t + 4 * HOUR);
  assert.deepEqual(all.map(r => r.title), ['A', 'B', 'C']);
  assert.equal(all[0].id, `a.de|${t}`);
  assert.equal(all[0].channel, entry.channel);
  assert.equal(all[0].night, false);
  assert.deepEqual(store.window('a.de', t + 30 * MIN, t + 31 * MIN).map(r => r.title), ['A']); // hineinragend
  assert.deepEqual(store.window('x.de', 0, 1e15), []);
  assert.equal(store.window('a.de', t + 3 * HOUR, t + 4 * HOUR).length, 0);
  store.ingest(entry, [{ start: local(2026, 10, 6, 1, 0), stop: local(2026, 10, 6, 2, 0), title: 'Nacht', desc: 'ignoriert' }]);
  assert.equal(store.window('a.de', local(2026, 10, 6, 0, 0), local(2026, 10, 6, 3, 0))[0].night, true);
  store.loaded.add('x');
  store.clear();
  assert.equal(store.loaded.size, 0);
  assert.deepEqual(store.window('a.de', 0, 1e15), []);
});

test('Zeilenobjekte des Rasters und der Liste teilen die ID-Form (Auswahl gilt in beiden Modi)', () => {
  const start = local(2026, 10, 5, 21, 0);
  const slot = { start, stop: start + HOUR, title: 'Film' };
  const entry = { key: 'ard.de', channel: { id: 'ard.de', name: 'ARD', tvgId: 'ard.de' } };
  const store = gm.createSlotStore();
  store.ingest(entry, [slot]);
  const gridRow = store.window('ard.de', start, start + 1)[0];
  const listRow = vm.buildDayRows(days.find(d => d.isToday), [{ channelKey: 'ard.de', slots: [slot] }], new Map([['ard.de', entry.channel]]))[0];
  assert.equal(gridRow.id, listRow.id);
  assert.deepEqual(vm.markerSlot(gridRow), vm.markerSlot(listRow));
  // und die Marker-Zuordnung greift auf Raster-Zeilen
  const schedules = [{ id: 'sch_1', state: 'scheduled', channelId: 'ard.de', tvgId: 'ard.de', epgStart: new Date(start).toISOString(), epgStop: new Date(start + HOUR).toISOString() }];
  assert.deepEqual(grid.matchMarkers([vm.markerSlot(gridRow)], schedules, [], NOW), [{ state: 'scheduled', ids: ['sch_1'] }]);
});

test('P9 im Raster: Blöcke mehr als 8 Tage voraus sind nicht planbar (Hinweis, deaktiviert), davor planbar', () => {
  // Achse reicht bis ~10 Tage; erst Blöcke hinter jetzt+8 Tage lösen den Hinweis aus
  const store = gm.createSlotStore();
  const entry = { key: 'a.de', channel: { id: 'a.de', name: 'A' } };
  store.ingest(entry, [
    { start: NOW + 7 * 24 * HOUR, stop: NOW + 7 * 24 * HOUR + HOUR, title: 'nah' },
    { start: NOW + 9 * 24 * HOUR, stop: NOW + 9 * 24 * HOUR + HOUR, title: 'fern' },
  ]);
  const [near, far] = store.window('a.de', NOW, NOW + 10 * 24 * HOUR);
  assert.equal(vm.toggleState({ row: near, marker: null, nowMs: NOW }).disabled, false);
  const state = vm.toggleState({ row: far, marker: null, nowMs: NOW });
  assert.equal(state.disabled, true);
  assert.equal(state.hint, 'Planung nur bis 8 Tage im Voraus');
  assert.ok(far.start < axis.endMs); // der Block liegt im Raster
});

test('Zoom im Ansichtszustand: Standard 5, nur 3/5/8, Moduswechsel ändert den Zoom nicht', () => {
  const state = vm.createViewState();
  assert.equal(state.zoom, 5);
  assert.equal(state.setZoom(8), true);
  assert.equal(state.setZoom(4), false);
  assert.equal(state.zoom, 8);
  state.setMode('grid');
  state.setMode('list');
  assert.equal(state.zoom, 8);
  assert.equal(vm.createViewState({ zoom: 3 }).zoom, 3);
  assert.equal(vm.createViewState({ zoom: 7 }).zoom, 5);
});

test('Großfixture 438 Kanäle × 10 Tage: Rasterfenster bleibt klein, Nachladen in Buckets zu ≤ 100 Kanälen', () => {
  const startMs = local(2026, 10, 4, 5, 0);
  const slotMap = generateChannelSlots({ channels: 438, days: 10, startMs, seed: 5 });
  const entries = [...slotMap.keys()].map(key => ({ key, channel: { id: key, name: key } }));
  const ax = gm.axisFor({ days, coverageToMs: startMs + 10 * 24 * HOUR });
  const store = gm.createSlotStore();
  const win = grid.virtualWindow({
    scrollLeft: gm.scrollLeftForNow(ax, NOW, 5, 1130),
    scrollTop: 0,
    viewportWidth: 1130,
    viewportHeight: 700,
    rowHeight: gm.ROW_HEIGHT,
    rowCount: entries.length,
    originMs: ax.originMs,
    pxPerMin: 5,
    overscan: 1,
  });
  assert.ok(win.rowEnd - win.rowStart < 40, `Zeilen im Fenster: ${win.rowEnd - win.rowStart}`);
  const keys = entries.slice(win.rowStart, win.rowEnd).map(e => e.key);
  const calls = gm.neededFetches({ fromMs: win.fromMs, toMs: win.toMs, axis: ax, keys, loaded: store.loaded });
  assert.ok(calls.length <= 5);
  for (const call of calls) {
    for (const entry of entries.filter(e => call.keys.includes(e.key))) store.ingest(entry, slotMap.get(entry.key).filter(s => s.start < call.toMs && s.stop > call.fromMs));
  }
  let blocks = 0;
  for (const key of keys) blocks += store.window(key, win.fromMs, win.toMs).length;
  assert.ok(blocks > 0 && blocks < 1200, `Blöcke im Fenster: ${blocks}`);
});

test('Slot-Speicher übernimmt das schlanke Genre (nur bekannte Gruppen), ohne Genre bleibt es leer', () => {
  const store = gm.createSlotStore();
  const entry = { key: 'a.de', channel: { id: 'a.de', name: 'A' } };
  const t = local(2026, 10, 5, 20, 0);
  store.ingest(entry, [
    { start: t, stop: t + HOUR, title: 'A', genre: 'film' },
    { start: t + HOUR, stop: t + 2 * HOUR, title: 'B', genre: '' },
    { start: t + 2 * HOUR, stop: t + 3 * HOUR, title: 'C', genre: '<img>' },
    { start: t + 3 * HOUR, stop: t + 4 * HOUR, title: 'D' },
  ]);
  assert.deepEqual(store.window('a.de', t, t + 4 * HOUR).map(r => r.genre), ['film', '', '', '']);
});

test('channelBadge: Kürzel aus Wortanfängen oder den ersten Buchstaben, stabiler Farbton', () => {
  assert.equal(gm.channelBadge('Das Erste HD').abbr, 'DEH');
  assert.equal(gm.channelBadge('ZDF').abbr, 'ZDF');
  assert.equal(gm.channelBadge('arte').abbr, 'ART');
  assert.equal(gm.channelBadge('rbb Fernsehen Brandenburg').abbr, 'RFB');
  assert.equal(gm.channelBadge('').abbr, '?');
  assert.equal(gm.channelBadge('ZDF').hue, gm.channelBadge('ZDF').hue);
  assert.ok(gm.channelBadge('RTL').hue >= 0 && gm.channelBadge('RTL').hue < 360);
});
