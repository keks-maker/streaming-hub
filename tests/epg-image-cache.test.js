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

// ── QA-Nachbesserung: Dekompressionsbombe, SSRF über aufgelöste IP, GIF, stopMs ──
const { readImageSize, assertSafeImageSize } = require('../lib/epg/image-size.js');
const { createSafeFetch, isBlockedAddress } = require('../lib/epg/safe-fetch.js');
const http = require('node:http');

function pngHeader(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpegHeader(w, h) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
}
function webpHeader(kind, w, h) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  if (kind === 'VP8 ') {
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === 'VP8L') {
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}

test('image-size: liest PNG, JPEG, WebP (VP8, VP8L, VP8X) aus dem Kopf', () => {
  assert.deepEqual(readImageSize(pngHeader(640, 360)), { width: 640, height: 360 });
  assert.deepEqual(readImageSize(jpegHeader(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(readImageSize(webpHeader('VP8 ', 800, 450)), { width: 800, height: 450 });
  assert.deepEqual(readImageSize(webpHeader('VP8L', 800, 450)), { width: 800, height: 450 });
  assert.deepEqual(readImageSize(webpHeader('VP8X', 800, 450)), { width: 800, height: 450 });
});

test('image-size: Bomben, zu große Maße, unbekannte und kaputte Formate werden abgelehnt', () => {
  assert.throws(() => assertSafeImageSize(pngHeader(20000, 20000)), /zu groß/);
  assert.throws(() => assertSafeImageSize(pngHeader(4097, 10)), /zu groß/);
  assert.throws(() => assertSafeImageSize(webpHeader('VP8X', 16000, 16000)), /zu groß/);
  assert.doesNotThrow(() => assertSafeImageSize(jpegHeader(4096, 4096)));
  for (const bad of [Buffer.from('GIF89a......................'), Buffer.alloc(40, 1), Buffer.alloc(3), pngHeader(0, 5), 'text', null]) {
    assert.throws(() => assertSafeImageSize(bad), /unbekannt/);
  }
});

test('GIF ist kein zulässiger Bildtyp', async () => {
  const cache = cacheWith({ fetchImpl: async () => new Response(jpegBytes(50), { headers: { 'content-type': 'image/gif' } }) });
  assert.equal(await cache.get('https://img.example.org/a.gif', NOW), null);
});

test('stopMs wird auf jetzt + 14 Tage begrenzt', async () => {
  const cache = cacheWith({ fetchImpl: okFetch() });
  const url = 'https://img.example.org/far.jpg';
  await cache.get(url, NOW + 400 * DAY);
  const file = path.join(cache.dir, `${hashUrl(url)}.jpg`);
  assert.equal(Math.round(fs.statSync(file).mtimeMs), NOW + 14 * DAY);
  assert.equal(validateEpgImage('https://a.example/x.jpg', Infinity).stopMs, 0);
});

test('isBlockedAddress: lokal, privat, Link-Local, ULA, unspezifiziert, IPv4-gemappt', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'kein-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('safeFetch: lehnt Namen ab, die auf lokale IPs auflösen (localhost, Literal, 127.0.0.1.nip.io-Muster)', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end('x');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const safe = createSafeFetch();
  for (const host of ['localhost', '127.0.0.1', '[::1]', '127.1']) {
    await assert.rejects(() => safe(`http://${host}:${port}/a.jpg`, {}), undefined, host);
  }
  assert.equal(hits.length, 0, 'es wurde nie verbunden');
  const local = createSafeFetch({ allowLocal: true });
  const res = await local(`http://127.0.0.1:${port}/a.jpg`, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'x');
  await new Promise(resolve => server.close(resolve));
});
