'use strict';

// Tests: reine Planungslogik (Etappe 2a; Konzept §3.3/§3.4) — ISO mit Offset
// (Sommerzeitwechsel), effektive Fenster (Mittelpunkt-Regel), Überlappungs-Sweep
// inkl. laufender Aufnahmen, Zusammenlegen. Keine Uhr, kein Electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const logic = require('../lib/recorder/schedule-logic.js');

const MIN = 60 * 1000;

function entry(id, startIso, stopIso, extra = {}) {
  return {
    id,
    channelId: 'das-erste',
    channelName: 'Das Erste',
    title: id,
    description: '',
    epgStart: startIso,
    epgStop: stopIso,
    bufferBeforeSec: 120,
    bufferAfterSec: 300,
    state: 'scheduled',
    ...extra,
  };
}

test('ISO mit Offset: strikt geparst, Offset wird in ms umgerechnet', () => {
  const a = logic.parseIsoWithOffset('2026-10-05T20:00:00+02:00');
  const b = logic.parseIsoWithOffset('2026-10-05T18:00:00Z');
  assert.equal(a, b);
  assert.equal(logic.parseIsoWithOffset('2026-10-05T20:00:00.250+02:00'), a + 250);
  // Ohne Offset, mit Leerzeichen, Datum-only, unmögliche Daten → NaN
  for (const bad of [
    '2026-10-05T20:00:00', '2026-10-05 20:00:00+02:00', '2026-10-05', '2026-02-31T10:00:00Z',
    '2026-13-01T10:00:00Z', '2026-10-05T24:00:00Z', '2026-10-05T20:60:00Z', '2026-10-05T20:00:00+15:00',
    '2026-10-05T20:00:00+02', 20260105, null, undefined, '', 'x'.repeat(100),
  ]) {
    assert.ok(Number.isNaN(logic.parseIsoWithOffset(bad)), `sollte NaN sein: ${String(bad)}`);
  }
});

test('Sommerzeitwechsel Europe/Berlin 2026-10-25: doppelte Stunde 02:xx wird über den Offset eindeutig', () => {
  // 01:30 CEST (+02:00) → 02:30 CET (+01:00) = 2 Stunden echte Dauer
  const start = logic.parseIsoWithOffset('2026-10-25T01:30:00+02:00');
  const stop = logic.parseIsoWithOffset('2026-10-25T02:30:00+01:00');
  assert.equal(stop - start, 120 * MIN);
  // 02:30 CEST und 02:30 CET sind verschieden (eine Stunde Abstand)
  assert.equal(
    logic.parseIsoWithOffset('2026-10-25T02:30:00+01:00') - logic.parseIsoWithOffset('2026-10-25T02:30:00+02:00'),
    60 * MIN,
  );
  // Frühling 2026-03-29: 01:30 CET → 03:30 CEST = nur 1 Stunde
  assert.equal(
    logic.parseIsoWithOffset('2026-03-29T03:30:00+02:00') - logic.parseIsoWithOffset('2026-03-29T01:30:00+01:00'),
    60 * MIN,
  );
});

test('Sommerzeitwechsel: ein Eintrag über die Umstellung hat das richtige Fenster', () => {
  const e = entry('s1', '2026-10-25T01:30:00+02:00', '2026-10-25T02:30:00+01:00');
  const w = logic.effectiveWindows([e]).get('s1');
  assert.equal(w.epgStopMs - w.epgStartMs, 120 * MIN);
  assert.equal(w.startMs, w.epgStartMs - 2 * MIN);
  assert.equal(w.endMs, w.epgStopMs + 5 * MIN);
});

test('formatIsoWithOffset/toScheduleIso: Offset gilt für den Zeitpunkt selbst (TZ=Europe/Berlin)', () => {
  assert.equal(logic.formatIsoWithOffset(Date.UTC(2026, 9, 5, 18, 0, 0), 120), '2026-10-05T20:00:00+02:00');
  assert.equal(logic.formatIsoWithOffset(Date.UTC(2026, 9, 5, 18, 0, 0), 0), '2026-10-05T18:00:00Z');
  assert.equal(logic.formatIsoWithOffset(Date.UTC(2026, 9, 5, 18, 0, 0), -330), '2026-10-05T12:30:00-05:30');
  const script = `
    const ui = require(${JSON.stringify(path.join(__dirname, '../lib/recorder/schedule-ui-model.js'))});
    const logic = require(${JSON.stringify(path.join(__dirname, '../lib/recorder/schedule-logic.js'))});
    const out = [
      Date.UTC(2026, 9, 24, 23, 30), // 25.10. 01:30 CEST
      Date.UTC(2026, 9, 25, 1, 30),  // 25.10. 02:30 CET
      Date.UTC(2026, 6, 1, 10, 0),
    ].map(ms => { const iso = ui.toScheduleIso(ms); return [iso, logic.parseIsoWithOffset(iso) === ms]; });
    process.stdout.write(JSON.stringify(out));
  `;
  const res = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Europe/Berlin' } }));
  assert.deepEqual(res, [
    ['2026-10-25T01:30:00+02:00', true],
    ['2026-10-25T02:30:00+01:00', true],
    ['2026-07-01T12:00:00+02:00', true],
  ]);
});

