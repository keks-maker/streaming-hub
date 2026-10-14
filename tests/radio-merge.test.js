'use strict';

// Tests: 3-way-Merge der Radio-Senderliste (lib/radiosources-merge.js) und Reconcile beim Start.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeRadiosources } = require('../lib/radiosources-merge.js');
const { reconcileRadioSources } = require('../lib/post-update-reconcile.js');

const st = (id, extra = {}) => ({ id, name: id.toUpperCase(), streamUrl: `http://${id}.test/s`, ...extra });
const bundled = (stations, extra = {}) => ({ id: 'deutsche-radiosender', name: 'Deutsche Radiosender', type: 'bundled', stations, sortOrder: stations.map(s => s.id), ...extra });
const custom = (stations = [], extra = {}) => ({ id: 'eigene-radiosender', name: 'Eigene Sender', type: 'user', stations, sortOrder: stations.map(s => s.id), ...extra });
const find = (list, id) => list.find(s => s.id === id);

test('ohne Geräte-Kopie gilt der mitgelieferte Stand; ohne neuen Stand bleibt die alte Datei', () => {
  const neu = [bundled([st('a')])];
  assert.deepEqual(mergeRadiosources(null, null, neu).value, neu);
  const r = mergeRadiosources(null, [bundled([st('a')])], null);
  assert.equal(r.ok, false);
  assert.equal(r.keepOld, true);
  assert.equal(mergeRadiosources(null, {}, neu).keepOld, true);
  assert.equal(mergeRadiosources(null, [], 'x').keepOld, true);
});

test('Favoriten und Reihenfolge des Nutzers bleiben, neue Sender kommen dazu', () => {
  const base = [bundled([st('a'), st('b')])];
  const old = [bundled([st('a'), st('b')], { favorites: ['b', 'a'], favoriteRank: { b: 0, a: 1 }, sortOrder: ['b', 'a'] })];
  const neu = [bundled([st('a'), st('b'), st('c')])];
  const { value } = mergeRadiosources(base, old, neu);
  const src = find(value, 'deutsche-radiosender');
  assert.deepEqual(src.favorites, ['b', 'a']);
  assert.deepEqual(src.favoriteRank, { b: 0, a: 1 });
  assert.deepEqual(src.sortOrder, ['b', 'a']);
  assert.deepEqual(src.stations.map(s => s.id), ['a', 'b', 'c']);
});

test('unveränderte Nutzerfelder folgen dem neuen Stand (Sortierung)', () => {
  const base = [bundled([st('a'), st('b')])];
  const old = [bundled([st('a'), st('b')])];
  const neu = [bundled([st('a'), st('b'), st('c')], { sortOrder: ['c', 'a', 'b'] })];
  const src = find(mergeRadiosources(base, old, neu).value, 'deutsche-radiosender');
  assert.deepEqual(src.sortOrder, ['c', 'a', 'b']);
});

test('Stream-URL-Korrektur der neuen Version gilt für Sender ohne Nutzer-Override', () => {
  const base = [bundled([st('a')])];
  const old = [bundled([st('a')])];
  const neu = [bundled([st('a', { streamUrl: 'http://neu.test/s' })])];
  const src = find(mergeRadiosources(base, old, neu).value, 'deutsche-radiosender');
  assert.equal(src.stations[0].streamUrl, 'http://neu.test/s');
});

test('stationOverrides: Nutzer-Eintrag gewinnt, unberührte folgen dem neuen Stand, Entfernung im Release greift', () => {
  const base = [bundled([st('a'), st('b'), st('c')], { stationOverrides: { b: { name: 'Alt-B' }, c: { logo: 'https://x/c.png' } } })];
  const old = [
    bundled([st('a'), st('b'), st('c')], {
      stationOverrides: { a: { name: 'Mein A' }, b: { name: 'Alt-B' }, c: { logo: 'https://x/c.png' } },
    }),
  ];
  const neu = [bundled([st('a'), st('b'), st('c')], { stationOverrides: { b: { name: 'Neu-B' } } })];
  const src = find(mergeRadiosources(base, old, neu).value, 'deutsche-radiosender');
  assert.deepEqual(src.stationOverrides, { a: { name: 'Mein A' }, b: { name: 'Neu-B' } });
});

