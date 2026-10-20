'use strict';

// Tests: dl://-Protokoll der Downloads (nur Index-Dateien, Range, Content-Type, kein Pfadzugriff).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRange, idFromUrl, playbackUrl, createDownloadProtocolHandler } = require('../lib/download/protocol.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-protocol-'));
const file = path.join(dir, 'Folge.mp4');
const content = Buffer.from('0123456789abcdefghij'); // 20 Byte
fs.writeFileSync(file, content);
const secret = path.join(dir, 'geheim.txt');
fs.writeFileSync(secret, 'nicht ausliefern');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ID = 'dl_abc123_deadbeef';
const handler = createDownloadProtocolHandler({ getFileInfo: id => (id === ID ? { path: file } : id === 'dl_secret_1234' ? { path: secret } : null) });
const get = (url, headers = {}, method = 'GET') => handler(new Request(url, { method, headers }));

test('parseRange: Bereiche, Suffix, offenes Ende, ungültig', () => {
  assert.deepEqual(parseRange('bytes=0-4', 20), { start: 0, end: 4 });
  assert.deepEqual(parseRange('bytes=5-', 20), { start: 5, end: 19 });
  assert.deepEqual(parseRange('bytes=-6', 20), { start: 14, end: 19 });
  assert.deepEqual(parseRange('bytes=10-99', 20), { start: 10, end: 19 });
  assert.equal(parseRange(null, 20), null);
  for (const bad of ['bytes=20-', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'items=0-1', 'bytes=0-1,3-4', 'bytes=a-b']) assert.equal(parseRange(bad, 20), 'invalid', bad);
});

test('idFromUrl: nur dl://local/<id>.mp4|mkv', () => {
  assert.equal(idFromUrl(playbackUrl(ID, 'mp4')), ID);
  assert.equal(idFromUrl(playbackUrl(ID, 'mkv')), ID);
  for (const bad of ['dl://fremd/dl_abc123_deadbeef.mp4', 'dl://local/../etc/passwd.mp4', 'dl://local/dl_abc123_deadbeef.txt', 'dl://local/x.mp4', 'https://local/dl_abc123_deadbeef.mp4', 'dl://local/dl_abc123_deadbeef.mp4/extra', 'dl://local/%2e%2e%2fdl_abc123_deadbeef.mp4']) assert.equal(idFromUrl(bad), null, bad);
});

test('Vollständige Datei: 200, Länge, Typ, Accept-Ranges', async () => {
  const response = await get(playbackUrl(ID, 'mp4'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-length'), '20');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), content.toString());
});

test('Range: 206 mit Content-Range und genau den angeforderten Bytes', async () => {
  const response = await get(playbackUrl(ID, 'mp4'), { Range: 'bytes=5-9' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 5-9/20');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '56789');
  const tail = await get(playbackUrl(ID, 'mp4'), { Range: 'bytes=-3' });
  assert.equal(Buffer.from(await tail.arrayBuffer()).toString(), 'hij');
});

test('Range hinter dem Dateiende: 416', async () => {
  const response = await get(playbackUrl(ID, 'mp4'), { Range: 'bytes=50-' });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */20');
});

test('Unbekannte ID, fremde Endung, fremde Methode, nicht unterstützter Dateityp: kein Inhalt', async () => {
  assert.equal((await get(playbackUrl('dl_unknown_1234', 'mp4'))).status, 404);
  assert.equal((await get('dl://local/dl_abc123_deadbeef.exe')).status, 404);
  assert.equal((await get(playbackUrl(ID, 'mp4'), {}, 'POST')).status, 405);
  assert.equal((await get(playbackUrl('dl_secret_1234', 'mp4'))).status, 404, '.txt wird nie ausgeliefert');
  assert.equal((await get(playbackUrl(ID, 'mp4'), {}, 'HEAD')).status, 200);
});

test('Datei nicht mehr vorhanden: 404', async () => {
  const gone = createDownloadProtocolHandler({ getFileInfo: () => ({ path: path.join(dir, 'weg.mp4') }) });
  assert.equal((await gone(new Request(playbackUrl(ID, 'mp4')))).status, 404);
});
