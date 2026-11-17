'use strict';

// Tests: EPG-Vorschaubild-Cache (Senderkachel S2): Hash, URL-Validierung, Download-Regeln, Limit, Aufräumen, IPC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEpgImageCache, hashUrl, validateImageUrl } = require('../lib/epg/image-cache.js');
const { registerEpgIpc } = require('../lib/epg/ipc.js');
const { validateEpgImage } = require('../lib/ipc-validation.js');
const { EpgService } = require('../lib/epg/EpgService.js');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'epg-img-'));
const jpegBytes = n => Buffer.alloc(n, 7);
const identity = buf => buf; // Bildverarbeitung ersetzt (nativeImage gibt es nur in Electron)
const okFetch = (calls = []) => async url => {
  calls.push(url);
  return new Response(jpegBytes(1000), { status: 200, headers: { 'content-type': 'image/jpeg' } });
};
const cacheWith = (over = {}) =>
  createEpgImageCache({ dir: path.join(tmp(), 'epg-images'), processImage: identity, validateUrl: u => u, now: () => NOW, ...over });

test('hashUrl: stabil, hex, 64 Zeichen, verschieden je URL', () => {
  assert.match(hashUrl('https://a.example/x.jpg'), /^[0-9a-f]{64}$/);
  assert.equal(hashUrl('https://a.example/x.jpg'), hashUrl('https://a.example/x.jpg'));
  assert.notEqual(hashUrl('https://a.example/x.jpg'), hashUrl('https://a.example/y.jpg'));
});

test('validateImageUrl: nur http/https, keine lokalen Ziele, Länge begrenzt', () => {
  assert.equal(validateImageUrl('https://img.example.org/a.jpg'), 'https://img.example.org/a.jpg');
  assert.equal(validateImageUrl('http://img.example.org/a.jpg'), 'http://img.example.org/a.jpg');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://x.example/a.jpg', 'http://127.0.0.1/a.jpg', 'http://localhost/a.jpg', '', 5, null, `https://x.example/${'a'.repeat(600)}`]) {
    assert.throws(() => validateImageUrl(bad), undefined, String(bad));
  }
});

test('validateEpgImage: URL-Text und Sendungsende', () => {
  assert.deepEqual(validateEpgImage('https://a.example/x.jpg', 5), { url: 'https://a.example/x.jpg', stopMs: 5 });
  assert.equal(validateEpgImage('https://a.example/x.jpg', 'x').stopMs, 0);
  assert.throws(() => validateEpgImage({}, 1));
  assert.throws(() => validateEpgImage('', 1));
});

test('get: lädt, legt <hash>.jpg ab, setzt mtime = Sendungsende, zweiter Aufruf aus dem Cache', async () => {
  const calls = [];
  const cache = cacheWith({ fetchImpl: okFetch(calls) });
  const url = 'https://img.example.org/a.jpg';
  const stop = NOW + 3600 * 1000;
  const result = await cache.get(url, stop);
  assert.match(result, /^data:image\/jpeg;base64,/);
  const file = path.join(cache.dir, `${hashUrl(url)}.jpg`);
  assert.ok(fs.existsSync(file));
  assert.equal(Math.round(fs.statSync(file).mtimeMs), stop);
  assert.equal(await cache.get(url, stop), result);
  assert.equal(calls.length, 1, 'zweiter Aufruf ohne Netz');
});

