'use strict';

// Tests nutzen Fake-Bundles unter <appRoot>/bin — System-ffmpeg-Präferenz aus.
process.env.STREAMING_HUB_FFMPEG = 'bundled';

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
  // (x64: evermeet.cx 7.0.2 / x86_64; arm64: osxexperts 7.1 / nativ arm64) — getrennte Hashes
  for (const key of [
    'ffmpeg-darwin-arm64',
    'ffprobe-darwin-arm64',
    'ffmpeg-darwin-x64',
    'ffprobe-darwin-x64',
  ]) {
    assert.match(FFMPEG_SHA256_DARWIN[key], /^[0-9a-f]{64}$/, `Checksummen-Format für ${key}`);
  }
  assert.notEqual(FFMPEG_SHA256_DARWIN['ffmpeg-darwin-arm64'], FFMPEG_SHA256_DARWIN['ffmpeg-darwin-x64']);
  assert.notEqual(FFMPEG_SHA256_DARWIN['ffprobe-darwin-arm64'], FFMPEG_SHA256_DARWIN['ffprobe-darwin-x64']);
  if (process.platform === 'darwin') {
    assert.equal(ffmpegReleaseTag('x64'), 'evermeet-7.0.2');
    assert.equal(ffmpegReleaseTag('arm64'), 'osxexperts-7.1-arm64');
  } else {
    assert.equal(ffmpegReleaseTag(), 'b6.1.1');
  }
});

// ── Mach-O-Architektur (Rosetta-Ausstieg, macOS 28) ──

function writeMachO(file, cpuType, { fat = false } = {}) {
  const buf = Buffer.alloc(64);
  if (fat) {
    buf.writeUInt32BE(0xcafebabe, 0);
    buf.writeUInt32BE(2, 4);
    buf.writeUInt32BE(0x01000007, 8);
    buf.writeUInt32BE(0x0100000c, 28);
  } else {
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(cpuType, 4);
  }
  fs.writeFileSync(file, buf, { mode: 0o755 });
}

test('machoArchs liest Thin-/Fat-Header und ignoriert Skripte', () => {
  const { machoArchs } = require('../lib/ffmpeg.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-macho-'));
  writeMachO(path.join(dir, 'x'), 0x01000007);
  writeMachO(path.join(dir, 'a'), 0x0100000c);
  writeMachO(path.join(dir, 'f'), 0, { fat: true });
  fs.writeFileSync(path.join(dir, 's'), '#!/bin/sh\n');
  assert.deepEqual(machoArchs(path.join(dir, 'x')), ['x64']);
  assert.deepEqual(machoArchs(path.join(dir, 'a')), ['arm64']);
  assert.deepEqual(machoArchs(path.join(dir, 'f')), ['x64', 'arm64']);
  assert.equal(machoArchs(path.join(dir, 's')), null);
  assert.equal(machoArchs(path.join(dir, 'fehlt')), null);
});

test('Health-Check: x86_64-Mach-O gilt auf arm64-Zielarchitektur nicht als gesund (darwin)', { skip: process.platform !== 'darwin' }, () => {
  const fixture = makeFakeApp();
  writeMachO(path.join(fixture.binDir, 'ffmpeg'), 0x01000007);
  assert.equal(isBinaryHealthy('ffmpeg', fixture.root, 'arm64'), false, 'x86_64 auf arm64 → ungesund');
  // Cross-Prüfung ohne Ausführung: passende Architektur genügt.
  assert.equal(isBinaryHealthy('ffmpeg', fixture.root, 'x64'), process.arch === 'x64' ? false : true);
  writeMachO(path.join(fixture.binDir, 'ffmpeg'), 0x0100000c);
  assert.equal(isBinaryHealthy('ffmpeg', fixture.root, 'x64'), false, 'arm64 auf x64-Ziel → ungesund');
  assert.equal(isBinaryHealthy('ffmpeg', fixture.root, 'arm64'), process.arch === 'arm64' ? false : true);
});

