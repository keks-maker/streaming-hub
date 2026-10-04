'use strict';

// Test: Speicher voll auf einem ECHTEN, kleinen Volume (Konzept §3.9, §5).
//
// Ablauf: kleines Disk-Image (hdiutil, HFS+) wird gemountet; ein lokaler,
// gedrosselter HTTP-Server liefert eine große VOD-HLS-Quelle (echtes ffmpeg
// erzeugt sie); der RecorderService nimmt mit echtem ffmpeg auf das Volume
// auf, bis die Reserve unterschritten ist. Erwartung: kontrolliert gestoppt
// (Grund 'disk-full'), Remux zurückgestellt (zu wenig Platz), die HLS-Form ist
// mit ffprobe lesbar und mit `ffmpeg -v error -i … -f null -` ohne Fehler
// dekodierbar.
//
// SKIP-FÄHIG: Der Test hängt ein Disk-Image ein (Nebenwirkung auf dem Host,
// ~30–60 s) und läuft deshalb nur, wenn STREAMING_HUB_VOLUME_TEST=1 gesetzt ist
// UND macOS + hdiutil + das gebündelte echte ffmpeg (bin/ffmpeg) vorhanden sind.
//   STREAMING_HUB_VOLUME_TEST=1 node --test tests/recorder-disk-full-volume.test.js
// Linux: kein hdiutil → wird übersprungen (dort wäre ein tmpfs-Mount nötig,
// der root-Rechte braucht und nicht automatisierbar ist).

process.env.STREAMING_HUB_FFMPEG = 'bundled';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FFMPEG = path.join(ROOT, 'bin', 'ffmpeg');
const FFPROBE = path.join(ROOT, 'bin', 'ffprobe');

function hasHdiutil() {
  return process.platform === 'darwin' && spawnSync('which', ['hdiutil']).status === 0;
}

const skipReason =
  process.env.STREAMING_HUB_VOLUME_TEST !== '1'
    ? 'STREAMING_HUB_VOLUME_TEST=1 nicht gesetzt (Test hängt ein Disk-Image ein)'
    : !hasHdiutil()
      ? 'kein macOS/hdiutil'
      : !fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)
        ? 'echtes ffmpeg/ffprobe in bin/ fehlt'
        : false;

