'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyMacBundle } = require('../updater.js');

test('Signaturfehler bricht vor Installation ab und lässt den alten Stand unverändert', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-updater-test-'));
  const bundle = path.join(root, 'Streaming Hub.app');
  const oldInstall = path.join(root, 'install');
  fs.mkdirSync(path.join(bundle, 'Contents', 'Resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(oldInstall), 'alter Stand');
  assert.throws(() => verifyMacBundle(bundle, root), /Signatur|Signaturprüfung|macOS/);
  assert.equal(fs.readFileSync(oldInstall, 'utf8'), 'alter Stand');
  fs.rmSync(root, { recursive: true, force: true });
});
