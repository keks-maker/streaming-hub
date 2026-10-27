'use strict';

// Tests: Main-Seite des YouTube-Mini-Players — Einstellungen, Playlist (validiert, persistent), Rollen der Webviews,
// Seitenzustand für den Preload (nur Streaming-Partition, Hauptfenster, YouTube-Seite, Schalter), Titelsuche.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerYoutubeMini } = require('../lib/youtube-mini-ipc.js');
const { createUserStorage } = require('../lib/user-storage.js');

const ID = 'dQw4w9WgXcQ';

function setup({ net = null, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmini-'));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const storage = createUserStorage({ userDataPath: dir, bundlePath: path.join(dir, 'bundle') });
  const handlers = new Map();
  const listeners = new Map();
  const streaming = { name: 'streaming' };
  const mainContents = { id: 1 };
  const guests = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), on: (c, f) => listeners.set(c, f) };
  const api = registerYoutubeMini({
    ipcMain,
    session: { fromPartition: name => (name === 'persist:streaming' ? streaming : { name }) },
    webContents: { fromId: id => guests.get(id) || null },
    storage,
    requireMainRenderer: event => {
      if (event.sender !== mainContents) throw new Error('nicht autorisiert');
    },
    getMainContents: () => mainContents,
    net,
  });
  const main = { sender: mainContents };
  const call = (channel, ...args) => handlers.get(channel)(main, ...args);
  const guest = (id, { session = streaming, host = mainContents, url = 'https://www.youtube.com/' } = {}) => {
    const g = { id, session, hostWebContents: host, getType: () => 'webview', getURL: () => url, isDestroyed: () => false };
    guests.set(id, g);
    return g;
  };
  const pageState = (sender, frame = {}) => {
    const event = { sender, senderFrame: { url: sender.getURL(), parent: null, ...frame }, returnValue: null };
    listeners.get('youtube-mini:page-state')(event);
    return event.returnValue;
  };
  return { dir, api, call, handlers, guest, pageState, mainContents, streaming };
}

test('Einstellungen: Standard an/ersetzen, Patch validiert und persistent, nur Haupt-Renderer', async () => {
  const t = setup();
  assert.deepEqual(await t.call('youtube-mini:get-settings'), { enabled: true, clickBehavior: 'replace' });
  assert.deepEqual(await t.call('youtube-mini:set-settings', { enabled: false }), { enabled: false, clickBehavior: 'replace' });
  assert.deepEqual(await t.call('youtube-mini:set-settings', { clickBehavior: 'playlist' }), { enabled: false, clickBehavior: 'playlist' });
  await assert.rejects(async () => t.call('youtube-mini:set-settings', { enabled: 'ja' }), /Ungültige Mini-Player-Einstellungen/);
  await assert.rejects(async () => t.handlers.get('youtube-mini:get-settings')({ sender: {} }), /nicht autorisiert/);
  const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'youtube-mini-settings.json'), 'utf8'));
  assert.deepEqual(saved, { enabled: false, clickBehavior: 'playlist' });
  const again = setup({ files: { 'youtube-mini-settings.json': saved } });
  assert.deepEqual(await again.call('youtube-mini:get-settings'), saved);
  const broken = setup();
  fs.writeFileSync(path.join(broken.dir, 'youtube-mini-settings.json'), '{kaputt');
  assert.equal(setup({ files: {} }).api.getSettings().enabled, true);
});

test('Playlist: wird validiert gespeichert und nach Neustart wieder gelesen; kaputte Datei → leer', async () => {
  const t = setup();
  assert.deepEqual(await t.call('youtube-mini:get-playlist'), []);
  const stored = await t.call('youtube-mini:set-playlist', [{ id: ID, title: 'Titel\n' }, { id: ID, title: 'doppelt' }]);
  assert.deepEqual(stored, [{ id: ID, title: 'Titel' }]);
  await assert.rejects(async () => t.call('youtube-mini:set-playlist', [{ id: 'kaputt' }]), /Ungültige Playlist/);
  await assert.rejects(async () => t.call('youtube-mini:set-playlist', 'x'), /Ungültige Playlist/);
  const file = JSON.parse(fs.readFileSync(path.join(t.dir, 'youtube-playlist.json'), 'utf8'));
  assert.deepEqual(file, { version: 1, items: [{ id: ID, title: 'Titel' }] });
  const restart = setup({ files: { 'youtube-playlist.json': file } });
  assert.deepEqual(await restart.call('youtube-mini:get-playlist'), [{ id: ID, title: 'Titel' }]);
  const broken = setup({ files: { 'youtube-playlist.json': { items: [{ id: 'x' }, { id: ID, title: 5 }, null] } } });
  assert.deepEqual(await broken.call('youtube-mini:get-playlist'), [{ id: ID, title: '' }]);
});

