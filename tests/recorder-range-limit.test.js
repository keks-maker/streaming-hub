'use strict';

// Tests: längenbegrenzte Aufnahme einer schon beendeten Sendung (limitSec / rangeDurationSec).
// - Fake-ffmpeg: Argumente (-t), Exit 0 = Sendung komplett, Abbruch = kontrollierter Stopp ohne Reconnect.
// - Echter ffmpeg (falls vorhanden): lokaler Test-HLS-Stream mit Verlauf; Länge, Inhalt und Abschluss stimmen,
//   und die Aufnahme ist schneller fertig als die Sendungsdauer (kein Uhr-Stopp möglich).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { RecordJob } = require('../lib/recorder/RecordJob.js');
const { validateRecordingRequest } = require('../lib/recorder/RecorderService.js');

const FAKE_DIR = path.join(os.tmpdir(), `recorder-range-fake-${process.pid}`);

// mode: 'finish' (Exit 0 nach einem Segment), 'die' (Exit 1 nach einem Segment), 'log-args' (schreibt Argumente, bleibt aktiv)
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('ffmpeg version 7.0.2-static'); process.exit(0); }
const MODE = '__MODE__';
const segPattern = args[args.indexOf('-hls_segment_filename') + 1];
const playlist = args[args.length - 1];
const dir = path.dirname(playlist);
fs.appendFileSync(path.join(dir, 'args.log'), JSON.stringify(args) + '\\n');
const segName = path.basename(segPattern).replace('%05d', '00000');
fs.writeFileSync(path.join(dir, segName), Buffer.alloc(2048));
let existing = '';
try { existing = fs.readFileSync(playlist, 'utf-8'); } catch (_) {}
fs.writeFileSync(playlist, existing + '#EXTINF:1.0,\\n' + segName + '\\n');
if (MODE === 'finish') setTimeout(() => process.exit(0), 150);
else if (MODE === 'die') setTimeout(() => process.exit(1), 150);
else {
  process.on('SIGINT', () => { fs.appendFileSync(playlist, '#EXT-X-ENDLIST\\n'); process.exit(0); });
  setInterval(() => {}, 1000);
}
`;

function fakeFfmpeg(mode) {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const file = path.join(FAKE_DIR, `fake-${mode}.js`);
  fs.writeFileSync(file, FAKE.replace('__MODE__', mode), { mode: 0o755 });
  return file;
}

let counter = 0;
function makeJob(mode, extra = {}) {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rec-range-${counter}-`));
  const recId = `rec_20260930_r${String(counter).padStart(2, '0')}x`;
  const job = new RecordJob({
    recId,
    sourceUrl: 'https://stream.example/live.m3u8',
    dir,
    ffmpegPath: fakeFfmpeg(mode),
    meta: { id: recId, channelId: 'c', channelName: 'C', epgTitle: 'Sendung', status: 'recording', sourceUrl: 'https://stream.example/live.m3u8' },
    timing: { firstAttemptMinRunMs: 50, retryBaseDelayMs: 50 },
    ...extra,
  });
  return { job, dir };
}

function whenDone(job) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Job endete nicht')), 15000);
    job.once('stopped', p => { clearTimeout(t); resolve(p); });
    job.once('failed', p => { clearTimeout(t); resolve(p); });
  });
}

function ffmpegArgsLog(dir) {
  return fs.readFileSync(path.join(dir, 'args.log'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}

test('limitSec: ffmpeg bekommt -t; Exit 0 beendet die Aufnahme als Sendungsende (kein Reconnect)', async () => {
  const { job, dir } = makeJob('finish', { limitSec: 120 });
  const autoStops = [];
  job.on('auto-stop', e => autoStops.push(e.reason));
  const done = whenDone(job);
  job.start();
  const payload = await done;
  const calls = ffmpegArgsLog(dir);
  assert.equal(calls.length, 1, 'genau ein ffmpeg-Lauf, kein Reconnect');
  const args = calls[0];
  assert.equal(args[args.indexOf('-t') + 1], '120');
  assert.ok(args.indexOf('-t') > args.indexOf('-c') && args.indexOf('-t') < args.indexOf('-f'), '-t ist Output-Option');
  assert.equal(payload.meta.status, 'remux-pending');
  assert.equal(payload.meta.stopReason, 'stop-at');
  assert.deepEqual(autoStops, ['stop-at']);
});

test('limitSec: abgebrochener Stream endet kontrolliert (range-interrupted), behält das Aufgenommene, kein Live-Material', async () => {
  const { job, dir } = makeJob('die', { limitSec: 120 });
  const reconnects = [];
  const autoStops = [];
  job.on('reconnecting', e => reconnects.push(e));
  job.on('auto-stop', e => autoStops.push(e));
  const done = whenDone(job);
  job.start();
  const payload = await done;
  await new Promise(r => setTimeout(r, 400));
  assert.equal(reconnects.length, 0, 'kein Reconnect-Versuch');
  assert.equal(ffmpegArgsLog(dir).length, 1, 'kein zweiter ffmpeg-Lauf an der Live-Kante');
  assert.equal(payload.meta.status, 'remux-pending', 'Aufgenommenes bleibt erhalten');
  assert.equal(payload.meta.stopReason, 'range-interrupted');
  assert.equal(autoStops.length, 1);
  assert.match(autoStops[0].message, /nur teilweise/);
  assert.ok(fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf-8').includes('#EXT-X-ENDLIST'));
});

test('ohne limitSec bleibt das Verhalten: kein -t, Abbruch führt in den Reconnect', async () => {
  const { job, dir } = makeJob('die');
  const reconnecting = new Promise(resolve => job.once('reconnecting', resolve));
  job.start();
  const ev = await reconnecting;
  assert.equal(ev.nextAttempt, 2);
  assert.ok(!ffmpegArgsLog(dir)[0].includes('-t'));
  await job.stop({ reason: 'abort' });
});

test('limitSec: nie erfolgreich gestarteter Stream bleibt ein harter Fehler (failed)', async () => {
  const { job } = makeJob('log-args', { limitSec: 60, ffmpegPath: '/nonexistent/ffmpeg' });
  const done = whenDone(job);
  job.start();
  const payload = await done;
  assert.equal(payload.meta.status, 'failed');
});

test('validateRecordingRequest: rangeDurationSec wird validiert', () => {
  const base = { sourceUrl: 'https://x.example/a.m3u8', channelId: 'c', channelName: 'C' };
  assert.equal(validateRecordingRequest(base).rangeDurationSec, null);
  assert.equal(validateRecordingRequest({ ...base, rangeDurationSec: 1800.2 }).rangeDurationSec, 1801);
  for (const bad of [0, -5, 'abc', Infinity, 13 * 3600]) {
    assert.throws(() => validateRecordingRequest({ ...base, rangeDurationSec: bad }), /Sendungsdauer/, String(bad));
  }
});

// ── Echter ffmpeg ──

function findFfmpeg() {
  const cands = [process.env.STREAMING_HUB_FFMPEG, 'ffmpeg', path.join(__dirname, '..', 'bin', 'ffmpeg'),
    path.join(__dirname, '..', '..', '..', '..', 'bin', 'ffmpeg')].filter(Boolean);
  for (const c of cands) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 10000 });
      return c;
    } catch (_) { /* nächster Kandidat */ }
  }
  return null;
}
const ffmpeg = findFfmpeg();

