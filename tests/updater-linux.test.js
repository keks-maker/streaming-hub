'use strict';

// Linux-Release-Updater: tar.gz-Entpacken, Paketpruefung, atomarer Austausch mit Rollback.
// Die Tests nutzen Dummy-Pakete (ELF-Header + Textdateien); ein echtes Linux-System ist nicht noetig.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { applyLinuxRelease, extractLinuxArchive, assertSafeArchiveEntries } = require('../updater.js');
const { installLinuxRelease, verifyLinuxInstall, findLinuxAppRoot, isLinuxX64Elf } = require('../lib/linux-install.js');

// 64-Bit-ELF, little endian, e_machine 0x3E (x86-64)
function elfHeader() {
  const head = Buffer.alloc(64);
  head.write('\x7fELF', 0, 'latin1');
  head[4] = 2;
  head[5] = 1;
  head.writeUInt16LE(0x3e, 18);
  return head;
}

function makeRelease(parent, name, version, extra = {}) {
  const root = path.join(parent, name);
  const app = path.join(root, 'resources', 'app');
  fs.mkdirSync(path.join(app, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'streaming-hub'), extra.exe || elfHeader(), { mode: extra.exeMode ?? 0o755 });
  fs.writeFileSync(path.join(root, 'chrome-sandbox'), 'sb', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'chrome_crashpad_handler'), 'ch', { mode: 0o755 });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: extra.pkgName || 'streaming-hub', version: extra.pkgVersion || version }));
  for (const f of ['main.js', 'preload.js', 'updater.js']) fs.writeFileSync(path.join(app, f), `// ${version}`);
  fs.writeFileSync(path.join(root, 'marker.txt'), version);
  return root;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sh-linux-upd-'));
}

