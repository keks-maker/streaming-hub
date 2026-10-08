const test = require('node:test');
const assert = require('node:assert/strict');
const {
  globalFavoriteList,
  applyFavoriteOrder,
  toggleGlobalFavorite,
  moveGlobalFavorite,
  globalFavoritePosition,
  moveGlobalFavoriteTo,
  orderFavoriteChannels,
  filterManagedChannels,
} = require('../lib/settings-channel-logic.js');
const { mergeTvsources } = require('../lib/tvsources-merge.js');

const e = (sourceId, id) => ({ sourceId, id });
const ids = list => list.map(x => `${x.sourceId}:${x.id}`);
const legacy = () => [
  { id: 'A', favorites: ['a1', 'a2'] },
  { id: 'B', favorites: ['b1', 'b2'] },
];

test('Migration: ohne Rang gilt Quellenreihenfolge + Index (bisherige Anzeige)', () => {
  assert.deepEqual(ids(globalFavoriteList(legacy())), ['A:a1', 'A:a2', 'B:b1', 'B:b2']);
});

test('Mischen über Quellen: Sender aus B vor Sender aus A, Persistenz in Rängen', () => {
  const sources = legacy();
  const list = moveGlobalFavoriteTo(globalFavoriteList(sources), e('B', 'b1'), e('A', 'a1'));
  const next = applyFavoriteOrder(sources, list);
  assert.deepEqual(ids(globalFavoriteList(next)), ['B:b1', 'A:a1', 'A:a2', 'B:b2']);
  assert.deepEqual(next[0].favorites, ['a1', 'a2']);
  assert.deepEqual(next[1].favorites, ['b1', 'b2']);
  assert.deepEqual(sources[0].favoriteRank, undefined, 'Eingabe bleibt unverändert');
});

test('Hoch/Runter an der Quellgrenze wechselt in die andere Quelle', () => {
  const list = globalFavoriteList(legacy());
  const up = moveGlobalFavorite(list, e('B', 'b1'), -1);
  assert.deepEqual(ids(up), ['A:a1', 'B:b1', 'A:a2', 'B:b2']);
  const down = moveGlobalFavorite(list, e('A', 'a2'), 1);
  assert.deepEqual(ids(down), ['A:a1', 'B:b1', 'A:a2', 'B:b2']);
  assert.deepEqual(ids(moveGlobalFavorite(list, e('A', 'a1'), -1)), ids(list), 'Anfang bleibt');
  assert.deepEqual(ids(moveGlobalFavorite(list, e('B', 'b2'), 1)), ids(list), 'Ende bleibt');
});

test('Geister-Favoriten werden beim Verschieben übersprungen und behalten ihren Platz', () => {
  const list = [e('A', 'a1'), e('A', 'geist'), e('B', 'b1')];
  const visible = x => x.id !== 'geist';
  assert.deepEqual(ids(moveGlobalFavorite(list, e('B', 'b1'), -1, visible)), ['B:b1', 'A:geist', 'A:a1']);
  assert.deepEqual(globalFavoritePosition(list, e('B', 'b1'), visible), { index: 1, count: 2 });
});

test('gleiche Sender-ID in zwei Quellen bleibt getrennt', () => {
  const sources = [
    { id: 'A', favorites: ['x'] },
    { id: 'B', favorites: ['x'] },
  ];
  const list = moveGlobalFavorite(globalFavoriteList(sources), e('B', 'x'), -1);
  const next = applyFavoriteOrder(sources, list);
  assert.deepEqual(ids(globalFavoriteList(next)), ['B:x', 'A:x']);
  const channels = [
    { sourceId: 'A', id: 'x' },
    { sourceId: 'B', id: 'x' },
  ];
  assert.deepEqual(orderFavoriteChannels(channels, next).map(c => c.sourceId), ['B', 'A']);
  assert.deepEqual(filterManagedChannels(channels, next, { view: 'favorites' }).map(c => c.sourceId), ['B', 'A']);
});

test('neuer Favorit ans Ende, Entfernen räumt Rang und favorites auf', () => {
  let sources = applyFavoriteOrder(legacy(), moveGlobalFavoriteTo(globalFavoriteList(legacy()), e('B', 'b2'), e('A', 'a1')));
  sources = applyFavoriteOrder(sources, toggleGlobalFavorite(globalFavoriteList(sources), e('A', 'neu')));
  assert.deepEqual(ids(globalFavoriteList(sources)), ['B:b2', 'A:a1', 'A:a2', 'B:b1', 'A:neu']);
  sources = applyFavoriteOrder(sources, toggleGlobalFavorite(globalFavoriteList(sources), e('A', 'a1')));
  assert.deepEqual(ids(globalFavoriteList(sources)), ['B:b2', 'A:a2', 'B:b1', 'A:neu']);
  assert.deepEqual(sources[0].favorites, ['a2', 'neu']);
  assert.equal(sources[0].favoriteRank.a1, undefined);
});

test('gelöschte Quelle: verwaiste Einträge verschwinden, Rest bleibt in Reihenfolge', () => {
  const sources = applyFavoriteOrder(legacy(), [e('B', 'b1'), e('A', 'a1'), e('B', 'b2'), e('A', 'a2')]);
  assert.deepEqual(ids(globalFavoriteList(sources.filter(s => s.id !== 'A'))), ['B:b1', 'B:b2']);
  const cleaned = applyFavoriteOrder(sources, [e('A', 'a1'), e('GONE', 'z'), e('A', 'a1'), e('B', 'b1')]);
  assert.deepEqual(ids(globalFavoriteList(cleaned)), ['A:a1', 'B:b1']);
  assert.deepEqual(cleaned[1].favorites, ['b1']);
});

test('Ränge: Einträge ohne Rang (Altpfad) folgen nach den gerankten', () => {
  const sources = [
    { id: 'A', favorites: ['a1', 'a2'], favoriteRank: { a1: 1 } },
    { id: 'B', favorites: ['b1'], favoriteRank: { b1: 0 } },
  ];
  assert.deepEqual(ids(globalFavoriteList(sources)), ['B:b1', 'A:a1', 'A:a2']);
});

test('Quellen-Refresh (mergeTvsources) erhält die globale Reihenfolge des Users', () => {
  const base = [{ id: 'A', url: 'u', favorites: ['a1'] }];
  const old = [{ id: 'A', url: 'u', favorites: ['a1'], favoriteRank: { a1: 3 } }];
  const neu = [{ id: 'A', url: 'u2', favorites: ['a1'] }];
  const merged = mergeTvsources(base, old, neu);
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.value[0].favoriteRank, { a1: 3 });
  assert.equal(merged.value[0].url, 'u2');
  const untouched = mergeTvsources(base, base, [{ ...neu[0], favoriteRank: { a1: 0 } }]);
  assert.deepEqual(untouched.value[0].favoriteRank, { a1: 0 });
});
