'use strict';

// Tests: Verwaltungs-IPC der Podcasts (P4) — Reihenfolge, Anpassung (Name/Cover nur nach Abruf über den Cover-Lader),
// Abbestellen, Einstellungen und Lautstärke-Speicherung, Absenderprüfung. Echte PodcastLibrary im Temp-Verzeichnis.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerPodcastIpc } = require('../lib/podcast/ipc.js');
const { PodcastLibrary } = require('../lib/podcast/PodcastLibrary.js');
const { createPodcastSettingsService } = require('../lib/podcast/podcast-settings-service.js');
const { createCoverAllowlist } = require('../lib/podcast/cover-allowlist.js');
const { createUserStorage } = require('../lib/user-storage.js');
const { EventEmitter } = require('node:events');

function setup({ coverOk = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-podcast-manage-'));
  fs.mkdirSync(path.join(root, 'b'), { recursive: true });
  const library = new PodcastLibrary({ userStorage: createUserStorage({ userDataPath: path.join(root, 'u'), bundlePath: path.join(root, 'b') }) });
  const handlers = new Map();
  const events = [];
  const mainSender = { id: 'main' };
  const coverCalls = [];
  const coverLoader = { load: async url => (coverCalls.push(url), coverOk ? { ok: true, dataUrl: 'data:image/png;base64,AA==' } : { ok: false }) };
  const controller = Object.assign(new EventEmitter(), {
    volumes: [],
    getState: () => ({ episode: null }),
    setVolume(value) {
      this.volumes.push(value);
      return { volume: value };
    },
    settingsChanged() {},
    playerWebContents: () => null,
  });
  const timers = [];
  const settings = createPodcastSettingsService({ library, controller, setTimer: fn => (timers.push(fn), { unref() {} }), clearTimer() {} });
  registerPodcastIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on() {} },
    library,
    refresher: { refreshOne: async id => ({ id, status: 'updated' }), refreshAll: async () => ({ results: [] }) },
    search: {},
    controller,
    settings,
    coverLoader,
    requireMainRenderer: event => {
      if (event.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: (channel, payload) => events.push({ channel, payload }),
  });
  const call = async (channel, ...args) => handlers.get(channel)({ sender: mainSender }, ...args);
  const sub = async (url, title) => (await call('podcast:subscribe', { feedUrl: url, source: 'eigene-podcasts', title })).subscription;
  return { library, handlers, call, events, coverCalls, controller, settings, timers, sub, mainSender };
}

// Abo ohne Netz: der Refresher-Fake liefert nur ein Ergebnis, die Bibliothek speichert das Abo selbst
test('Reihenfolge: podcast:reorder speichert, meldet die Liste, ignoriert Unbekanntes und hängt Fehlendes hinten an', async () => {
  const t = setup();
  const [a, b, c] = [await t.sub('https://a.test/1', 'A'), await t.sub('https://a.test/2', 'B'), await t.sub('https://a.test/3', 'C')];
  const list = await t.call('podcast:reorder', { order: [c.id, 'unbekannt', a.id] });
  assert.deepEqual(list.map(s => s.id), [c.id, a.id, b.id]);
  assert.deepEqual(t.library.getSubscriptions().map(s => s.id), [c.id, a.id, b.id]);
  assert.equal(t.events.at(-1).channel, 'podcast:subscriptions-changed');
  assert.deepEqual(t.events.at(-1).payload.map(s => s.id), [c.id, a.id, b.id]);
  await assert.rejects(t.call('podcast:reorder', { order: 'x' }), /Reihenfolge/);
});

test('Anpassung: Name wird gesetzt und zurückgesetzt; Original bleibt sichtbar; unbekanntes Abo wird abgelehnt', async () => {
  const t = setup();
  const a = await t.sub('https://a.test/1', 'Original');
  const named = await t.call('podcast:set-override', { id: a.id, title: 'Mein Name' });
  assert.equal(named.title, 'Mein Name');
  assert.equal(named.original.title, 'Original');
  assert.deepEqual(named.overrides, { title: 'Mein Name' });
  const reset = await t.call('podcast:set-override', { id: a.id, title: null });
  assert.equal(reset.title, 'Original');
  assert.equal(reset.overrides, undefined);
  await assert.rejects(t.call('podcast:set-override', { id: 'nope', title: 'X' }), /nicht gefunden/);
  assert.equal(t.coverCalls.length, 0, 'ohne Cover kein Netzabruf');
});

