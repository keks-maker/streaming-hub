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
const { computeRangeSeek } = require('../lib/recorder/dvr-seek.js');
const { recordingDoneToast } = require('../lib/recorder/ui-model.js');

const FAKE_DIR = path.join(os.tmpdir(), `recorder-range-fake-${process.pid}`);

// mode: 'finish' (Exit 0 nach einem Segment), 'die' (Exit 1 nach einem Segment), 'segv' (SIGSEGV ohne Material),
// 'die-empty' (Exit 1 ohne Material), sonst: schreibt Argumente und bleibt aktiv. __DUR__ = EXTINF-Dauer des Segments.
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('ffmpeg version 7.0.2-static'); process.exit(0); }
const MODE = '__MODE__';
const DUR = '__DUR__';
const segPattern = args[args.indexOf('-hls_segment_filename') + 1];
const playlist = args[args.length - 1];
const dir = path.dirname(playlist);
fs.appendFileSync(path.join(dir, 'args.log'), JSON.stringify(args) + '\\n');
if (MODE === 'segv') process.kill(process.pid, 'SIGSEGV');
if (MODE === 'die-empty') process.exit(1);
if (MODE === 'finish-gap') { process.stderr.write('[hls @ 0x1] skipping 3 segments ah'); setTimeout(() => process.stderr.write('ead, expired from playlists\\n'), 20); }
const segName = path.basename(segPattern).replace('%05d', '00000');
fs.writeFileSync(path.join(dir, segName), Buffer.alloc(2048));
let existing = '';
try { existing = fs.readFileSync(playlist, 'utf-8'); } catch (_) {}
fs.writeFileSync(playlist, existing + '#EXTINF:' + DUR + ',\\n' + segName + '\\n');
if (MODE === 'finish' || MODE === 'finish-gap') setTimeout(() => process.exit(0), 150);
else if (MODE === 'die') setTimeout(() => process.exit(1), 150);
else {
  process.on('SIGINT', () => { fs.appendFileSync(playlist, '#EXT-X-ENDLIST\\n'); process.exit(0); });
  setInterval(() => {}, 1000);
}
`;

function fakeFfmpeg(mode, dur = '1.0') {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const file = path.join(FAKE_DIR, `fake-${mode}-${dur}.js`);
  fs.writeFileSync(file, FAKE.replace('__MODE__', mode).replace('__DUR__', dur), { mode: 0o755 });
  return file;
}

let counter = 0;
function makeJob(mode, extra = {}, dur = '1.0') {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rec-range-${counter}-`));
  const recId = `rec_20260930_r${String(counter).padStart(2, '0')}x`;
  const job = new RecordJob({
    recId,
    sourceUrl: 'https://stream.example/live.m3u8',
    dir,
    ffmpegPath: fakeFfmpeg(mode, dur),
    meta: { id: recId, channelId: 'c', channelName: 'C', epgTitle: 'Sendung', status: 'recording', sourceUrl: 'https://stream.example/live.m3u8' },
    timing: { firstAttemptMinRunMs: 50, retryBaseDelayMs: 50 },
    ...extra,
  });
  return { job, dir };
}

function whenDone(job, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Job endete nicht')), timeoutMs);
    job.once('stopped', p => { clearTimeout(t); resolve(p); });
    job.once('failed', p => { clearTimeout(t); resolve(p); });
  });
}

