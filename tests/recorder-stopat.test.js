'use strict';

// Tests: stopAt + Höchstdauer im Main-Prozess (Etappe 1, Befund L1).
// Beweis „Aufnahme stoppt im Main ohne Fenster“: Der RecorderService wird
// ohne Renderer/BrowserWindow betrieben — der Stopp kommt allein aus dem Job
// (Fake-ffmpeg + injizierbare Uhr).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeFakeService, REQUEST, sleep, waitForDone } = require('./helpers/recorder-fakes.js');

function makeClock(startMs = Date.UTC(2026, 9, 5, 18, 0, 0)) {
  const clock = { t: startMs, now: () => new Date(clock.t), advance(ms) { clock.t += ms; } };
  return clock;
}

test('stopAt: Aufnahme endet im Main ohne Fenster, sobald die Uhr stopAt erreicht (injizierte Uhr)', async () => {
  const clock = makeClock();
  const { service } = makeFakeService({ now: clock.now });
  const autoStopped = [];
  service.on('recording:auto-stopped', p => autoStopped.push(p));

  const stopAt = clock.t + 15 * 60 * 1000; // Sendungsende in 15 min
  const { recId } = await service.start({ ...REQUEST, stopAt });
  await sleep(300); // Fake schreibt Segment + Playlist
  const job = service.getJob(recId);
  assert.equal(job.stopAt, stopAt);
  assert.equal(service.status().active[0].stopAt, stopAt);

  // Noch vor dem Ende: kein Stopp
  clock.advance(14 * 60 * 1000);
  assert.equal(job.checkLimits(), null);
  assert.equal(service.getJob(recId) !== null, true);

  // Sendungsende erreicht → Job stoppt selbst, Service remuxt (kein Renderer beteiligt)
  const doneP = waitForDone(service, recId);
  clock.advance(61 * 1000);
  assert.equal(job.checkLimits(), 'stop-at');
  const meta = await doneP;

  assert.equal(meta.id, recId);
  assert.equal(meta.status, 'completed');
  assert.equal(meta.stopReason, 'stop-at');
  assert.ok(fs.existsSync(meta.outputFile), 'MP4 existiert');
  assert.equal(service.getJob(recId), null, 'Job aus der Registry entfernt');
  assert.equal(autoStopped.length, 1);
  assert.equal(autoStopped[0].reason, 'stop-at');
  assert.equal(autoStopped[0].recId, recId);
});

test('stopAt: echter Timer (kein manuelles checkLimits) beendet die Aufnahme', async () => {
  const { service } = makeFakeService();
  const { recId } = await service.start({ ...REQUEST, stopAt: Date.now() + 1500 });
  const meta = await waitForDone(service, recId, 12000);
  assert.equal(meta.id, recId);
  assert.equal(meta.status, 'completed');
  assert.equal(meta.stopReason, 'stop-at');
  assert.equal(service.activeJobs().length, 0);
});

test('stopAt: Zeitpunkt in der Vergangenheit wird ignoriert; Unsinn wird abgelehnt', async () => {
  const clock = makeClock();
  const { service } = makeFakeService({ now: clock.now });
  const { recId } = await service.start({ ...REQUEST, stopAt: clock.t - 1000 });
  assert.equal(service.getJob(recId).stopAt, null, 'vergangenes stopAt → kein Auto-Stopp');
  await service.stop(recId);

  await assert.rejects(() => service.start({ ...REQUEST, stopAt: 'morgen' }), /stopAt/);
  await assert.rejects(() => service.start({ ...REQUEST, stopAt: -5 }), /stopAt/);
  await assert.rejects(() => service.start({ ...REQUEST, stopAt: 9e15 }), /stopAt/);
  // null/undefined = kein Auto-Stopp
  const open = await service.start({ ...REQUEST, stopAt: null });
  assert.equal(service.getJob(open.recId).stopAt, null);
  await service.stop(open.recId);
});

test('Höchstdauer: Notbremse nach maxDurationHours (Default 6 h) auch ohne stopAt', async () => {
  const clock = makeClock();
  const { service } = makeFakeService({ now: clock.now });
  assert.equal(service.getLimits().maxDurationHours, 6);
  const { recId } = await service.start(REQUEST);
  await sleep(300);
  const job = service.getJob(recId);
  assert.equal(job.maxDurationSec, 6 * 3600);

  clock.advance(6 * 3600 * 1000 - 1000);
  assert.equal(job.checkLimits(), null);
  const doneP = waitForDone(service, recId);
  clock.advance(2000);
  assert.equal(job.checkLimits(), 'max-duration');
  const meta = await doneP;
  assert.equal(meta.stopReason, 'max-duration');
});

test('Höchstdauer: stopAt vor Höchstdauer gewinnt, Höchstdauer vor spätem stopAt', async () => {
  const clock = makeClock();
  const { service } = makeFakeService({ now: clock.now, maxDurationHours: 1 });
  const { recId } = await service.start({ ...REQUEST, stopAt: clock.t + 3 * 3600 * 1000 });
  await sleep(300);
  const job = service.getJob(recId);
  clock.advance(3600 * 1000 + 1);
  const doneP = waitForDone(service, recId);
  assert.equal(job.checkLimits(), 'max-duration', 'Sendung noch nicht zu Ende, aber Notbremse');
  const meta = await doneP;
  assert.equal(meta.stopReason, 'max-duration');
});

test('Höchstdauer: Clamp im Service (Main) — 0 → 1 h, 99 → 24 h, Settings-Setter ebenso', () => {
  assert.equal(makeFakeService({ maxDurationHours: 0 }).service.maxDurationHours, 1);
  assert.equal(makeFakeService({ maxDurationHours: 99 }).service.maxDurationHours, 24);
  assert.equal(makeFakeService({}).service.maxDurationHours, 6);
  const { service } = makeFakeService({});
  assert.equal(service.setLimits({ maxDurationHours: 500 }).maxDurationHours, 24);
  assert.equal(service.setLimits({ maxDurationHours: 'x' }).maxDurationHours, 6);
});

test('Auto-Stopp ist idempotent: manueller Stopp nach Auslösung liefert dieselben finalen Metadaten', async () => {
  const clock = makeClock();
  const { service } = makeFakeService({ now: clock.now });
  const { recId } = await service.start({ ...REQUEST, stopAt: clock.t + 1000 });
  await sleep(300);
  const job = service.getJob(recId);
  clock.advance(5000);
  const doneP = waitForDone(service, recId);
  job.checkLimits();
  const meta = await service.stop(recId); // gleicher Stop-Pfad, kein Doppel-Remux
  const viaEvent = await doneP;
  assert.equal(meta.status, 'completed');
  assert.equal(viaEvent.id, meta.id);
  const libraryMp4 = fs.readdirSync(path.dirname(meta.outputFile)).filter(f => f.endsWith('.mp4'));
  assert.equal(libraryMp4.length, 1, 'genau eine MP4');
});

test('Auto-Stopp nutzt die kurze SIGINT-Grace (3 s statt 10 s) — kein langes Überlaufen über das Sendungsende', async () => {
  const clock = makeClock();
  const { service } = makeFakeService({ now: clock.now });
  const { recId } = await service.start({ ...REQUEST, stopAt: clock.t + 1000 });
  await sleep(300);
  const job = service.getJob(recId);
  assert.equal(job._stopGraceMs, 10000, 'manueller Stopp: reguläre Grace');
  const doneP = waitForDone(service, recId);
  clock.advance(5000);
  job.checkLimits();
  assert.equal(job._stopGraceMs, 3000);
  const meta = await doneP;
  assert.equal(meta.status, 'completed');
});
