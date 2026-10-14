'use strict';

// Tests: Senderdaten (lib/radio/radio-sources-logic.js, RadioLibrary, radio-settings, mitgelieferte radiosources.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logic = require('../lib/radio/radio-sources-logic.js');
const { RadioLibrary } = require('../lib/radio/RadioLibrary.js');
const { createUserStorage } = require('../lib/user-storage.js');
const { normalizeRadioSettings, applyRadioSettingsPatch } = require('../lib/radio/radio-settings.js');
const { radioStreamUrlError, radioLogoUrlError } = require('../lib/input-validation.js');

const st = (id, extra = {}) => ({ id, name: id.toUpperCase(), streamUrl: `http://${id}.test/s`, ...extra });
const base = () => [
  { id: 'b1', name: 'Bundle 1', type: 'bundled', stations: [st('a', { genre: 'Pop' }), st('b'), st('c')], sortOrder: ['c', 'a', 'b'] },
  { id: 'b2', name: 'Bundle 2', type: 'bundled', stations: [st('a')], sortOrder: ['a'] },
];

test('mitgelieferte radiosources.json: gültiges Format, eindeutige IDs, sinnvolle URLs', () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'radiosources.json'), 'utf8'));
  assert.ok(Array.isArray(list) && list.length >= 1);
  const sourceIds = new Set();
  let total = 0;
  for (const source of list) {
    assert.ok(source.id && source.name);
    assert.equal(source.type, 'bundled');
    assert.ok(!sourceIds.has(source.id));
    sourceIds.add(source.id);
    const ids = new Set();
    for (const station of source.stations) {
      total += 1;
      assert.ok(station.id && station.name, 'id und Name');
      assert.ok(!ids.has(station.id), `doppelte ID ${station.id}`);
      ids.add(station.id);
      assert.equal(radioStreamUrlError(station.streamUrl), null, station.id);
      if (station.logo) assert.equal(radioLogoUrlError(station.logo), null);
      assert.equal(station.country, 'DE');
    }
    assert.deepEqual([...source.sortOrder].sort(), [...ids].sort(), 'sortOrder enthält genau die Sender');
  }
  assert.ok(total >= 150 && total <= 300, `Startliste ${total} Sender`);
  assert.ok(!list.some(s => s.id === logic.CUSTOM_SOURCE_ID), 'eigene Quelle wird zur Laufzeit ergänzt');
});

test('ensureCustomSource ergänzt "Eigene Sender" genau einmal', () => {
  const once = logic.ensureCustomSource(base());
  assert.equal(once.length, 3);
  const custom = once[2];
  assert.deepEqual([custom.id, custom.type, custom.stations], [logic.CUSTOM_SOURCE_ID, 'user', []]);
  assert.equal(logic.ensureCustomSource(once), once);
  assert.equal(logic.ensureCustomSource(undefined).length, 1);
});

test('effectiveStation wendet stationOverrides an (Name, Logo, Stream-URL), nur nicht-leere Strings', () => {
  const source = { id: 's', type: 'bundled', stationOverrides: { a: { name: 'Mein A', logo: 'https://l/a.png', streamUrl: '' } } };
  const e = logic.effectiveStation(source, st('a', { logo: 'https://alt/a.png' }));
  assert.equal(e.name, 'Mein A');
  assert.equal(e.logo, 'https://l/a.png');
  assert.equal(e.streamUrl, 'http://a.test/s');
  assert.equal(e.custom, false);
  assert.equal(e.sourceId, 's');
});

test('listStations: Quellenreihenfolge, je Quelle sortOrder, Favoritenstatus', () => {
  let sources = base();
  sources = logic.setStationFavorite(sources, 'b1', 'a', true);
  const list = logic.listStations(sources);
  assert.deepEqual(list.map(s => `${s.sourceId}/${s.id}`), ['b1/c', 'b1/a', 'b1/b', 'b2/a']);
  assert.deepEqual(list.map(s => s.favorite), [false, true, false, false]);
  assert.equal(list[1].favoriteRank, 0);
});

