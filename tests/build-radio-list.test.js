'use strict';

// Tests: scripts/build-radio-list.js (offline mit Fixtures), die eingecheckte radiosources.json und der Listenwechsel
// alt (21 Sender) -> neu (große Liste) mit der Merge-Logik aus R1.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildList, parseArgs } = require('../scripts/build-radio-list.js');
const { REQUIRED } = require('../scripts/radio-list-curated.js');
const { hasCredentials } = require('../lib/radio/radio-browser.js');
const { mergeRadiosources } = require('../lib/radiosources-merge.js');
const shipped = require('../radiosources.json');

const rbRaw = (n, extra = {}) => ({ stationuuid: `uuid-${n}`, name: `Sender ${n}`, url: `http://s${n}.test/stream`, url_resolved: `http://s${n}.test/stream`, votes: 1000 - n, lastcheckok: 1, codec: 'MP3', bitrate: 128, state: 'Bayern', tags: 'pop', ...extra });
const existing = { id: 'deutsche-radiosender', name: 'Deutsche Radiosender', type: 'bundled', stations: [{ id: 'alt-eins', name: 'Sender 3', streamUrl: 'http://alt.test/s', genre: 'Pop' }], sortOrder: ['alt-eins'] };

test('buildList: bestehende IDs/URLs bleiben, Dubletten, Mindest-Votes, Token-Adressen und Unerreichbare fallen heraus, Zielgröße', async () => {
  const pool = [
    rbRaw(1),
    rbRaw(2, { stationuuid: 'uuid-1' }), // Dublette über stationuuid
    rbRaw(3), // gleicher Name wie der bestehende Sender
    rbRaw(4, { name: 'Sender 1' }), // Dublette über Namen
    rbRaw(5, { url: 'http://s5.test/stream?token=x', url_resolved: 'http://s5.test/stream?token=x' }),
    rbRaw(6, { votes: 5 }), // unter Mindest-Votes
    rbRaw(7),
    rbRaw(8, { url: 'http://s1.test/stream', url_resolved: 'http://s1.test/stream' }), // gleiche Stream-Adresse wie 1
    rbRaw(9),
    rbRaw(10),
  ];
  const probe = async url => ({ ok: !url.includes('s9.test') });
  const { source, report } = await buildList({ existing, pool, api: null, probe, required: [], target: 3, minVotes: 100, concurrency: 2 });
  const byId = Object.fromEntries(source.stations.map(s => [s.id, s]));
  assert.equal(byId['alt-eins'].streamUrl, 'http://alt.test/s');
  assert.equal(byId['alt-eins'].rbUuid, 'uuid-3');
  assert.equal(source.stations.length, 3);
  assert.deepEqual(new Set(source.stations.map(s => s.id)), new Set(['alt-eins', 'sender-1', 'sender-7']));
  assert.equal(new Set(source.stations.map(s => s.rbUuid)).size, 3);
  assert.deepEqual(source.sortOrder, source.stations.map(s => s.id));
  assert.equal(source.type, 'bundled');
  assert.equal(source.id, 'deutsche-radiosender');
  assert.ok(source.stations.every(s => s.country === 'DE' && !hasCredentials(s.streamUrl)));
  assert.equal(report.count, 3);
});

test('buildList: Pflichtsender per Muster, Ersatzadresse, fehlend wird gemeldet; unerreichbarer bestehender Sender behält seine ID', async () => {
  const required = [
    { id: 'er-eins', name: 'Eins', match: /^Eins$/, search: 'Eins', genre: 'Pop', region: 'BY' },
    { id: 'er-zwei', name: 'Zwei', match: /^Zwei$/, search: 'Zwei', fallbackUrl: 'http://zwei.test/mid' },
    { id: 'er-drei', name: 'Drei', match: /^Drei$/, search: 'Drei' },
  ];
  const pool = [rbRaw(1, { name: 'Eins' }), rbRaw(2, { name: 'Zwei', url: 'http://z.test/s?token=1', url_resolved: 'http://z.test/s?token=1' })];
  const searched = [];
  const api = { getJson: async p => (searched.push(p), []) };
  const dead = { ...existing, stations: [...existing.stations, { id: 'tot', name: 'Tot', streamUrl: 'http://tot.test/s' }] };
  const probe = async url => ({ ok: !url.includes('tot.test') });
  const { source, report } = await buildList({ existing: dead, pool, api, probe, required, target: 10, minVotes: 100, concurrency: 2 });
  const byId = Object.fromEntries(source.stations.map(s => [s.id, s]));
  assert.equal(byId['er-eins'].streamUrl, 'http://s1.test/stream');
  assert.equal(byId['er-eins'].genre, 'Pop');
  assert.equal(byId['er-zwei'].streamUrl, 'http://zwei.test/mid');
  assert.equal(byId['er-drei'], undefined);
  assert.deepEqual(report.required.missing, ['er-drei']);
  assert.deepEqual(report.unreachableExisting, ['tot']);
  assert.ok(byId.tot);
  assert.ok(searched.some(p => p.includes('name=Drei')));
});

