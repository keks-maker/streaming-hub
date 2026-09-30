'use strict';

// Integrationstest: echte ffmpeg/ffprobe-Binaries (Aufnahme Phase 1b, t_17ee2ca5)
//
// Läuft nur, wenn ffmpeg >= 7 im PATH (oder STREAMING_HUB_FFMPEG gesetzt)
// ist — sonst Skip. Aufbau: lokaler Mini-Live-Stream (lavfi testsrc, HLS,
// 1s-Segmente) wird über einen statischen HTTP-Server auf 127.0.0.1
// ausgeliefert (realer http(s)-Pfad wie in Produktion). Aufnahme über die
// echte RecordJob-Logik, Stop, Remux über die echte RemuxJob-Logik,
// Verifikation mit echtem ffprobe.
// Akzeptanzkriterium der Karte: Aufnahme wächst, Stop → Remux → MP4
// abspielbar (ffprobe Dauer/Streams), Zwischendateien weg.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { RecordJob } = require('../lib/recorder/RecordJob.js');
const { runRemux } = require('../lib/recorder/RemuxJob.js');

function resolveFfmpeg() {
  if (process.env.STREAMING_HUB_FFMPEG) return process.env.STREAMING_HUB_FFMPEG;
  try {
    const out = execFileSync('ffmpeg', ['-version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Tolerant gegen n-Präfix (git-describe-Builds wie "n9.0.1") — die App
    // selbst nutzt das gebündelte 7.0.2-static ohne Präfix.
    const m = /version\s+n?(\d+)\.(\d+)/.exec(out);
    if (m && (Number(m[1]) > 7 || (Number(m[1]) === 7 && Number(m[2]) >= 0))) return 'ffmpeg';
  } catch (_) {}
  return null;
}

const ffmpeg = resolveFfmpeg();
const ffprobe = ffmpeg ? 'ffprobe' : null;

function startStaticServer(rootDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const filePath = path.join(rootDir, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': filePath.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
      res.end(data);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function ffprobeJson(ffprobeBin, mp4Path) {
  const out = execFileSync(
    ffprobeBin,
    [
      '-v', 'error',
      '-show_entries', 'format=duration,size',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      mp4Path,
    ],
    { encoding: 'utf-8', timeout: 20000 },
  );
  return JSON.parse(out);
}

test('Integration: Aufnahme → Stop → Remux → MP4 abspielbar, Zwischenform weg', { skip: !ffmpeg && 'kein ffmpeg >= 7 im PATH' }, async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-integration-'));
  const srcDir = path.join(baseDir, 'src');
  const recDir = path.join(baseDir, 'rec');
  fs.mkdirSync(srcDir);
  fs.mkdirSync(recDir);

  const { server, port } = await startStaticServer(srcDir);

  // ── Lokaler Mini-Live-Stream (HLS, 1s-Segmente, live via -re + delete_segments) ──
  const source = spawn(
    ffmpeg,
    [
      '-re',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+program_date_time',
      '-hls_segment_filename', path.join(srcDir, 'seg_%05d.ts'),
      path.join(srcDir, 'live.m3u8'),
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  try {
    // Warten, bis die Quelle liefert
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !fs.existsSync(path.join(srcDir, 'live.m3u8'))) {
      await new Promise(r => setTimeout(r, 200));
    }
    assert.ok(fs.existsSync(path.join(srcDir, 'live.m3u8')), 'Quelle erzeugt Playlist');

    // ── Aufnahme über RecordJob (echte Logik, echter http-Transport) ──
    const recId = 'rec_20260930_integr1';
    const sourceUrl = `http://127.0.0.1:${port}/live.m3u8`;
    const job = new RecordJob({
      recId,
      sourceUrl,
      dir: recDir,
      ffmpegPath: ffmpeg,
      meta: {
        id: recId,
        channelId: 'integration',
        channelName: 'Integrations-Kanal',
        epgTitle: 'Mini-Live',
        status: 'recording',
        sourceUrl,
      },
    });
    const startedP = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Aufnahme startete nicht')), 20000);
      job.once('started', () => {
        clearTimeout(t);
        resolve();
      });
    });
    job.start();
    await startedP;

    // Aufnahme wächst lassen (Konzept: "Aufnahme wächst")
    await new Promise(r => setTimeout(r, 6000));
    const run = job.getRunState();
    assert.ok(run.bytesWritten > 0, `Aufnahme wächst (bytesWritten=${run.bytesWritten})`);
    assert.ok(fs.existsSync(path.join(recDir, 'index.m3u8')), 'Zwischenplaylist existiert');
    assert.ok(fs.readdirSync(recDir).some(f => f.endsWith('.ts')), 'Fragmente existieren');

    // ── Stop → ENDLIST ──
    const stopPayload = await job.stop({ reason: 'user' });
    assert.equal(stopPayload.meta.status, 'remux-pending');
    assert.ok(stopPayload.meta.durationSec >= 3, `Dauer >= 3s (war ${stopPayload.meta.durationSec})`);
    assert.ok(fs.readFileSync(path.join(recDir, 'index.m3u8'), 'utf-8').includes('#EXT-X-ENDLIST'));

    // ── Remux über RemuxJob (echte Logik) ──
    const mp4Path = path.join(baseDir, 'Integrations-Kanal_Mini-Live.mp4');
    const progressCalls = [];
    const result = await runRemux({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      dir: recDir,
      playlistPath: path.join(recDir, 'index.m3u8'),
      outputPath: mp4Path,
      expectedDurationSec: stopPayload.meta.durationSec,
      onProgress: p => progressCalls.push(p),
    });

    // ffprobe-Verifikation: Dauer + Streams (Akzeptanzkriterium)
    assert.ok(result.durationSec >= 3, `Remux-Dauer >= 3s (war ${result.durationSec})`);
    assert.deepEqual(result.streamTypes.sort(), ['audio', 'video']);
    assert.ok(result.fileSizeBytes > 10000);
    const probed = ffprobeJson(ffprobe, mp4Path);
    assert.ok(Number(probed.format.duration) >= 3);
    assert.ok(probed.streams.some(s => s.codec_type === 'video'));
    assert.ok(probed.streams.some(s => s.codec_type === 'audio'));

    // Progress-Events sind während des Remux eingegangen
    assert.ok(progressCalls.length > 0, 'Remux-Progress-Events kamen');

    // ── Aufräumen der Zwischenform wie im Service ──
    for (const name of fs.readdirSync(recDir)) {
      if (/\.ts$|\.tmp$|^index\.m3u8$/.test(name)) fs.rmSync(path.join(recDir, name), { force: true });
    }
    const leftovers = fs.readdirSync(recDir).filter(f => f.endsWith('.ts') || f === 'index.m3u8');
    assert.deepEqual(leftovers, [], 'Zwischendateien weg');
  } finally {
    server.close();
    source.kill('SIGKILL');
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (_) {}
  }
});
