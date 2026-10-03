const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normEpgId,
  filterManagedChannels,
  toggleFavoriteList,
  moveFavorite,
  moveFavoriteTo,
  mergeOverride,
  buildOverrideChanges,
  validateOverrideChanges,
  paginate,
} = require('../lib/settings-channel-logic.js');

const sources = [
  { id: 's1', name: 'A', favorites: ['c3', 'c1'] },
  { id: 's2', name: 'B', favorites: ['d2'] },
];
const channels = [
  { id: 'c1', sourceId: 's1', name: 'Das Erste', tvgId: 'ard.de', group: 'Vollprogramm' },
  { id: 'c2', sourceId: 's1', name: 'ZDF', tvgId: 'zdf.de', group: 'Vollprogramm' },
  { id: 'c3', sourceId: 's1', name: 'arte', tvgId: 'arte.de', group: 'Kultur' },
  { id: 'd1', sourceId: 's2', name: 'ARD alpha', tvgId: '', group: 'Bildung' },
  { id: 'd2', sourceId: 's2', name: 'Phoenix', tvgId: 'phoenix.de', group: 'Info' },
];

test('normEpgId entfernt @-Suffix, Groß-/Kleinschreibung und Leerraum', () => {
  assert.equal(normEpgId(' ARD.de@SD '), 'ard.de');
  assert.equal(normEpgId(undefined), '');
});

test('filterManagedChannels: Quellenfilter, Suche (Name, tvg-id, Gruppe), Alle-Ansicht behält Reihenfolge', () => {
  assert.deepEqual(filterManagedChannels(channels, sources, { sourceIds: ['s1', 's2'] }).map(c => c.id), ['c1', 'c2', 'c3', 'd1', 'd2']);
  assert.deepEqual(filterManagedChannels(channels, sources, { sourceIds: ['s2'] }).map(c => c.id), ['d1', 'd2']);
  assert.deepEqual(filterManagedChannels(channels, sources, { sourceIds: ['s1', 's2'], query: 'ard' }).map(c => c.id), ['c1', 'd1']);
  assert.deepEqual(filterManagedChannels(channels, sources, { sourceIds: ['s1', 's2'], query: 'KULTUR' }).map(c => c.id), ['c3']);
  assert.deepEqual(filterManagedChannels(channels, sources, { sourceIds: ['s1'], query: 'zdf.de' }).map(c => c.id), ['c2']);
});

test('filterManagedChannels: Favoriten-Ansicht in Favoriten-Reihenfolge je Quelle', () => {
  const out = filterManagedChannels(channels, sources, { sourceIds: ['s1', 's2'], view: 'favorites' });
  assert.deepEqual(out.map(c => c.id), ['c3', 'c1', 'd2']);
  const searched = filterManagedChannels(channels, sources, { sourceIds: ['s1', 's2'], view: 'favorites', query: 'a' });
  assert.deepEqual(searched.map(c => c.id), ['c3', 'c1']);
  assert.deepEqual(filterManagedChannels(channels, sources, { sourceIds: [], view: 'favorites' }), []);
});