const MB = 1024 * 1024;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → ${r.status}: ${(r.stderr || r.stdout || '').slice(-400)}`);
  return r;
}

// Große VOD-HLS-Quelle: MPEG-2 mit hoher Bitrate füllt das Volume schnell
// (kopierbar mit -c copy, schnell zu erzeugen).
function generateSource(dir, seconds) {
  run(FFMPEG, [
    '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'mpeg2video', '-b:v', '60M', '-minrate', '60M', '-maxrate', '60M', '-bufsize', '12M',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, 'src_%03d.ts'),
    path.join(dir, 'index.m3u8'),
  ]);
}

// Gedrosselter Server (~8 MB/s für .ts): das Volume läuft „live-artig“ voll,
// damit der 200-ms-Tick vor ENOSPC eingreifen kann.
function startThrottledServer(dir, bytesPerSec = 8 * MB) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(new URL(req.url, 'http://x').pathname));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const data = fs.readFileSync(file);
    const isTs = file.endsWith('.ts');
    res.writeHead(200, {
      'Content-Type': isTs ? 'video/mp2t' : 'application/vnd.apple.mpegurl',
      'Content-Length': data.length,
    });
    if (!isTs) {
      res.end(data);
      return;
    }
    const chunk = 64 * 1024;
    const delay = Math.max(1, Math.floor((chunk / bytesPerSec) * 1000));
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= data.length || res.destroyed) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(data.subarray(offset, offset + chunk));
      offset += chunk;
    }, delay);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('Speicher voll auf echtem Volume: kontrolliert gestoppt, Zwischenform abspielbar (ffprobe + Decode-Check)', { skip: skipReason, timeout: 240000 }, async () => {
  const { RecorderService } = require('../lib/recorder/RecorderService.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-volume-test-'));
  const image = path.join(work, 'small.dmg');
  const mountPoint = path.join(work, 'mnt');
  const srcDir = path.join(work, 'src');
  fs.mkdirSync(mountPoint);
  fs.mkdirSync(srcDir);
  let attached = false;
  let server = null;
  try {
    // 150-MB-Volume (mehr als MIN_FREE_DISK_BYTES = 64 MiB des Start-Checks)
    run('hdiutil', ['create', '-size', '150m', '-fs', 'HFS+', '-volname', 'SHVOLTEST', image]);
    run('hdiutil', ['attach', image, '-nobrowse', '-mountpoint', mountPoint]);
    attached = true;

    generateSource(srcDir, 20); // ≈ 150 MB Quelle > Volume
    const srcBytes = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts')).reduce((n, f) => n + fs.statSync(path.join(srcDir, f)).size, 0);
    assert.ok(srcBytes > 140 * MB, `Quelle muss größer als das Volume sein (ist ${Math.round(srcBytes / MB)} MB)`);
    server = await startThrottledServer(srcDir);
    const url = `http://127.0.0.1:${server.address().port}/index.m3u8`;

    const storage = path.join(mountPoint, 'Aufnahmen-Root');
    fs.mkdirSync(storage);
    const service = new RecorderService({
      appRoot: ROOT,
      storageRoot: storage,
      reserveMB: 100, // großzügig: Überschuss = Quellrate (8 MB/s) × (Tick + ffmpeg-Stoppzeit ≈ 2 s)
      minReserveBytes: 16 * MB, // Test-Seam: Produktion = 512 MB
      sizeTickMs: 200,
    });
    const freeAt = [];
    const autoStop = new Promise(resolve =>
      service.once('recording:auto-stopped', p => {
        const st0 = fs.statfsSync(mountPoint);
        freeAt.push(Math.round((st0.bavail * st0.bsize) / MB));
        resolve(p);
      }),
    );
    const deferred = new Promise(resolve =>
      service.on('recording:changed', p => {
        if (p.meta.remuxDeferredReason) resolve(p.meta);
      }),
    );
    const { recId } = await service.start({ channelId: 'volume-test', channelName: 'Volume Test', epgTitle: 'Voll', sourceUrl: url });

    const info = await Promise.race([
      autoStop,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Kein Auto-Stopp innerhalb 120 s')), 120000)),
    ]);
    assert.equal(info.reason, 'disk-full');
    const meta = await deferred;
    assert.equal(meta.status, 'remux-pending');
    assert.equal(meta.stopReason, 'disk-full');
    assert.equal(meta.remuxDeferredReason, 'Nicht konvertiert — Speicher knapp');

    const jobDir = path.join(storage, 'Aufnahmen', recId);
    const playlist = path.join(jobDir, 'index.m3u8');
    assert.match(fs.readFileSync(playlist, 'utf-8'), /#EXT-X-ENDLIST/);

    // Volume ist nicht „restlos“ voll: Platz für Playlist-Abschluss/Meta blieb
    const st = fs.statfsSync(mountPoint);
    assert.ok(st.bavail * st.bsize > 1 * MB, `Rest-Platz > 1 MB (bei Auto-Stopp ${freeAt[0]} MB frei, danach ${Math.round((st.bavail * st.bsize) / MB * 100) / 100} MB)`);

    // ffprobe: Dauer + Streams lesbar
    const probe = JSON.parse(
      run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', playlist]).stdout,
    );
    assert.ok(Number(probe.format.duration) > 2, 'Dauer > 2 s');
    const types = probe.streams.map(s => s.codec_type);
    assert.ok(types.includes('video'));

    // Decode-Check: komplette Zwischenform fehlerfrei dekodierbar
    const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', playlist, '-f', 'null', '-'], { encoding: 'utf-8' });
    assert.equal(decode.status, 0, `Decode-Check Exit-Code: ${decode.stderr}`);
    assert.equal(decode.stderr.trim(), '', `Decode-Check ohne Fehlerzeilen, war: ${decode.stderr.slice(0, 300)}`);
    assert.equal(service.activeJobs().length, 0);
  } finally {
    if (server) server.close();
    if (attached) spawnSync('hdiutil', ['detach', mountPoint, '-force']);
    fs.rmSync(work, { recursive: true, force: true });
  }
});
