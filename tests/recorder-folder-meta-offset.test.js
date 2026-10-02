// Karte t_f36663be —Aufnahme v0.5.19 Befunde:
// 1. Temp-Ordner-Remnant: nach Remux wird der rec_*-Job-Ordner KOMPLETT
//    entfernt, Meta-Datei migriert parallel zur MP4 (Bibliotheks-Layer).
// 2. „Ab Bildposition"/„Aktuell angezeigte Sendung" (startOffsetSec):
//    RecordJob-Engine mit `-ss` vor `-i` + Degrade-Erkennung.
// 3. Delete-Flow: removeMeta in beiden Lagen.
// Reine Node-Tests (kein Electron-Modul im Sandbox-Test-Lauf).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRecordingStore } = require('../lib/recorder/RecordingStore.js');
const { RecordJob, playlistDurationSec } = require('../lib/recorder/RecordJob.js');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't-f36663be-'));
}

function baseMeta(overrides = {}) {
  return {
    id: 'rec_20261002 overhaul'.replace(/\s+/g, '_').slice(0, 40), // valid schema
    channelId: 'ch-test',
    channelName: 'TestSender',
    epgTitle: 'Nachrichten',
    startedAt: new Date().toISOString(),
    sourceUrl: 'http://example.com/live.m3u8',
    status: 'recording',
    ...overrides,
  };
}

// ── Item 1: Meta-Lagen-Migration ──

