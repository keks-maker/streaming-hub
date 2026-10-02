process.env.STREAMING_HUB_UPDATER_SKIP_SIGNATURE = '1';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMacBundle, verifyMacBundle } = require('../updater.js');

function makeBundle(root) {
  const bundle = path.join(root, 'Release', 'Streaming Hub.app');
  const app = path.join(bundle, 'Contents', 'Resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'release.txt'), 'new release');
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'fake plist');
  return bundle;
}

test('installMacBundle installiert ein frisches Layout ohne Support-Verzeichnis', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-updater-test-'));
  try {
    const bundle = makeBundle(root);
    const supportDir = path.join(root, 'Library', 'Application Support', 'Streaming Hub');
    const applicationsDir = path.join(root, 'Applications');

    installMacBundle(bundle, supportDir, { applicationsDir });

    assert.equal(fs.readFileSync(path.join(supportDir, 'release.txt'), 'utf8'), 'new release');
    const appLink = path.join(applicationsDir, 'Streaming Hub.app', 'Contents', 'Resources', 'app');
    assert.equal(fs.realpathSync(appLink), fs.realpathSync(supportDir));
    assert.equal(fs.lstatSync(appLink).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installMacBundle aktualisiert ein bestehendes Layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-updater-test-'));
  try {
    const bundle = makeBundle(root);
    const supportDir = path.join(root, 'Library', 'Application Support', 'Streaming Hub');
    const applicationsDir = path.join(root, 'Applications');
    const wrapper = path.join(applicationsDir, 'Streaming Hub.app');
    fs.mkdirSync(path.join(supportDir), { recursive: true });
    fs.writeFileSync(path.join(supportDir, 'user-settings.json'), 'keep me');
    fs.mkdirSync(path.join(wrapper, 'Contents', 'Resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(wrapper, 'Contents', 'Resources', 'old.txt'), 'old wrapper');

    installMacBundle(bundle, supportDir, { applicationsDir });

    assert.equal(fs.readFileSync(path.join(supportDir, 'release.txt'), 'utf8'), 'new release');
    assert.equal(fs.existsSync(path.join(supportDir, 'user-settings.json')), false);
    assert.equal(fs.realpathSync(path.join(wrapper, 'Contents', 'Resources', 'app')), fs.realpathSync(supportDir));
    assert.equal(fs.existsSync(`${supportDir}.update-rollback-${process.pid}`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installMacBundle rollt nach Fehler direkt nach Support-Swap vollständig zurück', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-updater-test-'));
  try {
    const bundle = makeBundle(root);
    const supportDir = path.join(root, 'Library', 'Application Support', 'Streaming Hub');
    const applicationsDir = path.join(root, 'Applications');
    const wrapper = path.join(applicationsDir, 'Streaming Hub.app');
    fs.mkdirSync(supportDir, { recursive: true });
    fs.writeFileSync(path.join(supportDir, 'user-settings.json'), 'old user data');
    fs.mkdirSync(path.join(wrapper, 'Contents', 'Resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(wrapper, 'Contents', 'Resources', 'app', 'old.txt'), 'old app');

    assert.throws(() => installMacBundle(bundle, supportDir, {
      applicationsDir,
      afterSupportSwap: () => { throw new Error('simulierter Fehler nach Support-Swap'); },
    }), /simulierter Fehler/);

    assert.equal(fs.readFileSync(path.join(supportDir, 'user-settings.json'), 'utf8'), 'old user data');
    assert.equal(fs.existsSync(path.join(supportDir, 'release.txt')), false);
    assert.equal(fs.readFileSync(path.join(wrapper, 'Contents', 'Resources', 'app', 'old.txt'), 'utf8'), 'old app');
    assert.equal(fs.existsSync(`${supportDir}.update-staging-${process.pid}`), false);
    assert.equal(fs.existsSync(`${supportDir}.update-rollback-${process.pid}`), false);
    assert.equal(fs.existsSync(`${wrapper}.update-rollback-${process.pid}`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Signaturfehler bricht vor Installation ab und lässt den alten Stand unverändert', () => {
  delete process.env.STREAMING_HUB_UPDATER_SKIP_SIGNATURE; // Gate MUSS hier failen (Dummy ohne Signatur)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-updater-test-'));
  try {
    const bundle = path.join(root, 'Streaming Hub.app');
    const oldInstall = path.join(root, 'install');
    fs.mkdirSync(path.join(bundle, 'Contents', 'Resources', 'app'), { recursive: true });
    fs.writeFileSync(oldInstall, 'alter Stand');
    assert.throws(() => verifyMacBundle(bundle, root), /Signatur|Signaturprüfung|macOS/);
    assert.equal(fs.readFileSync(oldInstall, 'utf8'), 'alter Stand');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
