'use strict';

// Tests: Radio R3 (Backend) — Sender-Anpassungen (stationOverrides), Validierung, IPC (set-override, clear-override,
// set-settings) und „Beim Start fortsetzen“ im Controller. Echte RadioLibrary mit In-Memory-Speicher, kein Fenster, kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { RadioLibrary } = require('../lib/radio/RadioLibrary.js');
const { RadioController } = require('../lib/radio/RadioController.js');
const { registerRadioIpc } = require('../lib/radio/ipc.js');
const logic = require('../lib/radio/radio-sources-logic.js');
const { radioStationOverride } = require('../lib/input-validation.js');
const { validateRadioSettingsPatch } = require('../lib/ipc-validation.js');
const { createFakeWindowClass } = require('./helpers/radio-fakes.js');

const MAIN = { id: 'main' };

function sources() {
  return [
    {
      id: 'bundle',
      name: 'Gelieferte Liste',
      type: 'bundled',
      stations: [
        { id: 'a', name: 'Alpha', streamUrl: 'http://a.test/s', logo: 'https://a.test/a.png', genre: 'Pop' },
        { id: 'b', name: 'Beta', streamUrl: 'http://b.test/s', genre: 'Rock' },
      ],
    },
  ];
}

function memoryStorage(initial = {}) {
  const data = { radioSources: sources(), ...initial };
  return { data, readJson: (key, fallback) => (key in data ? JSON.parse(JSON.stringify(data[key])) : fallback), writeJson: (key, value) => (data[key] = JSON.parse(JSON.stringify(value))) };
}

test('Logik: Override setzen, Felder einzeln zurücksetzen, leer entfernt den Eintrag', () => {
  let list = logic.setStationOverride(sources(), 'bundle', 'a', { name: 'Eins', streamUrl: 'http://neu.test/s' });
  const station = logic.findStation(list, { sourceId: 'bundle', stationId: 'a' });
  assert.equal(station.name, 'Eins');
  assert.equal(station.streamUrl, 'http://neu.test/s');
  assert.equal(station.logo, 'https://a.test/a.png');
  list = logic.setStationOverride(list, 'bundle', 'a', { name: null });
  assert.equal(logic.findStation(list, { sourceId: 'bundle', stationId: 'a' }).name, 'Alpha');
  list = logic.setStationOverride(list, 'bundle', 'a', { streamUrl: null });
  assert.deepEqual(list[0].stationOverrides, {});
});

test('Logik: Eingabe bleibt unverändert; unbekannter und eigener Sender werden abgelehnt', () => {
  const input = sources();
  const before = JSON.stringify(input);
  logic.setStationOverride(input, 'bundle', 'a', { name: 'X' });
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => logic.setStationOverride(input, 'bundle', 'zzz', { name: 'X' }), /nicht gefunden/);
  assert.throws(() => logic.setStationOverride(input, 'nope', 'a', { name: 'X' }), /nicht gefunden/);
  const withCustom = logic.addCustomStation(logic.ensureCustomSource(input), { name: 'Eigen', streamUrl: 'http://e.test/s' }).sources;
  assert.throws(() => logic.setStationOverride(withCustom, logic.CUSTOM_SOURCE_ID, withCustom[1].stations[0].id, { name: 'X' }), /Eigene Sender/);
});

test('Logik: clearStationOverride entfernt alle Anpassungen, ohne Anpassung bleibt die Liste identisch', () => {
  const base = sources();
  assert.equal(logic.clearStationOverride(base, 'bundle', 'a'), base);
  const changed = logic.setStationOverride(base, 'bundle', 'a', { name: 'X', logo: 'https://x.test/l.png' });
  const cleared = logic.clearStationOverride(changed, 'bundle', 'a');
  assert.equal(logic.findStation(cleared, { sourceId: 'bundle', stationId: 'a' }).name, 'Alpha');
  assert.throws(() => logic.clearStationOverride(base, 'bundle', 'zzz'), /nicht gefunden/);
});

