'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  binaryPath,
  checkHealth,
  isBinaryHealthy,
  ffmpegReleaseTag,
  FFMPEG_SHA256_GZ,
} = require('../lib/ffmpeg.js');

function makeFakeApp({ ffmpegOut = 'ffmpeg version 7.0.2-static', ffprobeOut = 'ffprobe version 7.0.2-static' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-ffmpeg-test-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const writeFake = (name, out) => {
    const file = path.join(root, 'bin', name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${out}"\n`, { mode: 0o755 });
  };
  writeFake('ffmpeg', ffmpegOut);
  writeFake('ffprobe', ffprobeOut);
  return { root, binDir: path.join(root, 'bin') };
}

test('binaryPath zeigt auf <appRoot>/bin unabhängig von der Plattform', () => {
  const root = os.tmpdir();
  const p = binaryPath('ffmpeg', root);
  assert.equal(path.dirname(p), path.join(root, 'bin'));
  assert.match(path.basename(p), /^ffmpeg(\.exe)?$/);
});

test('Prüfsummen-Manifest deckt linux-x64 und beide Darwin-Architekturen ab', () => {
  for (const key of [
    'ffmpeg-linux-x64',
    'ffprobe-linux-x64',
    'ffmpeg-darwin-arm64',
    'ffprobe-darwin-arm64',
    'ffmpeg-darwin-x64',
    'ffprobe-darwin-x64',
  ]) {
    assert.match(FFMPEG_SHA256_GZ[key], /^[0-9a-f]{64}$/, `Checksummen-Format für ${key}`);
  }
  assert.equal(ffmpegReleaseTag(), 'b6.1.1');
});

test('checkHealth meldet Fehlschlag, wenn Binaries fehlen (leeres App-Root)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-ffmpeg-empty-'));
  const health = checkHealth(root);
  assert.equal(health.ok, false);
  assert.deepEqual(health.missing.sort(), ['ffmpeg', 'ffprobe']);
  assert.equal(health.ffmpegPath, null);
  assert.equal(health.ffprobePath, null);
});

test('checkHealth ist ok, wenn beide Binaries vorhanden, ausführbar und aktuell sind', () => {
  const fixture = makeFakeApp();
  const health = checkHealth(fixture.root);
  assert.equal(health.ok, true);
  assert.deepEqual(health.missing, []);
  assert.match(health.ffmpegPath, /bin\/ffmpeg$/);
  assert.match(health.ffprobePath, /bin\/ffprobe$/);
});

test('isBinaryHealthy lehnt nicht ausführbare oder stumme Binaries ab', () => {
  const fixture = makeFakeApp();
  assert.equal(isBinaryHealthy('ffmpeg', fixture.root), true);

  // ausführbar weg → ungesund
  fs.rmSync(path.join(fixture.binDir, 'ffmpeg'));
  assert.equal(isBinaryHealthy('ffmpeg', fixture.root), false);

  // Binary meldet keine Version → ungesund
  const silent = makeFakeApp({ ffmpegOut: 'nichts Erkennbares' });
  assert.equal(isBinaryHealthy('ffmpeg', silent.root), false);
});

test('isBinaryHealthy erzwingt die Mindestversion (>= 7.0.0)', () => {
  const tooOld = makeFakeApp({ ffmpegOut: 'ffmpeg version 6.1.1-static' });
  assert.equal(isBinaryHealthy('ffmpeg', tooOld.root), false);

  const same = makeFakeApp({ ffmpegOut: 'ffmpeg version 7.0.2-static' });
  assert.equal(isBinaryHealthy('ffmpeg', same.root), true);

  const newer = makeFakeApp({ ffmpegOut: 'ffmpeg version 7.1.0-static' });
  assert.equal(isBinaryHealthy('ffmpeg', newer.root), true);
});
