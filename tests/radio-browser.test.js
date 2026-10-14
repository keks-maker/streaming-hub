'use strict';

// Tests: radio-browser.info-Zugriff (lib/radio/radio-browser.js) und „Liste aktualisieren“ (radio-refresh.js), offline mit Fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rb = require('../lib/radio/radio-browser.js');
const { refreshStreamUrls } = require('../lib/radio/radio-refresh.js');
const { RadioLibrary } = require('../lib/radio/RadioLibrary.js');
const { createUserStorage } = require('../lib/user-storage.js');
const logic = require('../lib/radio/radio-sources-logic.js');

const raw = (extra = {}) => ({ stationuuid: 'u1', name: 'Alpha', url: 'http://a.test/s', url_resolved: 'http://a.test/s', votes: 10, lastcheckok: 1, codec: 'MP3', bitrate: 128, ...extra });

test('Kandidaten: Token-/Zugangsdaten-Adressen werden verworfen, aggregator-Markierung entfernt, url als Ersatz', () => {
  assert.equal(rb.normalizeCandidate(raw({ url_resolved: 'http://a.test/s?token=abc' , url: 'http://a.test/plain' })).streamUrl, 'http://a.test/plain');
  assert.equal(rb.normalizeCandidate(raw({ url_resolved: 'http://a.test/s?token=abc', url: 'http://a.test/s?sid=1' })), null);
  assert.equal(rb.normalizeCandidate(raw({ url_resolved: 'http://u:p@a.test/s', url: 'http://u:p@a.test/s' })), null);
  assert.equal(rb.normalizeCandidate(raw({ url_resolved: 'https://a.test/s?aggregator=web' })).streamUrl, 'https://a.test/s');
  assert.equal(rb.normalizeCandidate(raw({ url_resolved: 'ftp://a.test/s', url: 'ftp://a.test/s' })), null);
  assert.equal(rb.normalizeCandidate(raw({ lastcheckok: 0 })), null);
  assert.equal(rb.normalizeCandidate({ name: 'ohne uuid', url: 'http://a.test/s' }), null);
  const c = rb.normalizeCandidate(raw({ name: 'DLF | MP3 128k', codec: 'AAC+', tags: 'schlager,pop', state: 'Hessen', favicon: 'javascript:x', homepage: 'https://a.test/' }));
  assert.deepEqual([c.name, c.codec, c.genre, c.region, c.logo, c.homepage], ['DLF', 'aac', 'Schlager', 'HE', null, 'https://a.test/']);
});

test('Serverauswahl: DNS-Namen (nur radio-browser.info), sonst feste Liste', async () => {
  assert.deepEqual(await rb.resolveApiServers({ resolveHosts: async () => ['de1.api.radio-browser.info', 'evil.example.com', 'de1.api.radio-browser.info', 'fr1.api.radio-browser.info'] }), ['de1.api.radio-browser.info', 'fr1.api.radio-browser.info']);
  const fallback = await rb.resolveApiServers({ resolveHosts: async () => { throw new Error('dns'); }, fallback: ['x.api.radio-browser.info'] });
  assert.deepEqual(fallback, ['x.api.radio-browser.info']);
  assert.deepEqual(await rb.resolveApiServers({ resolveHosts: async () => [], fallback: ['y.api.radio-browser.info'] }), ['y.api.radio-browser.info']);
});

test('API-Client: User-Agent, Zufallsreihenfolge und Failover auf den nächsten Server', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, ua: options.headers['User-Agent'] });
    if (url.startsWith('https://a.')) return { ok: false, status: 503 };
    if (url.startsWith('https://b.')) throw new Error('netz');
    return { ok: true, json: async () => [{ ok: true }] };
  };
  const api = rb.createApiClient({ servers: ['a.x', 'b.x', 'c.x'], fetchImpl, random: () => 0.999 });
  assert.deepEqual(await api.getJson('/json/x'), [{ ok: true }]);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(entry => /StreamingHub/.test(entry.ua)));
  const dead = rb.createApiClient({ servers: ['a.x'], fetchImpl });
  await assert.rejects(dead.getJson('/json/x'), /nicht erreichbar/);
});

test('fetchByUuids: Blöcke und URL-Kodierung', async () => {
  const requests = [];
  const api = { getJson: async p => (requests.push(p), [{ stationuuid: 'x' }]) };
  const list = await rb.fetchByUuids(api, ['a', 'b', 'c'], { chunk: 2 });
  assert.equal(list.length, 2);
  assert.deepEqual(requests, ['/json/stations/byuuid?uuids=a,b', '/json/stations/byuuid?uuids=c']);
});

// ── Liste aktualisieren ──

