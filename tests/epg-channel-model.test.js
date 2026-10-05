'use strict';

// Tests: epg-channel-model.js (Etappe 3.4) — DOM-freies Zustandsmodell der Kanalansicht:
// 7 TV-Tage, Tagesgruppierung (Nachtsendungen, Mitternacht, Zeitumstellung), Slot-Status
// (läuft/vorbei/zukünftig/> 8 Tage), Kennzeichnung, Anzeigezustände, Zustandserhalt beim
// Wechsel Herkunft → Kanalansicht → zurück. TV-Tag-Tests laufen in Europe/Berlin.
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const channel = require('../epg-channel-model.js');
const viewModel = require('../epg-view-model.js');
const grid = require('../lib/epg-grid.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

// Mo 05.10.2026 20:32 (Europe/Berlin)
const NOW = local(2026, 10, 5, 20, 32);
const KEY = 'DasErste.de';
const CH = { id: 'ch-erste', name: 'Das Erste', tvgId: KEY, logo: 'https://logo.example/erste.png' };

const slot = (start, stop, title = 'X', genre = '') => ({ start, stop, title, genre });

// ── Tage ──

test('channelDays: 7 TV-Tage ab heute (05:00–05:00), Beschriftung, Cache-Ende', () => {
  const days = channel.channelDays({ nowMs: NOW, coverageToMs: NOW + 10 * DAY });
  assert.equal(days.length, 7);
  assert.deepEqual(
    days.map(d => d.label),
    ['Heute', 'Morgen', 'Mi 7.10.', 'Do 8.10.', 'Fr 9.10.', 'Sa 10.10.', 'So 11.10.'],
  );
  assert.equal(days[0].key, '2026-10-05');
  assert.equal(days[0].isToday, true);
  assert.equal(days[0].heading, 'Heute · Mo 05.10.');
  assert.equal(days[0].startMs, local(2026, 10, 5, 5));
  assert.equal(days[6].endMs, local(2026, 10, 12, 5));
  assert.ok(days.every(d => !d.beyondCache));
  // Cache endet nach 3 Tagen: spätere Tage bleiben, sind aber als „hinter dem Cache“ gekennzeichnet
  const short = channel.channelDays({ nowMs: NOW, coverageToMs: local(2026, 10, 7, 12) });
  assert.deepEqual(short.map(d => d.beyondCache), [false, false, false, true, true, true, true]);
  // ohne Abdeckung: alle hinter dem Cache
  assert.ok(channel.channelDays({ nowMs: NOW, coverageToMs: null }).every(d => d.beyondCache));
  assert.deepEqual(channel.channelDays({ nowMs: NaN, coverageToMs: null }), []);
});

test('channelDays: nach Mitternacht (vor 05:00) ist der heutige TV-Tag noch der Vorabend', () => {
  const nowMs = local(2026, 10, 6, 1, 30); // Di 01:30 → TV-Tag Mo 05.10.
  const days = channel.channelDays({ nowMs, coverageToMs: nowMs + 10 * DAY });
  assert.equal(days[0].key, '2026-10-05');
  assert.equal(days[0].label, 'Heute');
  assert.equal(days[1].label, 'Morgen');
  // und genau um 05:00 wechselt „Heute“
  const at5 = channel.channelDays({ nowMs: local(2026, 10, 6, 5, 0), coverageToMs: null });
  assert.equal(at5[0].key, '2026-10-06');
});

test('channelDays: Sommerzeitumstellung — lückenlos, 7 Tage, Herbst 25 h und Frühjahr 23 h', () => {
  // Herbst: Sa 24.10. 05:00 bis So 25.10. 05:00 hat 25 Stunden (Umstellung 03:00 → 02:00)
  const autumn = channel.channelDays({ nowMs: local(2026, 10, 22, 20, 0), coverageToMs: null });
  assert.equal(autumn.length, 7);
  assert.deepEqual(autumn.map(d => d.key), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
  for (let i = 0; i < autumn.length - 1; i += 1) assert.equal(autumn[i].endMs, autumn[i + 1].startMs, `lückenlos ${i}`);
  const lengths = autumn.map(d => (d.endMs - d.startMs) / HOUR);
  assert.deepEqual(lengths, [24, 24, 25, 24, 24, 24, 24]);
  assert.ok(autumn.every(d => new Date(d.startMs).getHours() === 5));
  // Frühjahr: Sa 28.03. 05:00 bis So 29.03. 05:00 hat 23 Stunden
  const spring = channel.channelDays({ nowMs: local(2026, 3, 26, 12, 0), coverageToMs: null });
  assert.deepEqual(spring.map(d => (d.endMs - d.startMs) / HOUR), [24, 24, 23, 24, 24, 24, 24]);
  for (let i = 0; i < spring.length - 1; i += 1) assert.equal(spring[i].endMs, spring[i + 1].startMs);
});

test('channelDays extended: Tage 8–14 nur soweit der Cache reicht; hasMoreDays', () => {
  const coverageToMs = NOW + 9 * DAY + HOUR;
  assert.equal(channel.hasMoreDays({ nowMs: NOW, coverageToMs }), true);
  assert.equal(channel.hasMoreDays({ nowMs: NOW, coverageToMs: NOW + 6 * DAY }), false);
  assert.equal(channel.hasMoreDays({ nowMs: NOW, coverageToMs: null }), false);
  const ext = channel.channelDays({ nowMs: NOW, coverageToMs, extended: true });
  assert.ok(ext.length > 7 && ext.length <= channel.MAX_EXTENDED_DAYS);
  assert.ok(ext[ext.length - 1].startMs < coverageToMs, 'letzter Tag beginnt vor dem Cache-Ende');
  assert.ok(ext.slice(0, 7).every(d => !d.beyondCache));
  // sehr langer Cache: gedeckelt
  const huge = channel.channelDays({ nowMs: NOW, coverageToMs: NOW + 60 * DAY, extended: true });
  assert.equal(huge.length, channel.MAX_EXTENDED_DAYS);
  // ohne extended bleibt es bei 7
  assert.equal(channel.channelDays({ nowMs: NOW, coverageToMs, extended: false }).length, 7);
});

test('channelRange: ein Aufruf über alle Tage', () => {
  const days = channel.channelDays({ nowMs: NOW, coverageToMs: NOW + 10 * DAY });
  assert.deepEqual(channel.channelRange(days), { fromMs: local(2026, 10, 5, 5), toMs: local(2026, 10, 12, 5) });
  assert.equal(channel.channelRange([]), null);
});

// ── Gruppierung ──

function groupOf(slots, nowMs = NOW) {
  const days = channel.channelDays({ nowMs, coverageToMs: nowMs + 10 * DAY });
  return channel.groupByDay({ days, slots, channelKey: KEY, channel: CH });
}

test('groupByDay: Nachtsendung steht beim Vorabend mit night = true, 05:00 gehört zum neuen Tag', () => {
  const data = groupOf([
    slot(local(2026, 10, 5, 22, 0), local(2026, 10, 5, 23, 30), 'Abend'),
    slot(local(2026, 10, 6, 1, 0), local(2026, 10, 6, 2, 0), 'Nachtkrimi'), // Di 01:00 → Montag-TV-Tag
    slot(local(2026, 10, 6, 4, 59), local(2026, 10, 6, 5, 30), 'Frühestens'), // 04:59 → noch Montag
    slot(local(2026, 10, 6, 5, 0), local(2026, 10, 6, 6, 0), 'Frühstück'), // exakt 05:00 → Dienstag
  ]);
  const monday = data[0];
  assert.equal(monday.day.key, '2026-10-05');
  assert.deepEqual(monday.rows.map(r => r.title), ['Abend', 'Nachtkrimi', 'Frühestens']);
  assert.deepEqual(monday.rows.map(r => r.night), [false, true, true]);
  assert.deepEqual(data[1].rows.map(r => r.title), ['Frühstück']);
  assert.equal(data[1].rows[0].night, false);
  assert.equal(monday.empty, false);
  assert.equal(data[2].empty, true);
});

test('groupByDay: beim Öffnen noch laufende Sendung vom Vorabend-TV-Tag steht am Anfang des ersten Tages', () => {
  const nowMs = local(2026, 10, 5, 5, 10);
  const days = channel.channelDays({ nowMs, coverageToMs: nowMs + 10 * DAY });
  const data = channel.groupByDay({
    days,
    slots: [
      slot(local(2026, 10, 5, 3, 0), local(2026, 10, 5, 4, 40), 'Längst vorbei'),
      slot(local(2026, 10, 5, 4, 40), local(2026, 10, 5, 5, 30), 'Läuft noch'),
      slot(local(2026, 10, 5, 5, 30), local(2026, 10, 5, 6, 0), 'Danach'),
    ],
    channelKey: KEY,
    channel: CH,
  });
  assert.deepEqual(data[0].rows.map(r => r.title), ['Läuft noch', 'Danach']);
  assert.equal(data[0].rows[0].night, true);
  assert.equal(data[0].rows[0].dayKey, '2026-10-05');
  assert.equal(channel.highlights(data, nowMs).running.title, 'Läuft noch');
  assert.equal(channel.nowLine(data, nowMs).kind, 'running');
  // spätere Tage übernehmen nichts vom Vortag
  assert.equal(data[1].empty, true);
});

test('groupByDay: Mitternachts-Überlauf — eine Sendung 23:30–00:30 gehört zum Tag ihres Starts, nie doppelt', () => {
  const data = groupOf([slot(local(2026, 10, 5, 23, 30), local(2026, 10, 6, 0, 30), 'Spätfilm')]);
  assert.equal(data[0].rows.length, 1);
  assert.equal(channel.rowTotal(data), 1);
  assert.equal(data[0].rows[0].night, false);
});

test('groupByDay: Zeitumstellung — die doppelte Stunde 02:xx zählt zum Vorabend, ohne Doppelung oder Verlust', () => {
  const nowMs = local(2026, 10, 23, 20, 0);
  const days = channel.channelDays({ nowMs, coverageToMs: nowMs + 10 * DAY });
  // 02:30 CEST (= 00:30 UTC) und 02:30 CET (= 01:30 UTC) am So 25.10.2026
  const first = Date.UTC(2026, 9, 25, 0, 30);
  const second = Date.UTC(2026, 9, 25, 1, 30);
  const slots = [
    slot(first, first + HOUR / 2, 'Nacht CEST'),
    slot(second, second + HOUR / 2, 'Nacht CET'),
    slot(local(2026, 10, 25, 5, 0), local(2026, 10, 25, 6, 0), 'Morgen'),
  ];
  const data = channel.groupByDay({ days, slots, channelKey: KEY, channel: CH });
  const saturday = data.find(d => d.day.key === '2026-10-24');
  const sunday = data.find(d => d.day.key === '2026-10-25');
  assert.deepEqual(saturday.rows.map(r => r.title), ['Nacht CEST', 'Nacht CET']);
  assert.deepEqual(saturday.rows.map(r => r.night), [true, true]);
  assert.deepEqual(sunday.rows.map(r => r.title), ['Morgen']);
  assert.equal(channel.rowTotal(data), 3);
});

test('groupByDay: Duplikate, ungültige Slots, fremde Tage und Reihenfolge', () => {
  const data = groupOf([
    slot(local(2026, 10, 5, 21, 0), local(2026, 10, 5, 22, 0), 'B'),
    slot(local(2026, 10, 5, 20, 0), local(2026, 10, 5, 21, 0), 'A'),
    slot(local(2026, 10, 5, 20, 0), local(2026, 10, 5, 21, 0), 'A doppelt'),
    { start: 'x', stop: 1, title: 'kaputt' },
    null,
    slot(local(2026, 10, 3, 20, 0), local(2026, 10, 3, 21, 0), 'vor den 7 Tagen'),
    slot(local(2026, 10, 14, 20, 0), local(2026, 10, 14, 21, 0), 'nach den 7 Tagen'),
  ]);
  assert.deepEqual(data[0].rows.map(r => r.title), ['A', 'B']);
  assert.equal(channel.rowTotal(data), 2);
  assert.deepEqual(channel.groupByDay({ days: [], slots: [], channelKey: KEY, channel: CH }), []);
  assert.equal(channel.allRows(data).length, 2);
  // Zeilen sind dieselben Objekte wie in der Liste (gleiche id: Auswahl/Modal gemeinsam)
  assert.equal(data[0].rows[0].id, `${KEY}|${local(2026, 10, 5, 20, 0)}`);
  assert.equal(data[0].rows[0].channel, CH);
});

test('groupByDay: Genre wird bereinigt, Marker-Zuordnung über matchMarkers (geplant / laufend)', () => {
  const data = groupOf([
    slot(local(2026, 10, 5, 20, 15), local(2026, 10, 5, 21, 45), 'Tatort', 'film'),
    slot(local(2026, 10, 5, 21, 45), local(2026, 10, 5, 22, 15), 'Tagesthemen', 'unbekannt'),
    slot(local(2026, 10, 6, 20, 15), local(2026, 10, 6, 21, 45), 'Morgen-Film', 'film'),
  ]);
  const rows = channel.allRows(data);
  assert.deepEqual(rows.map(r => r.genre), ['film', '', 'film']);
  const iso = ms => new Date(ms).toISOString();
  const schedules = [
    { id: 'sch_1', state: 'scheduled', tvgId: KEY, channelId: 'ch-erste', epgStart: iso(rows[2].start), epgStop: iso(rows[2].stop) },
    { id: 'sch_2', state: 'recording', tvgId: KEY, channelId: 'ch-erste', epgStart: iso(rows[0].start), epgStop: iso(rows[0].stop) },
    { id: 'sch_3', state: 'cancelled', tvgId: KEY, channelId: 'ch-erste', epgStart: iso(rows[1].start), epgStop: iso(rows[1].stop) },
  ];
  const markers = grid.matchMarkers(rows.map(viewModel.markerSlot), schedules, [], NOW);
  assert.deepEqual(markers.map(m => m && m.state), ['recording', null, 'scheduled']);
});

// ── Status, Kennzeichnung ──

test('slotStatus: vorbei / läuft / zukünftig / mehr als 8 Tage voraus (Grenze exakt)', () => {
  const at = (start, stop) => ({ start, stop });
  assert.equal(channel.slotStatus(at(NOW - 2 * HOUR, NOW - HOUR), NOW), 'past');
  assert.equal(channel.slotStatus(at(NOW - 1, NOW + HOUR), NOW), 'now');
  assert.equal(channel.slotStatus(at(NOW, NOW + HOUR), NOW), 'now', 'Start = jetzt zählt als laufend');
  assert.equal(channel.slotStatus(at(NOW - HOUR, NOW), NOW), 'past', 'Ende = jetzt ist vorbei');
  assert.equal(channel.slotStatus(at(NOW + 1, NOW + HOUR), NOW), 'future');
  const limit = NOW + viewModel.PLAN_MAX_AHEAD_MS;
  assert.equal(channel.slotStatus(at(limit, limit + HOUR), NOW), 'future', 'genau 8 Tage voraus ist noch planbar');
  assert.equal(channel.slotStatus(at(limit + 1, limit + HOUR), NOW), 'too-far');
});

test('Toggle-Zustand der Kanalansicht ist der gemeinsame (viewModel.toggleState): > 8 Tage deaktiviert mit Hinweis', () => {
  const far = NOW + 9 * DAY;
  const row = { start: far, stop: far + HOUR };
  const toggle = viewModel.toggleState({ row, marker: null, nowMs: NOW });
  assert.equal(toggle.kind, 'record');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.hint, 'Planung nur bis 8 Tage im Voraus');
  assert.equal(channel.slotStatus(row, NOW), 'too-far');
  // geplant/laufend markiert: Abbrechen/Stoppen
  assert.equal(viewModel.toggleState({ row, marker: { state: 'scheduled', ids: ['sch_1'] }, nowMs: NOW }).kind, 'cancel');
  assert.equal(viewModel.toggleState({ row, marker: { state: 'recording', ids: ['rec_1'] }, nowMs: NOW }).kind, 'stop');
});

test('highlights/flagFor/nowLine: laufende und nächste Sendung, auch über Tagesgrenzen', () => {
  const data = groupOf([
    slot(local(2026, 10, 5, 20, 15), local(2026, 10, 5, 21, 45), 'Tatort'),
    slot(local(2026, 10, 5, 21, 45), local(2026, 10, 5, 22, 15), 'Tagesthemen'),
    slot(local(2026, 10, 5, 19, 0), local(2026, 10, 5, 20, 15), 'Vorher'),
  ]);
  const marks = channel.highlights(data, NOW);
  assert.equal(marks.running.title, 'Tatort');
  assert.equal(marks.next.title, 'Tagesthemen');
  const rows = channel.allRows(data);
  assert.deepEqual(rows.map(r => channel.flagFor(r, marks)), ['', 'now', 'next']);
  const line = channel.nowLine(data, NOW);
  assert.equal(line.kind, 'running');
  assert.equal(line.title, 'Tatort');
  assert.equal(line.suffix, ' · noch 73 min');
  // nach Sendungsende: nächste Sendung liegt morgen
  const late = local(2026, 10, 5, 23, 0);
  const tomorrow = groupOf([slot(local(2026, 10, 6, 6, 0), local(2026, 10, 6, 7, 0), 'Morgenmagazin')], late);
  assert.equal(channel.highlights(tomorrow, late).running, null);
  assert.equal(channel.nowLine(tomorrow, late).kind, 'next');
  assert.equal(channel.nowLine(tomorrow, late).suffix, ' · 06:00');
  assert.equal(channel.nowLine([], NOW).kind, 'none');
  assert.equal(channel.nowLine([], NOW).label, 'Gerade keine Sendung im EPG');
});

test('Kennzeichnung wandert mit der Zeit (30-s-Tick): nur die Flags ändern sich, nicht die Zeilen', () => {
  const data = groupOf([
    slot(local(2026, 10, 5, 20, 15), local(2026, 10, 5, 21, 45), 'Tatort'),
    slot(local(2026, 10, 5, 21, 45), local(2026, 10, 5, 22, 15), 'Tagesthemen'),
  ]);
  const sig = channel.dataSignature(data);
  const [a, b] = channel.allRows(data);
  const flagsAt = ms => {
    const marks = channel.highlights(data, ms);
    return [channel.flagFor(a, marks), channel.flagFor(b, marks)];
  };
  assert.deepEqual(flagsAt(NOW), ['now', 'next']);
  assert.deepEqual(flagsAt(local(2026, 10, 5, 21, 45)), ['', 'now']);
  assert.deepEqual(flagsAt(local(2026, 10, 5, 22, 15)), ['', '']);
  assert.equal(channel.dataSignature(data), sig, 'Signatur hängt nicht von der Uhr ab');
});

test('dataSignature: gleiche Daten → gleiche Signatur; Titel-, Zeit- oder Genre-Änderung → andere', () => {
  const base = [slot(local(2026, 10, 5, 20, 0), local(2026, 10, 5, 21, 0), 'A', 'film')];
  const sig = channel.dataSignature(groupOf(base));
  assert.equal(channel.dataSignature(groupOf(base.map(s => ({ ...s })))), sig);
  assert.notEqual(channel.dataSignature(groupOf([{ ...base[0], title: 'B' }])), sig);
  assert.notEqual(channel.dataSignature(groupOf([{ ...base[0], stop: base[0].stop + MIN }])), sig);
  assert.notEqual(channel.dataSignature(groupOf([{ ...base[0], genre: 'news' }])), sig);
});

// ── Scrollen ──

test('initialTarget: heute → laufende/nächste Sendung, anderer Tag → Tagesanfang, ohne Sendung → Tag', () => {
  const data = groupOf([
    slot(local(2026, 10, 5, 20, 15), local(2026, 10, 5, 21, 45), 'Tatort'),
    slot(local(2026, 10, 6, 6, 0), local(2026, 10, 6, 7, 0), 'Morgen'),
  ]);
  const today = '2026-10-05';
  const ids = channel.allRows(data).map(r => r.id);
  assert.deepEqual(channel.initialTarget({ dayData: data, dayKey: null, todayKey: today, nowMs: NOW }), { kind: 'row', rowId: ids[0] });
  assert.deepEqual(channel.initialTarget({ dayData: data, dayKey: today, todayKey: today, nowMs: NOW }), { kind: 'row', rowId: ids[0] });
  assert.deepEqual(channel.initialTarget({ dayData: data, dayKey: '2026-10-07', todayKey: today, nowMs: NOW }), { kind: 'day', dayKey: '2026-10-07' });
  // heute ist vorbei, nächste Sendung erst morgen → Tagesanfang von heute
  const late = local(2026, 10, 5, 23, 0);
  assert.deepEqual(channel.initialTarget({ dayData: data, dayKey: null, todayKey: today, nowMs: late }), { kind: 'day', dayKey: today });
  // unbekannter Tag fällt auf heute zurück
  assert.deepEqual(channel.initialTarget({ dayData: data, dayKey: '2030-01-01', todayKey: today, nowMs: late }), { kind: 'day', dayKey: today });
  assert.equal(channel.initialTarget({ dayData: [], dayKey: null, todayKey: today, nowMs: NOW }), null);
});

test('resolveActiveDay: folgt der Scrollposition, explizit gewählter Tag bleibt (Pin) bis zum Wegscrollen', () => {
  const tops = [
    { key: 'a', top: 0 },
    { key: 'b', top: 500 },
    { key: 'c', top: 1200 },
  ];
  assert.deepEqual(channel.resolveActiveDay(tops, 0, null), { key: 'a', pin: null });
  assert.deepEqual(channel.resolveActiveDay(tops, 498, null), { key: 'a', pin: null });
  assert.deepEqual(channel.resolveActiveDay(tops, 500, null), { key: 'b', pin: null });
  assert.deepEqual(channel.resolveActiveDay(tops, 5000, null), { key: 'c', pin: null });
  // Pin: Liste zu kurz → Position geklemmt, der gewählte Tab bleibt aktiv
  const pin = { key: 'c', top: 800 };
  assert.deepEqual(channel.resolveActiveDay(tops, 800, pin), { key: 'c', pin });
  assert.deepEqual(channel.resolveActiveDay(tops, 300, pin), { key: 'a', pin: null });
  assert.deepEqual(channel.resolveActiveDay([], 0, null), { key: null, pin: null });
});

// ── Anzeigezustand (M9) ──

test('deriveChannelState: Fehler → Quelle ohne EPG → lädt → Cache leer → kein Programm → bereit', () => {
  const source = { configured: true };
  const ok = { sources: [source], refreshing: false };
  const base = { status: ok, loadError: '', loading: false, rowCount: 5, hasCoverage: true, channelName: 'Das Erste' };
  assert.equal(channel.deriveChannelState(base).kind, 'ready');
  const err = channel.deriveChannelState({ ...base, loadError: 'IPC kaputt' });
  assert.deepEqual([err.kind, err.action, err.text], ['error', 'refresh', 'IPC kaputt']);
  const noSource = channel.deriveChannelState({ ...base, status: { sources: [{ configured: false }] } });
  assert.deepEqual([noSource.kind, noSource.action], ['no-source', null]);
  assert.equal(channel.deriveChannelState({ ...base, loading: true }).kind, 'loading');
  assert.equal(channel.deriveChannelState({ ...base, status: { sources: [source], refreshing: true }, hasCoverage: false }).kind, 'loading');
  const empty = channel.deriveChannelState({ ...base, hasCoverage: false, status: { sources: [{ configured: true, lastError: 'HTTP 404' }] } });
  assert.deepEqual([empty.kind, empty.action], ['empty', 'refresh']);
  assert.match(empty.text, /HTTP 404/);
  const none = channel.deriveChannelState({ ...base, rowCount: 0 });
  assert.deepEqual([none.kind, none.action], ['no-programmes', 'refresh']);
  assert.match(none.text, /Das Erste/);
  // Fehler hat Vorrang vor allem
  assert.equal(channel.deriveChannelState({ ...base, loadError: 'x', loading: true, rowCount: 0 }).kind, 'error');
});

test('emptyDayNote: Tag hinter dem Cache vs. Lücke im Cache', () => {
  assert.match(channel.emptyDayNote({ beyondCache: true }), /noch kein EPG/);
  assert.match(channel.emptyDayNote({ beyondCache: false }), /keine Sendungen im Cache/);
});

// ── Ansichtszustand ──

test('channelMeta: Name/Logo, Fallback auf den Schlüssel, ungültige Sender ohne Schlüssel', () => {
  assert.deepEqual(channel.channelMeta(CH), { key: KEY, name: 'Das Erste', logo: 'https://logo.example/erste.png' });
  assert.deepEqual(channel.channelMeta({ tvgId: 'x.de' }), { key: 'x.de', name: 'x.de', logo: '' });
  assert.equal(channel.channelMeta({ name: 'ohne tvgId' }).key, '');
  assert.equal(channel.channelMeta(null).key, '');
});

test('Zustandserhalt: Liste → Kanalansicht → zurück liefert den Herkunftszustand unverändert', () => {
  const view = viewModel.createViewState({ mode: 'list', dayKey: '2026-10-07', anchorMs: local(2026, 10, 7, 20, 15), selectedRowId: `${KEY}|1`, zoom: 8 });
  const state = channel.createChannelState();
  assert.equal(state.active, false);
  const snapshot = { ...view.snapshot(), listScrollTop: 1234, gridScroll: { left: 10, top: 20 }, returnTo: { type: 'list-row', rowId: `${KEY}|1` } };
  assert.equal(state.enter(CH, snapshot), true);
  assert.equal(state.active, true);
  assert.equal(state.key, KEY);
  assert.equal(state.meta.name, 'Das Erste');
  assert.equal(state.dayKey, null);
  assert.equal(state.extended, false);
  // Arbeit in der Kanalansicht ändert den Herkunftszustand nicht
  state.setDay('2026-10-09');
  state.setExtended(true);
  assert.equal(view.dayKey, '2026-10-07');
  assert.equal(view.mode, 'list');
  const back = state.leave();
  assert.deepEqual(back, snapshot);
  assert.equal(state.active, false);
  assert.equal(state.key, null);
  assert.equal(state.dayKey, null);
  assert.equal(state.extended, false, 'jeder Einstieg beginnt mit 7 Tagen');
  assert.equal(state.origin, null);
  assert.equal(state.leave(), null);
});

test('Zustandserhalt: Raster-Herkunft (Modus, Zoom, Zeitanker, Scroll) und Wiedereintritt behält den ersten Snapshot', () => {
  const view = viewModel.createViewState({ mode: 'grid', zoom: 3, anchorMs: NOW, dayKey: '2026-10-05' });
  const state = channel.createChannelState();
  const first = { ...view.snapshot(), gridScroll: { left: 4000, top: 128 }, listScrollTop: 0, returnTo: { type: 'grid-channel', key: KEY } };
  state.enter(CH, first);
  // zweiter Einstieg (Modal-Link innerhalb der Kanalansicht): Herkunft bleibt der erste Snapshot
  assert.equal(state.enter(CH, { mode: 'list' }), true);
  const back = state.leave();
  assert.equal(back.mode, 'grid');
  assert.equal(back.zoom, 3);
  assert.equal(back.anchorMs, NOW);
  assert.deepEqual(back.gridScroll, { left: 4000, top: 128 });
  assert.deepEqual(back.returnTo, { type: 'grid-channel', key: KEY });
});

test('enter ohne EPG-Schlüssel scheitert und ändert nichts', () => {
  const state = channel.createChannelState();
  assert.equal(state.enter({ name: 'ohne Schlüssel' }, {}), false);
  assert.equal(state.active, false);
  assert.equal(state.enter(null, {}), false);
});

test('CHANNEL_DAYS entspricht P8 (7 TV-Tage) und der Plan-Konstante des Overlays', () => {
  assert.equal(channel.CHANNEL_DAYS, 7);
  assert.equal(channel.CHANNEL_DAYS, viewModel.PLAN_DAYS);
});
