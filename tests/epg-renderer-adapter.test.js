'use strict';

// Tests: Adapter Main-EPG (ms) -> Renderer/tv.html (XMLTV-Zeitstrings), Etappe 3.7.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../lib/epg/renderer-adapter.js');
const { currentEpgStopMs } = require('../lib/recorder/ui-model.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const HOUR = 3600 * 1000;

test('msToXmltvTime: UTC-XMLTV-Format, ungültig -> leer', () => {
  assert.equal(adapter.msToXmltvTime(NOW), '20261006120000 +0000');
  assert.equal(adapter.msToXmltvTime(Date.UTC(2026, 0, 2, 3, 4, 5)), '20260102030405 +0000');
  for (const bad of [NaN, Infinity, '1', null, undefined]) assert.equal(adapter.msToXmltvTime(bad), '');
});

test('Rundreise: Adapter-Zeitstring wird von typed-core parseEpgTime und ui-model identisch gelesen', () => {
  const { parseEpgTime } = require('@streaming-hub/typed-core');
  const entry = adapter.slotToXmltvEntry({ start: NOW, stop: NOW + HOUR, title: 'Tagesschau', genre: 'News' });
  assert.deepEqual(entry, { title: 'Tagesschau', start: '20261006120000 +0000', stop: '20261006130000 +0000' });
  assert.equal(parseEpgTime(entry.start).getTime(), NOW);
  assert.equal(parseEpgTime(entry.stop).getTime(), NOW + HOUR);
  assert.equal(currentEpgStopMs([entry], NOW + 1000), NOW + HOUR);
});

test('slotToXmltvEntry/slotsToXmltvEntries: ungültige Slots entfallen, Titel bleibt Text', () => {
  assert.equal(adapter.slotToXmltvEntry(null), null);
  assert.equal(adapter.slotToXmltvEntry({ start: 'x', stop: 1 }), null);
  assert.equal(adapter.slotToXmltvEntry({ start: NOW, stop: NOW + 1 }).title, '');
  const list = adapter.slotsToXmltvEntries([null, { start: NOW, stop: NOW + HOUR, title: '<b>x</b> & y' }, undefined]);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '<b>x</b> & y');
  assert.deepEqual(adapter.slotsToXmltvEntries(undefined), []);
});

test('nowNextToMap: Zuordnung je channelKey, defekte Zeilen werden ignoriert', () => {
  const cur = { start: NOW - HOUR, stop: NOW + HOUR, title: 'A', genre: '' };
  const map = adapter.nowNextToMap([{ channelKey: 'ard.de', current: cur, next: null }, { channelKey: 5 }, null, { channelKey: 'zdf.de' }]);
  assert.deepEqual([...map.keys()], ['ard.de', 'zdf.de']);
  assert.equal(map.get('ard.de').current, cur);
  assert.deepEqual(map.get('zdf.de'), { current: null, next: null });
  assert.equal(adapter.nowNextToMap(undefined).size, 0);
});

test('resolveNowNext: Fortschreibung abgelaufener Sendungen', () => {
  const a = { start: NOW - HOUR, stop: NOW, title: 'A' };
  const b = { start: NOW, stop: NOW + HOUR, title: 'B' };
  assert.deepEqual(adapter.resolveNowNext({ current: a, next: b }, NOW - 1), { current: a, next: b });
  assert.deepEqual(adapter.resolveNowNext({ current: a, next: b }, NOW), { current: b, next: null });
  assert.deepEqual(adapter.resolveNowNext({ current: a, next: b }, NOW + HOUR), { current: null, next: null });
  // next noch nicht gestartet, current abgelaufen: nichts Laufendes, next bleibt
  const c = { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: 'C' };
  assert.deepEqual(adapter.resolveNowNext({ current: a, next: c }, NOW + 1), { current: null, next: c });
  assert.deepEqual(adapter.resolveNowNext(undefined, NOW), { current: null, next: null });
});

test('channelEpgKey/normEpgKey/chunk', () => {
  assert.equal(adapter.normEpgKey('  ARD.de@SD '), 'ard.de');
  assert.equal(adapter.channelEpgKey({ tvgId: 'ZDF.de@HD', name: 'x' }), 'zdf.de');
  assert.equal(adapter.channelEpgKey({ tvgId: '', name: 'Das Erste' }), 'das erste');
  assert.equal(adapter.channelEpgKey(null), '');
  assert.deepEqual(adapter.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(adapter.NOW_NEXT_CHUNK, 600);
});

test('Verdrahtung: Renderer nutzt Main-APIs statt Download/Index; Fremdtexte nicht per innerHTML', () => {
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf-8');
  assert.ok(!/tvEpgIndex|loadEpgData|fetchEPG|buildEpgIndex|parseXMLTV/.test(renderer));
  for (const api of ['getEpgNowNext', 'getEpgChannels', 'getEpgRangeMany', 'onEpgChanged', 'getEpgStatus', 'refreshEpgCache']) {
    assert.ok(renderer.includes(`electronAPI.${api}(`), api);
  }
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf-8');
  assert.ok(!/fetch-epg|fetchEPG/.test(preload));
  for (const f of ['eslint.config.js', '.eslintrc.json']) assert.ok(!/tvEpgIndex/.test(fs.readFileSync(path.join(ROOT, f), 'utf-8')), f);
});