test('parseArgs: Standardwerte und Optionen', () => {
  assert.equal(parseArgs([]).target, 250);
  assert.deepEqual([parseArgs(['--target', '150', '--dry-run']).target, parseArgs(['--dry-run']).dryRun], [150, true]);
  assert.throws(() => parseArgs(['--unbekannt']), /Unbekannte Option/);
});

// ── eingecheckte Liste ──

const OLD_IDS = ['1live', 'wdr2-rheinland', 'wdr4', 'wdr5', 'swr3', 'antenne-bayern', 'antenne-bayern-chillout', 'rock-antenne', 'rock-antenne-heavy-metal', 'b5-aktuell', 'inforadio', 'mdr-aktuell', 'mdr-klassik', 'hit-radio-ffh', 'ffh-80er', 'deutschlandfunk', 'deutschlandfunk-kultur', 'dlf-nova', 'sunshine-live', '80s80s', '90s90s-hits'];

test('radiosources.json: 150–300 Sender, eindeutige IDs/UUIDs, keine Zugangsdaten, alle alten IDs und Pflichtsender enthalten', () => {
  assert.equal(shipped.length, 1);
  const { stations, sortOrder } = shipped[0];
  assert.ok(stations.length >= 150 && stations.length <= 300, String(stations.length));
  const ids = stations.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(sortOrder, ids);
  assert.equal(new Set(stations.map(s => s.rbUuid)).size, stations.length);
  for (const s of stations) {
    assert.ok(s.name && /^https?:\/\//.test(s.streamUrl), s.id);
    assert.equal(hasCredentials(s.streamUrl), false, s.id);
    assert.equal(s.country, 'DE');
  }
  for (const id of OLD_IDS) assert.ok(ids.includes(id), `alte ID fehlt: ${id}`);
  for (const entry of REQUIRED) assert.ok(ids.includes(entry.id), `Pflichtsender fehlt: ${entry.id}`);
});

test('Listenwechsel alt (21 Sender) -> neu: Favoriten, Reihenfolge und eigene Sender bleiben, neue Sender kommen dazu', () => {
  const oldStations = shipped[0].stations.filter(s => OLD_IDS.includes(s.id)).map(s => ({ id: s.id, name: s.name, streamUrl: s.streamUrl }));
  const base = [{ id: 'deutsche-radiosender', name: 'Deutsche Radiosender', type: 'bundled', stations: oldStations, sortOrder: OLD_IDS }];
  const favorites = ['swr3', '1live', 'dlf-nova'];
  const old = [
    { ...base[0], favorites, favoriteRank: { swr3: 0, '1live': 1, 'dlf-nova': 2 }, sortOrder: [...OLD_IDS].reverse() },
    { id: 'eigene-radiosender', name: 'Eigene Sender', type: 'user', stations: [{ id: 'custom-x', name: 'Mein Sender', streamUrl: 'http://lan.test/s' }], sortOrder: ['custom-x'], favorites: ['custom-x'], favoriteRank: { 'custom-x': 3 } },
  ];
  const { ok: merged, value } = mergeRadiosources(base, old, shipped);
  assert.equal(merged, true);
  const source = value.find(s => s.id === 'deutsche-radiosender');
  assert.deepEqual(source.favorites, favorites);
  assert.deepEqual(source.sortOrder, [...OLD_IDS].reverse());
  assert.equal(source.stations.length, shipped[0].stations.length);
  assert.ok(source.stations.every(s => s.removed !== true));
  assert.ok(source.stations.some(s => s.id === 'bayern-3'));
  const mine = value.find(s => s.id === 'eigene-radiosender');
  assert.deepEqual(mine.favorites, ['custom-x']);
  assert.equal(mine.stations.length, 1);
  // Merge ohne Basis (erstes Update nach R1): Favoriten bleiben ebenfalls
  assert.deepEqual(mergeRadiosources(null, old, shipped).value.find(s => s.id === 'deutsche-radiosender').favorites, favorites);
});

test('Backup: die große Liste als radioSources besteht die Backup-Prüfung und bleibt weit unter den Grenzen', () => {
  const { validateBackup, MAX_BACKUP_BYTES } = require('../lib/backup.js');
  const data = { services: [{ id: 'y', name: 'Y', url: 'https://youtube.com' }], tvsources: [], history: [], radioSources: shipped };
  assert.equal(validateBackup(data).ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(shipped)) < MAX_BACKUP_BYTES / 20);
});
