'use strict';

// Regression: Updater-Prozess (fork mit ELECTRON_RUN_AS_NODE) darf *.asar im
// Release-Bundle nicht als Archiv behandeln (ENOENT default_app.asar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyBundleTree } = require('../lib/bundle-install.js');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('updater.js setzt process.noAsar vor dem ersten require', () => {
  const src = read('updater.js');
  const idx = src.indexOf('process.noAsar = true;');
  assert.ok(idx >= 0);
  assert.equal(src.indexOf("require('"), src.indexOf("require('./logger.js')"));
  assert.ok(idx < src.indexOf("require('"));
});

test('main.js übergibt ELECTRON_NO_ASAR an beide Updater-forks', () => {
  const src = read('main.js');
  const forks = src.split('\n').reduce((acc, line, i, lines) => {
    if (/fork\(.*updater/.test(line)) acc.push(lines.slice(i, i + 5).join('\n'));
    return acc;
  }, []);
  assert.equal(forks.length, 2);
  for (const f of forks) assert.match(f, /ELECTRON_NO_ASAR: '1'/);
});

test('copyBundleTree kopiert Contents/Resources/default_app.asar', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-asar-test-'));
  try {
    const src = path.join(tmp, 'Streaming Hub.app');
    const res = path.join(src, 'Contents', 'Resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'default_app.asar'), 'asar-bytes');
    const dest = path.join(tmp, 'out.app');
    fs.mkdirSync(dest);
    copyBundleTree(src, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'Contents', 'Resources', 'default_app.asar'), 'utf8'), 'asar-bytes');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
