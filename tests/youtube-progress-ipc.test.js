'use strict';

// Tests: Main-Seite des Fortschritts (lib/youtube-progress-ipc.js) — Seitenzustand nur für Streaming-Webviews des Hauptfensters,
// validierte Meldungen, Schreiben nur bei Änderung, Datei im iPad-Format, Startposition.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerYoutubeProgress } = require('../lib/youtube-progress-ipc.js');
const { createUserStorage } = require('../lib/user-storage.js');
const { validateYoutubeProgressReport } = require('../lib/ipc-validation.js');

const ID = 'dQw4w9WgXcQ';
const OTHER = 'bbbbbbbbbbb';

function setup({ file = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytprog-'));
  const target = path.join(dir, 'youtube-progress.json');
  if (file !== null) fs.writeFileSync(target, typeof file === 'string' ? file : JSON.stringify(file));
  const storage = createUserStorage({ userDataPath: dir, bundlePath: path.join(dir, 'bundle') });
  let writes = 0;
  const realWrite = storage.writeJson;
  storage.writeJson = (...args) => { writes++; return realWrite(...args); };
  const listeners = new Map();
  const handlers = new Map();
  const streaming = { name: 'streaming' };
  const mainContents = { id: 1 };
  let clock = 1000;
  registerYoutubeProgress({
    ipcMain: { on: (c, f) => listeners.set(c, f), handle: (c, f) => handlers.set(c, f) },
    session: { fromPartition: name => (name === 'persist:streaming' ? streaming : { name }) },
    storage,
    getMainContents: () => mainContents,
    now: () => clock++,
  });
  const guest = ({ session = streaming, host = mainContents, url = `https://www.youtube.com/watch?v=${ID}` } = {}) => ({ session, hostWebContents: host, getURL: () => url, isDestroyed: () => false });
  const ev = (sender, frame = {}) => ({ sender, senderFrame: { url: sender.getURL(), parent: null, ...frame }, returnValue: null });
  const report = (sender, msg, frame) => listeners.get('youtube-progress:report')(ev(sender, frame), msg);
  const position = (sender, id) => handlers.get('youtube-progress:get-position')(ev(sender), id);
  const state = (sender, frame) => { const e = ev(sender, frame); listeners.get('youtube-progress:page-state')(e); return e.returnValue; };
  const read = () => JSON.parse(fs.readFileSync(target, 'utf8'));
  return { target, guest, report, position, state, read, writes: () => writes };
}

test('Seitenzustand: aktiv nur in Streaming-Webviews des Hauptfensters auf YouTube-Seiten im Hauptframe', () => {
  const t = setup();
  const s = t.state(t.guest());
  assert.equal(s.active, true);
  assert.match(s.script, /__shProgress/);
  assert.equal(t.state(t.guest({ session: { name: 'tv' } })).active, false);
  assert.equal(t.state(t.guest({ host: { id: 2 } })).active, false);
  assert.equal(t.state(t.guest({ url: 'https://example.org/' })).active, false);
  assert.equal(t.state(t.guest(), { parent: {} }).active, false); // Unterframe
});

test('Meldung wird im iPad-Format gespeichert: reines Array, Sekunden, updated in Sekunden seit 1970', () => {
  const t = setup();
  t.report(t.guest(), { id: ID, t: 42.5, d: 300 });
  const list = t.read();
  assert.ok(Array.isArray(list));
  assert.deepEqual(Object.keys(list[0]).sort(), ['duration', 'id', 'position', 'updated']);
  assert.equal(list[0].id, ID);
  assert.equal(list[0].position, 42.5);
  assert.equal(list[0].duration, 300);
  assert.ok(list[0].updated < 1e11);
  assert.equal(t.position(t.guest(), ID), 42.5);
});

test('Ungültige Meldungen und fremde Absender werden ignoriert; nichts wird geschrieben', () => {
  const t = setup();
  for (const bad of [null, 'x', [], { id: 'kurz', t: 10, d: 100 }, { id: ID, t: NaN, d: 100 }, { id: ID, t: Infinity, d: 100 }, { id: ID, t: -1, d: 100 }, { id: ID, t: '10', d: 100 }, { id: ID, t: 10 }, { id: ID, t: 1e9, d: 100 }]) {
    t.report(t.guest(), bad);
  }
  t.report(t.guest({ host: { id: 2 } }), { id: ID, t: 50, d: 100 });
  t.report(t.guest({ session: { name: 'tv' } }), { id: ID, t: 50, d: 100 });
  t.report(t.guest({ url: 'https://example.org/' }), { id: ID, t: 50, d: 100 });
  assert.equal(t.writes(), 0);
  assert.equal(fs.existsSync(t.target), false);
  assert.throws(() => validateYoutubeProgressReport({ id: ID, t: 5 }));
});

test('Geschrieben wird nur bei Änderung: Anfang unter 3 s und Ende ohne Eintrag ändern nichts', () => {
  const t = setup();
  t.report(t.guest(), { id: ID, t: 1, d: 300 });
  assert.equal(t.writes(), 0);
  t.report(t.guest(), { id: ID, t: 100, d: 300 });
  assert.equal(t.writes(), 1);
  t.report(t.guest(), { id: ID, t: 1, d: 300 });
  assert.equal(t.writes(), 1);
  assert.equal(t.read()[0].position, 100);
  t.report(t.guest(), { id: ID, t: 295, d: 300 });
  assert.equal(t.writes(), 2);
  assert.deepEqual(t.read(), []);
  t.report(t.guest(), { id: ID, t: 299, d: 300 });
  assert.equal(t.writes(), 2);
  assert.equal(t.position(t.guest(), ID), 0);
});

test('Laden: bestehende Datei (iPad-Format) setzt fort; unlesbar → leer; ungültige IDs verworfen; fremder Sender bekommt 0', () => {
  const t = setup({ file: [{ id: ID, position: 77, duration: 600, updated: 5 }, { id: 'kurz', position: 9, duration: 90, updated: 6 }] });
  assert.equal(t.position(t.guest(), ID), 77);
  assert.equal(t.position(t.guest(), OTHER), 0);
  assert.equal(t.position(t.guest(), 'kurz'), 0);
  assert.equal(t.position(t.guest({ host: { id: 2 } }), ID), 0);
  const broken = setup({ file: '{kaputt' });
  assert.equal(broken.position(broken.guest(), ID), 0);
  broken.report(broken.guest(), { id: ID, t: 20, d: 100 });
  assert.equal(broken.read().length, 1);
});