function ffmpegArgsLog(dir) {
  return fs.readFileSync(path.join(dir, 'args.log'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}

test('limitSec: ffmpeg bekommt -t; Exit 0 beendet die Aufnahme als Sendungsende (kein Reconnect)', async () => {
  const { job, dir } = makeJob('finish', { limitSec: 120 }, '120.0');
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

test('F1: Exit 0 mit zu wenig Material (Server-/Segmentausfall, ENDLIST) = range-interrupted, nicht stop-at', async () => {
  const { job } = makeJob('finish', { limitSec: 100 }, '16.0');
  const done = whenDone(job);
  job.start();
  const payload = await done;
  assert.equal(payload.meta.stopReason, 'range-interrupted');
  assert.equal(payload.meta.status, 'remux-pending');
});

test('F1/W1: Toleranz - fast vollständiges Material gilt als komplett, 83 von 100 s nicht', async () => {
  const ok = makeJob('finish', { limitSec: 100 }, '98.0');
  const okDone = whenDone(ok.job);
  ok.job.start();
  assert.equal((await okDone).meta.stopReason, 'stop-at');
  const gap = makeJob('finish', { limitSec: 100 }, '83.0');
  const gapDone = whenDone(gap.job);
  gap.job.start();
  assert.equal((await gapDone).meta.stopReason, 'range-interrupted');
});

test('F3: früher Abbruch (unter der Mindestlaufzeit) mit verwertbarem Material = range-interrupted, nicht failed', async () => {
  const { job } = makeJob('die', { limitSec: 120, timing: { firstAttemptMinRunMs: 5000, retryBaseDelayMs: 50 } }, '10.0');
  const done = whenDone(job);
  job.start();
  const payload = await done;
  assert.equal(payload.meta.status, 'remux-pending');
  assert.equal(payload.meta.stopReason, 'range-interrupted');
});

test('begrenzte Aufnahme ohne Material = failed (kein Reconnect)', async () => {
  const { job, dir } = makeJob('die-empty', { limitSec: 120 });
  const done = whenDone(job);
  job.start();
  const payload = await done;
  assert.equal(payload.meta.status, 'failed');
  assert.equal(ffmpegArgsLog(dir).length, 1);
});

test('E1/E3: Lückensignal des Demuxers (auch über Chunk-Grenzen) = range-interrupted, trotz voller Dauer und Exit 0', async () => {
  const { job } = makeJob('finish-gap', { limitSec: 600 }, '600.0');
  const done = whenDone(job);
  job.start();
  const payload = await done;
  assert.equal(payload.meta.stopReason, 'range-interrupted');
});

test('Gegenprobe: lückenlose Aufnahme mit voller Dauer bleibt stop-at', async () => {
  const { job } = makeJob('finish', { limitSec: 600 }, '600.0');
  const done = whenDone(job);
  job.start();
  assert.equal((await done).meta.stopReason, 'stop-at');
});

test('E2: unvollständige Aufnahme trägt den Hinweis in der Fertig-Meldung, lange sichtbar', () => {
  const partial = recordingDoneToast({ epgTitle: 'Film', stopReason: 'range-interrupted' });
  assert.match(partial.text, /Film.*nur teilweise aufgenommen.*MP4 bereit/);
  assert.ok(partial.durationMs >= 8000);
  const normal = recordingDoneToast({ channelName: 'Das Erste', stopReason: 'stop-at' });
  assert.equal(normal.text, 'Aufnahme beendet — MP4 bereit: Das Erste');
  assert.equal(normal.durationMs, 4000);
  assert.equal(recordingDoneToast(null).text, 'Aufnahme beendet — MP4 bereit: Aufnahme');
});

const PDT = ms => new Date(ms).toISOString();
const START_MS = Date.UTC(2026, 8, 10, 20, 0, 0);
function pdtPlaylist(count = 30, withPdt = true) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:100'];
  for (let i = 0; i < count; i += 1) {
    if (withPdt && i === 0) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${PDT(START_MS)}`);
    lines.push('#EXTINF:2.0,', `s${i}.ts`);
  }
  return lines.join('\n') + '\n';
}

test('computeRangeSeek: Segment und Rest aus dem PDT, außerhalb des Fensters, ohne PDT', () => {
  const plan = computeRangeSeek(pdtPlaylist(), START_MS + 25000);
  assert.equal(plan.segmentIndex, 12);
  assert.equal(plan.liveStartIndex, 12 - 30);
  assert.equal(plan.residualSec, 1);
  assert.equal(plan.withinWindow, true);
  assert.equal(computeRangeSeek(pdtPlaylist(), START_MS - 5000).withinWindow, false);
  assert.equal(computeRangeSeek(pdtPlaylist(30, false), START_MS + 25000), null);
  assert.equal(computeRangeSeek('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', START_MS), null);
});

test('F4: Startpunkt kommt aus dem PDT beim Spawn, nicht aus dem (veralteten) Rückstand', async () => {
  const { job, dir } = makeJob('hold', {
    limitSec: 100, showStartMs: START_MS + 25000, startOffsetSec: 9999,
    fetchPlaylist: async () => pdtPlaylist(),
  });
  job.on('auto-stop', () => {});
  job.start();
  await new Promise(r => setTimeout(r, 400));
  const args = ffmpegArgsLog(dir)[0];
  assert.equal(args[args.indexOf('-live_start_index') + 1], '-18');
  assert.equal(args[args.indexOf('-t') + 1], '101', 'Dauer + Rest-Seek 1 s');
  assert.ok(!args.includes('-ss'));
  await job.stop({ reason: 'abort' });
});

test('F2: begrenzte Aufnahme ohne PDT oder außerhalb des Fensters schlägt klar fehl, ffmpeg startet nie', async () => {
  for (const [playlist, start] of [[pdtPlaylist(30, false), START_MS + 25000], [pdtPlaylist(), START_MS - 60000]]) {
    const { job, dir } = makeJob('hold', {
      limitSec: 100, showStartMs: start, startOffsetSec: 600, fetchPlaylist: async () => playlist,
    });
    const done = whenDone(job);
    job.start();
    const payload = await done;
    assert.equal(payload.meta.status, 'failed');
    assert.match(payload.meta.lastError, /Startpunkt im DVR-Fenster nicht bestimmbar/);
    assert.ok(!fs.existsSync(path.join(dir, 'args.log')), 'kein Legacy-Seek, kein Live-Start');
  }
  const failing = makeJob('hold', { limitSec: 100, showStartMs: START_MS, fetchPlaylist: async () => { throw new Error('offline'); } });
  const d = whenDone(failing.job);
  failing.job.start();
  assert.equal((await d).meta.status, 'failed');
});

test('F2: SIGSEGV bei begrenzter Aufnahme baut die Seek-Argumente nicht ab (kein Legacy-Seek, kein Live-Start)', async () => {
  const { job, dir } = makeJob('segv', {
    limitSec: 100, showStartMs: START_MS + 25000, fetchPlaylist: async () => pdtPlaylist(),
  });
  const done = whenDone(job);
  job.start();
  const payload = await done;
  assert.equal(payload.meta.status, 'failed');
  assert.equal(ffmpegArgsLog(dir).length, 1);
});

test('laufende Sendung (ohne limitSec): PDT-Plan wenn möglich, sonst bisheriger Rückstand', async () => {
  const withPdt = makeJob('hold', { showStartMs: START_MS + 25000, startOffsetSec: 9999, fetchPlaylist: async () => pdtPlaylist() });
  withPdt.job.start();
  await new Promise(r => setTimeout(r, 400));
  const a = ffmpegArgsLog(withPdt.dir)[0];
  assert.equal(a[a.indexOf('-live_start_index') + 1], '-18');
  assert.ok(!a.includes('-t'));
  await withPdt.job.stop({ reason: 'abort' });
  const noPdt = makeJob('hold', { showStartMs: START_MS, startOffsetSec: 20, fetchPlaylist: async () => pdtPlaylist(30, false) });
  noPdt.job.start();
  await new Promise(r => setTimeout(r, 400));
  const b = ffmpegArgsLog(noPdt.dir)[0];
  assert.equal(b[b.indexOf('-live_start_index') + 1], String(-(20 / 2)), 'Rückstand 20 s = 10 Segmente von hinten');
  await noPdt.job.stop({ reason: 'abort' });
});

test('validateRecordingRequest: rangeDurationSec wird validiert', () => {
  const base = { sourceUrl: 'https://x.example/a.m3u8', channelId: 'c', channelName: 'C' };
  assert.equal(validateRecordingRequest(base).rangeDurationSec, null);
  assert.equal(validateRecordingRequest({ ...base, showStartMs: Date.now() - 1000, rangeDurationSec: 1800.2 }).rangeDurationSec, 1801);
  const showStartMs = Date.now() - 3600 * 1000;
  assert.equal(validateRecordingRequest({ ...base, showStartMs }).showStartMs, showStartMs);
  assert.equal(validateRecordingRequest({ ...base, showStartMs, rangeDurationSec: 60 }).rangeDurationSec, 60);
  for (const bad of [0, -5, 'abc', Infinity, 13 * 3600]) {
    assert.throws(() => validateRecordingRequest({ ...base, showStartMs, rangeDurationSec: bad }), /Sendungsdauer/, String(bad));
  }
  for (const bad of ['x', Infinity, Date.now() - 48 * 3600 * 1000]) {
    assert.throws(() => validateRecordingRequest({ ...base, showStartMs: bad }), /Sendungsstart/, String(bad));
  }
  assert.throws(() => validateRecordingRequest({ ...base, rangeDurationSec: 60 }), /benötigt einen Sendungsstart/);
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
    let blockFrom = Infinity; // Segmente ab dieser Nummer liefern 404 (Ausfall mitten in der Sendung)
    const server = http.createServer((req, res) => {
      const segNo = /seg_(\d+)\.ts/.exec(req.url);
      if (segNo && Number(segNo[1]) >= blockFrom) { res.writeHead(404).end(); return; }
      fs.readFile(path.join(src, path.basename(req.url)), (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200).end(data);
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      // Sendung: 35 s vor der Live-Kante begonnen, 7 s lang (nicht segmentgenau: 1 s nach dem Segmentanfang)
      const pdt0 = Date.parse(/#EXT-X-PROGRAM-DATE-TIME:(\S+)/.exec(fs.readFileSync(path.join(src, 'live.m3u8'), 'utf-8'))[1]);
      const job = new RecordJob({
        recId: 'rec_20260930_real1', sourceUrl: `http://127.0.0.1:${server.address().port}/live.m3u8`, dir: rec,
        ffmpegPath: ffmpeg, expectedSegmentSec: 2, showStartMs: pdt0 + 25000, limitSec: 7,
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

      // Ausfall mitten in der Sendung (Segmente ab 16 liefern 404): ffmpeg endet mit Exit 0, Material fehlt
      blockFrom = 16;
      const rec2 = path.join(base, 'rec2');
      fs.mkdirSync(rec2);
      const job2 = new RecordJob({
        recId: 'rec_20260930_real2', sourceUrl: `http://127.0.0.1:${server.address().port}/live.m3u8`, dir: rec2,
        ffmpegPath: ffmpeg, expectedSegmentSec: 2, showStartMs: pdt0 + 25000, limitSec: 30,
        meta: { id: 'rec_20260930_real2', channelId: 'c', channelName: 'C', epgTitle: 'Sendung', status: 'recording', sourceUrl: 'x' },
      });
      const done2 = whenDone(job2);
      job2.start();
      const p2 = await done2;
      assert.equal(p2.meta.stopReason, 'range-interrupted', 'unvollständig, kein stop-at');
      assert.equal(p2.meta.status, 'remux-pending');
      assert.ok(p2.meta.durationSec > 0 && p2.meta.durationSec < 20);
    } finally {
      server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

test('echter ffmpeg: zu langsames Lesen (Segmente laufen aus der Playlist) = range-interrupted, lückenloses Lesen = stop-at',
  { skip: !ffmpeg && 'kein ffmpeg gefunden' }, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-range-slow-'));
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
      '-c:a', 'aac', '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', path.join(base, 's%05d.ts')]);
    // Live-Fenster von 6 Segmenten (1 s), Kante startet bei Segment 40 und wandert in Echtzeit
    const t0 = Date.now();
    const edge = () => 40 + Math.floor((Date.now() - t0) / 1000);
    const pdtBase = t0 - 41 * 1000;
    let throttleMs = 0;
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('.m3u8')) {
        const e = edge();
        let m = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${e - 5}\n`;
        for (let i = e - 5; i <= e; i += 1) {
          m += `#EXT-X-PROGRAM-DATE-TIME:${new Date(pdtBase + i * 1000).toISOString()}\n#EXTINF:1.000000,\ns${String(i).padStart(5, '0')}.ts\n`;
        }
        res.writeHead(200).end(m);
        return;
      }
      setTimeout(() => fs.readFile(path.join(base, path.basename(req.url)), (err, d) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200).end(d);
      }), throttleMs);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const run = async (name, ms) => {
      throttleMs = ms;
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      const job = new RecordJob({
        recId: `rec_20260930_${name}`, sourceUrl: `http://127.0.0.1:${server.address().port}/live.m3u8`, dir,
        ffmpegPath: ffmpeg, expectedSegmentSec: 1, showStartMs: pdtBase + (edge() - 4) * 1000, limitSec: 12,
        meta: { id: `rec_20260930_${name}`, channelId: 'c', channelName: 'C', epgTitle: 'S', status: 'recording', sourceUrl: 'x' },
      });
      const done = whenDone(job, 60000);
      job.start();
      return (await done).meta.stopReason;
    };
    try {
      assert.equal(await run('slow', 1500), 'range-interrupted');
      assert.equal(await run('fast', 400), 'stop-at');
    } finally {
      server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
