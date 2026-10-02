'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { updateMode } = require('../lib/update-mode.js');

test('updateMode: AppImage hat Vorrang, macOS nutzt Release-Updater, sonst unsupported', () => {
  assert.equal(updateMode('linux', { APPIMAGE: '/x/app.AppImage' }), 'appimage');
  assert.equal(updateMode('darwin', {}), 'mac-release');
  assert.equal(updateMode('linux', {}), 'unsupported');
  assert.equal(updateMode('win32', {}), 'unsupported');
});

test('main.js: Updater-Prozess nur auf macOS, Apply-Timeout über Download-Timeout, Kill bei Timeout', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  assert.match(src, /updateMode\(\) === 'mac-release'/);
  assert.match(src, /updateMode\(\) === 'unsupported'/);
  const m = /UPDATE_APPLY_TIMEOUT_MS = (.+);/.exec(src);
  assert.ok(m, 'UPDATE_APPLY_TIMEOUT_MS fehlt');
  assert.ok(eval(m[1]) > 300000, 'Apply-Timeout muss über dem 300-s-Download-Timeout liegen');
  assert.match(src, /proc\.kill\('SIGKILL'\)/);
});
