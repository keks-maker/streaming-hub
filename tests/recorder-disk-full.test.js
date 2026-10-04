'use strict';

// Tests: Speicher voll / NAS-Ausfall (Etappe 1, Konzept §3.9) mit SIMULIERTEM
// statfs (injizierbare freeBytes-Funktion). Der echte Volume-Test (hdiutil +
// echtes ffmpeg + Decode-Check) liegt in recorder-disk-full-volume.test.js.

process.env.STREAMING_HUB_FFMPEG = 'bundled';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecordJob } = require('../lib/recorder/RecordJob.js');
const { makeFakeService, REQUEST, sleep, waitForEvent, waitForDone } = require('./helpers/recorder-fakes.js');

const MB = 1024 * 1024;
const GB = 1024 * MB;

function makeFree(initial) {
  const state = { free: initial, calls: [] };
  state.fn = dir => {
    state.calls.push(dir);
    return state.free;
  };
  return state;
}

function deferredEvent(service, recId) {
  return waitForEvent(service, 'recording:changed', p => p.recId === recId && !!p.meta.remuxDeferredReason);
}

test('Speicher voll: Größen-Tick stoppt kontrolliert, ENDLIST gesetzt, Remux zurückgestellt, Aufnahme bleibt abspielbar', async () => {
  const free = makeFree(50 * GB);
  const { service, storageRoot } = makeFakeService({ freeBytes: free.fn, sizeTickMs: 150, reserveMB: 1024 });
  const autoStopped = [];
  service.on('recording:auto-stopped', p => autoStopped.push(p));

  const { recId } = await service.start(REQUEST);
  await sleep(400); // Ticks laufen, genug Platz → weiter aufnehmen
  assert.equal(service.getJob(recId) !== null, true);
  assert.ok(free.calls.length >= 1, 'Freiplatz wird im Tick geprüft');

  const deferredP = deferredEvent(service, recId);
  free.free = 300 * MB; // unter 1 GB Reserve und unter Remux-Bedarf (512 MB + Zwischenform)
  const { meta } = await deferredP;

  assert.equal(autoStopped.length, 1);
  assert.equal(autoStopped[0].reason, 'disk-full');
  assert.equal(autoStopped[0].message, 'Speicher voll');
  assert.equal(meta.stopReason, 'disk-full');
  assert.equal(meta.status, 'remux-pending');
  assert.equal(meta.remuxDeferredReason, 'Nicht konvertiert — Speicher knapp');
  assert.equal(service.getJob(recId), null);

  // Abspielbare HLS-Form: Playlist mit ENDLIST + vorhandene Segmente, kein MP4
  const jobDir = path.join(storageRoot, 'Aufnahmen', recId);
  const playlist = fs.readFileSync(path.join(jobDir, 'index.m3u8'), 'utf-8');
  assert.match(playlist, /#EXT-X-ENDLIST/);
  assert.ok(fs.existsSync(path.join(jobDir, 'seg_00000.ts')));
  assert.equal(fs.readdirSync(path.join(storageRoot, 'Aufnahmen')).filter(f => f.endsWith('.mp4')).length, 0);
  // Persistierte Meta/Index tragen Grund + Status
  const persisted = service.store.readMeta(recId);
  assert.equal(persisted.stopReason, 'disk-full');
  assert.equal(persisted.remuxDeferredReason, 'Nicht konvertiert — Speicher knapp');

  // Nachholen über den remux-pending-Mechanismus, sobald wieder Platz da ist
  free.free = 50 * GB;
  const done = await service.retryDeferredRemuxes();
  assert.equal(done.length, 1);
  assert.equal(done[0].status, 'completed');
  assert.equal(done[0].remuxDeferredReason, null);
  assert.equal(done[0].stopReason, 'disk-full', 'Grund bleibt dokumentiert');
  assert.ok(fs.existsSync(done[0].outputFile));
  assert.ok(!fs.existsSync(jobDir), 'Zwischenform nach Remux geräumt');
});

test('Speicher voll: Platz wird vor dem Remux wieder frei → Remux läuft direkt (kein Zurückstellen)', async () => {
  const free = makeFree(50 * GB);
  const { service } = makeFakeService({ freeBytes: free.fn, sizeTickMs: 150 });
  service.on('recording:auto-stopped', () => {
    free.free = 50 * GB; // z. B. Nutzer hat aufgeräumt
  });
  const { recId } = await service.start(REQUEST);
  await sleep(300);
  const doneP = waitForDone(service, recId);
  free.free = 100 * MB;
  const meta = await doneP;
  assert.equal(meta.status, 'completed');
  assert.equal(meta.stopReason, 'disk-full');
  assert.equal(meta.remuxDeferredReason, null);
});

test('Speicher voll: Remux-Bedarf = Größe der Zwischenform + Mindest-Reserve (knapp → zurückgestellt)', async () => {
  const free = makeFree(50 * GB);
  const { service } = makeFakeService({ freeBytes: free.fn, sizeTickMs: 150, reserveMB: 512 });
  const { recId } = await service.start(REQUEST);
  await sleep(300);
  const deferredP = deferredEvent(service, recId);
  // Genau zwischen Reserve (512 MB, damit der Tick auslöst) und Bedarf (> 512 MB + Zwischenform)
  free.free = 512 * MB - 1;
  await deferredP;
  free.free = 512 * MB + 1024; // < 512 MB + 2 KB Zwischenform? nein: 2048 B Segment → noch zu knapp
  assert.equal((await service.retryDeferredRemuxes()).length, 0, 'zu knapp: bleibt zurückgestellt');
  assert.equal(service.store.readMeta(recId).status, 'remux-pending');
  free.free = 512 * MB + 4096;
  assert.equal((await service.retryDeferredRemuxes()).length, 1);
});

test('Freiplatz nicht ermittelbar (null): kein Auto-Stopp, Remux läuft normal', async () => {
  const free = makeFree(null);
  const { service } = makeFakeService({ freeBytes: free.fn, sizeTickMs: 100 });
  const { recId } = await service.start(REQUEST);
  await sleep(500);
  assert.equal(service.getJob(recId) !== null, true, 'weiter aufnehmen');
  const meta = await service.stop(recId);
  assert.equal(meta.status, 'completed');
  assert.equal(meta.stopReason, null);
});

test('Reserve: Clamp im Main — unter 512 MB wird auf 512 MB gesetzt (Konstruktor, Setter)', async () => {
  const { service } = makeFakeService({ reserveMB: 10 });
  assert.equal(service.getLimits().reserveMB, 512);
  assert.equal(service.setLimits({ reserveMB: 0 }).reserveMB, 512);
  assert.equal(service.setLimits({ reserveMB: 2048 }).reserveMB, 2048);
  assert.equal(service.setLimits({ reserveMB: 'kaputt' }).reserveMB, 1024);
  assert.equal(makeFakeService({}).service.getLimits().reserveMB, 1024, 'Default 1 GB');

  // Auch wirksam: Job bekommt die geklemmte Reserve (512 MB), nicht 10 MB
  const free = makeFree(200 * MB);
  const svc = makeFakeService({ freeBytes: free.fn, sizeTickMs: 100, reserveMB: 10 }).service;
  const { recId } = await svc.start(REQUEST);
  const stopped = await waitForEvent(svc, 'recording:auto-stopped', p => p.recId === recId, 5000);
  assert.equal(stopped.reason, 'disk-full', '200 MB frei < 512 MB geklemmte Reserve');
  await sleep(300);
});

test('Recovery: zurückgestellte Aufnahme wird beim Start nachgeholt, sobald Platz da ist', async () => {
  const free = makeFree(50 * GB);
  const { service, storageRoot, appRoot } = makeFakeService({ freeBytes: free.fn, sizeTickMs: 150 });
  const { recId } = await service.start(REQUEST);
  await sleep(300);
  const deferredP = deferredEvent(service, recId);
  free.free = 100 * MB;
  await deferredP;

  // „App-Neustart“: neuer Service auf demselben Speicherort, weiterhin wenig Platz
  const { RecorderService } = require('../lib/recorder/RecorderService.js');
  const lowFree = makeFree(100 * MB);
  const restarted = new RecorderService({ appRoot, storageRoot, freeBytes: lowFree.fn });
  const first = await restarted.recover();
  assert.equal(first.recovered.length, 0);
  assert.equal(first.deferred.length, 1);
  assert.equal(restarted.store.readMeta(recId).status, 'remux-pending');

  // Platz wieder da → Recovery holt nach
  lowFree.free = 50 * GB;
  const second = await restarted.recover();
  assert.equal(second.recovered.length, 1);
  assert.equal(second.recovered[0].status, 'completed');
  assert.equal(second.recovered[0].remuxDeferredReason, null);
});

test('Speicherort nicht erreichbar beim Remux: zurückgestellt statt failed', async () => {
  const { service, storageRoot } = makeFakeService({});
  const { recId } = await service.start(REQUEST);
  await sleep(300);
  const job = service.getJob(recId);
  const payload = await job.stop({ reason: 'user' });
  service.jobs.delete(recId);
  // NAS „weg“: Speicherort verschwindet vor dem Remux
  fs.rmSync(storageRoot, { recursive: true, force: true });
  const result = await service._remuxAfterStop(payload.meta);
  assert.equal(result.status, 'remux-pending');
  assert.equal(result.remuxDeferredReason, 'Nicht konvertiert — Speicherort nicht erreichbar');
});

// ── NAS-Ausfall im Job: Retry-Budget erschöpft + Speicherort nicht beschreibbar ──

const FAKE_DIES = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const segIdx = args.indexOf('-hls_segment_filename');
const segPattern = args[segIdx + 1];
const playlist = args[args.length - 1];
const segName = segPattern.split('/').pop().replace('%05d', '00000');
fs.writeFileSync(segPattern.replace('%05d', '00000'), Buffer.alloc(2048));
let existing = '';
try { existing = fs.readFileSync(playlist, 'utf-8'); } catch (_) {}
fs.writeFileSync(playlist, existing + '#EXTINF:1.0,\\n' + segName + '\\n');
setTimeout(() => process.exit(1), 250); // „Stream/NAS weg“: ffmpeg endet von selbst
`;

function makeDyingJob(storageProbe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-nas-'));
  const ffmpegPath = path.join(dir, 'fake-dies.js');
  fs.writeFileSync(ffmpegPath, FAKE_DIES, { mode: 0o755 });
  const recId = `rec_20261004_nas${Math.random().toString(36).slice(2, 6)}`;
  const job = new RecordJob({
    recId,
    sourceUrl: 'https://stream.example/live.m3u8',
    dir,
    ffmpegPath,
    meta: { id: recId, channelId: 'x', channelName: 'X', status: 'recording', sourceUrl: 'https://s/x.m3u8' },
    storageProbe,
    timing: { firstAttemptMinRunMs: 100, retryBaseDelayMs: 40, retryMaxDelayMs: 80, retryMaxWaitMs: 200 },
  });
  return { job, dir };
}

test('NAS-Ausfall: Retry-Budget erschöpft + Speicherort nicht beschreibbar → kontrolliert beendet (storage-lost)', async () => {
  const { job, dir } = makeDyingJob(() => false);
  const autoStop = waitForEvent(job, 'auto-stop', () => true, 20000);
  const stopped = waitForEvent(job, 'stopped', () => true, 20000);
  job.start();
  const info = await autoStop;
  assert.equal(info.reason, 'storage-lost');
  const payload = await stopped;
  assert.equal(payload.meta.status, 'remux-pending', 'nicht failed: Zwischenform bleibt nachholbar');
  assert.equal(payload.meta.stopReason, 'storage-lost');
  const playlist = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf-8');
  assert.match(playlist, /#EXT-X-ENDLIST/, 'Playlist abgeschlossen (Pfad noch beschreibbar im Test)');
});

test('Retry-Budget erschöpft bei intaktem Speicherort bleibt ein normaler Fehler (failed)', async () => {
  const { job } = makeDyingJob(() => true);
  const failed = waitForEvent(job, 'failed', () => true, 20000);
  job.start();
  const payload = await failed;
  assert.equal(payload.meta.status, 'failed');
  assert.match(payload.meta.lastError, /dauerhaft nicht erreichbar/);
  assert.ok(!payload.meta.stopReason);
});
