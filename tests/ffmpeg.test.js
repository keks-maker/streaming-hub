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
  ensureBinary,
  FFMPEG_SHA256_GZ,
  FFMPEG_SHA256_DARWIN,
  __clearUnpackedSha256CacheForTests,
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

test('Prüfsummen-Manifest deckt die unterstützten Plattformen ab', () => {
  // linux-x64: gepinnte .gz-Assets (ffmpeg-static b6.1.1)
  for (const key of ['ffmpeg-linux-x64', 'ffprobe-linux-x64']) {
    assert.match(FFMPEG_SHA256_GZ[key], /^[0-9a-f]{64}$/, `Checksummen-Format für ${key}`);
  }
  // darwin (arm64 + x64): gepinnte SHAs der ENTPACKTEN Binaries
  // (evermeet.cx 7.0.2; arm64 läuft über Rosetta 2)
  for (const key of [
    'ffmpeg-darwin-arm64',
    'ffprobe-darwin-arm64',
    'ffmpeg-darwin-x64',
    'ffprobe-darwin-x64',
  ]) {
    assert.match(FFMPEG_SHA256_DARWIN[key], /^[0-9a-f]{64}$/, `Checksummen-Format für ${key}`);
  }
  assert.equal(ffmpegReleaseTag(), process.platform === 'darwin' ? 'evermeet-7.0.2' : 'b6.1.1');
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

// ── Ensure-Schnellpfad (QA F-FB-03) ──
// Szenario des QA-Befunds: Binary vorhanden, Marker-Tag "passt" (vom früheren
// Ensure geschrieben), aber die Binary selbst ist alt/abweichend. Der
// Schnellpfad darf sie NICHT stillschweigend akzeptieren.

test('ensureBinary ersetzt abweichende Binary trotz passendem Marker-Tag (F-FB-03)', async () => {
  __clearUnpackedSha256CacheForTests();
  const fixture = makeFakeApp();
  // Bestand: gesund gemäß Mindestversion, aber SHA weicht vom Pin ab
  // (dargestellt durch eine andere ausführbare Binary mit 7.x-Ausgabe).
  const foreign = path.join(fixture.binDir, 'ffmpeg');
  fs.writeFileSync(foreign, '#!/bin/sh\necho "ffmpeg version 7.0.4-foreign"\n', { mode: 0o755 });
  // Marker so, wie ihn der Ensure der Vorgängerversion hinterlassen hat.
  fs.writeFileSync(path.join(fixture.binDir, '.ffmpeg-release'), `${ffmpegReleaseTag()}\n`);

  // Download-Ersatz: stellt die "gepinnte" Binary bereit (SHA ergibt den Pin).
  const pinned = path.join(fixture.binDir, '..', 'pinned-ffmpeg');
  fs.writeFileSync(pinned, '#!/bin/sh\necho "ffmpeg version 7.0.2-static"\n', { mode: 0o755 });
  const pinnedSha = require('../lib/ffmpeg.js').sha256File(pinned);
  require('../lib/ffmpeg.js').__setDownloadOverrideForTests((tool, tmpDir) => {
    const target = path.join(tmpDir, 'ffmpeg');
    fs.copyFileSync(pinned, target);
    return target;
  });

  try {
    const result = await ensureBinary('ffmpeg', fixture.root);
    assert.equal(result.action, 'downloaded');
    assert.ok(result.version);
    assert.equal(result.sha256, pinnedSha);
    // Ersatzbinärdatei wurde installiert und referenziert den Pin.
    assert.equal(require('../lib/ffmpeg.js').sha256File(fixture.binDir + '/ffmpeg'), pinnedSha);
    assert.equal(
      require('../lib/ffmpeg.js').readSha256References(fixture.root)[
        `ffmpeg-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'x64' ? 'x64' : 'arm64'}`
      ],
      pinnedSha,
    );
  } finally {
    require('../lib/ffmpeg.js').__setDownloadOverrideForTests(null);
  }
});

test('ensureBinary akzeptiert pin-identischen Bestand ohne Download (schneller Pfad)', async () => {
  __clearUnpackedSha256CacheForTests();
  const fixture = makeFakeApp();
  const fake = path.join(fixture.binDir, 'ffmpeg');
  // Pin-Referenz der installierten Binary persistieren (Zustand nach einer
  // echten Installation) und Marker passend setzen.
  const sha = require('../lib/ffmpeg.js').sha256File(fake);
  require('../lib/ffmpeg.js').writeSha256Reference(fixture.root, 'ffmpeg', sha);
  fs.writeFileSync(path.join(fixture.binDir, '.ffmpeg-release'), `${ffmpegReleaseTag()}\n`);

  const result = await ensureBinary('ffmpeg', fixture.root);
  assert.equal(result.action, 'ok');
  assert.equal(result.sha256, sha);
  assert.ok(result.version);
});