test('Validierung radioStationOverride: bekannte Felder, URLs geprüft, leer = zurücksetzen', () => {
  assert.deepEqual(radioStationOverride({ name: ' Neu ', logo: '', streamUrl: 'http://lan.test:8000/s' }), { name: 'Neu', logo: null, streamUrl: 'http://lan.test:8000/s' });
  assert.deepEqual(radioStationOverride({ name: null }), { name: null });
  assert.throws(() => radioStationOverride({}), /leer/);
  assert.throws(() => radioStationOverride({ genre: 'x' }), /Unbekanntes Feld/);
  assert.throws(() => radioStationOverride({ streamUrl: 'ftp://x' }), /http/);
  assert.throws(() => radioStationOverride({ logo: 'http://u:p@x.test/l.png' }), /Zugangsdaten/);
  assert.throws(() => radioStationOverride([]), /ungültig/);
});

test('Validierung set-settings: nur die drei Schalter, nur Booleans', () => {
  assert.deepEqual(validateRadioSettingsPatch({ resumeOnStart: true, pauseOnTv: false }), { resumeOnStart: true, pauseOnTv: false });
  assert.throws(() => validateRadioSettingsPatch({}), /leer/);
  assert.throws(() => validateRadioSettingsPatch({ volume: 0.5 }), /Unbekanntes Feld/);
  assert.throws(() => validateRadioSettingsPatch({ lastStation: null }), /Unbekanntes Feld/);
  assert.throws(() => validateRadioSettingsPatch({ pauseOnTv: 'ja' }), /Boolean/);
  assert.throws(() => validateRadioSettingsPatch(null), /ungültig/);
});

test('Validierung set-settings: trayDisplay nur aus der Auswahl (off, station, station-title)', () => {
  for (const value of ['off', 'station', 'station-title']) assert.deepEqual(validateRadioSettingsPatch({ trayDisplay: value }), { trayDisplay: value });
  assert.deepEqual(validateRadioSettingsPatch({ trayDisplay: 'off', pauseOnTv: true }), { trayDisplay: 'off', pauseOnTv: true });
  for (const bad of ['', 'title', 'OFF', true, null, 1, undefined]) assert.throws(() => validateRadioSettingsPatch({ trayDisplay: bad }), /trayDisplay/);
});

test('Einstellungen: trayDisplay Standard station-title, ungültige Dateiwerte fallen zurück, Patch wird geprüft', () => {
  const { normalizeRadioSettings, applyRadioSettingsPatch, DEFAULT_RADIO_SETTINGS } = require('../lib/radio/radio-settings.js');
  assert.equal(DEFAULT_RADIO_SETTINGS.trayDisplay, 'station-title');
  assert.equal(normalizeRadioSettings({}).trayDisplay, 'station-title');
  assert.equal(normalizeRadioSettings({ trayDisplay: 'station' }).trayDisplay, 'station');
  assert.equal(normalizeRadioSettings({ trayDisplay: 'kaputt' }).trayDisplay, 'station-title');
  assert.equal(applyRadioSettingsPatch(normalizeRadioSettings({}), { trayDisplay: 'off' }).trayDisplay, 'off');
  assert.throws(() => applyRadioSettingsPatch(normalizeRadioSettings({}), { trayDisplay: 'x' }), /ungültig/);
});

function ipcSetup(storage = memoryStorage(), onSettingsChanged = null) {
  const handlers = new Map();
  const sent = [];
  const library = new RadioLibrary({ userStorage: storage });
  const { FakeWindow } = createFakeWindowClass();
  const controller = new RadioController({ BrowserWindow: FakeWindow, library, resolveStream: async url => ({ streamUrl: url, kind: 'direct', via: [] }), readIcyTitle: async () => ({ metaint: 0 }), setTimer: () => 1, clearTimer: () => {} });
  registerRadioIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} },
    controller,
    library,
    requireMainRenderer: event => {
      if (!event || event.sender !== MAIN) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: (channel, payload) => sent.push({ channel, payload }),
    onSettingsChanged,
  });
  const call = (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: MAIN }, ...args));
  return { call, sent, storage, library, controller };
}

test('IPC: set-override speichert, sendet sources-changed; clear-override setzt zurück', async () => {
  const { call, sent, library } = ipcSetup();
  const key = { sourceId: 'bundle', stationId: 'a' };
  const result = await call('radio:set-override', key, { name: 'Eins', logo: '' });
  assert.equal(result[0].stationOverrides.a.name, 'Eins');
  assert.equal(library.getStation(key).name, 'Eins');
  assert.equal(sent.at(-1).channel, 'radio:sources-changed');
  await call('radio:clear-override', key);
  assert.equal(library.getStation(key).name, 'Alpha');
});