test('Anpassung Cover: nur nach erfolgreichem Abruf über den Cover-Lader; sonst nichts gespeichert und nichts freigeschaltet', async () => {
  const bad = setup({ coverOk: false });
  const a = await bad.sub('https://a.test/1', 'A');
  await assert.rejects(bad.call('podcast:set-override', { id: a.id, cover: 'http://192.168.0.1/intern.png' }), /Cover konnte nicht geladen werden/);
  assert.deepEqual(bad.coverCalls, ['http://192.168.0.1/intern.png'], 'Prüfung läuft über den Lader (Ziel-IP-Filter)');
  assert.equal(bad.library.getSubscription(a.id).overrides, undefined);
  const allowlist = createCoverAllowlist({ library: bad.library });
  assert.equal(allowlist.has('http://192.168.0.1/intern.png'), false, 'abgelehnte Adresse bleibt unbekannt');
  // ungültige Schemata erreichen den Lader gar nicht
  for (const cover of ['file:///etc/passwd', 'javascript:1', 'https://u:p@a.test/c.png']) {
    await assert.rejects(bad.call('podcast:set-override', { id: a.id, cover }));
  }
  assert.equal(bad.coverCalls.length, 1);

  const good = setup({ coverOk: true });
  const b = await good.sub('https://a.test/1', 'A');
  const result = await good.call('podcast:set-override', { id: b.id, cover: 'https://img.test/c.png' });
  assert.equal(result.cover, 'https://img.test/c.png');
  assert.equal(result.original.cover, null);
  assert.equal(createCoverAllowlist({ library: good.library }).has('https://img.test/c.png'), true, 'gespeichertes Override-Cover ist ladbar');
  await good.call('podcast:set-override', { id: b.id, cover: '' });
  assert.equal(createCoverAllowlist({ library: good.library }).has('https://img.test/c.png'), false, 'nach Zurücksetzen nicht mehr freigegeben');
});

test('Abbestellen räumt Anpassung und Reihenfolge auf', async () => {
  const t = setup();
  const a = await t.sub('https://a.test/1', 'A');
  const b = await t.sub('https://a.test/2', 'B');
  await t.call('podcast:set-override', { id: a.id, title: 'Neu' });
  assert.deepEqual(await t.call('podcast:unsubscribe', a.id), { ok: true, removed: true });
  assert.deepEqual(t.library.getSubscriptions().map(s => s.id), [b.id]);
  assert.deepEqual(t.library.exportBackup().podcasts.overrides, {});
  assert.deepEqual(t.library.exportBackup().podcasts.subscriptionRank, [b.id]);
});

test('Einstellungen: lesen, validiert ändern (nur erlaubte Werte), Lautstärke der Podcasts wird separat gespeichert', async () => {
  const t = setup();
  assert.equal((await t.call('podcast:get-settings')).skipBack, 15);
  const next = await t.call('podcast:set-settings', { skipBack: 10, autoPlayNext: true });
  assert.deepEqual([next.skipBack, next.autoPlayNext], [10, true]);
  assert.equal(t.library.getSettings().skipBack, 10);
  await assert.rejects(t.call('podcast:set-settings', { skipBack: 11 }), /Sprungweite/);
  await assert.rejects(t.call('podcast:set-settings', { volume: 3 }));
  await assert.rejects(t.call('podcast:set-settings', {}), /leer/);
  await assert.rejects(t.call('podcast:get-settings', 'x'), /Unerwartete Eingabe/);
  await t.call('podcast:volume', 0.25);
  assert.deepEqual(t.controller.volumes, [0.25]);
  assert.equal(t.library.getSettings().volume, 0.8, 'Speichern verzögert');
  t.timers.forEach(fn => fn());
  assert.equal(t.library.getSettings().volume, 0.25);
  await assert.rejects(t.call('podcast:volume', 2), /Lautstärke/);
});

test('Absenderprüfung: fremde Absender erreichen die neuen Kanäle nicht', () => {
  const t = setup();
  for (const channel of ['podcast:reorder', 'podcast:set-override', 'podcast:get-settings', 'podcast:set-settings']) {
    assert.ok(t.handlers.has(channel), channel);
    assert.throws(() => t.handlers.get(channel)({ sender: { id: 'webview' } }), /nicht autorisiert/, channel);
  }
});