test('ensureBinary (Cross-Ziel) ersetzt Altbestand anderer Architektur und setzt arch-eigenen Marker', { skip: process.platform !== 'darwin' }, async () => {
  const lib = require('../lib/ffmpeg.js');
  __clearUnpackedSha256CacheForTests();
  // Zielarchitektur ≠ Host: kein -version-Smoke (nicht ausführbar), Header-Prüfung greift.
  const target = process.arch === 'arm64' ? 'x64' : 'arm64';
  const targetCpu = target === 'arm64' ? 0x0100000c : 0x01000007;
  const otherCpu = target === 'arm64' ? 0x01000007 : 0x0100000c;
  const fixture = makeFakeApp();
  writeMachO(path.join(fixture.binDir, 'ffmpeg'), otherCpu);
  fs.writeFileSync(path.join(fixture.binDir, '.ffmpeg-release'), 'alt-tag\n');
  const staged = path.join(fixture.root, 'staged-ffmpeg');
  writeMachO(staged, targetCpu);
  const copyStaged = (tool, tmpDir) => {
    const dest = path.join(tmpDir, 'ffmpeg');
    fs.copyFileSync(staged, dest);
    return dest;
  };
  try {
    lib.__setDownloadOverrideForTests(copyStaged);
    const result = await lib.ensureBinary('ffmpeg', fixture.root, { arch: target });
    assert.equal(result.action, 'downloaded');
    assert.deepEqual(lib.machoArchs(path.join(fixture.binDir, 'ffmpeg')), [target]);
    assert.equal(fs.readFileSync(path.join(fixture.binDir, '.ffmpeg-release'), 'utf-8').trim(), lib.ffmpegReleaseTag(target));
    assert.ok(lib.readSha256References(fixture.root)[`ffmpeg-darwin-${target}`]);
    // Falsche Architektur im Download wird verworfen.
    writeMachO(staged, otherCpu);
    await assert.rejects(lib.ensureBinary('ffmpeg', fixture.root, { arch: target, force: true }), /Architektur/);
  } finally {
    lib.__setDownloadOverrideForTests(null);
  }
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

// ── Versions-Parser + System-Binary-Präferenz ──

test('parseVersion versteht Bundle- und Distro-/Git-Tag-Versionen (n9.0.2)', () => {
  const { parseVersion } = require('../lib/ffmpeg.js');
  assert.deepEqual(parseVersion('ffmpeg version 7.0.2-static https://johnvansickle.com'), [7, 0, 2]);
  assert.deepEqual(parseVersion('ffmpeg version n9.0.2 Copyright (c) 2000-2026'), [9, 0, 2]);
  // osxexperts-Release ohne Patchstufe; die clang-Zeile darf nicht als ffmpeg-Version zählen.
  assert.deepEqual(
    parseVersion('ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with Apple clang version 13.1.6 (clang-1316.0.21.2.5)'),
    [7, 1, 0],
  );
  assert.equal(parseVersion('kein Treffer'), null);
});

test('System-Binary (Linux): brauchbares ≥7.0 wird bevorzugt, abstürzendes oder altes nicht', { skip: process.platform !== 'linux' }, () => {
  const lib = require('../lib/ffmpeg.js');
  const saved = { PATH: process.env.PATH, MODE: process.env.STREAMING_HUB_FFMPEG };
  const mkSys = (version, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-sysbin-'));
    for (const tool of ['ffmpeg', 'ffprobe']) {
      fs.writeFileSync(
        path.join(dir, tool),
        `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "${tool} version ${version}"; exit 0; fi\n${body}\n`,
        { mode: 0o755 },
      );
    }
    return dir;
  };
  try {
    delete process.env.STREAMING_HUB_FFMPEG;
    const run = sysDir => {
      process.env.PATH = `${sysDir}:/usr/bin:/bin`;
      const fixture = makeFakeApp();
      lib.__clearResolveCacheForTests();
      return { fixture, health: lib.checkHealth(fixture.root), path: lib.resolveBinaryPath('ffmpeg', fixture.root) };
    };

    const good = mkSys('n9.0.2', 'exit 1'); // reguläres Exit ≠ 0 bei Verbindungsfehler
    const g = run(good);
    assert.equal(g.path, path.join(good, 'ffmpeg'));
    assert.equal(g.health.ffmpegPath, path.join(good, 'ffmpeg'));

    const crashing = mkSys('n9.0.2', 'kill -SEGV $$');
    const c = run(crashing);
    assert.equal(c.path, binaryPath('ffmpeg', c.fixture.root), 'abstürzendes System-Binary → Bundle');

    const old = mkSys('6.1.1', 'exit 1');
    const o = run(old);
    assert.equal(o.path, binaryPath('ffmpeg', o.fixture.root), 'zu altes System-Binary → Bundle');

    process.env.STREAMING_HUB_FFMPEG = 'bundled';
    const b = run(good);
    assert.equal(b.path, binaryPath('ffmpeg', b.fixture.root), 'Schalter bundled → Bundle');
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.MODE === undefined) delete process.env.STREAMING_HUB_FFMPEG;
    else process.env.STREAMING_HUB_FFMPEG = saved.MODE;
    lib.__clearResolveCacheForTests();
  }
});
