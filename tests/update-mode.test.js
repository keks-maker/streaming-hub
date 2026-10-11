'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { updateMode, isLinuxReleaseLayout } = require('../lib/update-mode.js');

const RELEASE_APP = '/home/u/.local/share/streaming-hub/resources/app';
const GIT_APP = '/home/u/.local/share/streaming-hub';

test('updateMode: macOS nutzt Release-Updater, Linux-x64 nur aus dem Release-Layout, sonst unsupported', () => {
  assert.equal(updateMode('darwin', '/x'), 'mac-release');
  assert.equal(updateMode('linux', RELEASE_APP, 'x64'), 'linux-release');
  assert.equal(updateMode('linux', GIT_APP, 'x64'), 'unsupported');
  assert.equal(updateMode('linux', RELEASE_APP, 'arm64'), 'unsupported');
  assert.equal(updateMode('win32', RELEASE_APP, 'x64'), 'unsupported');
});

test('updateMode: APPIMAGE-Umgebung hat keinen Sonderweg mehr', () => {
  process.env.APPIMAGE = '/x/app.AppImage';
  try {
    assert.equal(updateMode('linux', GIT_APP, 'x64'), 'unsupported');
  } finally {
    delete process.env.APPIMAGE;
  }
});

test('isLinuxReleaseLayout erkennt nur resources/app', () => {
  assert.equal(isLinuxReleaseLayout(RELEASE_APP), true);
  assert.equal(isLinuxReleaseLayout('/x/resources/other'), false);
  assert.equal(isLinuxReleaseLayout('/x/app'), false);
  assert.equal(isLinuxReleaseLayout(''), false);
  assert.equal(isLinuxReleaseLayout(undefined), false);
});

test('main.js: Updater-Prozess auf macOS und Linux-Release, Apply-Timeout über Download-Timeout, Kill bei Timeout', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  assert.match(src, /\['mac-release', 'linux-release'\]\.includes\(updateMode\(process\.platform, __dirname\)\)/);
  assert.match(src, /updateMode\(process\.platform, __dirname\) === 'unsupported'/);
  assert.doesNotMatch(src, /APPIMAGE|AppImage/);
  assert.match(src, /app\.relaunch\(\{ execPath: path\.resolve\(__dirname, '\.\.', '\.\.', 'streaming-hub'\)/);
  const m = /UPDATE_APPLY_TIMEOUT_MS = (.+);/.exec(src);
  assert.ok(m, 'UPDATE_APPLY_TIMEOUT_MS fehlt');
  assert.ok(eval(m[1]) > 300000, 'Apply-Timeout muss über dem 300-s-Download-Timeout liegen');
  assert.match(src, /proc\.kill\('SIGKILL'\)/);
});
