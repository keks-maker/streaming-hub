'use strict';

// Tests: Mediathek-Einstellungen (lib/mediathek/settings.js) und die zugehörigen IPC-Kanäle (Weiterschauen, Einstellungen).

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/mediathek/settings.js');
const { registerMediathekIpc } = require('../lib/mediathek/ipc.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { createMediathekFavorites } = require('../lib/mediathek/favorites.js');
const { createWatchProgress } = require('../lib/mediathek/watch-progress.js');

test('Normalisierung: Standard, Teilangaben und Müll', () => {
  assert.deepEqual(s.normalizeMediathekSettings(null), { sources: { ard: true, zdf: true, arte: true }, quality: 'auto', audioLanguage: 'de', subtitles: 'off' });
  assert.deepEqual(s.normalizeMediathekSettings({ sources: { zdf: false, rtl: false }, quality: '720', audioLanguage: 'fr', subtitles: 'de' }), {
    sources: { ard: true, zdf: false, arte: true },
    quality: '720',
    audioLanguage: 'de',
    subtitles: 'de',
  });
  assert.equal(s.normalizeMediathekSettings('x').quality, 'auto');
  assert.equal(s.normalizeMediathekSettings({ sources: [] }).sources.ard, true);
  assert.equal(s.normalizeMediathekSettings({ sources: { ard: 'nein' } }).sources.ard, true);
});

test('Teiländerung: gültig und ungültig', () => {
  const base = s.normalizeMediathekSettings(null);
  assert.equal(s.applyMediathekSettingsPatch(base, { quality: '1080' }).quality, '1080');
  assert.deepEqual(s.applyMediathekSettingsPatch(base, { sources: { arte: false } }).sources, { ard: true, zdf: true, arte: false });
  assert.equal(base.sources.arte, true, 'Eingabe bleibt unverändert');
  for (const bad of [{ quality: '4k' }, { audioLanguage: 'fr' }, { subtitles: 'alle' }, { sources: { rtl: true } }, { sources: { ard: 'ja' } }, { sources: [] }, { nope: 1 }, null, 'x', []]) {
    assert.throws(() => s.applyMediathekSettingsPatch(base, bad), undefined, JSON.stringify(bad));
  }
});

test('Dienst: lädt, speichert, übersteht defekten Speicher', () => {
  const written = [];
  const service = s.createMediathekSettings({ read: () => ({ quality: '540' }), write: value => written.push(value) });
  assert.equal(service.get().quality, '540');
  assert.equal(service.update({ subtitles: 'de' }).subtitles, 'de');
  assert.equal(written.length, 1);
  assert.equal(written[0].quality, '540');
  const broken = s.createMediathekSettings({
    read: () => {
      throw new Error('kaputt');
    },
    write: () => {},
    logger: { warn() {} },
  });
  assert.equal(broken.get().quality, 'auto');
});

function setup() {
  const handlers = new Map();
  const sent = [];
  const stored = { history: [], settings: {} };
  registerMediathekIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    service: createMediathekService({ http: { getText: async () => '{}' } }),
    favorites: createMediathekFavorites({ read: () => [], write: () => {} }),
    watchProgress: createWatchProgress({ load: () => stored.history, save: history => (stored.history = JSON.parse(JSON.stringify(history))) }),
    settings: s.createMediathekSettings({ read: () => stored.settings, write: value => (stored.settings = JSON.parse(JSON.stringify(value))) }),
    requireMainRenderer: event => {
      if (event.sender !== 'main') throw new Error('Nur das Hauptfenster darf Mediathek-Kanäle nutzen');
    },
    sendToMain: (channel, payload) => sent.push([channel, payload]),
    logger: { warn() {} },
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender: 'main' }, ...args);
  return { handlers, call, sent, stored };
}

test('IPC Einstellungen: lesen, ändern mit Validierung, Absender, Änderungs-Ereignis', async () => {
  const { handlers, call, sent, stored } = setup();
  assert.deepEqual((await call('mediathek:get-settings')).settings.sources, { ard: true, zdf: true, arte: true });
  const changed = await call('mediathek:set-settings', { sources: { zdf: false }, quality: '720' });
  assert.equal(changed.ok, true);
  assert.equal(stored.settings.sources.zdf, false);
  assert.deepEqual(sent, [['mediathek:settings-changed', changed.settings]]);
  assert.throws(() => call('mediathek:set-settings', { quality: 'riesig' }));
  assert.throws(() => call('mediathek:set-settings', { sources: { bbc: true } }));
  assert.throws(() => call('mediathek:set-settings'));
  assert.throws(() => call('mediathek:get-settings', {}), /Unerwartete Eingabe/);
  assert.throws(() => handlers.get('mediathek:get-settings')({ sender: 'fremd' }), /Hauptfenster/);
  assert.throws(() => handlers.get('mediathek:set-settings')({ sender: 'fremd' }, {}), /Hauptfenster/);
});

test('IPC Weiterschauen: begonnene Beiträge, je Serie nur einer, beendete entfallen', async () => {
  const { call, stored } = setup();
  const seriesA = { id: 'a', title: 'Serie A', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/g/a' };
  const item = (title, extra) => ({ title, serviceKey: 'mediathek:ard', serviceName: 'ARD', timestamp: '2026-10-20T10:00:00.000Z', imageUrl: 'https://x/i.jpg', url: 'https://x/v.m3u8', ...extra });
  stored.history = [
    item('A2', { series: seriesA, positionSeconds: 600, durationSeconds: 1200 }),
    item('A1', { series: seriesA, positionSeconds: 300, durationSeconds: 1200 }),
    item('Fertig', { positionSeconds: 1190, durationSeconds: 1200 }),
    item('Ohne Position', {}),
    item('Film', { positionSeconds: 100, durationSeconds: 5000 }),
    { title: 'Live', serviceKey: 'netflix', timestamp: '2026-10-20T09:00:00.000Z' },
  ];
  const result = await call('mediathek:resume-list');
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map(i => i.title), ['A2', 'Film']);
  assert.equal(result.items[0].fraction, 0.5);
  assert.equal(result.items[0].sourceId, 'ard');
  assert.equal(result.items[0].series.id, 'a');
  assert.equal(result.items[1].series, null);
  assert.throws(() => call('mediathek:resume-list', {}), /Unerwartete Eingabe/);
});
