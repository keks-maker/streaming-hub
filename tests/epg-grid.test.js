'use strict';

// Tests: lib/epg-grid.js (Etappe 3.1, EPG-Konzept §4 A-2) — reine Rasterlogik.
// TV-Tag-Tests laufen in Europe/Berlin (TZ vor der ersten Date-Nutzung gesetzt).
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTvId } = require('@streaming-hub/typed-core');
const grid = require('../lib/epg-grid.js');
const { foldText } = require('../lib/epg-text.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Lokale Zeit (Europe/Berlin) → ms
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

test('Zeitzone der Testumgebung ist Europe/Berlin', () => {
  assert.equal(new Date(2026, 6, 1, 12).getTimezoneOffset(), -120);
  assert.equal(new Date(2026, 0, 1, 12).getTimezoneOffset(), -60);
});

// ── Zeit <-> px ──

test('Zeit <-> px: px/min, Umkehrung, Slot-Block', () => {
  const origin = local(2026, 10, 5, 5, 0);
  assert.equal(grid.timeToX(origin + 60 * MIN, origin, 5), 300);
  assert.equal(grid.timeToX(origin - 10 * MIN, origin, 3), -30);
  assert.equal(grid.xToTime(300, origin, 5), origin + 60 * MIN);
  assert.deepEqual(grid.slotRect({ start: origin + 30 * MIN, stop: origin + 90 * MIN }, origin, 8), { left: 240, width: 480 });
  assert.equal(grid.slotRect({ start: origin, stop: origin - 1 }, origin, 8).width, 0);
  for (const ppm of [3, 5, 8]) {
    const t = origin + 137 * MIN;
    assert.equal(grid.xToTime(grid.timeToX(t, origin, ppm), origin, ppm), t);
  }
});

test('sichtbarer Bereich und Virtualisierungsfenster (±1 Viewport)', () => {
  const origin = local(2026, 10, 5, 5, 0);
  const vis = grid.visibleTimeRange({ scrollLeft: 600, viewportWidth: 900, originMs: origin, pxPerMin: 5 });
  assert.deepEqual(vis, { fromMs: origin + 120 * MIN, toMs: origin + 300 * MIN });

  const win = grid.virtualWindow({
    scrollLeft: 3000,
    scrollTop: 640,
    viewportWidth: 1000,
    viewportHeight: 600,
    rowHeight: 64,
    rowCount: 438,
    originMs: origin,
    pxPerMin: 5,
  });
  assert.equal(win.xFrom, 2000);
  assert.equal(win.xTo, 5000);
  assert.equal(win.fromMs, origin + 400 * MIN);
  assert.equal(win.toMs, origin + 1000 * MIN);
  assert.equal(win.rowStart, Math.floor(40 / 64));
  assert.equal(win.rowEnd, Math.ceil((640 + 600 + 600) / 64));

  // Ränder: nicht negativ, nicht über rowCount
  const edge = grid.virtualWindow({
    scrollLeft: 0, scrollTop: 0, viewportWidth: 1000, viewportHeight: 600, rowHeight: 64, rowCount: 5, originMs: origin, pxPerMin: 5,
  });
  assert.equal(edge.xFrom, 0);
  assert.equal(edge.rowStart, 0);
  assert.equal(edge.rowEnd, 5);
  const none = grid.virtualWindow({
    scrollLeft: 0, scrollTop: 0, viewportWidth: 1000, viewportHeight: 600, rowHeight: 64, rowCount: 0, originMs: origin, pxPerMin: 5,
  });
  assert.deepEqual([none.rowStart, none.rowEnd], [0, 0]);
});

test('slotsInWindow: Überlappung inkl. früher beginnender Slots, Grenzen exklusiv', () => {
  const t0 = local(2026, 10, 5, 18, 0);
  const slots = [];
  for (let i = 0; i < 100; i += 1) slots.push({ start: t0 + i * HOUR, stop: t0 + (i + 1) * HOUR, title: `S${i}` });
  slots.push({ start: t0 + 100 * HOUR, stop: t0 + 130 * HOUR, title: 'lang' });
  const got = grid.slotsInWindow(slots, t0 + 10 * HOUR + 30 * MIN, t0 + 13 * HOUR);
  assert.deepEqual(got.map(s => s.title), ['S10', 'S11', 'S12']);
  assert.deepEqual(grid.slotsInWindow(slots, t0 + 10 * HOUR, t0 + 11 * HOUR).map(s => s.title), ['S10']);
  assert.deepEqual(grid.slotsInWindow(slots, t0 + 120 * HOUR, t0 + 121 * HOUR).map(s => s.title), ['lang']);
  assert.deepEqual(grid.slotsInWindow(slots, t0 - 5 * HOUR, t0), []);
  assert.deepEqual(grid.slotsInWindow([], t0, t0 + HOUR), []);
});

// ── Fortschritt ──

test('Fortschritt und "noch N min"', () => {
  const slot = { start: 1000 * MIN, stop: 1060 * MIN };
  assert.equal(grid.slotPhase(slot, 999 * MIN), 'future');
  assert.equal(grid.slotPhase(slot, 1000 * MIN), 'now');
  assert.equal(grid.slotPhase(slot, 1059 * MIN), 'now');
  assert.equal(grid.slotPhase(slot, 1060 * MIN), 'past');
  assert.equal(grid.slotProgress(slot, 900 * MIN), 0);
  assert.equal(grid.slotProgress(slot, 1015 * MIN), 0.25);
  assert.equal(grid.slotProgress(slot, 1100 * MIN), 1);
  assert.equal(grid.minutesLeft(slot, 1015 * MIN), 45);
  assert.equal(grid.minutesLeft(slot, 1015 * MIN + 1), 45);
  assert.equal(grid.minutesLeft(slot, 1059 * MIN + 59000), 1);
  assert.equal(grid.minutesLeft(slot, 999 * MIN), null);
  assert.equal(grid.minutesLeft(slot, 1060 * MIN), null);
});

// ── TV-Tag ──

test('TV-Tag: 05:00-Grenze, 01:00 gehört zum Vorabend', () => {
  const d = grid.tvDayOf(local(2026, 10, 3, 20, 15));
  assert.equal(d.key, '2026-10-03');
  assert.equal(d.startMs, local(2026, 10, 3, 5, 0));
  assert.equal(d.endMs, local(2026, 10, 4, 5, 0));
  assert.equal(d.weekday, 6); // Samstag... 3.10.2026 ist ein Samstag
  assert.equal(grid.tvDayOf(local(2026, 10, 4, 1, 0)).key, '2026-10-03');
  assert.equal(grid.tvDayOf(local(2026, 10, 4, 4, 59)).key, '2026-10-03');
  assert.equal(grid.tvDayOf(local(2026, 10, 4, 5, 0)).key, '2026-10-04');
  assert.equal(grid.tvDayStart(local(2026, 10, 4, 5, 0)), local(2026, 10, 4, 5, 0));
  assert.equal(grid.tvDayOf(local(2026, 1, 1, 2, 0)).key, '2025-12-31'); // Jahreswechsel
});

test('TV-Tag: Sommerzeit-Beginn (29.03.2026) hat 23 h, Umgebung 24 h', () => {
  const before = grid.tvDayOf(local(2026, 3, 28, 12, 0));
  const dst = grid.tvDayOf(local(2026, 3, 28, 23, 0));
  assert.equal(dst.key, '2026-03-28');
  assert.equal((dst.endMs - dst.startMs) / HOUR, 23);
  assert.equal(before.startMs, dst.startMs);
  // 03:30 am Umstellungstag (nach dem Sprung) liegt noch im Vortags-TV-Tag
  assert.equal(grid.tvDayOf(local(2026, 3, 29, 3, 30)).key, '2026-03-28');
  assert.equal(grid.tvDayOf(local(2026, 3, 29, 5, 0)).key, '2026-03-29');
  assert.equal(grid.tvDayOf(dst.endMs).startMs, dst.endMs);
  assert.equal((grid.tvDayOf(local(2026, 3, 27, 12, 0)).endMs - grid.tvDayOf(local(2026, 3, 27, 12, 0)).startMs) / HOUR, 24);
  assert.equal((grid.tvDayOf(local(2026, 3, 29, 12, 0)).endMs - grid.tvDayOf(local(2026, 3, 29, 12, 0)).startMs) / HOUR, 24);
});

test('TV-Tag: Sommerzeit-Ende (25.10.2026) hat 25 h', () => {
  const day = grid.tvDayOf(local(2026, 10, 24, 22, 0));
  assert.equal(day.key, '2026-10-24');
  assert.equal((day.endMs - day.startMs) / HOUR, 25);
  // doppelte Stunde 02:00–03:00 gehört beide Male zum Vortags-TV-Tag
  const first = Date.parse('2026-10-25T02:30:00+02:00');
  const second = Date.parse('2026-10-25T02:30:00+01:00');
  assert.equal(second - first, HOUR);
  assert.equal(grid.tvDayOf(first).key, '2026-10-24');
  assert.equal(grid.tvDayOf(second).key, '2026-10-24');
  assert.equal(grid.tvDayOf(day.endMs).key, '2026-10-25');
  const next = grid.tvDayOf(local(2026, 10, 25, 12, 0));
  assert.equal((next.endMs - next.startMs) / HOUR, 24);
});

test('tvDayTime: Uhrzeit innerhalb des TV-Tags (hour < 5 = nach Mitternacht), auch am Umstellungstag', () => {
  const day = grid.tvDayOf(local(2026, 10, 3, 12, 0));
  assert.equal(grid.tvDayTime(day.startMs, 20, 15), local(2026, 10, 3, 20, 15));
  assert.equal(grid.tvDayTime(day.startMs, 22, 0), local(2026, 10, 3, 22, 0));
  assert.equal(grid.tvDayTime(day.startMs, 1, 0), local(2026, 10, 4, 1, 0));
  const dst = grid.tvDayOf(local(2026, 10, 24, 12, 0));
  assert.equal(grid.tvDayTime(dst.startMs, 20, 15), local(2026, 10, 24, 20, 15));
  assert.equal(grid.tvDayTime(dst.startMs, 4, 0), local(2026, 10, 25, 4, 0));
});

test('Sendung über Mitternacht und über 05:00: TV-Tage des Slots', () => {
  // 23:30–00:30: ein TV-Tag (Vorabend)
  const night = { start: local(2026, 10, 3, 23, 30), stop: local(2026, 10, 4, 0, 30) };
  assert.deepEqual(grid.slotTvDays(night).map(d => d.key), ['2026-10-03']);
  // 04:30–05:30: berührt zwei TV-Tage, Heimat ist der erste
  const dawn = { start: local(2026, 10, 4, 4, 30), stop: local(2026, 10, 4, 5, 30) };
  assert.deepEqual(grid.slotTvDays(dawn).map(d => d.key), ['2026-10-03', '2026-10-04']);
  // endet exakt um 05:00: nur der erste
  const upTo5 = { start: local(2026, 10, 4, 4, 0), stop: local(2026, 10, 4, 5, 0) };
  assert.deepEqual(grid.slotTvDays(upTo5).map(d => d.key), ['2026-10-03']);
  // Nachtsendung über die Sommerzeit-Umstellung (28.03. 23:00 – 29.03. 06:00)
  const dstNight = { start: local(2026, 3, 28, 23, 0), stop: local(2026, 3, 29, 6, 0) };
  assert.deepEqual(grid.slotTvDays(dstNight).map(d => d.key), ['2026-03-28', '2026-03-29']);
});

test('Tagesleisten-Chips: je TV-Tag, Offsets relativ zu jetzt, Umstellungstage vollständig', () => {
  const now = local(2026, 10, 3, 20, 15);
  const chips = grid.dayChips({ fromMs: local(2026, 10, 2, 8, 0), toMs: local(2026, 10, 6, 0, 0), nowMs: now });
  assert.deepEqual(chips.map(c => c.key), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(chips.map(c => c.offset), [-1, 0, 1, 2]);
  assert.deepEqual(chips.map(c => c.isToday), [false, true, false, false]);
  assert.equal(chips[0].isPast, true);
  assert.equal(chips[1].isPast, false);
  // Nach Mitternacht (01:00) ist "heute" noch der Vorabend
  const late = grid.dayChips({ fromMs: now, toMs: now + HOUR, nowMs: local(2026, 10, 4, 1, 0) });
  assert.equal(late[0].isToday, true);

  // Zehn Tage über die Zeitumstellung: lückenlos, jeder Tag beginnt, wo der vorige endet
  const span = grid.dayChips({ fromMs: local(2026, 10, 22, 12, 0), toMs: local(2026, 11, 2, 12, 0), nowMs: local(2026, 10, 22, 12, 0) });
  assert.equal(span.length, 12);
  for (let i = 1; i < span.length; i += 1) assert.equal(span[i].startMs, span[i - 1].endMs);
  assert.deepEqual(
    span.map(c => (c.endMs - c.startMs) / HOUR).filter(h => h !== 24),
    [25],
  );
  const march = grid.dayChips({ fromMs: local(2026, 3, 26, 12, 0), toMs: local(2026, 4, 1, 12, 0), nowMs: local(2026, 3, 26, 12, 0) });
  assert.deepEqual(march.map(c => (c.endMs - c.startMs) / HOUR).filter(h => h !== 24), [23]);
});

// ── Marker ──

const A_START = local(2026, 10, 5, 20, 15);
const iso = ms => new Date(ms).toISOString();
const slotsA = [
  { channelKey: 'DasErste.de', start: local(2026, 10, 5, 20, 0), stop: A_START, title: 'Tagesschau' },
  { channelKey: 'DasErste.de', start: A_START, stop: local(2026, 10, 5, 21, 0), title: 'Krimi' },
  { channelKey: 'DasErste.de', start: local(2026, 10, 5, 21, 0), stop: local(2026, 10, 5, 22, 0), title: 'Film' },
];
const entry = (over = {}) => ({
  id: 'sch_1',
  channelId: 'ch-erste',
  tvgId: 'DasErste.de@HD',
  state: 'scheduled',
  epgStart: iso(A_START),
  epgStop: iso(local(2026, 10, 5, 21, 0)),
  bufferBeforeSec: 120,
  bufferAfterSec: 300,
  merged: false,
  ...over,
});

test('Marker: Überlappung des Sendungsinhalts, Puffer zählen nicht, Grenzen berühren nicht', () => {
  const m = grid.matchMarkers(slotsA, [entry()], []);
  assert.equal(m[0], null); // endet exakt zum Start des Eintrags (Vorlauf 2 min zählt nicht)
  assert.deepEqual(m[1], { state: 'scheduled', ids: ['sch_1'] });
  assert.equal(m[2], null); // Nachlauf 5 min ragt nicht in den Folgeslot
});

test('Marker: nur state scheduled/recording', () => {
  for (const state of ['done', 'failed', 'missed', 'cancelled', 'unknown']) {
    assert.deepEqual(grid.matchMarkers(slotsA, [entry({ state })], []), [null, null, null], state);
  }
  assert.equal(grid.matchMarkers(slotsA, [entry({ state: 'recording' })], [])[1].state, 'recording');
});

test('Marker: Slip-Verschiebung folgt epgStart/epgStop des Eintrags', () => {
  // Sendung auf 20:25–21:10 verschoben: überdeckt Krimi (bis 21:00) und anteilig Film (ab 21:00)
  const slipped = entry({ epgStart: iso(local(2026, 10, 5, 20, 25)), epgStop: iso(local(2026, 10, 5, 21, 10)) });
  const m = grid.matchMarkers(slotsA, [slipped], []);
  assert.deepEqual(m.map(x => x && x.state), [null, 'scheduled', 'scheduled']);
  // Slots aus dem frischen Cache (ebenfalls verschoben) → genau ein Treffer
  const shifted = [{ channelKey: 'DasErste.de', start: local(2026, 10, 5, 20, 25), stop: local(2026, 10, 5, 21, 10) }];
  assert.deepEqual(grid.matchMarkers(shifted, [slipped], []), [{ state: 'scheduled', ids: ['sch_1'] }]);
});

test('Marker: zusammengelegter Eintrag markiert alle überdeckten Slots', () => {
  const merged = entry({ merged: true, title: 'Krimi + Film', epgStart: iso(A_START), epgStop: iso(local(2026, 10, 5, 22, 0)) });
  const m = grid.matchMarkers(slotsA, [merged], []);
  assert.deepEqual(m.map(x => x && x.state), [null, 'scheduled', 'scheduled']);
});

test('Marker: gleicher Titel auf anderem Sender wird nicht markiert', () => {
  const other = [{ channelKey: 'ZDF.de', start: A_START, stop: local(2026, 10, 5, 21, 0), title: 'Krimi' }];
  assert.deepEqual(grid.matchMarkers(other, [entry()], []), [null]);
});

test('Marker: Kanalvergleich über normalisierte tvgId/channelId (wie Scheduler: tvgId || channelId)', () => {
  const noTvg = entry({ tvgId: '', channelId: 'DasErste.de@SD' });
  assert.equal(grid.matchMarkers(slotsA, [noTvg], [])[1].state, 'scheduled');
  const bySlotChannelId = [{ channelId: 'ch-erste', start: A_START, stop: local(2026, 10, 5, 21, 0) }];
  assert.equal(grid.matchMarkers(bySlotChannelId, [entry({ tvgId: '' })], [])[0].state, 'scheduled');
  assert.equal(grid.matchMarkers([{ ...slotsA[1], channelKey: 'daserste.de' }], [entry()], [])[0].state, 'scheduled');
  // Kanal ohne jede Kennung matcht nie
  assert.deepEqual(grid.matchMarkers([{ start: A_START, stop: A_START + HOUR }], [entry({ tvgId: '', channelId: '' })], []), [null]);
});

test('normalizeKey entspricht normalizeTvId aus typed-core', () => {
  for (const id of ['ard@hdr.de', 'DasErste.de@HD', 'ZDF.de', 'a@b@c.de', '  X.de ', '', 'plain']) {
    assert.equal(grid.normalizeKey(id), normalizeTvId(id), id);
  }
  assert.equal(grid.normalizeKey(undefined), '');
});

test('Marker: laufende manuelle Aufnahme aus recording:list', () => {
  const now = local(2026, 10, 5, 20, 30);
  const rec = { id: 'rec_1', channelId: 'ch-erste', status: 'recording', startedAt: iso(local(2026, 10, 5, 20, 20)) };
  const withId = slotsA.map(s => ({ ...s, channelId: 'ch-erste' }));
  const m = grid.matchMarkers(withId, [], [rec], now);
  assert.deepEqual(m.map(x => x && x.state), [null, 'recording', null]);
  assert.deepEqual(m[1].ids, ['rec_1']);
  // andere Status zählen nicht
  for (const status of ['completed', 'failed', 'aborted', 'remux-pending']) {
    assert.deepEqual(grid.matchMarkers(withId, [], [{ ...rec, status }], now), [null, null, null], status);
  }
  // anderer Kanal
  assert.deepEqual(grid.matchMarkers(withId, [], [{ ...rec, channelId: 'ch-zdf' }], now), [null, null, null]);
  // ohne nowMs: nur der Slot, der den Start enthält
  assert.deepEqual(grid.matchMarkers(withId, [], [rec]).map(x => x && x.state), [null, 'recording', null]);
  // Aufnahme läuft über die Sendungsgrenze → beide Slots, bis "jetzt"
  const across = grid.matchMarkers(withId, [], [rec], local(2026, 10, 5, 21, 5));
  assert.deepEqual(across.map(x => x && x.state), [null, 'recording', 'recording']);
});

test('Marker: recording gewinnt über scheduled; ungültige Eingaben sind harmlos', () => {
  const rec = { id: 'rec_9', channelId: 'DasErste.de', status: 'recording', startedAt: iso(local(2026, 10, 5, 20, 20)) };
  const m = grid.matchMarkers(slotsA, [entry()], [rec], local(2026, 10, 5, 20, 30));
  assert.equal(m[1].state, 'recording');
  assert.deepEqual(m[1].ids, ['rec_9']);
  assert.deepEqual(grid.matchMarkers(slotsA, null, undefined), [null, null, null]);
  assert.deepEqual(grid.matchMarkers(slotsA, [null, { state: 'scheduled', epgStart: 'x', epgStop: 'y', tvgId: 'DasErste.de' }], [{}]), [null, null, null]);
  assert.deepEqual(grid.matchMarkers(null, [], []), []);
});

// ── Faltung ──

test('Faltung: dieselbe Funktion in epg-grid und epg-text; Käse/kase/Kaese gleich', () => {
  assert.equal(grid.foldText, foldText);
  const folded = ['Käse', 'KÄSE', 'kase', 'Kaese', 'KAESE'].map(foldText);
  assert.deepEqual(new Set(folded), new Set(['kase']));
  assert.equal(foldText('Straße'), foldText('STRASSE'));
  assert.equal(foldText('  Tages   Schau '), 'tages schau');
  assert.equal(foldText('Crème brûlée'), 'creme brulee');
  assert.equal(foldText(null), '');
  assert.equal(foldText(42), '');
});
