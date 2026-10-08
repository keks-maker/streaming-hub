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
  for (const bad of ['//evil.example/x.png', '\\\\host\\share\\x.png', 'file:///x.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
    assert.ok(validateOverrideChanges({ tvgLogo: bad }).tvgLogo, bad);
  }
  assert.deepEqual(validateOverrideChanges({ tvgLogo: 'logos/a.png' }), {});
  for (const bad of ['http://0.0.0.0/x', 'http://[::ffff:127.0.0.1]/x', 'http://[fd00::1]/x', 'http://printer.lan/x', 'http://intranet/x']) {
    assert.match(validateOverrideChanges({ url: bad }).url, /lokales oder privates/, bad);
  }
  assert.deepEqual(validateOverrideChanges({ url: 'http://[2001:4860:4860::8888]/x' }), {});
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

const { moveFavoriteAmongVisible, visibleFavoritePosition } = require('../lib/settings-channel-logic.js');

test('moveFavoriteAmongVisible: Geister behalten ihre Plätze, Tausch mit sichtbarem Nachbarn', () => {
  const favs = ['ghost1', 'a', 'ghost2', 'b', 'c', 'ghost3'];
  const visible = new Set(['a', 'b', 'c']);
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'b', -1, visible), ['ghost1', 'b', 'ghost2', 'a', 'c', 'ghost3']);
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'a', 1, visible), ['ghost1', 'b', 'ghost2', 'a', 'c', 'ghost3']);
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'c', -1, visible), ['ghost1', 'a', 'ghost2', 'c', 'b', 'ghost3']);
  for (const result of [
    moveFavoriteAmongVisible(favs, 'b', -1, visible),
    moveFavoriteAmongVisible(favs, 'c', -1, visible),
  ]) {
    assert.equal(new Set(result).size, favs.length, 'keine Duplikate/Verluste');
    assert.equal(result.indexOf('ghost1'), 0);
    assert.equal(result.indexOf('ghost2'), 2);
    assert.equal(result.indexOf('ghost3'), 5);
  }
});

test('moveFavoriteAmongVisible: Ränder, unbekannte Sender, ungültiges delta', () => {
  const favs = ['ghost', 'a', 'b', 'ghost2'];
  const visible = new Set(['a', 'b']);
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'a', -1, visible), favs, 'erster sichtbarer: kein Nachbar');
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'b', 1, visible), favs, 'letzter sichtbarer: kein Nachbar');
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'x', 1, visible), favs);
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'a', 2, visible), favs);
  assert.deepEqual(moveFavoriteAmongVisible(['a'], 'a', 1, new Set(['a'])), ['a']);
  assert.deepEqual(moveFavoriteAmongVisible(undefined, 'a', 1, visible), []);
  const input = ['a', 'b'];
  moveFavoriteAmongVisible(input, 'a', 1, new Set(['a', 'b']));
  assert.deepEqual(input, ['a', 'b'], 'Eingabe bleibt unverändert');
});

test('moveFavoriteAmongVisible: Seitengrenze (Position 49 -> 50) und Obergrenze', () => {
  const favs = Array.from({ length: 60 }, (_, i) => `c${i}`);
  const visible = new Set(favs);
  const moved = moveFavoriteAmongVisible(favs, 'c49', 1, visible);
  assert.equal(moved.indexOf('c49'), 50);
  assert.equal(moved.indexOf('c50'), 49);
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'c59', 1, visible), favs);
  assert.deepEqual(moveFavoriteAmongVisible(favs, 'c0', -1, visible), favs);
});

test('visibleFavoritePosition zählt nur sichtbare Favoriten', () => {
  const favs = ['ghost', 'a', 'ghost2', 'b'];
  const visible = new Set(['a', 'b']);
  assert.deepEqual(visibleFavoritePosition(favs, 'a', visible), { index: 0, count: 2 });
  assert.deepEqual(visibleFavoritePosition(favs, 'b', visible), { index: 1, count: 2 });
  assert.deepEqual(visibleFavoritePosition(favs, 'ghost', visible), { index: -1, count: 2 });
});

const { channelLabel } = require('../lib/settings-channel-logic.js');

test('channelLabel: Name, sonst tvg-id, sonst ID, sonst Platzhalter', () => {
  assert.equal(channelLabel({ id: 'c1', name: 'ARD', tvgId: 'ard.de' }), 'ARD');
  assert.equal(channelLabel({ id: 'c1', name: '', tvgId: 'ard.de' }), 'ard.de');
  assert.equal(channelLabel({ id: 'c1', name: '  ', tvgId: '' }), 'c1');
  assert.equal(channelLabel({}), 'Sender');
  assert.equal(channelLabel(undefined), 'Sender');
  assert.ok(!channelLabel({ id: undefined, name: undefined }).includes('undefined'));
});

// Regression: Favoriten aus mehreren Quellen (Dashboard-Reihenfolge = Einstellungen-Reihenfolge)
const { orderFavoriteChannels } = require('../lib/settings-channel-logic.js');

test('orderFavoriteChannels: Quellen nicht nach Index vermischt, Verschieben wirkt', () => {
  const channels = [
    { sourceId: 'A', id: 'a1' }, { sourceId: 'A', id: 'a2' }, { sourceId: 'A', id: 'a3' },
    { sourceId: 'B', id: 'b1' }, { sourceId: 'B', id: 'b2' }, { sourceId: 'B', id: 'x' },
  ];
  let sources = [{ id: 'A', favorites: ['a1', 'a2'] }, { id: 'B', favorites: ['b1', 'b2'] }];
  const ids = () => orderFavoriteChannels(channels, sources).map(c => c.id);
  assert.deepEqual(ids(), ['a1', 'a2', 'b1', 'b2']);
  sources = [{ id: 'A', favorites: ['a2', 'a1'] }, { id: 'B', favorites: ['b2', 'b1'] }];
  assert.deepEqual(ids(), ['a2', 'a1', 'b2', 'b1']);
  // gleiche Sender-ID in zwei Quellen bleibt eindeutig
  const dup = [{ sourceId: 'A', id: '1' }, { sourceId: 'B', id: '1' }];
  assert.deepEqual(
    orderFavoriteChannels(dup, [{ id: 'A', favorites: [] }, { id: 'B', favorites: ['1'] }]).map(c => c.sourceId),
    ['B'],
  );
});