const bundled = (stations, extra = {}) => ({ id: 'b', name: 'B', type: 'bundled', stations, ...extra });
const st = (id, extra = {}) => ({ id, name: id, streamUrl: `http://${id}.test/old`, rbUuid: `uuid-${id}`, ...extra });
const dir = id => ({ stationuuid: `uuid-${id}`, name: id, url: `http://${id}.test/new`, url_resolved: `http://${id}.test/new`, lastcheckok: 1, votes: 1 });

test('refresh: abweichende, erreichbare Adresse wird gemerkt; Override, Fehler, Token und eigene Sender bleiben außen vor', async () => {
  const sources = [
    bundled([st('a'), st('b'), st('c'), st('d'), st('e'), { id: 'x', name: 'x', streamUrl: 'http://x.test/s' }], { stationOverrides: { b: { streamUrl: 'http://mine.test/s' } } }),
    { id: 'eigene-radiosender', name: 'Eigene', type: 'user', stations: [{ id: 'u', name: 'u', streamUrl: 'http://u.test/s', rbUuid: 'uuid-u' }] },
  ];
  const directory = [dir('a'), dir('b'), dir('c'), { ...dir('d'), url: 'http://d.test/s?token=1', url_resolved: 'http://d.test/s?token=1' }, { ...dir('e'), url: 'http://e.test/old', url_resolved: 'http://e.test/old' }, dir('u')];
  const requests = [];
  const api = { getJson: async p => (requests.push(p), directory) };
  const probe = async url => ({ ok: !url.startsWith('http://c.test') });
  const result = await refreshStreamUrls({ sources, api, probe });
  assert.deepEqual({ checked: result.checked, updated: result.updated, failed: result.failed, reverted: result.reverted }, { checked: 4, updated: 1, failed: 1, reverted: 0 });
  assert.deepEqual(result.refreshed, { b: { a: 'http://a.test/new' } });
  assert.ok(!requests.join().includes('uuid-u') && !requests.join().includes('uuid-b'));
});

test('refresh: Limit, Zurücksetzen auf die gelieferte Adresse und Fehler des Verzeichnisses', async () => {
  const sources = [bundled([st('a'), st('b'), st('c')])];
  const api = { getJson: async () => [dir('a'), dir('b'), dir('c')] };
  const limited = await refreshStreamUrls({ sources, api, probe: async () => ({ ok: true }), limit: 2 });
  assert.equal(limited.checked, 2);
  assert.deepEqual(Object.keys(limited.refreshed.b), ['a', 'b']);
  const back = await refreshStreamUrls({ sources: [{ ...sources[0], refreshedStreams: { a: 'http://a.test/new' } }], refreshed: { b: { a: 'http://a.test/new' } }, api: { getJson: async () => [{ ...dir('a'), url: 'http://a.test/old', url_resolved: 'http://a.test/old' }] }, probe: async () => ({ ok: true }) });
  assert.equal(back.reverted, 1);
  assert.deepEqual(back.refreshed, {});
  await assert.rejects(refreshStreamUrls({ sources, api: { getJson: async () => { throw new Error('offline'); } }, probe: async () => ({ ok: true }) }), /offline/);
});

test('RadioLibrary: aktualisierte Adresse liegt zwischen Nutzer-Override und Bundle und wird nie in radiosources.json geschrieben', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-refresh-'));
  const bundlePath = path.join(tmp, 'bundle');
  fs.mkdirSync(bundlePath);
  fs.writeFileSync(path.join(bundlePath, 'radiosources.json'), JSON.stringify([bundled([st('a'), st('b')])]));
  const userDataPath = path.join(tmp, 'user');
  const lib = new RadioLibrary({ userStorage: createUserStorage({ userDataPath, bundlePath }) });
  const url = key => lib.getStation({ sourceId: 'b', stationId: key }).streamUrl;
  assert.equal(url('a'), 'http://a.test/old');
  lib.setRefreshedStreams({ b: { a: 'http://a.test/new', b: 'http://b.test/new' } });
  assert.equal(url('a'), 'http://a.test/new');
  lib.setOverride('b', 'b', { streamUrl: 'http://mine.test/s' });
  assert.equal(url('b'), 'http://mine.test/s');
  lib.setFavorite('b', 'a', true);
  const persisted = JSON.parse(fs.readFileSync(path.join(userDataPath, 'radiosources.json'), 'utf8'));
  assert.ok(persisted.every(source => !('refreshedStreams' in source)));
  assert.equal(persisted.find(source => source.id === 'b').stations[0].streamUrl, 'http://a.test/old');
  assert.equal(logic.listStations(lib.getSources()).find(s => s.id === 'a').streamUrl, 'http://a.test/new');
});
