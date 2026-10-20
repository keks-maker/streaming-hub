'use strict';

// Test-Helfer für die Download-Tests: ffmpeg/ffprobe aus bin/ (Symlink im Worktree), Mini-Testmedien per lavfi und ein lokaler
// HTTP-Server mit Range-Unterstützung (kein Netz). Dateien in tests/helpers sind keine Tests.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FFMPEG = path.join(ROOT, 'bin', 'ffmpeg');
const FFPROBE = path.join(ROOT, 'bin', 'ffprobe');

/** { ffmpeg, ffprobe } oder null, wenn die Binaries fehlen/nicht laufen (Tests werden dann übersprungen). */
function binaries() {
  for (const file of [FFMPEG, FFPROBE]) {
    const result = spawnSync(file, ['-version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return null;
  }
  return { ffmpeg: FFMPEG, ffprobe: FFPROBE };
}

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path.basename(file)} fehlgeschlagen: ${(result.stderr || '').slice(-300)}`);
  return result.stdout;
}

/** Erzeugt in dir: video.mp4 (H.264+AAC, 4 s), ad.mp4 (anderer Ton, gleiches Bild), sub.vtt (WebVTT). */
function makeMedia(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'video.mp4');
  const ad = path.join(dir, 'ad.mp4');
  const vtt = path.join(dir, 'sub.vtt');
  const common = ['-v', 'error', '-y'];
  run(FFMPEG, [...common, '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', video]);
  run(FFMPEG, [...common, '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', ad]);
  fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHallo Welt\n\n00:00:02.500 --> 00:00:03.500\nZweite Zeile\n');
  return { video, ad, vtt };
}

/** ffprobe-JSON einer Datei (Streams mit Tags/Disposition, Format). */
function probe(file) {
  return JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

/**
 * Lokaler Server für Dateien aus einem Verzeichnis, mit Range (206) und Statistik. options: ignoreRange (200 statt 206),
 * status(path, request) -> Zahl | null (Fehlerstatus erzwingen), etag, slowChunkMs (bremst die Auslieferung), dropAfter (Bytes, dann
 * Verbindung trennen; nur beim ersten Abruf je Datei).
 */
function startServer(dir, options = {}) {
  const requests = [];
  const dropped = new Set();
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(request.url.split('?')[0].slice(1));
    requests.push({ name, range: request.headers.range || null, ifRange: request.headers['if-range'] || null, userAgent: request.headers['user-agent'] });
    const forced = options.status ? options.status(name, request) : null;
    if (forced) {
      response.writeHead(forced);
      return response.end();
    }
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      response.writeHead(404);
      return response.end();
    }
    const data = fs.readFileSync(file);
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (options.etag) headers.ETag = options.etag;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    let body = data;
    let status = 200;
    if (match && !options.ignoreRange) {
      const start = Number(match[1]);
      if (start >= data.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        return response.end();
      }
      const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      body = data.subarray(start, end + 1);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
    }
    headers['Content-Length'] = body.length;
    response.writeHead(status, headers);
    if (options.dropAfter && !dropped.has(name) && status === 200) {
      dropped.add(name);
      response.write(body.subarray(0, options.dropAfter));
      setTimeout(() => response.destroy(), 30);
      return undefined;
    }
    if (options.slowChunkMs) {
      let offset = 0;
      const step = () => {
        if (offset >= body.length) return response.end();
        response.write(body.subarray(offset, offset + 4096));
        offset += 4096;
        return setTimeout(step, options.slowChunkMs);
      };
      return step();
    }
    return response.end(body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: name => `http://127.0.0.1:${server.address().port}/${name}`, requests, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

module.exports = { binaries, makeMedia, probe, startServer, FFMPEG, FFPROBE };
