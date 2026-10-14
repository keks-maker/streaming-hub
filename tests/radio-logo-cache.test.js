'use strict';

// Tests: Logo-Cache für Menü-Icons (lib/radio/radio-logo-cache.js) mit Netzwerk-, nativeImage- und Dateisystem-Attrappen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRadioLogoCache, fileBase } = require('../lib/radio/radio-logo-cache.js');

function png(width = 64, height = 64) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeNativeImage() {
  const make = (width, height, tag) => ({
    tag,
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }) => make(w, h, 'resized'),
    toPNG: () => Buffer.from(`png:${width}x${height}`),
    reps: [],
    addRepresentation(rep) { this.reps.push(rep); },
  });
  return {
    createFromBuffer: (buf, opts) => {
      const text = buf.toString();
      const m = /^png:(\d+)x(\d+)$/.exec(text);
      if (m) return make(Number(m[1]), Number(m[2]), 'cached');
      if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return make(buf.readUInt32BE(16), buf.readUInt32BE(20), 'source');
      return make(0, 0, 'empty');
    },
  };
}

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial)); // name -> { data, mtimeMs }
  const rel = p => p.split('/').pop();
  return {
    files,
    mkdir: async () => {},
    readFile: async p => { const f = files.get(rel(p)); if (!f) throw new Error('ENOENT'); return f.data; },
    writeFile: async (p, data) => { files.set(rel(p), { data, mtimeMs: fs.now }); },
    stat: async p => { const f = files.get(rel(p)); if (!f) throw new Error('ENOENT'); return { mtimeMs: f.mtimeMs }; },
    readdir: async () => [...files.keys()],
    unlink: async p => { files.delete(rel(p)); },
  };
}
const fs = { now: 1000 };

function makeNet(replies) {
  const net = { calls: [], get: async (url, opts) => { net.calls.push([url, opts]); const r = replies[url]; if (r instanceof Error) throw r; return r || { status: 404, contentType: 'text/html', buffer: Buffer.alloc(0) }; } };
  return net;
}
const ok = (buffer = png(), extra = {}) => ({ status: 200, contentType: 'image/png', buffer, truncated: false, finalUrl: undefined, ...extra });

test('lädt https-Logo, skaliert auf 16 px (@2x 32 px), speichert beide Dateien und meldet einmal onChange', async () => {
  fs.now = 1000;
  const mem = fakeFs();
  const net = makeNet({ 'https://a.test/l.png': ok(), 'https://b.test/l.png': ok(png(100, 50)) });
  let changes = 0;
  const cache = createRadioLogoCache({ dir: '/c', net, nativeImage: fakeNativeImage(), fs: mem, now: () => fs.now, onChange: () => { changes += 1; } });
  assert.equal(cache.peek('https://a.test/l.png'), null);
  await cache.request(['https://a.test/l.png', 'https://b.test/l.png', 'https://a.test/l.png']);
  assert.equal(changes, 1, 'eine Neubau-Meldung je Ladewelle');
  const a = cache.peek('https://a.test/l.png');
  assert.deepEqual(a.getSize(), { width: 16, height: 16 });
  assert.deepEqual(a.reps[0].scaleFactor, 2);
  assert.equal(a.reps[0].buffer.toString(), 'png:32x32');
  assert.deepEqual(cache.peek('https://b.test/l.png').getSize(), { width: 16, height: 8 }, 'Seitenverhältnis bleibt');
  const base = fileBase('https://a.test/l.png');
  assert.ok(mem.files.has(`${base}.png`) && mem.files.has(`${base}@2x.png`));
  assert.equal(net.calls.length, 2, 'doppelte URL nur einmal geladen');
  assert.equal(net.calls[0][1].maxBytes, 512 * 1024);
});