test('Favoriten: setzen, Reihenfolge global über Quellen, entfernen, Eingabe bleibt unverändert', () => {
  const sources = base();
  const snapshot = JSON.stringify(sources);
  let next = logic.setStationFavorite(sources, 'b1', 'b', true);
  next = logic.setStationFavorite(next, 'b2', 'a', true);
  next = logic.setStationFavorite(next, 'b1', 'a', true);
  assert.equal(JSON.stringify(sources), snapshot);
  assert.deepEqual(logic.favoriteKeys(next), [{ sourceId: 'b1', id: 'b' }, { sourceId: 'b2', id: 'a' }, { sourceId: 'b1', id: 'a' }]);
  next = logic.setFavoriteOrder(next, [{ sourceId: 'b2', id: 'a' }, { sourceId: 'b1', id: 'a' }, { sourceId: 'b1', id: 'b' }]);
  assert.deepEqual(logic.favoriteKeys(next).map(k => `${k.sourceId}/${k.id}`), ['b2/a', 'b1/a', 'b1/b']);
  assert.deepEqual(next[0].favorites, ['a', 'b']);
  assert.deepEqual(logic.favoriteStations(next).map(s => s.name), ['A', 'A', 'B']);
  next = logic.setStationFavorite(next, 'b1', 'a', false);
  assert.deepEqual(logic.favoriteKeys(next).map(k => `${k.sourceId}/${k.id}`), ['b2/a', 'b1/b']);
  assert.equal(logic.setStationFavorite(next, 'b1', 'a', false), next, 'kein Wechsel → gleiche Referenz');
});

test('Favorit für unbekannten Sender wird abgelehnt, Geister-Favoriten erscheinen nicht in der Liste', () => {
  assert.throws(() => logic.setStationFavorite(base(), 'b1', 'gibt-es-nicht', true), /Sender nicht gefunden/);
  const sources = base();
  sources[0].favorites = ['a', 'weg'];
  assert.deepEqual(logic.favoriteKeys(sources), [{ sourceId: 'b1', id: 'a' }]);
});

test('"removed"-Favorit bleibt in der Favoritenliste und ist als entfernt gekennzeichnet', () => {
  const sources = base();
  sources[0].stations.push(st('old', { removed: true }));
  const next = logic.setStationFavorite(sources, 'b1', 'old', true);
  const fav = logic.favoriteStations(next).find(s => s.id === 'old');
  assert.equal(fav.removed, true);
});

test('eigene Sender: hinzufügen, ändern, löschen (inkl. Favorit/Sortierung)', () => {
  let ids = 0;
  const idFactory = () => `custom-${++ids}`;
  const { sources, station } = logic.addCustomStation(base(), { name: 'Mein Sender', streamUrl: 'http://lan.test:8000/live', genre: 'Rock' }, { idFactory });
  assert.equal(station.id, 'custom-1');
  assert.equal(logic.findStation(sources, { sourceId: logic.CUSTOM_SOURCE_ID, stationId: 'custom-1' }).custom, true);
  assert.deepEqual(sources.at(-1).sortOrder, ['custom-1']);
  const second = logic.addCustomStation(sources, { name: 'Zwei', streamUrl: 'http://z.test/s', logo: 'https://l/z.png' }, { idFactory }).sources;
  assert.equal(second.at(-1).stations.length, 2);
  const favorited = logic.setStationFavorite(second, logic.CUSTOM_SOURCE_ID, 'custom-1', true);
  const updated = logic.updateCustomStation(favorited, 'custom-1', { name: 'Umbenannt', genre: null, logo: 'https://l/x.png' });
  const changed = updated.at(-1).stations[0];
  assert.deepEqual([changed.name, changed.genre, changed.logo], ['Umbenannt', undefined, 'https://l/x.png']);
  assert.throws(() => logic.updateCustomStation(updated, 'nein', { name: 'x' }), /nicht gefunden/);
  const removed = logic.removeCustomStation(updated, 'custom-1');
  assert.deepEqual(removed.at(-1).stations.map(s => s.id), ['custom-2']);
  assert.deepEqual(removed.at(-1).sortOrder, ['custom-2']);
  assert.deepEqual(logic.favoriteKeys(removed), []);
  assert.throws(() => logic.removeCustomStation(removed, 'custom-1'), /nicht gefunden/);
  assert.equal(logic.findStation(removed, { sourceId: 'b1', stationId: 'a' }).name, 'A', 'mitgelieferte Sender bleiben');
});

test('Standard-ID-Fabrik erzeugt eindeutige, lesbare IDs', () => {
  let sources = base();
  const ids = new Set();
  for (let i = 0; i < 20; i += 1) {
    const result = logic.addCustomStation(sources, { name: 'Äther Radio!', streamUrl: 'http://x.test/s' });
    sources = result.sources;
    assert.match(result.station.id, /^custom-ather-radio-[0-9a-f]{6}$/);
    ids.add(result.station.id);
  }
  assert.equal(ids.size, 20);
});

// ── RadioLibrary mit echtem user-storage ──

