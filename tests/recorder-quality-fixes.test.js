'use strict';

// Regressionstests (Qualitätsprüfung 2026-10): RecordJob-Reconnect-Verhalten.
// 1) Retry-Budget wird nach stabilem Lauf zurückgesetzt (lange Aufnahmen).
// 2) Reconnect-Attempts (≥ 2) seeken nicht erneut um den DVR-Offset zurück.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecordJob, STABLE_RUN_MS } = require('../lib/recorder/RecordJob.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-quality-'));
let counter = 0;

// Fake-ffmpeg: schreibt seine Argumente als JSON in <dir>/args-<n>.json und bleibt am Leben.
function fakeFfmpeg() {
  const file = path.join(TMP, 'fake-ffmpeg.js');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('fs');
const dir = process.cwd();
const n = fs.readdirSync(dir).filter(f => f.startsWith('args-')).length + 1;
fs.writeFileSync(dir + '/args-' + n + '.json', JSON.stringify(process.argv.slice(2)));
setInterval(() => {}, 1000);
process.on('SIGINT', () => process.exit(0));
`,
    { mode: 0o755 },
  );
  return file;
}

function makeJob({ startOffsetSec = 0, now } = {}) {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(TMP, `job-${counter}-`));
  const recId = `rec_20261002_q${counter}`;
  const job = new RecordJob({
    recId,
    sourceUrl: 'https://stream.example/live.m3u8',
    dir,
    ffmpegPath: fakeFfmpeg(),
    startOffsetSec,
    fetchPlaylist: async () => {
      throw new Error('offline'); // erzwingt den Legacy-Seek-Pfad
    },
    now,
    meta: { id: recId, channelId: 'x', channelName: 'X', status: 'recording', sourceUrl: 'https://stream.example/live.m3u8' },
  });
  return { job, dir };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readArgs(dir, n) {
  const f = path.join(dir, `args-${n}.json`);
  for (let i = 0; i < 50 && !fs.existsSync(f); i += 1) await sleep(100);
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

test('Retry-Budget wird nach stabilem Lauf zurückgesetzt', () => {
  let t = 1_000_000;
  const { job } = makeJob({ now: () => new Date(t) });
  job._attempt = 2; // kein Fatal-Pfad für „Start nie geglückt“
  const closeAfter = ms => {
    job._state = 'recording';
    job._attemptStartedAt = t;
    t += ms;
    job._onAttemptClose(1, null);
    clearTimeout(job._retryTimer);
    job._retryTimer = null;
  };
  // Viele kurze Aussetzer nach jeweils stabilem Lauf dürfen das Budget nie erschöpfen.
  for (let i = 0; i < 40; i += 1) {
    closeAfter(STABLE_RUN_MS + 1000);
    assert.equal(job._state, 'waiting-retry', `Aussetzer ${i + 1} darf nicht fatal sein`);
    assert.equal(job._retryWaitTotalMs, 2000, 'Backoff beginnt nach stabilem Lauf neu');
  }
});

test('Instabile Reconnect-Schleife erschöpft das Budget weiterhin', () => {
  let t = 1_000_000;
  const { job } = makeJob({ now: () => new Date(t) });
  job._attempt = 2;
  for (let i = 0; i < 40 && job._state !== 'stopped'; i += 1) {
    job._state = 'recording';
    job._attemptStartedAt = t;
    t += 1000; // kurz
    job._onAttemptClose(1, null);
    clearTimeout(job._retryTimer);
    job._retryTimer = null;
  }
  assert.equal(job._state, 'stopped');
  assert.equal(job.meta.status, 'failed');
});

test('Attempt 1 mit DVR-Offset seekt, Reconnect (Attempt 2) nicht', async () => {
  const { job, dir } = makeJob({ startOffsetSec: 3600 });
  job.start();
  const first = await readArgs(dir, 1);
  assert.ok(first.includes('-ss'), 'Attempt 1 nutzt -ss');
  assert.equal(first[first.indexOf('-ss') + 1], '3600');

  // Reconnect simulieren: Attempt 2 direkt spawnen (erstes Child separat aufräumen).
  const firstChild = job._child;
  job._state = 'waiting-retry';
  job._spawnAttempt();
  const second = await readArgs(dir, 2);
  assert.ok(!second.includes('-ss'), 'Attempt 2 darf nicht erneut seeken');
  assert.ok(!second.includes('-sn'));
  await job.stop({ reason: 'abort' });
  firstChild.kill('SIGKILL');
});