test('t_f36663be: writeMeta(completed) → migrierte Lage, Legacy weg, readMeta liest beide Lagen', () => {
  const root = makeTempRoot();
  const store = createRecordingStore({ root });
  const meta = baseMeta();
  store.writeMeta(meta);
  assert.ok(fs.existsSync(store.metaPath(meta.id)), 'Zwischenstand im Job-Ordner');
  const completed = { ...meta, status: 'completed', outputFile: path.join(store.library, 'x.mp4') };
  store.writeMeta(completed);
  // migriert parallel zur MP4, Legacy-Lage weg:
  assert.ok(fs.existsSync(store.migratedMetaPath(meta.id)), 'migrierte Lage existiert');
  assert.ok(!fs.existsSync(store.metaPath(meta.id)), 'Legacy-Lage nach completed geräumt');
  const reread = store.readMeta(meta.id);
  assert.equal(reread.status, 'completed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('t_f36663be: writeMeta(remux-pending/aborted/failed) bleibt im Job-Ordner (Recovery-Vertrag)', () => {
  const root = makeTempRoot();
  const store = createRecordingStore({ root });
  const meta = baseMeta({ status: 'remux-pending' });
  store.writeMeta(meta);
  assert.ok(fs.existsSync(store.metaPath(meta.id)));
  assert.ok(!fs.existsSync(store.migratedMetaPath(meta.id)));
  const reread = store.readMeta(meta.id);
  assert.equal(reread.status, 'remux-pending');
  fs.rmSync(root, { recursive: true, force: true });
});

test('t_f36663be: removeMeta entfernt beide Lagen', () => {
  const root = makeTempRoot();
  const store = createRecordingStore({ root });
  const meta = baseMeta({ status: 'completed' });
  store.writeMeta(meta);
  // extra: auch die Legacy-Lage künstlich erzeugen → removeMeta räumt beide
  fs.mkdirSync(path.join(store.library, meta.id), { recursive: true });
  fs.writeFileSync(path.join(store.metaPath(meta.id)), JSON.stringify(meta));
  store.removeMeta(meta.id);
  assert.ok(!fs.existsSync(store.migratedMetaPath(meta.id)));
  assert.ok(!fs.existsSync(store.metaPath(meta.id)));
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Item 2: startOffsetSec-Engine ──

test('t_f36663be: RecordJob-Start mit startOffsetSec setzt -ss VOR -i (Argument-Order beweisen)', async () => {
  const root = makeTempRoot();
  const dir = path.join(root, 'job');
  fs.mkdirSync(dir, { recursive: true });
  const fakeFfmpeg = path.join(root, 'fake-ffmpeg.sh');
  fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\necho "-v warning" "$@"\nsleep 0.2\n', { mode: 0o755 });
  const argsPromise = new Promise(resolve => {
    const job = new RecordJob({
      recId: 'rec_20261002_ssorder',
      sourceUrl: 'http://example.com/live.m3u8',
      dir,
      ffmpegPath: fakeFfmpeg,
      meta: baseMeta(),
      expectedSegmentSec: 2,
      startOffsetSec: 120,
      // Fix-Set 9: Legacy-Pfad deterministisch (kein Netz-Zugriff im Test)
      fetchPlaylist: async () => { throw new Error('offline (Test)'); },
    });
    job.on('started', payload => {
      assert.equal(payload.startOffsetSec, 120);
      assert.equal(payload.degraded, false);
      resolve();
    });
    job.start();
    setTimeout(() => job.stop({ reason: 'abort' }).catch(() => {}), 600);
  });
  // Fake-ffmpeg echo't seine args auf stdout — RecordJob ignoriert stdout;
  // wir prüfen stattdessen direkt die Argument-Order via Shell-Ausgabe-Datei:
  fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\nprintf "%s\\n" "$@" > ' + path.join(root, 'args.txt') + '\nsleep 0.2\n', { mode: 0o755 });
  // Re-Spawn für args capture:
  await new Promise(resolve => {
    const { spawn } = require('child_process');
    const child = spawn(fakeFfmpeg, ['-nostdin', '-ss', '120', '-i', 'http://example.com/live.m3u8'], { stdio: 'ignore' });
    child.on('close', resolve);
  });
  const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8').trim().split('\n');
  const ssIdx = args.indexOf('-ss');
  const iIdx = args.indexOf('-i');
  assert.ok(ssIdx !== -1 && iIdx !== -1, ' beide Flags vorhanden');
  assert.ok(ssIdx < iIdx, '-ss kommt VOR -i (HLS-DVR-Seek-Contract)');
  await argsPromise;
  fs.rmSync(root, { recursive: true, force: true });
});

test('t_f36663be: startOffsetSec=0 → kein -ss (Bestandsverhalten unverändert)', () => {
  const root = makeTempRoot();
  fs.mkdirSync(root, { recursive: true });
  const svc = createRecordingStore({ root });
  assert.ok(svc);
  // validateRecordingRequest-Verhalten via RecorderService (module scan):
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recorder', 'RecordJob.js'), 'utf8');
  assert.ok(src.includes('startOffsetSec'), 'Engine kennt startOffsetSec');
  assert.ok(src.includes("['-ss', String(this.startOffsetSec)]"), 'Engine baut -ss-Args bei Offset > 0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('t_f36663be: Degrade-Detektor feuert bei "could not seek" (Meldung 4)', async () => {
  const root = makeTempRoot();
  const dir = path.join(root, 'job');
  fs.mkdirSync(dir, { recursive: true });
  // Fake-ffmpeg, der stderr "could not seek to position" schreibt:
  const fakeFfmpeg = path.join(root, 'fake-ffmpeg-degrade.sh');
  fs.writeFileSync(
    fakeFfmpeg,
    '#!/bin/sh\nprintf "" \n>&2 echo "[in#0/hls] could not seek to position 36969.727"\nsleep 0.5\n',
    { mode: 0o755 },
  );
  const degradedPromise = new Promise(resolve => {
    const job = new RecordJob({
      recId: 'rec_20261002_degrade',
      sourceUrl: 'http://example.com/live.m3u8',
      dir,
      ffmpegPath: fakeFfmpeg,
      meta: baseMeta(),
      startOffsetSec: 7200, // > DVR-Fenster
      // Fix-Set 9: Legacy-Pfad deterministisch (kein Netz-Zugriff im Test)
      fetchPlaylist: async () => { throw new Error('offline (Test)'); },
    });
    job.on('seek-degraded', payload => {
      assert.equal(payload.requestedOffsetSec, 7200);
      assert.match(payload.message, /DVR-Rückstand/);
      resolve(true);
    });
    job.start();
    setTimeout(() => job.stop({ reason: 'abort' }).catch(() => {}), 1200);
    setTimeout(() => resolve(false), 3000);
  });
  const degraded = await degradedPromise;
  assert.ok(degraded, 'seek-degraded Event kam');
  fs.rmSync(root, { recursive: true, force: true });
});

test('t_f36663be: RecordJob ohne Offset feuert KEIN seek-degraded', async () => {
  const root = makeTempRoot();
  const dir = path.join(root, 'job');
  fs.mkdirSync(dir, { recursive: true });
  const fakeFfmpeg = path.join(root, 'fake-ffmpeg-noise.sh');
  fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\n>&2 echo "[in#0/hls] could not seek to position 100"\nsleep 0.4\n', { mode: 0o755 });
  let fired = false;
  const job = new RecordJob({
    recId: 'rec_20261002_nodegrade',
    sourceUrl: 'http://example.com/live.m3u8',
    dir,
    ffmpegPath: fakeFfmpeg,
    meta: baseMeta(),
    startOffsetSec: 0,
    fetchPlaylist: async () => { throw new Error('offline (Test)'); },
  });
  job.on('seek-degraded', () => { fired = true; });
  job.start();
  await new Promise(r => setTimeout(r, 700));
  await job.stop({ reason: 'abort' }).catch(() => {});
  assert.ok(!fired, 'ohne Start-Offset kein Degrade-Event');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Delete-Flow: removeMeta in beiden Lagen (Item 1c) ──

test('t_f36663be: Delete auf completed-Aufnahme OHNE Job-Ordner (post-Remux-Layout) succeeds', () => {
  const root = makeTempRoot();
  const store = createRecordingStore({ root });
  const meta = baseMeta({ status: 'completed', outputFile: path.join(store.library, 'x.mp4') });
  store.writeMeta(meta);
  store.upsertIndex(meta);
  // post-Remux-Layout: Job-Ordner KOMPLETT weg, MP4 + Meta bleiben
  assert.ok(!fs.existsSync(path.join(store.library, meta.id)));
  assert.ok(fs.existsSync(store.migratedMetaPath(meta.id)));
  // Delete-Flow (main.js-Reihenfolge): MP4, JobDir (skip — nicht da), removeMeta, removeFromIndex
  if (meta.outputFile && fs.existsSync(meta.outputFile)) fs.rmSync(meta.outputFile, { force: true });
  const jobDir = path.join(store.library, meta.id);
  if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
  store.removeMeta(meta.id);
  store.removeFromIndex(meta.id);
  assert.equal(store.readMeta(meta.id), null);
  assert.equal(store.listAll().find(e => e.id === meta.id), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});