test('Override des Nutzers ist unabhängig von der Schlüsselreihenfolge unverändert (kein Falsch-Positiv)', () => {
  const base = [bundled([st('a')], { stationOverrides: { a: { name: 'X', logo: 'https://l/x.png' } } })];
  const old = [bundled([st('a')], { stationOverrides: { a: { logo: 'https://l/x.png', name: 'X' } } })];
  const neu = [bundled([st('a')], { stationOverrides: { a: { name: 'Y' } } })];
  assert.deepEqual(find(mergeRadiosources(base, old, neu).value, 'deutsche-radiosender').stationOverrides, { a: { name: 'Y' } });
});

test('entfernter Favorit bleibt als "removed" markiert, entfernter Nicht-Favorit verschwindet', () => {
  const base = [bundled([st('a'), st('b'), st('c')])];
  const old = [bundled([st('a'), st('b'), st('c')], { favorites: ['b'], favoriteRank: { b: 0 } })];
  const neu = [bundled([st('a')])];
  const src = find(mergeRadiosources(base, old, neu).value, 'deutsche-radiosender');
  assert.deepEqual(src.stations.map(s => s.id), ['a', 'b']);
  assert.equal(src.stations.find(s => s.id === 'b').removed, true);
  assert.equal(src.stations.find(s => s.id === 'b').name, 'B');
  assert.deepEqual(src.favorites, ['b']);
});

test('Override eines entfernten Favoriten bleibt, Override eines entfernten Nicht-Favoriten entfällt', () => {
  const base = [bundled([st('a'), st('b'), st('c')])];
  const old = [bundled([st('a'), st('b'), st('c')], { favorites: ['b'], stationOverrides: { b: { name: 'Mein B' }, c: { name: 'Mein C' } } })];
  const neu = [bundled([st('a')])];
  const src = find(mergeRadiosources(base, old, neu).value, 'deutsche-radiosender');
  assert.deepEqual(src.stationOverrides, { b: { name: 'Mein B' } });
});

test('kehrt ein markierter Sender in die Liste zurück, ist er nicht mehr "removed"', () => {
  const old = [bundled([st('a'), st('b', { removed: true })], { favorites: ['b'] })];
  const neu = [bundled([st('a'), st('b')])];
  const src = find(mergeRadiosources([bundled([st('a')])], old, neu).value, 'deutsche-radiosender');
  assert.equal(src.stations.find(s => s.id === 'b').removed, undefined);
});

test('eigene Sender (type user) bleiben vollständig erhalten, auch mit Favoriten', () => {
  const mine = custom([st('custom-x'), st('custom-y')], { favorites: ['custom-y'], favoriteRank: { 'custom-y': 0 } });
  const old = [bundled([st('a')]), mine];
  const neu = [bundled([st('a'), st('b')])];
  const { value } = mergeRadiosources([bundled([st('a')])], old, neu);
  assert.deepEqual(find(value, 'eigene-radiosender'), mine);
  assert.equal(find(value, 'deutsche-radiosender').stations.length, 2);
});

test('neue mitgelieferte Quelle wird angehängt, entfernte Quelle bleibt nur mit Favoriten (als removed)', () => {
  const old = [bundled([st('a'), st('b')], { favorites: ['a'] }), { ...bundled([st('z')]), id: 'alt', name: 'Alt' }];
  const neu = [bundled([st('a'), st('b')]), { ...bundled([st('n')]), id: 'neu', name: 'Neu' }];
  const { value } = mergeRadiosources(null, old, neu);
  assert.deepEqual(value.map(s => s.id), ['deutsche-radiosender', 'neu']);
  const withFav = [bundled([st('a')]), { ...bundled([st('z'), st('y')], { favorites: ['z'] }), id: 'alt', name: 'Alt' }];
  const kept = mergeRadiosources(null, withFav, [bundled([st('a')])]).value;
  const alt = find(kept, 'alt');
  assert.deepEqual(alt.stations.map(s => s.id), ['z']);
  assert.equal(alt.stations[0].removed, true);
});

test('Merge ist idempotent und verändert die Eingaben nicht', () => {
  const base = [bundled([st('a'), st('b')])];
  const old = [bundled([st('a'), st('b')], { favorites: ['a'], favoriteRank: { a: 0 } }), custom([st('custom-x')])];
  const neu = [bundled([st('a'), st('b'), st('c')])];
  const snapshot = JSON.stringify([base, old, neu]);
  const first = mergeRadiosources(base, old, neu).value;
  assert.equal(JSON.stringify([base, old, neu]), snapshot);
  const second = mergeRadiosources(neu, first, neu).value;
  assert.deepEqual(second, first);
});

