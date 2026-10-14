'use strict';

// Tests: Playlist-Auflösung für Radio (lib/radio/radio-resolve.js) gegen einen lokalen HTTP-Testserver.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStream, probeStream, parsePlaylist } = require('../lib/radio/radio-resolve.js');
const { startRadioServer } = require('./helpers/radio-server.js');

let server;
test.before(async () => {
  server = await startRadioServer();
});
test.after(async () => {
  await server.close();
});

const url = p => `${server.base}${p}`;

test('parsePlaylist erkennt pls, m3u, asx und HLS', () => {
  assert.deepEqual(parsePlaylist('[playlist]\nFile1=http://a/b\n'), { type: 'pls', url: 'http://a/b' });
  assert.deepEqual(parsePlaylist('#EXTM3U\n#EXTINF:-1,x\nhttp://a/b\n'), { type: 'm3u', url: 'http://a/b' });
  assert.deepEqual(parsePlaylist('<asx><entry><ref href="http://a/b"/></entry></asx>'), { type: 'asx', url: 'http://a/b' });
  assert.deepEqual(parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.aac'), { type: 'hls' });
  assert.equal(parsePlaylist('Hallo Welt'), null);
  assert.equal(parsePlaylist('<html><body>404</body></html>'), null);
  assert.equal(parsePlaylist(''), null);
});

test('parsePlaylist lehnt Nicht-http-Einträge (file:, javascript:) ab', () => {
  assert.equal(parsePlaylist('#EXTM3U\nfile:///etc/passwd\nhttps://ok/stream'), null);
  assert.equal(parsePlaylist('javascript:alert(1)'), null);
});

test('direkter Stream wird erkannt und nicht geladen', async () => {
  const r = await resolveStream(url('/direct.mp3'));
  assert.equal(r.kind, 'direct');
  assert.equal(r.streamUrl, url('/direct.mp3'));
  assert.equal(r.contentType, 'audio/mpeg');
});

test('.pls, .m3u (relativ) und .asx führen zum Stream', async () => {
  for (const [path, via] of [['/list.pls', 'pls'], ['/list.m3u', 'm3u'], ['/list.asx', 'asx']]) {
    const r = await resolveStream(url(path));
    assert.equal(r.kind, 'direct', path);
    assert.equal(r.streamUrl, url('/direct.mp3'), path);
    assert.deepEqual(r.via, [via], path);
  }
});

test('HLS (Media- und Master-Playlist) liefert kind hls mit der Playlist-URL', async () => {
  for (const path of ['/hls.m3u8', '/hls-master.m3u8']) {
    const r = await resolveStream(url(path));
    assert.equal(r.kind, 'hls', path);
    assert.equal(r.streamUrl, url(path));
  }
});

test('Redirects werden verfolgt, Schleifen und file:-Ziele abgelehnt', async () => {
  assert.equal((await resolveStream(url('/redirect1'))).streamUrl, url('/direct.mp3'));
  await assert.rejects(resolveStream(url('/loop')), /Zu viele Weiterleitungen/);
  await assert.rejects(resolveStream(url('/redirect1'), { maxRedirects: 1 }), /Zu viele Weiterleitungen/);
  await assert.rejects(resolveStream(url('/to-file')), /http/);
});

test('nur http und https als Eingabe', async () => {
  await assert.rejects(resolveStream('file:///etc/passwd'), /http/);
  await assert.rejects(resolveStream('ftp://example.test/x'), /http/);
  await assert.rejects(resolveStream('kein url'), /Ungültige Stream-URL/);
});

test('Playlist-Verschachtelung ist begrenzt', async () => {
  await assert.rejects(resolveStream(url('/nested.pls')), /verschachtelt/);
});

test('Content-Type zuerst: "pls"-Adresse mit Audio und octet-stream mit Binärdaten sind direkte Streams', async () => {
  const a = await resolveStream(url('/pls-but-audio'));
  assert.equal(a.kind, 'direct');
  const b = await resolveStream(url('/octet'));
  assert.equal(b.kind, 'direct');
});

test('HTML und Fehlerstatus sind keine Streams', async () => {
  await assert.rejects(resolveStream(url('/html')), /Keine Playlist erkannt/);
  await assert.rejects(resolveStream(url('/missing')), /HTTP 404/);
});

test('Größenlimit: riesige Playlist wird nach maxBytes abgeschnitten (kein Eintrag gefunden)', async () => {
  await assert.rejects(resolveStream(url('/big.m3u'), { maxBytes: 4096 }), /Keine Playlist erkannt/);
});

test('hartes Timeout bei hängendem Server', async () => {
  const started = Date.now();
  await assert.rejects(resolveStream(url('/hang'), { timeoutMs: 150 }), /Zeitüberschreitung/);
  assert.ok(Date.now() - started < 2000);
});

test('injizierter fetch wird verwendet (kein Netz)', async () => {
  const calls = [];
  const fakeFetch = async (target, init) => {
    calls.push({ target, redirect: init.redirect, hasSignal: Boolean(init.signal) });
    return new Response('x', { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const r = await resolveStream('http://radio.invalid/live', { fetch: fakeFetch });
  assert.equal(r.kind, 'direct');
  assert.deepEqual(calls, [{ target: 'http://radio.invalid/live', redirect: 'manual', hasSignal: true }]);
});

test('Netzwerkfehler werden lesbar gemeldet', async () => {
  const failing = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ENOTFOUND' };
    throw error;
  };
  await assert.rejects(resolveStream('http://radio.invalid/x', { fetch: failing }), /Server nicht gefunden/);
});

test('probeStream: Erfolg mit Bytes und ICY-Name, Playlist-Auflösung inklusive', async () => {
  const r = await probeStream(url('/list.pls'));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'direct');
  assert.equal(r.streamUrl, url('/direct.mp3'));
  assert.ok(r.bytes > 0);
  assert.equal(r.icyName, 'Testradio');
});

test('probeStream: HLS ok, Fehler als { ok:false } statt Exception', async () => {
  assert.equal((await probeStream(url('/hls.m3u8'))).kind, 'hls');
  const missing = await probeStream(url('/missing'));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /HTTP 404/);
  const bad = await probeStream('ftp://x');
  assert.equal(bad.ok, false);
  const hang = await probeStream(url('/hang'), { timeoutMs: 100 });
  assert.equal(hang.ok, false);
  assert.match(hang.error, /Zeitüberschreitung/);
});

test('probeStream bricht Endlos-Streams nach wenigen KB ab', async () => {
  const before = server.log.bytesSent;
  const r = await probeStream(url('/live.mp3'), { timeoutMs: 3000 });
  assert.equal(r.ok, true);
  assert.ok(r.bytes <= 4096 + 2048, `bytes=${r.bytes}`);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(server.log.bytesSent - before < 512 * 1024);
});
