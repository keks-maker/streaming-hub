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
  const origin = 'https://updates.example.invalid';
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
  const origin = 'https://updates.example.invalid';
  const release = {
    tag_name: 'v1.2.3',
    assets: [
      {
        name: 'Streaming-Hub.AppImage',
        browser_download_url: `${origin}/streaming-hub/releases/download/1.2.3/Streaming-Hub.AppImage`,
      },
    ],
  };
  assert.deepEqual(
    validateReleaseMetadata(release, '1.2.3', origin, '/streaming-hub/releases/download/1.2.3/'),
    { version: '1.2.3', asset: release.assets[0] },
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...release, tag_name: 'v1.2.4' },
        '1.2.3',
        origin,
        '/streaming-hub/releases/download/1.2.3/',
      ),
    /stimmt nicht/,
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...release, assets: [] },
        '1.2.3',
        origin,
        '/streaming-hub/releases/download/1.2.3/',
      ),
    /genau ein AppImage/,
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://evil.example/app.AppImage' }] },
        '1.2.3',
        origin,
        '/streaming-hub/releases/download/1.2.3/',
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

// ── EPG-Raster-/Suche-API (Etappe 3.1) ──

const {
  validateEpgRangeMany,
  validateEpgSearch,
  EPG_MAX_RANGE_MS,
  EPG_RANGE_MANY_MAX_CHANNELS,
  EPG_SEARCH_MAX_CHANNELS,
  EPG_SEARCH_DEFAULT_LIMIT,
  EPG_SEARCH_MAX_LIMIT,
} = require('../lib/ipc-validation.js');

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const keys = n => Array.from({ length: n }, (_, i) => `k${i}.de`);

test('validateEpgRangeMany: gültige Eingabe, Trimmen, Duplikate entfernen', () => {
  assert.deepEqual(validateEpgRangeMany([' A.de ', 'B.de', 'A.de'], T0, T0 + 1000), {
    channelKeys: ['A.de', 'B.de'],
    fromMs: T0,
    toMs: T0 + 1000,
  });
  assert.doesNotThrow(() => validateEpgRangeMany(keys(EPG_RANGE_MANY_MAX_CHANNELS), T0, T0 + EPG_MAX_RANGE_MS));
});

test('validateEpgRangeMany: Grenzfälle werden abgelehnt', () => {
  assert.throws(() => validateEpgRangeMany(keys(EPG_RANGE_MANY_MAX_CHANNELS + 1), T0, T0 + 1000), /Zu viele Kanäle/);
  for (const bad of [undefined, null, 'A.de', {}, [], [''], [5], ['a\u0000b'], [['x']]]) {
    assert.throws(() => validateEpgRangeMany(bad, T0, T0 + 1000), /Kanalliste|EPG-Kanal/, JSON.stringify(bad));
  }
  assert.throws(() => validateEpgRangeMany(['A.de'], T0, T0 + EPG_MAX_RANGE_MS + 1), /zu groß/);
  assert.throws(() => validateEpgRangeMany(['A.de'], T0, T0), /nach der Startzeit/);
  assert.throws(() => validateEpgRangeMany(['A.de'], '0', T0), /Startzeit/);
  assert.throws(() => validateEpgRangeMany(['A.de'], T0, 1.5), /Endzeit/);
  assert.throws(() => validateEpgRangeMany(['A.de'], -1, T0), /Startzeit/);
});

test('validateEpgSearch: Defaults, Trimmen, Optionen', () => {
  const ok = validateEpgSearch(['A.de'], '  Käse  ', T0, T0 + 1000);
  assert.deepEqual(ok, {
    channelKeys: ['A.de'],
    query: 'Käse',
    fromMs: T0,
    toMs: T0 + 1000,
    limit: EPG_SEARCH_DEFAULT_LIMIT,
    includeDesc: false,
    full: false,
  });
  assert.equal(validateEpgSearch(['A.de'], 'ab', T0, T0 + 1000, EPG_SEARCH_MAX_LIMIT, { includeDesc: true }).includeDesc, true);
  assert.equal(validateEpgSearch(['A.de'], 'ab', T0, T0 + 1000, null, { full: true }).full, true);
  assert.throws(() => validateEpgSearch(['A.de'], 'ab', T0, T0 + 1000, null, { full: 'ja' }), /Suchoptionen/);
  assert.equal(validateEpgSearch(['A.de'], 'ab', T0, T0 + 1000, null, null).limit, EPG_SEARCH_DEFAULT_LIMIT);
  assert.equal(validateEpgSearch(['A.de'], 'a'.repeat(80), T0, T0 + 1000).query.length, 80);
  assert.doesNotThrow(() => validateEpgSearch(keys(EPG_SEARCH_MAX_CHANNELS), 'ab', T0, T0 + 1000));
});

test('validateEpgSearch: Grenzfälle werden abgelehnt', () => {
  const call = (...args) => () => validateEpgSearch(...args);
  assert.throws(call(keys(EPG_SEARCH_MAX_CHANNELS + 1), 'ab', T0, T0 + 1000), /Zu viele Kanäle/);
  assert.throws(call([], 'ab', T0, T0 + 1000), /Kanalliste/);
  assert.throws(call(['A.de'], 'a', T0, T0 + 1000), /zu kurz/);
  assert.throws(call(['A.de'], ' a ', T0, T0 + 1000), /zu kurz/);
  assert.throws(call(['A.de'], '', T0, T0 + 1000), /zu kurz/);
  assert.throws(call(['A.de'], 'a'.repeat(81), T0, T0 + 1000), /zu lang/);
  for (const bad of [undefined, null, 5, {}, ['ab'], 'ab\u0000cd', 'ab\ncd']) {
    assert.throws(call(['A.de'], bad, T0, T0 + 1000), /Suchbegriff/, String(bad));
  }
  assert.throws(call(['A.de'], 'ab', T0, T0 + EPG_MAX_RANGE_MS + 1), /zu groß/);
  assert.throws(call(['A.de'], 'ab', T0 + 5, T0), /nach der Startzeit/);
  assert.throws(call(['A.de'], 'ab', 'x', T0), /Startzeit/);
  assert.throws(call(['A.de'], 'ab', T0, T0 + 1000, EPG_SEARCH_MAX_LIMIT + 1), /Limit ist zu groß/);
  for (const bad of [0, -1, 1.5, '10', NaN, Infinity, {}]) {
    assert.throws(call(['A.de'], 'ab', T0, T0 + 1000, bad), /Limit ist ungültig/, String(bad));
  }
  for (const bad of ['x', 5, [], { includeDesc: 'yes' }, { includeDesc: 1 }]) {
    assert.throws(call(['A.de'], 'ab', T0, T0 + 1000, 10, bad), /Suchoptionen/, JSON.stringify(bad));
  }
});
