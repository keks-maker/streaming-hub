process.env.STREAMING_HUB_UPDATER_SKIP_SIGNATURE = '1';
'use strict';

// Regressionstests für den S-Klasse-Updater-Fix (Karte t_ea243f43).
//
// Root-Cause: fs.cpSync rekonstruiert relative Bundle-Symlinks als ABSOLUTE
// Symlinks auf die Quelle im Temp-Update-Verzeichnis → nach dem Temp-Cleanup
// tot → dyld SIGABRT ("Library not loaded: @rpath/Electron Framework.framework").
// Diese Tests halten beide Sicherungen fest:
//  1. installMacBundle kopiert Symlinks verbatim relativ (kein Temp-Pfad im Ziel).
//  2. Das Integritäts-Gate verhindert kaputte/externe/tote Symlinks und leere
//     Frameworks — vor UND nach dem Swap.
//  3. Ein abgebrochener Lauf lässt den alten Stand unberührt UND startbar.
//  4. Recovery holt Installationen aus stale Rollbacks zurück statt sie zu löschen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMacBundle, verifyBundleIntegrity, recoverStaleUpdateDirs } = require('../updater.js');
const { copyBundleTree } = require('../lib/bundle-install.js');

// Standard-MacOS-Framework-Layout mit relativen Symlinks — exakt die Struktur,
// deren Zerstorung im User-Fall den Start-Crash verursacht hat.
function makeFrameworkBundle(root, label) {
  const bundle = path.join(root, `Extract${label}`, 'Streaming Hub.app');
  const fw = path.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework');
  fs.mkdirSync(path.join(fw, 'Versions', 'A', 'Libraries'), { recursive: true });
  fs.writeFileSync(path.join(fw, 'Versions', 'A', 'Electron Framework'), '#!/bin/elf');
  fs.mkdirSync(path.join(fw, 'Versions', 'A', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(fw, 'Versions', 'A', 'Resources', 'Info.plist'), 'x');
  // Standard-relatives Symlink-Set eines Frameworks:
  fs.symlinkSync('A', path.join(fw, 'Versions', 'Current'));
  fs.symlinkSync('Versions/Current/Electron Framework', path.join(fw, 'Electron Framework'));
  fs.symlinkSync('Versions/Current/Resources', path.join(fw, 'Resources'));
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Streaming Hub'), '#!/bin/elf');
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    '<plist><key>CFBundleExecutable</key><string>Streaming Hub</string></plist>'
  );
  const app = path.join(bundle, 'Contents', 'Resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'release.txt'), label);
  return bundle;
}

function assertNoTempPaths(root) {
  for (const { link, target } of require('../lib/bundle-install.js').listSymlinks(root)) {
    // Ausnahme: bewusstes Design — Resources/app -> Support-Verzeichnis.
    if (link.endsWith(path.join('Contents', 'Resources', 'app'))) continue;
    assert.equal(
      target.includes('streaming-hub-update') || path.isAbsolute(target),
      false,
      `Symlink ${link} zeigt auf absoluten/Temp-Pfad: ${target}`
    );
  }
}

test('REGRESSION t_ea243f43: installiertes Bundle enthält keine Symlinks ins Temp-Verzeichnis', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-updater-regr-'));
  try {
    const bundle = makeFrameworkBundle(root, 'v0523');
    const supportDir = path.join(root, 'Library', 'Application Support', 'Streaming Hub');
    const applicationsDir = path.join(root, 'Applications');

    installMacBundle(bundle, supportDir, { applicationsDir });

    const wrapper = path.join(applicationsDir, 'Streaming Hub.app');
    const fw = path.join(wrapper, 'Contents', 'Frameworks', 'Electron Framework.framework');
    // Standard-Layout: relative Ziele innerhalb des Bundles
    assert.equal(fs.readlinkSync(path.join(fw, 'Versions', 'Current')), 'A');
    assert.equal(fs.readlinkSync(path.join(fw, 'Electron Framework')), 'Versions/Current/Electron Framework');
    // alle auflösbar (das war der User-Crash: nicht auflösbar → dyld SIGABRT)
    assert.equal(fs.existsSync(path.join(fw, 'Electron Framework')), true);
    assert.equal(fs.readFileSync(path.join(fw, 'Electron Framework'), 'utf-8'), '#!/bin/elf');
    assertNoTempPaths(wrapper);
    // Integritäts-Gate muss das installierte Bundle grün prüfen
    const gate = verifyBundleIntegrity(wrapper, {
      allowedAbsoluteTargets: [supportDir],
    });
    assert.equal(gate.ok, true, `Gate schlug fehl: ${gate.errors.join('; ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REGRESSION t_ea243f43: copyBundleTree übersetzt absolute Selbstbezüge relativ und lehnt externe ab', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-copy-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'f'), 'x');
    fs.symlinkSync(path.join(src, 'sub', 'f'), path.join(src, 'abs-self')); // absolut auf Quelle
    fs.symlinkSync('/etc/hostname', path.join(src, 'abs-external'));
    const dst = path.join(root, 'dst');
    assert.throws(() => copyBundleTree(src, dst), /außerhalb des Quellbaums/);
    // Ohne den externen Link klappt es, und der Selbstbezug wird relativ:
    fs.unlinkSync(path.join(src, 'abs-external'));
    copyBundleTree(src, dst);
    const written = fs.readlinkSync(path.join(dst, 'abs-self'));
    assert.equal(path.isAbsolute(written), false, `absolut geblieben: ${written}`);
    assert.equal(fs.realpathSync(path.join(dst, 'abs-self')), fs.realpathSync(path.join(dst, 'sub', 'f')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Gate verhindert tote und bundle-externe Symlinks im Ziel-Bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-gate-'));
  try {
    const bundle = path.join(root, 'Streaming Hub.app');
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Streaming Hub'), 'x');
    fs.writeFileSync(
      path.join(bundle, 'Contents', 'Info.plist'),
      '<plist><key>CFBundleExecutable</key><string>Streaming Hub</string></plist>'
    );
    // toter relativer Symlink
    fs.symlinkSync('Versions/Current/fehlt', path.join(bundle, 'Contents', 'MacOS', 'dead'));
    let gate = verifyBundleIntegrity(bundle);
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(' '), /toter|nicht auflösbar/);

    // externer absoluter Symlink (der exakte User-Befund)
    fs.unlinkSync(path.join(bundle, 'Contents', 'MacOS', 'dead'));
    fs.symlinkSync('/private/var/folders/xx/T/streaming-hub-update-AAAA/extract/x', path.join(bundle, 'Contents', 'MacOS', 'ext'));
    gate = verifyBundleIntegrity(bundle);
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(' '), /absoluter Symlink/);

    // erlaubtes Design-Ziel (Resources/app -> Support-Dir) darf durchgehen
    fs.unlinkSync(path.join(bundle, 'Contents', 'MacOS', 'ext'));
    const support = path.join(root, 'support');
    fs.mkdirSync(support, { recursive: true });
    fs.symlinkSync(support, path.join(bundle, 'Contents', 'app'));
    gate = verifyBundleIntegrity(bundle, { allowedAbsoluteTargets: [support] });
    assert.equal(gate.ok, true, gate.errors.join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Gate erkennt fehlendes Versions/Current im Framework (dyld-ähnlicher Trockentest)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-gate2-'));
  try {
    const bundle = path.join(root, 'Streaming Hub.app');
    const fw = path.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework');
    fs.mkdirSync(path.join(fw, 'Versions'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Streaming Hub'), 'x');
    fs.writeFileSync(
      path.join(bundle, 'Contents', 'Info.plist'),
      '<plist><key>CFBundleExecutable</key><string>Streaming Hub</string></plist>'
    );
    const gate = verifyBundleIntegrity(bundle);
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(' '), /Electron Framework/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Update-Abruch lässt alte Installation unberührt UND startbar (simulierter Gate-Fail)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-abort-'));
  try {
    const oldBundle = makeFrameworkBundle(root, 'v0518');
    const supportDir = path.join(root, 'Library', 'Application Support', 'Streaming Hub');
    const applicationsDir = path.join(root, 'Applications');
    // alte Installation herstellen (wie ein Lauf 1)
    installMacBundle(makeFrameworkBundle(root, 'old'), supportDir, { applicationsDir });
    const oldWrapper = path.join(applicationsDir, 'Streaming Hub.app');
    const oldFwBinary = path.join(oldWrapper, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
    assert.equal(fs.existsSync(oldFwBinary), true);

    // neuer Lauf: Gate am Staging verhindern → alter Stand muss überleben
    assert.throws(() => installMacBundle(oldBundle, supportDir, {
      applicationsDir,
      otool: false,
      codesignGate: false,
      afterSupportSwap: () => { throw new Error('Abbruch nach Support-Swap'); },
    }), /Abbruch nach Support-Swap/);

    assert.equal(fs.readFileSync(path.join(supportDir, 'release.txt'), 'utf-8'), 'old');
    assert.equal(fs.existsSync(oldFwBinary), true);
    const gate = verifyBundleIntegrity(oldWrapper, { allowedAbsoluteTargets: [supportDir] });
    assert.equal(gate.ok, true, `alte Installation gate-grün: ${gate.errors.join('; ')}`);
    assertNoTempPaths(oldWrapper);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Selbstheilung: Installation aus stale Rollback zurückgeholt statt gelöscht', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-recover-'));
  try {
    const supportDir = path.join(root, 'Library', 'Application Support', 'Streaming Hub');
    const applicationsDir = path.join(root, 'Applications');
    const wrapper = path.join(applicationsDir, 'Streaming Hub.app');
    // simulierter Abbruch-Lauf: alter Stand liegt in Rollback, Live-Instanz fehlt
    fs.mkdirSync(path.join(supportDir, '..'), { recursive: true });
    const rollback = `${supportDir}.update-rollback-9999`;
    fs.renameSync(fs.mkdtempSync(path.join(root, 'tmpold')), rollback);
    fs.writeFileSync(path.join(rollback, 'release.txt'), 'old');
    fs.mkdirSync(applicationsDir, { recursive: true });
    const wrapperRollback = `${wrapper}.update-rollback-9999`;
    fs.mkdirSync(path.join(wrapperRollback, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(wrapperRollback, 'Contents', 'mac.x'), 'x');
    fs.writeFileSync(path.join(rollback, '.update-staging-marker'), 'x');
    fs.mkdirSync(`${supportDir}.update-staging-7777`, { recursive: true });
    fs.writeFileSync(path.join(`${supportDir}.update-staging-7777`, 'x'), 'x');
    const result = recoverStaleUpdateDirs(supportDir, wrapper);
    assert.deepEqual(result.restored.sort(), [supportDir, wrapper].sort());
    assert.equal(fs.readFileSync(path.join(supportDir, 'release.txt'), 'utf-8'), 'old');
    assert.equal(fs.existsSync(path.join(wrapper, 'Contents', 'mac.x')), true);
    assert.equal(fs.existsSync(`${supportDir}.update-staging-7777`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});