test('get: parallele Anfragen derselben URL laden einmal', async () => {
  const calls = [];
  const cache = cacheWith({ fetchImpl: okFetch(calls) });
  const [a, b] = await Promise.all([cache.get('https://img.example.org/p.jpg', NOW), cache.get('https://img.example.org/p.jpg', NOW)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test('get: folgt Redirects und prüft jedes Ziel', async () => {
  const seen = [];
  const cache = cacheWith({
    validateUrl: u => {
      if (u.includes('evil')) throw new Error('verboten');
      return u;
    },
    fetchImpl: async url => {
      seen.push(url);
      if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/real.jpg' } });
      if (url.endsWith('/bad')) return new Response(null, { status: 302, headers: { location: 'http://evil.example/x.jpg' } });
      return new Response(jpegBytes(500), { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });
  assert.match(await cache.get('https://img.example.org/start', NOW), /^data:image\/jpeg/);
  assert.equal(await cache.get('https://img.example.org/bad', NOW), null);
});

test('get: kein Bild (Content-Type), zu groß, Fehlerstatus, nicht verarbeitbar → null, Fehlversuch wird nicht sofort wiederholt', async () => {
  const calls = [];
  const mk = (res, extra = {}) =>
    cacheWith({ fetchImpl: async url => (calls.push(url), res()), maxDownloadBytes: 2000, ...extra });
  assert.equal(await mk(() => new Response('<html>', { headers: { 'content-type': 'text/html' } })).get('https://a.example/1', NOW), null);
  assert.equal(await mk(() => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })).get('https://a.example/2', NOW), null);
  assert.equal(await mk(() => new Response(jpegBytes(5000), { headers: { 'content-type': 'image/jpeg' } })).get('https://a.example/3', NOW), null);
  assert.equal(await mk(() => new Response('x', { status: 404, headers: { 'content-type': 'image/jpeg' } })).get('https://a.example/4', NOW), null);
  assert.equal(
    await mk(() => new Response(jpegBytes(10), { headers: { 'content-type': 'image/jpeg' } }), {
      processImage: () => {
        throw new Error('kaputt');
      },
    }).get('https://a.example/5', NOW),
    null,
  );
  const before = calls.length;
  const cache = mk(() => new Response('x', { status: 500 }));
  await cache.get('https://a.example/6', NOW);
  await cache.get('https://a.example/6', NOW);
  assert.equal(calls.length - before, 1, 'Fehlversuch 10 min gesperrt');
});

test('get: Timeout bricht ab', async () => {
  const cache = cacheWith({
    timeoutMs: 30,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abgebrochen')))),
  });
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout hält den Event-Loop nicht offen
  assert.equal(await cache.get('https://slow.example/a.jpg', NOW), null);
  clearTimeout(keepAlive);
});

test('get: ungültige URL → null ohne Netz', async () => {
  const calls = [];
  const cache = createEpgImageCache({ dir: path.join(tmp(), 'c'), processImage: identity, fetchImpl: okFetch(calls) });
  assert.equal(await cache.get('file:///etc/passwd', NOW), null);
  assert.equal(await cache.get('http://127.0.0.1/x.jpg', NOW), null);
  assert.equal(calls.length, 0);
});

function seed(cache, name, size, mtimeMs) {
  fs.mkdirSync(cache.dir, { recursive: true });
  const file = path.join(cache.dir, name);
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}
const nameOf = n => `${String(n).padStart(64, '0')}.jpg`;

test('cleanup: seit einem Tag beendete Sendungen und fremde Dateien werden gelöscht, neuere bleiben', () => {
  const cache = cacheWith();
  const old = seed(cache, nameOf(1), 10, NOW - DAY - 1000);
  const fresh = seed(cache, nameOf(2), 10, NOW - DAY + 60_000);
  const future = seed(cache, nameOf(3), 10, NOW + 3600_000);
  const stray = seed(cache, 'fremd.txt', 10, NOW);
  const tmpFile = seed(cache, `${nameOf(4)}.123.tmp`, 10, NOW);
  assert.equal(cache.cleanup(), 3);
  assert.ok(!fs.existsSync(old) && !fs.existsSync(stray) && !fs.existsSync(tmpFile));
  assert.ok(fs.existsSync(fresh) && fs.existsSync(future));
});

test('Limit: über dem Limit werden die ältesten zuerst gelöscht (cleanup und nach jedem Schreiben)', async () => {
  const cache = cacheWith({ limitBytes: 250 });
  const a = seed(cache, nameOf(1), 100, NOW + 1000);
  const b = seed(cache, nameOf(2), 100, NOW + 2000);
  const c = seed(cache, nameOf(3), 100, NOW + 3000);
  assert.equal(cache.cleanup(), 1);
  assert.ok(!fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(c));
  // neuer Download (1000 B, Limit 250) verdrängt alles Ältere und bleibt selbst nur, wenn er das Limit nicht sprengt
  const small = cacheWith({ limitBytes: 1500, fetchImpl: okFetch() });
  const o1 = seed(small, nameOf(1), 800, NOW + 1000);
  await small.get('https://img.example.org/n.jpg', NOW + 9000);
  assert.ok(!fs.existsSync(o1), 'ältestes Bild wich dem neuen');
  assert.ok(fs.existsSync(path.join(small.dir, `${hashUrl('https://img.example.org/n.jpg')}.jpg`)));
});

test('epg-image:get: nur Hauptfenster, validiert, liefert data:-URL; Preload-Wrapper vorhanden', async () => {
  const handlers = new Map();
  const mainSender = {};
  const cache = cacheWith({ fetchImpl: okFetch() });
  registerEpgIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    epg: new EpgService({ dir: tmp(), getSources: () => [], fetchImpl: async () => new Response('<tv/>'), now: () => NOW, timers: { setInterval: () => 0, clearInterval: () => {} } }),
    requireMainRenderer: e => {
      if (e?.sender !== mainSender) throw new Error('nicht autorisiert');
    },
    images: cache,
  });
  const get = handlers.get('epg-image:get');
  assert.match(await get({ sender: mainSender }, 'https://img.example.org/i.jpg', NOW + 1000), /^data:image\/jpeg;base64,/);
  await assert.rejects(() => get({ sender: {} }, 'https://img.example.org/i.jpg', NOW), /nicht autorisiert/);
  await assert.rejects(() => get({ sender: mainSender }, { evil: 1 }, NOW), /ungültig/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  assert.match(preload, /getEpgImage: \(url, stopMs\) => ipcRenderer\.invoke\('epg-image:get', url, stopMs\)/);
});

test('nowNext liefert das Bild-Feld der Sendung (Parser → Store → Jetzt/Nächste)', async () => {
  const fmt = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const body = `<tv><programme start="${fmt(NOW - 3600_000)}" stop="${fmt(NOW + 3600_000)}" channel="A.de"><title>T</title><icon src="https://img.example.org/t.jpg"/></programme></tv>`;
  const epg = new EpgService({ dir: tmp(), getSources: () => [{ id: 'de', epgUrl: 'https://epg.example/de.xml' }], fetchImpl: async () => new Response(body), validateUrl: u => u, now: () => NOW, timers: { setInterval: () => 0, clearInterval: () => {} } });
  await epg.refresh({ force: true });
  assert.equal(epg.nowNext(['A.de'])[0].current.icon, 'https://img.example.org/t.jpg');
});
