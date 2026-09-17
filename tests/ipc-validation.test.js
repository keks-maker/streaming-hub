'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWebviewKeydown, validateUpdateAssetUrl, validateVersion } = require('../lib/ipc-validation.js');

test('accepts only strict numeric update versions', () => {
  assert.equal(validateVersion('1.2.3'), '1.2.3');
  for (const value of ['1.2', 'v1.2.3', '1.2.3-beta', '1.2.3;touch', '', 123]) {
    assert.throws(() => validateVersion(value), /Versionsnummer/);
  }
});

test('accepts only update assets from the configured Gitea origin', () => {
  const origin = 'http://192.168.4.105:3000';
  assert.equal(validateUpdateAssetUrl(`${origin}/download/app.AppImage`, origin), `${origin}/download/app.AppImage`);
  assert.throws(
    () => validateUpdateAssetUrl('https://evil.example/app.AppImage', origin),
    /nicht autorisierten Origin/,
  );
  assert.throws(() => validateUpdateAssetUrl('file:///tmp/app.AppImage', origin), /Update-Download-URL/);
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
