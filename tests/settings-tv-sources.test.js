const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { detectSourceType, buildNewSource, buildSourceUpdates, formatIpcError, formatLoadedAt } = require('../settings-tv-sources.js');
const validation = require('../lib/input-validation.js');

const original = {
  id: 'de',
  name: 'Deutsch',
  url: 'https://example.com/a.m3u',
  type: 'url',
  color: '#112233',
  epgUrl: null,
  favorites: ['x'],
  sortOrder: ['x', 'y'],
  channelOverrides: { x: { url: 'https://example.com/x' } },
};

test('detectSourceType: Pfade = file, URLs = url', () => {
  assert.equal(detectSourceType('/Users/a/b.m3u'), 'file');
  assert.equal(detectSourceType('./b.m3u'), 'file');
  assert.equal(detectSourceType('C:\\tv\\b.m3u'), 'file');
  assert.equal(detectSourceType('https://example.com/b.m3u'), 'url');
});

test('buildNewSource: Pflichtfelder, Typ, leere EPG-URL wird null', () => {
  assert.equal(buildNewSource({ name: ' ', url: 'x' }), null);
  assert.equal(buildNewSource({ name: 'a', url: '' }), null);
  const src = buildNewSource({ name: ' A ', url: 'https://e.com/a.m3u', epgUrl: '  ', color: '#abcdef' });
  assert.deepEqual(src, { name: 'A', url: 'https://e.com/a.m3u', type: 'url', color: '#abcdef', epgUrl: null });
  assert.equal(buildNewSource({ name: 'A', url: 'rel.m3u' }, { forceFile: true }).type, 'file');
});

test('buildSourceUpdates: nur geaenderte Felder, nie favorites/sortOrder/channelOverrides', () => {
  assert.deepEqual(
    buildSourceUpdates(original, { name: 'Deutsch', url: original.url, epgUrl: '', color: '#112233' }),
    {},
  );
  const updates = buildSourceUpdates(original, {
    name: 'Neu',
    url: original.url,
    epgUrl: 'https://example.com/epg.xml',
    color: '#ffffff',
  });
  assert.deepEqual(updates, { name: 'Neu', epgUrl: 'https://example.com/epg.xml', color: '#ffffff' });
  for (const key of ['favorites', 'sortOrder', 'channelOverrides', 'id']) assert.ok(!(key in updates));
  // Das Ergebnis besteht die Main-Validierung.
  assert.doesNotThrow(() => validation.tvSourceUpdates(updates, original.type));
});

test('buildSourceUpdates: URL-Wechsel auf Datei setzt type; leere Pflichtfelder liefern error', () => {
  const updates = buildSourceUpdates(original, { name: 'Deutsch', url: '/tmp/a.m3u', type: 'file' });
  assert.deepEqual(updates, { url: '/tmp/a.m3u', type: 'file' });
  assert.ok(buildSourceUpdates(original, { name: '', url: original.url }).error);
  assert.ok(buildSourceUpdates(original, { name: 'x', url: ' ' }).error);
});

test('buildSourceUpdates: EPG-URL entfernen sendet null', () => {
  const withEpg = { ...original, epgUrl: 'https://example.com/epg.xml' };
  assert.deepEqual(buildSourceUpdates(withEpg, { name: withEpg.name, url: withEpg.url, epgUrl: '' }), { epgUrl: null });
});

test('main.js update-tv-source behaelt Overrides/Favoriten per Spread-Merge', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('sources[idx] = { ...sources[idx], ...source };'));
});

test('formatLoadedAt: ungueltig -> leer', () => {
  assert.equal(formatLoadedAt(null), '');
  assert.equal(formatLoadedAt(new Date('x')), '');
  assert.notEqual(formatLoadedAt(new Date()), '');
});

test('formatIpcError: Invalid URL wird verständlich, Electron-Präfix entfällt', () => {
  const msg = formatIpcError(new Error("Error invoking remote method 'update-tv-source': TypeError: Invalid URL"));
  assert.match(msg, /Ungültige URL/);
  assert.match(msg, /https:\/\//);
  assert.doesNotMatch(msg, /TypeError|Invalid URL|remote method/);
  assert.match(formatIpcError(new Error('Invalid URL')), /Ungültige URL/);
  assert.equal(
    formatIpcError(new Error("Error invoking remote method 'add-tv-source': Error: Quellenname ist ungültig")),
    'Quellenname ist ungültig',
  );
  assert.equal(formatIpcError('einfacher Text'), 'einfacher Text');
});
