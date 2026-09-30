'use strict';

// Tests: RecordingStore — Persistenz + Recovery (Karte t_17ee2ca5, Konzept §5)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecordingStore } = require('../lib/recorder/RecordingStore.js');

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-store-'));
  const store = createRecordingStore({ root, logger: quietLogger() });
  return { root, store, library: path.join(root, 'Aufnahmen') };
}

const baseMeta = {
  id: 'rec_20260930_aaaaaa-bbbb',
  channelId: 'das-erste',
  channelName: 'Das Erste',
  epgTitle: 'Tagesschau',
  startedAt: '2026-09-30T20:15:00+02:00',
  status: 'recording',
  sourceUrl: 'https://example.com/live.m3u8',
};

test('writeMeta/readMeta: Meta-Datei am richtigen Ort, atomar, round-trip', () => {
  const { store, library } = makeStore();
  const written = store.writeMeta(baseMeta);
  assert.ok(written);
  const expected = path.join(library, baseMeta.id, `${baseMeta.id}.recording.json`);
  assert.ok(fs.existsSync(expected));
  const read = store.readMeta(baseMeta.id);
  assert.equal(read.channelName, 'Das Erste');
  assert.equal(read.status, 'recording');
});

test('writeMeta lehnt invalid IDs ab (Pfad-Tricks)', () => {
  const { store } = makeStore();
  assert.throws(() => store.writeMeta({ ...baseMeta, id: '../evil' }));
  assert.throws(() => store.writeMeta({ ...baseMeta, id: 'anders' }));
  assert.equal(store.readMeta('../evil'), null);
});

test('Index: upsert/remove/list round-trip', () => {
  const { store } = makeStore();
  store.upsertIndex(baseMeta);
  store.upsertIndex({ ...baseMeta, id: 'rec_20260930_cccccc-dddd', channelName: 'ZDF', status: 'completed' });
  let all = store.listAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].channelName, 'ZDF'); // unshift = neueste zuerst
  store.removeFromIndex(baseMeta.id);
  all = store.listAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'rec_20260930_cccccc-dddd');
});

test('Korrupter Index wird leer behandelt (Meta-Dateien bleiben Wahrheit)', () => {
  const { store, library } = makeStore();
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'recordings.json'), '{kaputt', 'utf-8');
  assert.deepEqual(store.listAll(), []);
  // Upsert repariert den Index trotzdem
  store.upsertIndex(baseMeta);
  assert.equal(store.listAll().length, 1);
});

test('findResumable: remux-pending via Index UND via Meta-Scan (Index defekt)', () => {
  const { store, library } = makeStore();
  store.writeMeta({ ...baseMeta, status: 'remux-pending' });
  store.writeMeta({ ...baseMeta, id: 'rec_20260930_x1x1x1-y2y2', status: 'completed' });
  store.upsertIndex({ ...baseMeta, status: 'remux-pending' });

  const resumable = store.findResumable();
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0].id, baseMeta.id);

  // Index löschen → Meta-Scan findet die remux-pending trotzdem
  fs.rmSync(path.join(library, 'recordings.json'));
  const resumable2 = store.findResumable();
  assert.equal(resumable2.length, 1);
  assert.equal(resumable2[0].id, baseMeta.id);
});

test('findResumable: completed/failed/aborted/recording sind NICHT resumable', () => {
  const { store } = makeStore();
  store.writeMeta({ ...baseMeta, status: 'completed' });
  store.writeMeta({ ...baseMeta, id: 'rec_20260930_x1x1x1-y2y2', status: 'failed' });
  store.writeMeta({ ...baseMeta, id: 'rec_20260930_z9z9z9-w8w8', status: 'aborted' });
  assert.deepEqual(store.findResumable(), []);
});

test('reapOrphans: recording ohne aktiven Job → aborted, aktive bleiben', () => {
  const { store } = makeStore();
  store.writeMeta(baseMeta); // wird Zombie (kein aktiver Job)
  store.writeMeta({ ...baseMeta, id: 'rec_20260930_x1x1x1-y2y2' }); // aktiv
  const reaped = store.reapOrphans(['rec_20260930_x1x1x1-y2y2']);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].id, baseMeta.id);
  assert.equal(reaped[0].status, 'aborted');
  assert.ok(reaped[0].stoppedAt);
  // Persistiert?
  assert.equal(store.readMeta(baseMeta.id).status, 'aborted');
  assert.equal(store.readMeta('rec_20260930_x1x1x1-y2y2').status, 'recording');
  // Zweiter Lauf: kein weiterer Reap (activeIds enthalten beide nicht mehr)
  const reaped2 = store.reapOrphans([]);
  assert.equal(reaped2.length, 1); // der "aktive" aus dem Test ist jetzt auch orphan — korrektes Verhalten
  assert.equal(store.readMeta('rec_20260930_x1x1x1-y2y2').status, 'aborted');
});
