'use strict';

// Tests: RecordJob-State-Machine (Karte t_17ee2ca5; Konzept §2.1/§2.3)
// Nutzt einen Fake-ffmpeg (Node-Skript): steuert Start/Abbruch/Reconnect/Stop
// deterministisch — gleiche CLI-Schnittstelle wie das echte ffmpeg.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecordJob, playlistDurationSec, directoryBytes } = require('../lib/recorder/RecordJob.js');

const FAKE_DIR = path.join(os.tmpdir(), `recorder-fake-ffmpeg-${process.pid}`);

const FAKE_TEMPLATE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('ffmpeg version 7.0.2-static'); process.exit(0); }
const MODE = ${JSON.stringify('__MODE__')};
const segIdx = args.indexOf('-hls_segment_filename');
const segPattern = segIdx !== -1 ? args[segIdx + 1] : null;
const playlist = args[args.length - 1];
// Versuch-eigenes Segment (F-FB-09-Logik im Fake nachempfunden): das echte
// ffmpeg schreibt seit dem Fix mit attempt-eigenem Präfix — der Fake liest
// das Präfix aus dem Muster und hängt den passenden Eintrag an.
const segName = segPattern ? segPattern.split('/').pop() : 'seg_%05d.ts';
function appendSegment() {
  fs.writeFileSync(segPattern.replace('%05d', '00000'), Buffer.alloc(2048));
  let existing = '';
  try { existing = fs.readFileSync(playlist, 'utf-8'); } catch (_) {}
  fs.writeFileSync(playlist, existing + '#EXTINF:1.0,\\n' + segName.replace('%05d', '00000') + '\\n');
}
if (MODE === 'instant-exit') { console.error('fake: stream unreachable'); process.exit(1); }
if (MODE === 'run-forever') {
  appendSegment();
  process.on('SIGINT', () => {
    let raw = '';
    try { raw = fs.readFileSync(playlist, 'utf-8'); } catch (_) {}
    if (!raw.includes('#EXT-X-ENDLIST')) fs.appendFileSync(playlist, '#EXT-X-ENDLIST\\n');
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  return;
}
if (MODE === 'run-then-die') {
  appendSegment();
  setTimeout(() => process.exit(0), 6000); // > FIRST_ATTEMPT_MIN_RUN_MS (5s) → Retry-Pfad
  return;
}
process.exit(1);
`;

function createFakeFfmpeg(mode) {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const file = path.join(FAKE_DIR, `fake-${mode}.js`);
  fs.writeFileSync(file, FAKE_TEMPLATE.replace('__MODE__', mode), { mode: 0o755 });
  return file;
}

let recCounter = 0;

function makeJob(mode) {
  recCounter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rec-job-${recCounter}-`));
  const recId = `rec_20260930_t${String(recCounter).padStart(2, '0')}x`;
  const job = new RecordJob({
    recId,
    sourceUrl: 'https://stream.example/live.m3u8',
    dir,
    ffmpegPath: createFakeFfmpeg(mode),
    meta: {
      id: recId,
      channelId: 'das-erste',
      channelName: 'Das Erste',
      epgTitle: 'Tagesschau',
      startedAt: null,
      status: 'recording',
      sourceUrl: 'https://stream.example/live.m3u8',
    },
  });
  return { job, dir, recId };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitFor(job, event, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      job.removeListener(event, onEvent);
      reject(new Error(`Event "${event}" kam nicht innerhalb ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = payload => {
      clearTimeout(timer);
      resolve(payload);
    };
    job.once(event, onEvent);
  });
}

test('RecordJob lehnt ungültige Konfiguration ab', () => {
  const meta = { id: 'rec_a-b', channelId: 'x', status: 'recording', sourceUrl: 'https://s/x.m3u8' };
  const base = { dir: os.tmpdir(), ffmpegPath: '/bin/true' };
  assert.throws(() => new RecordJob({ ...base, recId: null, sourceUrl: 'https://s', meta }), /recId/);
  assert.throws(() => new RecordJob({ ...base, recId: 'rec_a-b', sourceUrl: 'ftp://s', meta }), /http/);
  assert.throws(
    () => new RecordJob({ ...base, recId: 'rec_a-b', sourceUrl: 'https://s', meta: { ...meta, status: 'completed' } }),
    /recording/,
  );
});

test('State-Machine: Start → recording, Stop → remux-pending, ENDLIST gesichert', async () => {
  const { job } = makeJob('run-forever');
  const startedP = waitFor(job, 'started');
  job.start();
  assert.equal(job.getRunState().state, 'recording');
  await startedP;
  await sleep(400); // Fake schreibt Segment + Playlist
  assert.ok(job.hasContent());

  const stopPayload = await job.stop({ reason: 'user' });
  assert.equal(stopPayload.reason, 'user');
  assert.equal(stopPayload.meta.status, 'remux-pending');
  assert.equal(job.getRunState().state, 'stopped');
  assert.ok(stopPayload.meta.durationSec >= 1);
  assert.ok(stopPayload.meta.fileSizeBytes >= 2048);
  // ENDLIST in der Playlist (ohne sie hängt der spätere Remux — Probe-Befund)
  const raw = fs.readFileSync(path.join(job.dir, 'index.m3u8'), 'utf-8');
  assert.ok(raw.includes('#EXT-X-ENDLIST'));
  assert.ok(stopPayload.meta.startedAt);
  assert.ok(stopPayload.meta.stoppedAt);
});

test('State-Machine: Doppel-Stop ist idempotent, Stop vor Start rejected', async () => {
  const { job } = makeJob('run-forever');
  const startedP = waitFor(job, 'started');
  job.start();
  await startedP;
  const p1 = job.stop();
  const p2 = job.stop();
  assert.equal(p1, p2); // zweiter Stop = dasselbe Promise
  const result = await p1;
  assert.equal(result.meta.status, 'remux-pending');
  // Stop nach abgeschlossenem Stop: idempotent, liefert das finale Meta
  const again = await job.stop();
  assert.equal(again.meta.status, 'remux-pending');
  // Stop ohne je gestartet zu haben: rejected
  const { job: fresh } = makeJob('run-forever');
  await assert.rejects(() => fresh.stop());
});

test('State-Machine: abort → Status aborted, nicht remux-pending', async () => {
  const { job } = makeJob('run-forever');
  const startedP = waitFor(job, 'started');
  job.start();
  await startedP;
  const result = await job.stop({ reason: 'abort' });
  assert.equal(result.reason, 'abort');
  assert.equal(result.meta.status, 'aborted');
});

test('State-Machine: Start nie geglückt (instant exit) → failed ohne Retry', async () => {
  const { job } = makeJob('instant-exit');
  const failedP = waitFor(job, 'failed', 15000);
  job.start();
  const payload = await failedP;
  assert.equal(payload.reason, 'failed');
  assert.equal(payload.meta.status, 'failed');
  assert.equal(job.getRunState().attempt, 1); // kein sinnloser Retry
  assert.ok(payload.meta.lastError);
  assert.equal(job.getRunState().state, 'stopped');
});

test('State-Machine: Stream-Abbruch → Reconnect → Aufnahme läuft weiter', async () => {
  const { job } = makeJob('run-then-die');
  const started1P = waitFor(job, 'started');
  job.start();
  await started1P;

  const reconnectP = waitFor(job, 'reconnecting', 25000);
  const reconnectPayload = await reconnectP;
  assert.equal(job.getRunState().state, 'waiting-retry');
  assert.match(reconnectPayload.error, /Stream abgebrochen/);
  assert.equal(reconnectPayload.attempt, 1);

  const started2P = waitFor(job, 'started', 15000); // nach 2s Backoff
  const attempt2 = await started2P;
  assert.equal(attempt2.attempt, 2);
  await sleep(800); // Fake schreibt Attempt-2-Beitrag in die Playlist

  const stopPayload = await job.stop({ reason: 'user' });
  assert.equal(stopPayload.meta.status, 'remux-pending');
  assert.equal(job.getRunState().attempt, 2);
  // Beide Attempts haben beigetragen (Playlist akkumuliert wie mit append_list)
  assert.ok(stopPayload.meta.durationSec >= 2);
  const run = job.getRunState();
  assert.ok(run.retryWaitTotalMs >= 2000);
});

test('Progress-Events kommen während der Aufnahme', async () => {
  const { job } = makeJob('run-forever');
  const startedP = waitFor(job, 'started');
  const progressP = waitFor(job, 'progress', 10000);
  job.start();
  await startedP;
  const progress = await progressP; // erster Tick nach SIZE_TICK_MS = 5s
  assert.equal(progress.recId, job.recId);
  assert.ok(progress.bytesWritten >= 2048);
  await job.stop({ reason: 'abort' });
});

test('playlistDurationSec summiert EXTINF-Zeilen (inkl. Reconnect-Naht)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-pl-'));
  const pl = path.join(dir, 'index.m3u8');
  fs.writeFileSync(pl, '#EXTM3U\n#EXTINF:2.0,\na.ts\n#EXTINF:1.92,\nb.ts\n#EXTINF:2.037,\nc.ts\n');
  assert.equal(playlistDurationSec(pl), 5.957);
  assert.throws(() => playlistDurationSec(path.join(dir, 'fehlt.m3u8')));
});

test('directoryBytes summiert nur .ts-Fragmente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-bytes-'));
  fs.writeFileSync(path.join(dir, 'seg_00000.ts'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, 'seg_00001.ts'), Buffer.alloc(50));
  fs.writeFileSync(path.join(dir, 'index.m3u8'), 'x');
  assert.equal(directoryBytes(dir), 150);
  assert.equal(directoryBytes(path.join(dir, 'fehlt')), 0);
});

test.after(() => {
  try {
    fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  } catch (_) {}
});