test('echter ffmpeg: Sendung aus dem Verlauf, Länge und Inhalt stimmen, fertig schneller als Echtzeit',
  { skip: !ffmpeg && 'kein ffmpeg gefunden' }, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-range-real-'));
    const src = path.join(base, 'src');
    const rec = path.join(base, 'rec');
    fs.mkdirSync(src);
    fs.mkdirSync(rec);
    // 60 s Verlauf, 2-s-Segmente, ohne ENDLIST (= Live-Playlist); testsrc zählt hoch, damit der Inhalt prüfbar ist
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50',
      '-sc_threshold', '0', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_flags', 'omit_endlist+program_date_time', '-hls_segment_filename', path.join(src, 'seg_%05d.ts'),
      path.join(src, 'live.m3u8')], { timeout: 60000 });
    const server = http.createServer((req, res) => {
      fs.readFile(path.join(src, path.basename(req.url)), (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200).end(data);
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      // Sendung: 35 s vor der Live-Kante begonnen, 7 s lang (nicht segmentgenau: 1 s nach dem Segmentanfang)
      const job = new RecordJob({
        recId: 'rec_20260930_real1', sourceUrl: `http://127.0.0.1:${server.address().port}/live.m3u8`, dir: rec,
        ffmpegPath: ffmpeg, expectedSegmentSec: 2, startOffsetSec: 35, limitSec: 7,
        meta: { id: 'rec_20260930_real1', channelId: 'c', channelName: 'C', epgTitle: 'Sendung', status: 'recording', sourceUrl: 'x' },
      });
      const t0 = Date.now();
      const done = whenDone(job);
      job.start();
      const payload = await done;
      const wallMs = Date.now() - t0;
      assert.equal(payload.meta.status, 'remux-pending');
      assert.equal(payload.meta.stopReason, 'stop-at');
      assert.ok(wallMs < 6000, `schneller als die 7-s-Sendung (war ${wallMs} ms)`);
      assert.equal(payload.meta.durationSec, 8, 'Start am Segmentanfang (24 s), Ende exakt bei 32 s');
      // Länge in Frames: 1 s Vorlauf bis zum Segmentanfang + 7 s Sendung = 8 s * 25 fps
      const out = execFileSync(ffmpeg, ['-v', 'error', '-i', path.join(rec, 'index.m3u8'), '-f', 'null', '-', '-progress', '-'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const frames = Number([...out.matchAll(/^frame=(\d+)/gm)].pop()[1]);
      assert.ok(frames >= 195 && frames <= 205, `8 s Bildmaterial (war ${frames} Frames)`);
      // Inhalt: erstes Bild gehört in Segment 12 (24 s), nicht in ein späteres
      const md5 = args => execFileSync(ffmpeg, ['-v', 'error', ...args, '-frames:v', '1', '-f', 'md5', '-'], { encoding: 'utf-8' }).trim();
      const first = md5(['-i', path.join(rec, 'index.m3u8')]);
      assert.equal(first, md5(['-i', path.join(src, 'seg_00012.ts')]), 'Erstes Bild = Segment 12 (Verlauf, nicht Live-Kante)');
      assert.ok(fs.readFileSync(path.join(rec, 'index.m3u8'), 'utf-8').includes('#EXT-X-ENDLIST'));
    } finally {
      server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