test('Zwei-Wege-Merge ohne Basis: vorhandene Favoriten gelten als Nutzerdaten', () => {
  const old = [bundled([st('a')], { favorites: ['a'], favoriteRank: { a: 0 } })];
  const neu = [bundled([st('a'), st('b')])];
  const src = find(mergeRadiosources(null, old, neu).value, 'deutsche-radiosender');
  assert.deepEqual(src.favorites, ['a']);
  assert.equal(src.stations.length, 2);
});

// ── Reconcile (Dateiebene) ──

function tmpFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-reconcile-'));
  return {
    dir,
    userFile: path.join(dir, 'radiosources.json'),
    bundleFile: path.join(dir, 'bundle-radiosources.json'),
    baseFile: path.join(dir, 'radiosources-base.json'),
  };
}
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('reconcile: ohne Nutzerkopie wird nur die Basis gemerkt', () => {
  const f = tmpFiles();
  write(f.bundleFile, [bundled([st('a')])]);
  const r = reconcileRadioSources(f);
  assert.equal(r.merged, false);
  assert.equal(fs.existsSync(f.userFile), false);
  assert.deepEqual(read(f.baseFile), [bundled([st('a')])]);
});

test('reconcile: neue Senderliste wird mit Nutzerdaten zusammengeführt, Basis aktualisiert', () => {
  const f = tmpFiles();
  write(f.baseFile, [bundled([st('a')])]);
  write(f.userFile, [bundled([st('a')], { favorites: ['a'], favoriteRank: { a: 0 } }), custom([st('custom-x')])]);
  write(f.bundleFile, [bundled([st('a'), st('b')])]);
  const r = reconcileRadioSources(f);
  assert.equal(r.merged, true);
  const user = read(f.userFile);
  assert.deepEqual(find(user, 'deutsche-radiosender').favorites, ['a']);
  assert.equal(find(user, 'deutsche-radiosender').stations.length, 2);
  assert.equal(find(user, 'eigene-radiosender').stations.length, 1);
  assert.deepEqual(read(f.baseFile), read(f.bundleFile));
});

test('reconcile: unveränderte Bundle-Liste lässt die Nutzerkopie unberührt', () => {
  const f = tmpFiles();
  write(f.baseFile, [bundled([st('a')])]);
  write(f.bundleFile, [bundled([st('a')])]);
  write(f.userFile, '[{"id":"x"}]');
  const before = fs.readFileSync(f.userFile, 'utf8');
  const r = reconcileRadioSources(f);
  assert.equal(r.merged, false);
  assert.equal(fs.readFileSync(f.userFile, 'utf8'), before);
});

test('reconcile: unlesbare Nutzerkopie wird nie überschrieben', () => {
  const f = tmpFiles();
  write(f.bundleFile, [bundled([st('a')])]);
  write(f.userFile, '{kaputt');
  const r = reconcileRadioSources(f);
  assert.equal(r.merged, false);
  assert.equal(fs.readFileSync(f.userFile, 'utf8'), '{kaputt');
  assert.equal(fs.existsSync(f.baseFile), false);
});

test('reconcile: fehlt oder zerbricht die mitgelieferte Datei, passiert nichts (wirft nie)', () => {
  const f = tmpFiles();
  assert.equal(reconcileRadioSources(f).merged, false);
  write(f.bundleFile, '{"kein":"array"}');
  write(f.userFile, [bundled([st('a')])]);
  assert.equal(reconcileRadioSources(f).merged, false);
  assert.deepEqual(read(f.userFile), [bundled([st('a')])]);
});

test('reconcile: zweiter Lauf ist ein No-op', () => {
  const f = tmpFiles();
  write(f.baseFile, [bundled([st('a')])]);
  write(f.userFile, [bundled([st('a')], { favorites: ['a'], favoriteRank: { a: 0 } })]);
  write(f.bundleFile, [bundled([st('a'), st('b')])]);
  assert.equal(reconcileRadioSources(f).merged, true);
  const after = fs.readFileSync(f.userFile, 'utf8');
  assert.equal(reconcileRadioSources(f).merged, false);
  assert.equal(fs.readFileSync(f.userFile, 'utf8'), after);
});