test('Favoriten: toggle, hoch/runter mit Randbegrenzung, Drag&Drop-Position', () => {
  assert.deepEqual(toggleFavoriteList(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(toggleFavoriteList(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleFavoriteList(undefined, 'a'), ['a']);
  const base = ['a', 'b', 'c'];
  assert.deepEqual(moveFavorite(base, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveFavorite(base, 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(moveFavorite(base, 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveFavorite(base, 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveFavorite(base, 'x', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveFavoriteTo(base, 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveFavoriteTo(base, 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveFavoriteTo(base, 'a', 'zzz'), ['a', 'b', 'c']);
  assert.deepEqual(base, ['a', 'b', 'c'], 'Eingabe bleibt unverändert');
});

test('mergeOverride: leere Werte entfernen, andere Sender und Felder erhalten', () => {
  const existing = { c1: { name: 'X', url: 'https://e.com/a', custom: 1 }, c2: { tvgId: 'zdf.de' } };
  const merged = mergeOverride(existing, 'c1', { name: 'Neu', tvgId: 'ard.de', url: undefined, tvgLogo: '' });
  assert.deepEqual(merged.c1, { name: 'Neu', custom: 1, tvgId: 'ard.de' });
  assert.deepEqual(merged.c2, { tvgId: 'zdf.de' });
  assert.deepEqual(existing.c1, { name: 'X', url: 'https://e.com/a', custom: 1 }, 'Eingabe unverändert');
  const cleared = mergeOverride({ c1: { name: 'X' } }, 'c1', { name: undefined });
  assert.deepEqual(cleared, {});
  assert.deepEqual(mergeOverride(undefined, 'c9', { name: 'N' }), { c9: { name: 'N' } });
  assert.deepEqual(mergeOverride({}, 'c9', {}), {});
});

test('buildOverrideChanges: leer = Override entfernen, gleich wie aktuell = keine Änderung', () => {
  const ch = { id: 'c1', name: 'Das Erste', tvgId: 'ard.de', logo: 'https://l/x.png' };
  const same = buildOverrideChanges(ch, { name: 'Das Erste', tvgId: 'ard.de', tvgLogo: 'https://l/x.png', urlEnabled: false, url: 'x' });
  assert.deepEqual(same, { url: undefined });
  const changed = buildOverrideChanges(ch, { name: ' Eins ', tvgId: '', tvgLogo: 'https://l/y.png', urlEnabled: true, url: ' https://s.example/x.m3u8 ' });
  assert.deepEqual(changed, { name: 'Eins', tvgId: undefined, tvgLogo: 'https://l/y.png', url: 'https://s.example/x.m3u8' });
  assert.deepEqual(buildOverrideChanges(ch, { name: 'a', tvgId: 'b', tvgLogo: 'c', urlEnabled: true, url: '' }).url, undefined);
});

test('validateOverrideChanges: URL http/https ohne lokale/private Ziele, Logo ohne fremde Schemata', () => {
  assert.deepEqual(validateOverrideChanges({ url: 'https://stream.example.com/a.m3u8', tvgLogo: 'logos/a.png', name: 'x' }), {});
  assert.deepEqual(validateOverrideChanges({ url: undefined, name: undefined }), {});
  for (const bad of ['ftp://x.example/a', 'javascript:alert(1)', 'kein url', 'file:///etc/passwd']) {
    assert.ok(validateOverrideChanges({ url: bad }).url, bad);
  }
  for (const priv of ['http://127.0.0.1/a', 'http://localhost/a', 'http://192.168.1.5/a', 'http://10.0.0.1/a', 'http://[::1]/a']) {
    assert.match(validateOverrideChanges({ url: priv }).url, /lokales oder privates/, priv);
  }
  assert.ok(validateOverrideChanges({ tvgLogo: 'javascript:alert(1)' }).tvgLogo);
  assert.ok(validateOverrideChanges({ tvgLogo: 'data:image/png;base64,AAAA' }).tvgLogo);
  assert.deepEqual(validateOverrideChanges({ tvgLogo: 'https://l.example/x.png' }), {});
  assert.ok(validateOverrideChanges({ name: 'x'.repeat(201) }).name);
});

test('paginate: Ausschnitt, Seitenzahl, Korrektur ungültiger Seiten', () => {
  const items = Array.from({ length: 125 }, (_, i) => i);
  const p0 = paginate(items, 0, 50);
  assert.equal(p0.items.length, 50);
  assert.equal(p0.pages, 3);
  assert.equal(paginate(items, 2, 50).items.length, 25);
  assert.equal(paginate(items, 99, 50).page, 2);
  assert.equal(paginate(items, -4, 50).page, 0);
  assert.deepEqual(paginate([], 3, 50), { items: [], page: 0, pages: 1, total: 0 });
});
