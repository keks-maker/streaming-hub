process.env.STREAMING_HUB_UPDATER_SKIP_SIGNATURE = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMacBundle, resignBundleAdHoc } = require('../updater.js');
const { verifyBundleIntegrity, isOtoolUnavailable, isMachOFile } = require('../lib/bundle-install.js');

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);

function makeBundle(root, { macho = true, marker = 'new' } = {}) {
  const bundle = path.join(root, 'src', 'Streaming Hub.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents', 'Frameworks', 'Libs'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents', 'Resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleExecutable</key><string>Streaming Hub</string></dict></plist>');
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Streaming Hub'), macho ? MACHO : 'not macho');
  fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'app', 'release.txt'), marker);
  return bundle;
}

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const darwin = { skip: process.platform !== 'darwin' && 'otool-Gate nur unter macOS' };
const otoolGate = (bundle, otoolPath) => verifyBundleIntegrity(bundle, {
  symlinks: false, resolvable: false, frameworks: true, otool: true, otoolPath,
});

test('isOtoolUnavailable erkennt nur den Shim ohne Developer Tools', () => {
  assert.equal(isOtoolUnavailable({ stderr: 'xcode-select: note: No developer tools were found, requesting install.' }), true);
  assert.equal(isOtoolUnavailable({ message: 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)' }), true);
  assert.equal(isOtoolUnavailable({ stderr: 'otool: error: truncated or malformed object' }), false);
});

test('isMachOFile prüft den Mach-O-Header', () => {
  const root = tmp('sh-macho-');
  try {
    const good = path.join(root, 'good'); fs.writeFileSync(good, MACHO);
    const bad = path.join(root, 'bad'); fs.writeFileSync(bad, 'text');
    assert.equal(isMachOFile(good), true);
    assert.equal(isMachOFile(bad), false);
    assert.equal(isMachOFile(path.join(root, 'missing')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('otool fehlt (Shim ohne CLT): Mach-O-Ersatzprüfung, kein Abbruch', darwin, () => {
  const root = tmp('sh-otool-');
  try {
    const shim = script(root, 'otool', 'echo "xcode-select: note: No developer tools were found, requesting install." >&2; exit 1');
    assert.deepEqual(otoolGate(makeBundle(root), shim), { ok: true, errors: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('otool fehlt UND Haupt-Binary kein Mach-O: weiterhin Fehler', darwin, () => {
  const root = tmp('sh-otool-');
  try {
    const shim = script(root, 'otool', 'echo "No developer tools" >&2; exit 1');
    const gate = otoolGate(makeBundle(root, { macho: false }), shim);
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(';'), /Mach-O/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('otool vorhanden und meldet Fehler: Abbruch (kein stilles Durchwinken)', darwin, () => {
  const root = tmp('sh-otool-');
  try {
    const bad = script(root, 'otool', 'echo "otool: error: malformed object" >&2; exit 1');
    const gate = otoolGate(makeBundle(root), bad);
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(';'), /otool-Prüfung fehlgeschlagen/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('otool vorhanden: dyld-Trockentest bleibt aktiv (fehlende @rpath-Lib = Fehler)', darwin, () => {
  const root = tmp('sh-otool-');
  try {
    const bundle = makeBundle(root);
    fs.writeFileSync(path.join(bundle, 'Contents', 'Frameworks', 'Libs', 'libok.dylib'), MACHO);
    const mk = lib => script(root, 'otool', `case "$1" in -L) printf 'x:\\n\\t%s (compatibility version 1.0.0)\\n' "${lib}";; *) ;; esac`);
    assert.equal(otoolGate(bundle, mk('@rpath/Libs/libok.dylib')).ok, true);
    const gate = otoolGate(bundle, mk('@rpath/Libs/libfehlt.dylib'));
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(';'), /libfehlt/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resignBundleAdHoc: erst force/deep/sign -, dann verify ohne --strict', () => {
  const root = tmp('sh-resign-');
  try {
    const log = path.join(root, 'calls.log');
    const cs = script(root, 'codesign', `echo "$@" >> "${log}"`);
    resignBundleAdHoc('/x/Bundle.app', cs);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
      ['--force --deep --sign - /x/Bundle.app', '--verify --deep /x/Bundle.app']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installMacBundle: Re-Sign läuft am Staging-Wrapper nach dem Symlink, vor dem Swap', () => {
  const root = tmp('sh-resign-');
  try {
    const log = path.join(root, 'calls.log');
    const cs = script(root, 'codesign', `for a; do last="$a"; done; echo "$@ link=$(readlink "$last/Contents/Resources/app" 2>/dev/null)" >> "${log}"`);
    const supportDir = path.join(root, 'Support');
    const applicationsDir = path.join(root, 'Applications');
    installMacBundle(makeBundle(root), supportDir, { applicationsDir, otool: false, resign: true, codesignPath: cs });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^--force --deep --sign - .*\.update-stage-\d+\/Streaming Hub\.app/);
    assert.ok(lines[0].endsWith(`link=${supportDir}`), 'Symlink bereits gesetzt');
    assert.match(lines[1], /^--verify --deep /);
    assert.doesNotMatch(lines[1], /--strict/);
    assert.equal(fs.readFileSync(path.join(supportDir, 'release.txt'), 'utf8'), 'new');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installMacBundle: verify nach Re-Sign scheitert -> alter Stand bleibt, Fehler wird geworfen', () => {
  const root = tmp('sh-resign-');
  try {
    const supportDir = path.join(root, 'Support');
    const applicationsDir = path.join(root, 'Applications');
    installMacBundle(makeBundle(root, { marker: 'old' }), supportDir, { applicationsDir, otool: false, resign: false });
    const wrapper = path.join(applicationsDir, 'Streaming Hub.app');
    const failing = script(root, 'codesign', 'if [ "$1" = "--verify" ]; then echo "invalid signature" >&2; exit 1; fi');
    assert.throws(() => installMacBundle(makeBundle(root, { marker: 'new' }), supportDir,
      { applicationsDir, otool: false, resign: true, codesignPath: failing }), /ungültig/);
    assert.equal(fs.readFileSync(path.join(supportDir, 'release.txt'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(wrapper, 'Contents', 'MacOS', 'Streaming Hub')), true);
    assert.deepEqual(fs.readdirSync(applicationsDir), ['Streaming Hub.app']);
    assert.deepEqual(fs.readdirSync(root).filter(n => n.includes('update-')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installMacBundle: codesign --sign scheitert -> Fehler, Ziel unberührt', () => {
  const root = tmp('sh-resign-');
  try {
    const supportDir = path.join(root, 'Support');
    const applicationsDir = path.join(root, 'Applications');
    const failing = script(root, 'codesign', 'exit 1');
    assert.throws(() => installMacBundle(makeBundle(root), supportDir,
      { applicationsDir, otool: false, resign: true, codesignPath: failing }), /ad-hoc codesign fehlgeschlagen/);
    assert.equal(fs.existsSync(supportDir), false);
    assert.equal(fs.existsSync(path.join(applicationsDir, 'Streaming Hub.app')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installMacBundle: ohne Re-Sign (EVS-Pfad / resign:false) wird codesign nicht aufgerufen', () => {
  const root = tmp('sh-resign-');
  try {
    const log = path.join(root, 'calls.log');
    const cs = script(root, 'codesign', `echo "$@" >> "${log}"`);
    installMacBundle(makeBundle(root), path.join(root, 'Support'), { applicationsDir: path.join(root, 'Applications'), otool: false, resign: false, codesignPath: cs });
    assert.equal(fs.existsSync(log), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
