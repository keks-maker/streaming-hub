'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWebviewKeydown,
  validateDownloadSize,
  validateReleaseMetadata,
  validateUpdateAssetUrl,
  validateVersion,
} = require('../lib/ipc-validation.js');

test('accepts only strict numeric update versions', () => {
  assert.equal(validateVersion('1.2.3'), '1.2.3');
  for (const value of ['1.2', 'v1.2.3', '1.2.3-beta', '1.2.3;touch', '', 123]) {
    assert.throws(() => validateVersion(value), /Versionsnummer/);
  }
});

test('accepts only update assets from the configured Gitea origin', () => {
  const origin = 'http://192.168.4.105:3000';
  assert.equal(
    validateUpdateAssetUrl(`${origin}/download/app.AppImage`, origin, '/download/'),
    `${origin}/download/app.AppImage`,
  );
  assert.throws(
    () => validateUpdateAssetUrl('https://evil.example/app.AppImage', origin),
    /nicht autorisierten Origin/,
  );
  assert.throws(() => validateUpdateAssetUrl('file:///tmp/app.AppImage', origin), /Update-Download-URL/);
});

test('validates release metadata and matching AppImage assets', () => {
  const origin = 'http://192.168.4.105:3000';
  const release = {
    tag_name: 'v1.2.3',
    assets: [
      {
        name: 'Streaming-Hub.AppImage',
        browser_download_url: `${origin}/kekskarlo/Streaming-Hub/releases/download/1.2.3/Streaming-Hub.AppImage`,
      },
    ],
  };
  assert.deepEqual(
    validateReleaseMetadata(release, '1.2.3', origin, '/kekskarlo/Streaming-Hub/releases/download/1.2.3/'),
    { version: '1.2.3', asset: release.assets[0] },
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...release, tag_name: 'v1.2.4' },
        '1.2.3',
        origin,
        '/kekskarlo/Streaming-Hub/releases/download/1.2.3/',
      ),
    /stimmt nicht/,
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...release, assets: [] },
        '1.2.3',
        origin,
        '/kekskarlo/Streaming-Hub/releases/download/1.2.3/',
      ),
    /genau ein AppImage/,
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://evil.example/app.AppImage' }] },
        '1.2.3',
        origin,
        '/kekskarlo/Streaming-Hub/releases/download/1.2.3/',
      ),
    /nicht autorisierten/,
  );
});

test('limits update download sizes', () => {
  assert.equal(validateDownloadSize('100', 1000), 100);
  assert.equal(validateDownloadSize('', 1000), 0);
  assert.throws(() => validateDownloadSize('1001', 1000), /zu groß/);
  assert.throws(() => validateDownloadSize('not-a-size', 1000), /zu groß/);
});

test('normalizes allowed webview keyboard payloads', () => {
  assert.deepEqual(
    normalizeWebviewKeydown({ key: 'F11', ctrlKey: false, shiftKey: false, metaKey: false, altKey: false }),
    {
      key: 'F11',
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    },
  );
  assert.equal(
    normalizeWebviewKeydown({ key: 'Enter', ctrlKey: false, shiftKey: false, metaKey: false, altKey: false }),
    null,
  );
  assert.equal(normalizeWebviewKeydown({ key: 'F11', ctrlKey: true }), null);
  assert.equal(normalizeWebviewKeydown(null), null);
});