// ── Mittelpunkt-Regel ──

test('Mittelpunkt-Regel: gleicher Kanal, direkt hintereinander, Puffer überlappen → Grenze in der Mitte', () => {
  // A 20:00–20:15 (+5 min Nachlauf → 20:20), B 20:15–20:45 (−2 min Vorlauf → 20:13)
  const a = entry('A', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00');
  const b = entry('B', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00');
  const w = logic.effectiveWindows([a, b]);
  // Mitte der Überlappung (20:13–20:20) wäre 20:16:30, geklemmt auf [epgStop(A), epgStart(B)] = 20:15
  // (Sendungsinhalt wird nie abgeschnitten, kein Spalt zwischen den Aufnahmen)
  const boundary = logic.parseIsoWithOffset('2026-10-05T20:15:00+02:00');
  assert.equal(w.get('A').endMs, boundary);
  assert.equal(w.get('B').startMs, boundary);
  // Äußere Kanten bleiben unberührt
  assert.equal(w.get('A').startMs, logic.parseIsoWithOffset('2026-10-05T19:58:00+02:00'));
  assert.equal(w.get('B').endMs, logic.parseIsoWithOffset('2026-10-05T20:50:00+02:00'));
});

test('Mittelpunkt-Regel: mit Lücke zwischen den Sendungen liegt die Grenze in der Mitte der Überlappung', () => {
  // A 20:00–20:10 (+5 → 20:15), B 20:20–20:40 (−10 → 20:10): Überlappung 20:10–20:15, Mitte 20:12:30
  const a = entry('A', '2026-10-05T20:00:00+02:00', '2026-10-05T20:10:00+02:00', { bufferBeforeSec: 0, bufferAfterSec: 300 });
  const b = entry('B', '2026-10-05T20:20:00+02:00', '2026-10-05T20:40:00+02:00', { bufferBeforeSec: 600, bufferAfterSec: 0 });
  const w = logic.effectiveWindows([b, a]); // Reihenfolge egal
  const expected = logic.parseIsoWithOffset('2026-10-05T20:12:30+02:00');
  assert.equal(w.get('A').endMs, expected);
  assert.equal(w.get('B').startMs, expected);
});

test('Mittelpunkt-Regel: keine Überlappung der Puffer → Fenster unverändert; anderer Kanal → unverändert', () => {
  const a = entry('A', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00', { bufferAfterSec: 60 });
  const b = entry('B', '2026-10-05T20:30:00+02:00', '2026-10-05T21:00:00+02:00', { bufferBeforeSec: 60 });
  const w = logic.effectiveWindows([a, b]);
  assert.equal(w.get('A').endMs, logic.parseIsoWithOffset('2026-10-05T20:16:00+02:00'));
  assert.equal(w.get('B').startMs, logic.parseIsoWithOffset('2026-10-05T20:29:00+02:00'));
  const other = entry('C', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00', { channelId: 'zdf', channelName: 'ZDF' });
  const w2 = logic.effectiveWindows([entry('A2', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00'), other]);
  assert.equal(w2.get('A2').endMs, logic.parseIsoWithOffset('2026-10-05T20:20:00+02:00'));
  assert.equal(w2.get('C').startMs, logic.parseIsoWithOffset('2026-10-05T20:13:00+02:00'));
});

test('Mittelpunkt-Regel: Kette A-B-C, Absage von B stellt den vollen Nachlauf von A wieder her (abgeleitet, nicht gespeichert)', () => {
  const a = entry('A', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00');
  const b = entry('B', '2026-10-05T20:15:00+02:00', '2026-10-05T20:30:00+02:00');
  const c = entry('C', '2026-10-05T20:30:00+02:00', '2026-10-05T20:45:00+02:00');
  const w = logic.effectiveWindows([a, b, c]);
  assert.equal(w.get('A').endMs, w.get('B').startMs);
  assert.equal(w.get('B').endMs, w.get('C').startMs);
  const without = logic.effectiveWindows([a, c]);
  assert.equal(without.get('A').endMs, logic.parseIsoWithOffset('2026-10-05T20:20:00+02:00'));
  assert.equal(a.bufferAfterSec, 300, 'Eintrag selbst bleibt unverändert');
});

test('Laufender Vorgänger desselben Kanals: B beginnt frühestens bei dessen stopAt', () => {
  const b = entry('B', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00');
  const stopAt = logic.parseIsoWithOffset('2026-10-05T20:14:00+02:00');
  const w = logic.effectiveWindows([b], [{ channelId: 'das-erste', channelName: 'Das Erste', stopAt }]);
  assert.equal(w.get('B').startMs, stopAt, 'Vorlauf (20:13) wird auf stopAt (20:14) verkürzt');
  // Unbekanntes Ende ändert nichts (offen)
  const w2 = logic.effectiveWindows([b], [{ channelId: 'das-erste', stopAt: null }]);
  assert.equal(w2.get('B').startMs, logic.parseIsoWithOffset('2026-10-05T20:13:00+02:00'));
});

// ── Konflikt-Sweep ──

test('Konflikt-Sweep: maxParallel nicht überschritten / überschritten', () => {
  const mk = (id, ch, s, e) => entry(id, s, e, { channelId: ch, channelName: ch });
  const base = [
    mk('e1', 'a', '2026-10-05T20:00:00+02:00', '2026-10-05T21:00:00+02:00'),
    mk('e2', 'b', '2026-10-05T20:00:00+02:00', '2026-10-05T21:00:00+02:00'),
  ];
  const cand = mk('', 'c', '2026-10-05T20:30:00+02:00', '2026-10-05T21:30:00+02:00');
  const ok = logic.findConflicts({ candidate: cand, entries: base, maxParallel: 3 });
  assert.equal(ok.exceeds, false);
  assert.equal(ok.maxConcurrent, 3);
  const over = logic.findConflicts({ candidate: cand, entries: base, maxParallel: 2 });
  assert.equal(over.exceeds, true);
  assert.equal(over.maxConcurrent, 3);
  assert.equal(over.overlapping.length, 2);
  assert.ok(over.firstOverloadAtMs >= logic.parseIsoWithOffset('2026-10-05T20:28:00+02:00'));
});

test('Konflikt-Sweep: nur Berührung an der Kante (halboffen) ist kein Konflikt; Puffer zählen mit', () => {
  const mk = (id, ch, s, e, extra) => entry(id, s, e, { channelId: ch, channelName: ch, ...extra });
  const existing = [mk('e1', 'a', '2026-10-05T19:00:00+02:00', '2026-10-05T20:00:00+02:00', { bufferBeforeSec: 0, bufferAfterSec: 0 })];
  const touching = mk('', 'b', '2026-10-05T20:00:00+02:00', '2026-10-05T21:00:00+02:00', { bufferBeforeSec: 0, bufferAfterSec: 0 });
  assert.equal(logic.findConflicts({ candidate: touching, entries: existing, maxParallel: 1 }).exceeds, false);
  // Mit 2 min Vorlauf überlappt es
  const buffered = { ...touching, bufferBeforeSec: 120 };
  assert.equal(logic.findConflicts({ candidate: buffered, entries: existing, maxParallel: 1 }).exceeds, true);
});

test('Konflikt-Sweep: laufende Aufnahmen zählen mit (bekanntes Ende / offen)', () => {
  const cand = entry('', '2026-10-05T20:00:00+02:00', '2026-10-05T21:00:00+02:00', { channelId: 'c', channelName: 'C' });
  const nowMs = logic.parseIsoWithOffset('2026-10-05T19:00:00+02:00');
  const running = [
    { id: 'r1', channelId: 'x', channelName: 'X', startedAtMs: nowMs, stopAt: logic.parseIsoWithOffset('2026-10-05T20:30:00+02:00') },
    { id: 'r2', channelId: 'y', channelName: 'Y', startedAtMs: nowMs, stopAt: null }, // offen → bis Ende des Prüffensters
  ];
  const res = logic.findConflicts({ candidate: cand, entries: [], running, maxParallel: 2 });
  assert.equal(res.exceeds, true);
  assert.equal(res.maxConcurrent, 3);
  // Läuft r1 vor dem Fenster zu Ende, bleibt nur das offene r2
  const early = [{ ...running[0], stopAt: logic.parseIsoWithOffset('2026-10-05T19:30:00+02:00') }, running[1]];
  const res2 = logic.findConflicts({ candidate: cand, entries: [], running: early, maxParallel: 2 });
  assert.equal(res2.exceeds, false);
  assert.equal(res2.maxConcurrent, 2);
});

test('Konflikt-Sweep: abgesagte/fertige Einträge und der ersetzte Eintrag zählen nicht', () => {
  const mk = (id, state) => entry(id, '2026-10-05T20:00:00+02:00', '2026-10-05T21:00:00+02:00', { channelId: id, channelName: id, state });
  const entries = [mk('a', 'cancelled'), mk('b', 'done'), mk('c', 'failed'), mk('d', 'scheduled')];
  const cand = entry('', '2026-10-05T20:00:00+02:00', '2026-10-05T21:00:00+02:00', { channelId: 'z', channelName: 'Z' });
  assert.equal(logic.findConflicts({ candidate: cand, entries, maxParallel: 2 }).exceeds, false);
  assert.equal(logic.findConflicts({ candidate: cand, entries, maxParallel: 1 }).exceeds, true);
  assert.equal(logic.findConflicts({ candidate: cand, entries, maxParallel: 1, excludeId: 'd' }).exceeds, false);
});

test('Konflikt-Sweep: gleicher Kanal direkt hintereinander ergibt dank Mittelpunkt-Regel keinen Parallel-Konflikt', () => {
  const a = entry('A', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00');
  const cand = entry('', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00');
  assert.equal(logic.findConflicts({ candidate: cand, entries: [a], maxParallel: 1 }).exceeds, false);
});

// ── Nachbarschaft / Zusammenlegen ──

test('describeAdjacency: erkennt benachbarte Sendung, Mittelpunkt und Merge-Ergebnis', () => {
  const a = entry('A', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00', { title: 'Tagesschau' });
  const cand = entry('', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00', { title: 'Tagesthemen' });
  const adj = logic.describeAdjacency({ candidate: cand, entries: [a] });
  assert.equal(adj.entry.id, 'A');
  assert.equal(adj.position, 'before');
  assert.equal(adj.gapSec, 0);
  assert.equal(adj.midpointIso, '2026-10-05T18:15:00Z');
  assert.equal(adj.firstAfterSec, 0);
  assert.equal(adj.secondBeforeSec, 0);
  assert.equal(adj.canMerge, true);
  assert.equal(adj.merged.title, 'Tagesschau + Tagesthemen');
  assert.equal(adj.merged.epgStart, a.epgStart);
  assert.equal(adj.merged.epgStop, cand.epgStop);
  assert.equal(adj.merged.bufferBeforeSec, 120);
  assert.equal(adj.merged.bufferAfterSec, 300);
});

test('describeAdjacency: Kandidat VOR dem bestehenden Eintrag; keine Nachbarschaft ohne Puffer-Überlappung / anderer Kanal', () => {
  const b = entry('B', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00', { title: 'Zweite' });
  const cand = entry('', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00', { title: 'Erste' });
  assert.equal(logic.describeAdjacency({ candidate: cand, entries: [b] }).position, 'after');
  const far = entry('F', '2026-10-05T22:00:00+02:00', '2026-10-05T22:30:00+02:00');
  assert.equal(logic.describeAdjacency({ candidate: cand, entries: [far] }), null);
  const other = entry('O', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00', { channelId: 'zdf', channelName: 'ZDF' });
  assert.equal(logic.describeAdjacency({ candidate: cand, entries: [other] }), null);
});

test('mergeEntries: Start von A, Stopp von B; lehnt falsche Paare und > 24 h ab', () => {
  const a = entry('A', '2026-10-05T20:00:00+02:00', '2026-10-05T20:15:00+02:00', { title: 'A', description: 'da' });
  const b = entry('B', '2026-10-05T20:15:00+02:00', '2026-10-05T20:45:00+02:00', { title: 'B', description: 'db' });
  const m = logic.mergeEntries(a, b);
  assert.equal(m.epgStart, a.epgStart);
  assert.equal(m.epgStop, b.epgStop);
  assert.equal(m.title, 'A + B');
  assert.equal(m.description, 'da\n\ndb');
  assert.throws(() => logic.mergeEntries(b, a), /nicht direkt hintereinander/);
  assert.throws(() => logic.mergeEntries(a, { ...b, channelId: 'zdf', channelName: 'ZDF' }), /denselben Sender/);
  const huge = entry('H', '2026-10-06T21:00:00+02:00', '2026-10-06T22:00:00+02:00');
  assert.throws(() => logic.mergeEntries(a, huge), /24 Stunden/);
});