function library() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-lib-'));
  const bundlePath = path.join(dir, 'bundle');
  fs.mkdirSync(bundlePath);
  fs.writeFileSync(path.join(bundlePath, 'radiosources.json'), JSON.stringify(base()));
  const userDataPath = path.join(dir, 'user');
  const userStorage = createUserStorage({ userDataPath, bundlePath });
  return { dir, userDataPath, lib: new RadioLibrary({ userStorage }) };
}

test('RadioLibrary: ohne Nutzerkopie kommt die Bundle-Liste plus "Eigene Sender"; Schreiben legt die Nutzerkopie an', () => {
  const { lib, userDataPath } = library();
  assert.deepEqual(lib.getSources().map(s => s.id), ['b1', 'b2', logic.CUSTOM_SOURCE_ID]);
  assert.equal(fs.existsSync(path.join(userDataPath, 'radiosources.json')), false);
  lib.setFavorite('b1', 'a', true);
  assert.equal(fs.existsSync(path.join(userDataPath, 'radiosources.json')), true);
  assert.deepEqual(lib.getFavoriteKeys(), [{ sourceId: 'b1', id: 'a' }]);
  assert.equal(lib.getStation({ sourceId: 'b1', stationId: 'a' }).name, 'A');
  assert.equal(lib.getStation({ sourceId: 'x', stationId: 'a' }), null);
});

test('RadioLibrary: eigene Sender überleben Neuladen; Favoriten-Reihenfolge wird gespeichert', () => {
  const { lib, userDataPath } = library();
  const { station } = lib.addCustom({ name: 'Mein Sender', streamUrl: 'http://lan.test/s' });
  lib.setFavorite(logic.CUSTOM_SOURCE_ID, station.id, true);
  lib.setFavorite('b1', 'b', true);
  lib.setFavoriteOrder([{ sourceId: 'b1', id: 'b' }, { sourceId: logic.CUSTOM_SOURCE_ID, id: station.id }]);
  const again = new RadioLibrary({ userStorage: createUserStorage({ userDataPath, bundlePath: path.join(userDataPath, 'nix') }) });
  assert.deepEqual(again.getFavoriteKeys().map(k => k.id), ['b', station.id]);
  lib.updateCustom(station.id, { name: 'Neu' });
  assert.equal(lib.getStation({ sourceId: logic.CUSTOM_SOURCE_ID, stationId: station.id }).name, 'Neu');
  lib.removeCustom(station.id);
  assert.deepEqual(lib.getFavoriteKeys().map(k => k.id), ['b']);
});

test('RadioLibrary: kaputte Nutzerdatei führt nicht zum Absturz', () => {
  const { lib, userDataPath } = library();
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'radiosources.json'), '{kaputt');
  assert.deepEqual(lib.getSources().map(s => s.id), [logic.CUSTOM_SOURCE_ID]);
  fs.writeFileSync(path.join(userDataPath, 'radio-settings.json'), 'kaputt');
  assert.equal(lib.getSettings().volume, 0.8);
});

test('Radio-Einstellungen: Standardwerte, Normalisierung, Patch-Validierung', () => {
  assert.deepEqual(normalizeRadioSettings(undefined), { volume: 0.8, lastStation: null, resumeOnStart: false, pauseOnTv: true, keepPlayingWhenClosed: true, trayDisplay: 'station-title' });
  const n = normalizeRadioSettings({ volume: 7, lastStation: { sourceId: 's', id: 'a' }, pauseOnTv: 'ja', resumeOnStart: true });
  assert.deepEqual([n.volume, n.lastStation, n.pauseOnTv, n.resumeOnStart], [1, { sourceId: 's', id: 'a' }, true, true]);
  assert.equal(normalizeRadioSettings({ lastStation: { sourceId: 1 } }).lastStation, null);
  const cur = normalizeRadioSettings({});
  assert.equal(applyRadioSettingsPatch(cur, { volume: 0.2 }).volume, 0.2);
  assert.equal(applyRadioSettingsPatch(cur, { keepPlayingWhenClosed: false }).keepPlayingWhenClosed, false);
  assert.throws(() => applyRadioSettingsPatch(cur, { evil: 1 }), /Unbekanntes Feld/);
  assert.throws(() => applyRadioSettingsPatch(cur, { pauseOnTv: 'x' }), /Boolean/);
  assert.throws(() => applyRadioSettingsPatch(cur, { volume: 'laut' }), /Lautstärke/);
  assert.throws(() => applyRadioSettingsPatch(cur, { lastStation: { sourceId: 1 } }), /Zuletzt/);
  assert.throws(() => applyRadioSettingsPatch(cur, null), /Ungültige/);
});