test('zweiter Start liest aus dem Cache ohne Netzwerk; zu alte Dateien (> 30 Tage) werden neu geladen', async () => {
  fs.now = 1000;
  const mem = fakeFs();
  const net = makeNet({ 'https://a.test/l.png': ok() });
  const make = () => createRadioLogoCache({ dir: '/c', net, nativeImage: fakeNativeImage(), fs: mem, now: () => fs.now });
  await make().request(['https://a.test/l.png']);
  const second = make();
  await second.request(['https://a.test/l.png']);
  assert.ok(second.peek('https://a.test/l.png'));
  assert.equal(net.calls.length, 1, 'aus Datei geladen');
  fs.now = 1000 + 31 * 24 * 3600 * 1000;
  const third = make();
  await third.request(['https://a.test/l.png']);
  assert.equal(net.calls.length, 2, 'Alterslimit: erneut geladen');
});

test('Fehler: http, kein Bild, falscher Content-Type, zu groß, 404, Netzfehler, SVG, Weiterleitung auf http — kein Icon, kein onChange', async () => {
  const urls = {
    'https://t.test/html': ok(Buffer.from('<html>'), { contentType: 'text/html' }),
    'https://t.test/junk': ok(Buffer.from('not an image at all')),
    'https://t.test/big': ok(png(), { truncated: true }),
    'https://t.test/404': { status: 404, contentType: 'image/png', buffer: png() },
    'https://t.test/net': new Error('ECONNRESET'),
    'https://t.test/svg': ok(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { contentType: 'image/svg+xml' }),
    'https://t.test/redir': ok(png(), { finalUrl: 'http://evil.test/x.png' }),
    'https://t.test/empty': ok(Buffer.alloc(0)),
  };
  const net = makeNet(urls);
  let changes = 0;
  const cache = createRadioLogoCache({ dir: '/c', net, nativeImage: fakeNativeImage(), fs: fakeFs(), onChange: () => { changes += 1; } });
  await cache.request(['http://t.test/plain', 'ftp://t.test/x', 'https://u:p@t.test/cred', ...Object.keys(urls)]);
  assert.equal(changes, 0);
  for (const url of Object.keys(urls)) assert.equal(cache.peek(url), null, url);
  assert.ok(!net.calls.some(([url]) => /^http:|^ftp:|u:p@/.test(url)), 'nur https ohne Zugangsdaten');
  await cache.request(Object.keys(urls));
  assert.equal(net.calls.length, Object.keys(urls).length, 'Gescheiterte werden in der Sitzung nicht erneut versucht');
});

test('Aufräumen: Dateien über dem Alterslimit und Überhang (> maxFiles, älteste zuerst) werden gelöscht', async () => {
  fs.now = 100 * 24 * 3600 * 1000;
  const name = i => i.toString(16).padStart(32, '0');
  const initial = {};
  initial[`${name(1)}.png`] = { data: Buffer.from('x'), mtimeMs: fs.now - 40 * 24 * 3600 * 1000 };
  initial[`${name(1)}@2x.png`] = { data: Buffer.from('x'), mtimeMs: fs.now - 40 * 24 * 3600 * 1000 };
  for (let i = 2; i <= 5; i += 1) initial[`${name(i)}.png`] = { data: Buffer.from('x'), mtimeMs: fs.now - i * 1000 };
  initial['notes.txt'] = { data: Buffer.from('fremd'), mtimeMs: 0 };
  const mem = fakeFs(initial);
  const cache = createRadioLogoCache({ dir: '/c', net: makeNet({}), nativeImage: fakeNativeImage(), fs: mem, now: () => fs.now, maxFiles: 3 });
  await cache.prune();
  assert.deepEqual([...mem.files.keys()].sort(), [`${name(2)}.png`, `${name(3)}.png`, `${name(4)}.png`, 'notes.txt'].sort());
});

test('Schreibfehler im Dateisystem: Icon steht trotzdem im Speicher', async () => {
  const mem = fakeFs();
  mem.writeFile = async () => { throw new Error('EACCES'); };
  const cache = createRadioLogoCache({ dir: '/c', net: makeNet({ 'https://a.test/l.png': ok() }), nativeImage: fakeNativeImage(), fs: mem });
  await cache.request(['https://a.test/l.png']);
  assert.ok(cache.peek('https://a.test/l.png'));
});