test('Player-Webview anmelden: nur Webviews der Streaming-Partition; Rolle player gilt nur für diese', async () => {
  const t = setup();
  const player = t.guest(11);
  const browse = t.guest(12);
  const tv = t.guest(13, { session: { name: 'tv' } });
  await assert.rejects(async () => t.call('youtube-mini:register-player', 99), /Keine Streaming-Webview/);
  await assert.rejects(async () => t.call('youtube-mini:register-player', tv.id), /Keine Streaming-Webview/);
  await assert.rejects(async () => t.call('youtube-mini:register-player', 'x'), /Webview-Kennung/);
  assert.equal(await t.call('youtube-mini:register-player', player.id), true);
  const p = t.pageState(player);
  assert.equal(p.active, true);
  assert.equal(p.role, 'player');
  assert.match(p.script, /"role":"player"/);
  assert.match(p.script, /html\.sh-mini/); // Stufen-CSS steckt im Skript
  const b = t.pageState(browse);
  assert.equal(b.role, 'browse');
  assert.doesNotMatch(b.script, /html\.sh-mini/);
  assert.match(b.script, /"clickBehavior":"replace"/);
});

test('Seitenzustand: inaktiv bei ausgeschaltetem Schalter, fremder Partition, Bild-in-Bild, Nicht-YouTube-Seite und Unterframes', async () => {
  const t = setup();
  const ok = t.guest(21);
  assert.equal(t.pageState(ok).active, true);
  assert.equal(t.pageState(t.guest(22, { session: { name: 'tv' } })).active, false);
  assert.equal(t.pageState(t.guest(23, { host: { id: 2 } })).active, false); // Bild-in-Bild-Fenster
  assert.equal(t.pageState(t.guest(24, { url: 'https://www.netflix.com/browse' })).active, false);
  assert.equal(t.pageState(t.guest(25, { url: 'https://evil.example/?u=https://www.youtube.com/' })).active, false);
  assert.equal(t.pageState(ok, { parent: {} }).active, false);
  const off = t.pageState(ok);
  assert.ok(off.script.length > 100);
  await t.call('youtube-mini:set-settings', { enabled: false });
  assert.deepEqual(t.pageState(ok), { active: false, role: 'browse', script: '' });
  await t.call('youtube-mini:set-settings', { enabled: true, clickBehavior: 'playlist' });
  assert.match(t.pageState(ok).script, /"clickBehavior":"playlist"/);
});

test('Titel nachschlagen: nur Video-ID geht an YouTube (oEmbed), Ergebnis bereinigt und zwischengespeichert; Fehler → leer', async () => {
  const requests = [];
  const net = {
    fetch: async url => {
      requests.push(url);
      return { ok: true, json: async () => ({ title: ' Ein\nTitel ' }) };
    },
  };
  const t = setup({ net });
  assert.equal(await t.call('youtube-mini:resolve-title', { id: ID }), 'Ein Titel');
  assert.equal(await t.call('youtube-mini:resolve-title', { id: ID }), 'Ein Titel');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ$/);
  await assert.rejects(async () => t.call('youtube-mini:resolve-title', { id: 'x' }), /Ungültiges Video/);
  const failing = setup({ net: { fetch: async () => { throw new Error('offline'); } } });
  assert.equal(await failing.call('youtube-mini:resolve-title', { id: ID }), '');
  const notFound = setup({ net: { fetch: async () => ({ ok: false }) } });
  assert.equal(await notFound.call('youtube-mini:resolve-title', { id: ID }), '');
  assert.equal(await setup().call('youtube-mini:resolve-title', { id: ID }), '');
});
