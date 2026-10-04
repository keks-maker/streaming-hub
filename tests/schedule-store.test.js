'use strict';

// Tests: ScheduleStore (Etappe 2a; Konzept §3.3) — Persistenz über simulierten
// Neustart, atomares Schreiben, tolerantes Laden korrupter Dateien, IDs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduleStore, makeScheduleId, SCHEDULE_ID_PATTERN } = require('../lib/recorder/ScheduleStore.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'));
}

const BASE = {
  channelId: 'das-erste',
  channelName: 'Das Erste',
  tvgId: 'DasErste.de',
  sourceId: 'q1',
  sourceUrlSnapshot: 'https://stream.example/live.m3u8',
  title: 'Tagesschau',
  description: 'Nachrichten',
  epgStart: '2026-10-25T01:30:00+02:00',
  epgStop: '2026-10-25T02:30:00+01:00',
  bufferBeforeSec: 120,
  bufferAfterSec: 300,
};

test('IDs: sch_-Präfix, regex-kompatibel, eindeutig', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = makeScheduleId();
    assert.match(id, SCHEDULE_ID_PATTERN);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test('add/get/update/remove + Persistenz über simulierten Neustart (neue Store-Instanz)', () => {
  const dir = tmpDir();
  const store = createScheduleStore({ dir });
  assert.equal(store.load(), 0);
  const e = store.add(BASE);
  assert.match(e.id, SCHEDULE_ID_PATTERN);
  assert.equal(e.state, 'scheduled');
  assert.equal(e.recId, null);
  assert.ok(e.createdAt);
  store.update(e.id, { state: 'recording', recId: 'rec_abc-1' });

  // Neustart
  const again = createScheduleStore({ dir });
  assert.equal(again.load(), 1);
  const loaded = again.get(e.id);
  assert.equal(loaded.state, 'recording');
  assert.equal(loaded.recId, 'rec_abc-1');
  assert.equal(loaded.epgStart, BASE.epgStart, 'ISO mit Offset bleibt unverändert erhalten');
  assert.equal(loaded.epgStop, BASE.epgStop);
  assert.equal(loaded.title, 'Tagesschau');

  assert.equal(again.remove(e.id), true);
  assert.equal(again.remove(e.id), false);
  assert.equal(createScheduleStore({ dir }).load(), 0);
  assert.equal(again.update('sch_unbekannt', { note: 'x' }), null);
});

test('Atomares Schreiben: nur schedules.json, keine tmp-Reste; Datei ist gültiges JSON', () => {
  const dir = tmpDir();
  const store = createScheduleStore({ dir });
  store.load();
  for (let i = 0; i < 5; i += 1) store.add({ ...BASE, title: `T${i}` });
  assert.deepEqual(fs.readdirSync(dir), ['schedules.json']);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf-8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries.length, 5);
});

test('Schreibfehler: Eintrag bleibt nicht halb im Speicher, aussagekräftiger Fehler', () => {
  const dir = tmpDir();
  const store = createScheduleStore({ dir, fileName: 'schedules.json' });
  store.load();
  store.add(BASE);
  // Verzeichnis durch Datei ersetzen → Schreiben schlägt fehl
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'blockiert');
  assert.throws(() => store.add({ ...BASE, title: 'Zwei' }), /nicht gespeichert/);
  assert.equal(store.list().length, 1);
  fs.rmSync(dir, { force: true });
});

test('Korrupte Datei: Backup + leerer Start + Log, kein Wurf', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'schedules.json'), '{ das ist kein json');
  const logs = [];
  const store = createScheduleStore({ dir, logger: { error: m => logs.push(m), warn: m => logs.push(m) } });
  assert.equal(store.load(), 0);
  assert.equal(store.list().length, 0);
  const files = fs.readdirSync(dir);
  assert.ok(files.some(f => f.startsWith('schedules.json.corrupt-')), 'defekte Datei gesichert');
  assert.ok(!files.includes('schedules.json'));
  assert.ok(logs.some(l => /defekt/.test(l)));
  // danach normal benutzbar
  store.add(BASE);
  assert.equal(createScheduleStore({ dir }).load(), 1);

  // Falsches Format (kein entries-Array) wird ebenso gesichert
  const dir2 = tmpDir();
  fs.writeFileSync(path.join(dir2, 'schedules.json'), JSON.stringify({ version: 1, entries: 'nope' }));
  assert.equal(createScheduleStore({ dir: dir2 }).load(), 0);
  assert.ok(fs.readdirSync(dir2).some(f => f.includes('corrupt')));
});

test('Einzelne ungültige Einträge werden verworfen, gültige bleiben', () => {
  const dir = tmpDir();
  const good = { ...BASE, id: 'sch_gut', state: 'scheduled' };
  const bad = [
    { ...BASE, id: 'sch_kaputt', epgStart: 'morgen', state: 'scheduled' },
    { ...BASE, id: 'ungueltige id', state: 'scheduled' },
    { ...BASE, id: 'sch_stopp', epgStop: BASE.epgStart, state: 'scheduled' },
    { ...BASE, id: 'sch_state', state: 'wasauchimmer' },
    null,
    'text',
  ];
  fs.writeFileSync(path.join(dir, 'schedules.json'), JSON.stringify({ version: 1, entries: [good, ...bad, good] }));
  const store = createScheduleStore({ dir });
  assert.equal(store.load(), 1, 'Duplikat-ID und Ungültige verworfen');
  assert.equal(store.list()[0].id, 'sch_gut');
});

test('add: ungültige Eingaben werden abgelehnt', () => {
  const store = createScheduleStore({ dir: tmpDir() });
  store.load();
  assert.throws(() => store.add({ ...BASE, epgStart: '2026-10-25T01:30:00' }), /Ungültiger Planungseintrag/);
  assert.throws(() => store.add({ ...BASE, channelId: '', channelName: '' }), /Ungültiger Planungseintrag/);
});

test('prune: alte abgeschlossene Einträge (> 14 Tage) werden entfernt, aktive bleiben', () => {
  const dir = tmpDir();
  const nowMs = Date.UTC(2026, 9, 25, 12, 0, 0);
  const store = createScheduleStore({ dir, now: () => nowMs });
  store.load();
  const old = store.add({ ...BASE, epgStart: '2026-09-01T20:00:00+02:00', epgStop: '2026-09-01T21:00:00+02:00', state: 'done' });
  const recent = store.add({ ...BASE, epgStart: '2026-10-20T20:00:00+02:00', epgStop: '2026-10-20T21:00:00+02:00', state: 'missed' });
  const active = store.add({ ...BASE, epgStart: '2026-09-01T20:00:00+02:00', epgStop: '2026-09-01T21:00:00+02:00', state: 'recording' });
  assert.equal(store.prune(), 1);
  const ids = store.list().map(e => e.id);
  assert.ok(!ids.includes(old.id));
  assert.ok(ids.includes(recent.id));
  assert.ok(ids.includes(active.id));
});
