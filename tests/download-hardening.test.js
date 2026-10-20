'use strict';

// Tests: Härtung aus der Engine-QA (Dateinamen, Symlinks im Speicherort).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const filenames = require('../lib/download/filenames.js');
const records = require('../lib/download/records.js');

test('sanitizeName: Punkte und Leerzeichen am Anfang werden gemeinsam entfernt', () => {
  assert.equal(filenames.sanitizeName('../x'), 'x');
  assert.equal(filenames.sanitizeName('. . x'), 'x');
});

test('isManagedFile: Symlink im Speicherort führt nicht hinaus', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'fremd.mp4'), 'x');
    fs.writeFileSync(path.join(root, 'eigen.mp4'), 'x');
    fs.symlinkSync(path.join(outside, 'fremd.mp4'), path.join(root, 'link.mp4'));
    fs.symlinkSync(outside, path.join(root, 'ordner'));
    const record = { root };
    assert.equal(records.isManagedFile(record, path.join(root, 'eigen.mp4')), true);
    assert.equal(records.isManagedFile(record, path.join(root, 'link.mp4')), false);
    assert.equal(records.isManagedFile(record, path.join(root, 'ordner', 'fremd.mp4')), false);
    assert.equal(records.isManagedFile(record, path.join(root, 'fehlt.mp4')), true, 'nicht vorhandene Datei bleibt lexikalisch geprüft');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