test('IPC: ungültige Anpassungen erreichen den Speicher nie', async () => {
  const storage = memoryStorage();
  const { call } = ipcSetup(storage);
  const key = { sourceId: 'bundle', stationId: 'a' };
  await assert.rejects(call('radio:set-override', key, { streamUrl: 'javascript:alert(1)' }), /http/);
  await assert.rejects(call('radio:set-override', { sourceId: 'bundle' }, { name: 'x' }), /ungültig/);
  await assert.rejects(call('radio:set-override', key, { name: 'x', extra: 1 }), /Unbekanntes Feld/);
  await assert.rejects(call('radio:set-override', { sourceId: 'bundle', stationId: 'zzz' }, { name: 'x' }), /nicht gefunden/);
  await assert.rejects(call('radio:clear-override', 'a'), /ungültig/);
  assert.deepEqual(storage.data.radioSources, sources());
});

test('IPC: set-settings trayDisplay speichert, meldet die Änderung (Tray) und übersteht einen Fehler der Folgeaktion', async () => {
  const seen = [];
  const { call, library } = ipcSetup(memoryStorage(), settings => seen.push(settings.trayDisplay));
  assert.equal((await call('radio:set-settings', { trayDisplay: 'off' })).trayDisplay, 'off');
  assert.equal(library.getSettings().trayDisplay, 'off');
  assert.deepEqual(seen, ['off']);
  await assert.rejects(call('radio:set-settings', { trayDisplay: 'bogus' }), /trayDisplay/);
  assert.deepEqual(seen, ['off'], 'ungültig: keine Folgeaktion');
  const broken = ipcSetup(memoryStorage(), () => { throw new Error('boom'); });
  assert.equal((await broken.call('radio:set-settings', { trayDisplay: 'station' })).trayDisplay, 'station');
});

test('IPC: set-settings speichert Schalter und liefert die normalisierten Einstellungen', async () => {
  const { call, library } = ipcSetup();
  const next = await call('radio:set-settings', { resumeOnStart: true, keepPlayingWhenClosed: false });
  assert.equal(next.resumeOnStart, true);
  assert.equal(next.keepPlayingWhenClosed, false);
  assert.equal(next.pauseOnTv, true);
  assert.deepEqual(library.getSettings(), next);
  await assert.rejects(call('radio:set-settings', { volume: 1 }), /Unbekanntes Feld/);
  await assert.rejects(call('radio:set-settings'), /ungültig/);
});

function controllerFor(settings, stations = [{ sourceId: 'bundle', id: 'a', name: 'Alpha', streamUrl: 'http://a.test/s' }]) {
  const { FakeWindow, instances } = createFakeWindowClass();
  const library = {
    getSettings: () => settings,
    getStation: key => stations.find(s => s.sourceId === key.sourceId && s.id === key.stationId) || null,
    getFavoriteKeys: () => [],
    updateSettings: () => settings,
  };
  const controller = new RadioController({ BrowserWindow: FakeWindow, library, resolveStream: async url => ({ streamUrl: url, kind: 'direct', via: [] }), readIcyTitle: async () => ({ metaint: 0 }), setTimer: () => 1, clearTimer: () => {} });
  return { controller, instances };
}

test('Start fortsetzen: nur bei aktivierter Option und vorhandenem letzten Sender', () => {
  const last = { sourceId: 'bundle', id: 'a' };
  const off = controllerFor({ volume: 0.5, lastStation: last, resumeOnStart: false });
  assert.equal(off.controller.resumeOnStart(), false);
  assert.equal(off.controller.getState().status, 'idle');
  assert.equal(off.instances.length, 0);

  const noLast = controllerFor({ volume: 0.5, lastStation: null, resumeOnStart: true });
  assert.equal(noLast.controller.resumeOnStart(), false);

  const gone = controllerFor({ volume: 0.5, lastStation: { sourceId: 'bundle', id: 'weg' }, resumeOnStart: true });
  assert.equal(gone.controller.resumeOnStart(), false);
  assert.equal(gone.controller.getState().status, 'idle');

  const on = controllerFor({ volume: 0.5, lastStation: last, resumeOnStart: true });
  assert.equal(on.controller.resumeOnStart(), true);
  assert.equal(on.controller.getState().status, 'loading');
  assert.equal(on.controller.getState().station.name, 'Alpha');
  assert.equal(on.controller.resumeOnStart(), false, 'läuft bereits: kein zweiter Start');
});