test('verifyLinuxInstall: gueltiges Paket ok, Fehler werden benannt', () => {
  const base = tmp();
  try {
    const ok = makeRelease(base, 'ok', '1.0.0');
    assert.deepEqual(verifyLinuxInstall(ok, { version: '1.0.0' }), { ok: true, errors: [] });
    assert.match(verifyLinuxInstall(ok, { version: '2.0.0' }).errors.join(), /stimmt nicht/);
    assert.match(verifyLinuxInstall(makeRelease(base, 'macho', '1.0.0', { exe: Buffer.from('MZ-not-elf-padding-padding') })).errors.join(), /kein x86-64-ELF/);
    const arm = elfHeader();
    arm.writeUInt16LE(0xb7, 18);
    assert.match(verifyLinuxInstall(makeRelease(base, 'arm', '1.0.0', { exe: arm })).errors.join(), /kein x86-64-ELF/);
    assert.match(verifyLinuxInstall(makeRelease(base, 'noexec', '1.0.0', { exeMode: 0o644 })).errors.join(), /nicht ausfuehrbar/);
    assert.match(verifyLinuxInstall(makeRelease(base, 'foreign', '1.0.0', { pkgName: 'other' })).errors.join(), /gehoert nicht/);
    const abs = makeRelease(base, 'abs', '1.0.0');
    fs.symlinkSync('/etc/passwd', path.join(abs, 'evil'));
    assert.match(verifyLinuxInstall(abs).errors.join(), /Symlink verlaesst/);
    const up = makeRelease(base, 'up', '1.0.0');
    fs.symlinkSync('../../outside', path.join(up, 'evil'));
    assert.match(verifyLinuxInstall(up).errors.join(), /Symlink verlaesst/);
    const dead = makeRelease(base, 'dead', '1.0.0');
    fs.symlinkSync('missing', path.join(dead, 'dead'));
    assert.match(verifyLinuxInstall(dead).errors.join(), /toter Symlink/);
    assert.equal(isLinuxX64Elf(path.join(ok, 'main-missing')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installLinuxRelease: frische Installation, Programm startfaehig (Modus-Bits), Staging aufgeraeumt', () => {
  const base = tmp();
  try {
    const next = makeRelease(path.join(base, 'extract'), 'streaming-hub-1.1.0', '1.1.0', { exeMode: 0o644 });
    const install = path.join(base, 'share', 'streaming-hub');
    installLinuxRelease(next, install, { version: '1.1.0' });
    assert.equal(fs.readFileSync(path.join(install, 'marker.txt'), 'utf-8'), '1.1.0');
    assert.ok(fs.statSync(path.join(install, 'streaming-hub')).mode & 0o100, 'streaming-hub ausfuehrbar');
    assert.ok(fs.statSync(path.join(install, 'chrome_crashpad_handler')).mode & 0o100);
    assert.deepEqual(fs.readdirSync(path.join(base, 'share')), ['streaming-hub']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installLinuxRelease: Update ersetzt alten Stand, uebernimmt ffmpeg, Nutzerdaten ausserhalb bleiben', () => {
  const base = tmp();
  try {
    const install = path.join(base, 'share', 'streaming-hub');
    const userData = path.join(base, 'config', 'Streaming Hub');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'tvsources.json'), '{"user":1}');
    installLinuxRelease(makeRelease(path.join(base, 'e1'), 'r', '1.0.0'), install, { version: '1.0.0' });
    fs.mkdirSync(path.join(install, 'resources', 'app', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(install, 'resources', 'app', 'bin', 'ffmpeg'), 'FF', { mode: 0o755 });
    fs.writeFileSync(path.join(install, 'resources', 'app', 'bin', '.ffmpeg-release'), 'b6.1.1');
    fs.writeFileSync(path.join(install, 'old-only.txt'), 'x');

    installLinuxRelease(makeRelease(path.join(base, 'e2'), 'r', '1.1.0'), install, { version: '1.1.0' });
    assert.equal(fs.readFileSync(path.join(install, 'marker.txt'), 'utf-8'), '1.1.0');
    assert.equal(fs.existsSync(path.join(install, 'old-only.txt')), false);
    assert.equal(fs.readFileSync(path.join(install, 'resources', 'app', 'bin', 'ffmpeg'), 'utf-8'), 'FF');
    assert.ok(fs.statSync(path.join(install, 'resources', 'app', 'bin', 'ffmpeg')).mode & 0o100);
    assert.equal(fs.readFileSync(path.join(userData, 'tvsources.json'), 'utf-8'), '{"user":1}');
    assert.deepEqual(fs.readdirSync(path.join(base, 'share')), ['streaming-hub']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installLinuxRelease: ungueltiges Paket (falsche Version, kein ELF) laesst alten Stand unberuehrt', () => {
  const base = tmp();
  try {
    const install = path.join(base, 'share', 'streaming-hub');
    installLinuxRelease(makeRelease(path.join(base, 'e1'), 'r', '1.0.0'), install, { version: '1.0.0' });
    assert.throws(() => installLinuxRelease(makeRelease(path.join(base, 'e2'), 'r', '1.1.0', { pkgVersion: '0.0.1' }), install, { version: '1.1.0' }), /Version im Paket/);
    assert.throws(() => installLinuxRelease(makeRelease(path.join(base, 'e3'), 'r', '1.1.0', { exe: Buffer.from('#!/bin/sh\nrm -rf /\n') }), install, { version: '1.1.0' }), /kein x86-64-ELF/);
    assert.equal(fs.readFileSync(path.join(install, 'marker.txt'), 'utf-8'), '1.0.0');
    assert.deepEqual(fs.readdirSync(path.join(base, 'share')), ['streaming-hub']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installLinuxRelease: Fehler direkt nach dem Swap rollt vollstaendig zurueck', () => {
  const base = tmp();
  try {
    const install = path.join(base, 'share', 'streaming-hub');
    installLinuxRelease(makeRelease(path.join(base, 'e1'), 'r', '1.0.0'), install, { version: '1.0.0' });
    assert.throws(
      () => installLinuxRelease(makeRelease(path.join(base, 'e2'), 'r', '1.1.0'), install, {
        version: '1.1.0',
        afterSwap: () => { throw new Error('Abbruch nach Swap'); },
      }),
      /Abbruch nach Swap/,
    );
    assert.equal(fs.readFileSync(path.join(install, 'marker.txt'), 'utf-8'), '1.0.0');
    assert.deepEqual(fs.readdirSync(path.join(base, 'share')), ['streaming-hub']);
    assert.deepEqual(verifyLinuxInstall(install, { version: '1.0.0' }), { ok: true, errors: [] });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installLinuxRelease: Selbstheilung holt Installation aus stale Rollback zurueck', () => {
  const base = tmp();
  try {
    const share = path.join(base, 'share');
    const install = path.join(share, 'streaming-hub');
    const staleRollback = `${install}.update-rollback-99999`;
    fs.mkdirSync(share, { recursive: true });
    fs.renameSync(makeRelease(path.join(base, 'e0'), 'r', '1.0.0'), staleRollback);
    fs.mkdirSync(`${install}.update-staging-88888`);
    installLinuxRelease(makeRelease(path.join(base, 'e1'), 'r', '1.1.0'), install, { version: '1.1.0' });
    assert.equal(fs.readFileSync(path.join(install, 'marker.txt'), 'utf-8'), '1.1.0');
    assert.deepEqual(fs.readdirSync(share), ['streaming-hub']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('assertSafeArchiveEntries lehnt absolute Pfade und ".." ab', () => {
  assertSafeArchiveEntries('streaming-hub-1.0.0/\nstreaming-hub-1.0.0/streaming-hub\n');
  assert.throws(() => assertSafeArchiveEntries('/etc/passwd\n'), /Unsicherer Pfad/);
  assert.throws(() => assertSafeArchiveEntries('a/../../b\n'), /Unsicherer Pfad/);
});

test('extractLinuxArchive + findLinuxAppRoot: echtes tar.gz mit einem Top-Level-Verzeichnis', () => {
  const base = tmp();
  try {
    const src = path.join(base, 'src');
    makeRelease(src, 'streaming-hub-1.0.0', '1.0.0');
    const archive = path.join(base, 'a.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'streaming-hub-1.0.0']);
    const install = path.join(base, 'share', 'streaming-hub');
    fs.mkdirSync(path.dirname(install), { recursive: true });
    const { extractDir, appRoot } = extractLinuxArchive(archive, install);
    assert.equal(path.basename(appRoot), 'streaming-hub-1.0.0');
    assert.ok(fs.statSync(path.join(appRoot, 'streaming-hub')).mode & 0o100, 'Ausfuehrbar-Bit bleibt im tar erhalten');
    assert.equal(findLinuxAppRoot(extractDir), appRoot);
    fs.rmSync(extractDir, { recursive: true, force: true });
    // Archiv ohne App-Verzeichnis
    fs.mkdirSync(path.join(base, 'bad', 'x'), { recursive: true });
    fs.writeFileSync(path.join(base, 'bad', 'x', 'f.txt'), 'x');
    const badArchive = path.join(base, 'bad.tar.gz');
    execFileSync('tar', ['-czf', badArchive, '-C', path.join(base, 'bad'), 'x']);
    assert.throws(() => extractLinuxArchive(badArchive, install), /kein Linux-App-Verzeichnis/);
    assert.deepEqual(fs.readdirSync(path.dirname(install)), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('applyLinuxRelease: Download, Entpacken, Installieren (gemocktes fetch), Temp-Dateien weg', async () => {
  const base = tmp();
  const realFetch = global.fetch;
  const oldEnv = process.env.STREAMING_HUB_LINUX_INSTALL_DIR;
  try {
    const src = path.join(base, 'src');
    makeRelease(src, 'streaming-hub-1.2.0', '1.2.0');
    const archive = path.join(base, 'a.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'streaming-hub-1.2.0']);
    const bytes = fs.readFileSync(archive);
    global.fetch = async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    const install = path.join(base, 'share', 'streaming-hub');
    process.env.STREAMING_HUB_LINUX_INSTALL_DIR = install;
    installLinuxRelease(makeRelease(path.join(base, 'old'), 'r', '1.0.0'), install, { version: '1.0.0' });
    const steps = [];
    await applyLinuxRelease(
      { version: '1.2.0', asset: { name: 'Streaming.Hub-1.2.0-linux-x64.tar.gz', browserDownloadUrl: 'https://example.test/a.tar.gz' } },
      message => steps.push(message.percent),
    );
    assert.deepEqual(steps, [15, 70]);
    assert.equal(fs.readFileSync(path.join(install, 'marker.txt'), 'utf-8'), '1.2.0');
    assert.deepEqual(fs.readdirSync(path.join(base, 'share')), ['streaming-hub']);
    // Falsche Version im Paket → Fehler, alter Stand bleibt
    await assert.rejects(
      applyLinuxRelease({ version: '9.9.9', asset: { name: 'x.tar.gz', browserDownloadUrl: 'https://example.test/a.tar.gz' } }, () => {}),
      /Version im Paket/,
    );
    assert.equal(fs.readFileSync(path.join(install, 'marker.txt'), 'utf-8'), '1.2.0');
    assert.deepEqual(fs.readdirSync(path.join(base, 'share')), ['streaming-hub']);
  } finally {
    global.fetch = realFetch;
    if (oldEnv === undefined) delete process.env.STREAMING_HUB_LINUX_INSTALL_DIR; else process.env.STREAMING_HUB_LINUX_INSTALL_DIR = oldEnv;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
