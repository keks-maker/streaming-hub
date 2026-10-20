'use strict';

// Tests: Direktdownload per HTTP (http-download.js) gegen einen lokalen Server: Range-Resume, Server ohne Range, If-Range,
// 416, abgelaufene Adresse (403/404), Verbindungsabbruch mit automatischer Fortsetzung, Bandbreitenlimit, Abbruch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadFile, parseContentRange } = require('../lib/download/http-download.js');
const { startServer } = require('./helpers/download-media.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-http-'));
  const data = Buffer.alloc(300000);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 7 + (i >> 8)) & 255;
  fs.writeFileSync(path.join(dir, 'f.bin'), data);
  return { dir, data, dest: path.join(dir, 'out.part'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('parseContentRange', () => {
  assert.deepEqual(parseContentRange('bytes 10-19/100'), { start: 10, end: 19, total: 100 });
  assert.equal(parseContentRange('bytes 10-19/*').total, null);
  assert.equal(parseContentRange('nonsense'), null);
});

test('vollständiger Download, User-Agent gesetzt, Fortschritt gemeldet', async () => {
  const env = setup();
  const server = await startServer(env.dir);
  try {
    const progress = [];
    const result = await downloadFile(server.url('f.bin'), env.dest, { onProgress: p => progress.push(p) });
    assert.equal(result.bytes, env.data.length);
    assert.equal(result.total, env.data.length);
    assert.ok(fs.readFileSync(env.dest).equals(env.data));
    assert.ok(progress.length > 0 && progress.at(-1).bytes === env.data.length);
    assert.match(server.requests[0].userAgent, /StreamingHub/);
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('Resume: vorhandene Teildatei wird per Range fortgesetzt', async () => {
  const env = setup();
  const server = await startServer(env.dir, { etag: '"v1"' });
  try {
    fs.writeFileSync(env.dest, env.data.subarray(0, 120000));
    const result = await downloadFile(server.url('f.bin'), env.dest, { etag: '"v1"' });
    assert.equal(result.bytes, env.data.length);
    assert.ok(fs.readFileSync(env.dest).equals(env.data));
    assert.equal(server.requests[0].range, 'bytes=120000-');
    assert.equal(server.requests[0].ifRange, '"v1"');
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('Server ignoriert Range (200): Datei wird von vorn geschrieben, nicht angehängt', async () => {
  const env = setup();
  const server = await startServer(env.dir, { ignoreRange: true });
  try {
    fs.writeFileSync(env.dest, env.data.subarray(0, 50000));
    await downloadFile(server.url('f.bin'), env.dest);
    assert.ok(fs.readFileSync(env.dest).equals(env.data));
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('416 bei bereits vollständiger Teildatei: fertig; bei falscher Größe: Neubeginn', async () => {
  const env = setup();
  const server = await startServer(env.dir);
  try {
    fs.writeFileSync(env.dest, env.data);
    const done = await downloadFile(server.url('f.bin'), env.dest);
    assert.equal(done.bytes, env.data.length);
    fs.writeFileSync(env.dest, Buffer.concat([env.data, Buffer.from('zu lang')]));
    await downloadFile(server.url('f.bin'), env.dest);
    assert.ok(fs.readFileSync(env.dest).equals(env.data));
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('403/404 -> Fehlercode expired ohne Adresse in der Meldung', async () => {
  const env = setup();
  const server = await startServer(env.dir);
  try {
    await assert.rejects(downloadFile(server.url('fehlt.bin'), env.dest), error => {
      assert.equal(error.code, 'expired');
      assert.ok(!error.message.includes('127.0.0.1') && !error.message.includes('fehlt.bin'));
      return true;
    });
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('Verbindungsabbruch mitten im Download: automatische Fortsetzung per Range', async () => {
  const env = setup();
  const server = await startServer(env.dir, { dropAfter: 100000 });
  try {
    const result = await downloadFile(server.url('f.bin'), env.dest, { retryDelayMs: 20 });
    assert.equal(result.bytes, env.data.length);
    assert.ok(fs.readFileSync(env.dest).equals(env.data));
    assert.ok(server.requests.some(request => request.range && request.range.startsWith('bytes=')));
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('Bandbreitenlimit bremst den Download', async () => {
  const env = setup();
  const server = await startServer(env.dir);
  try {
    const started = Date.now();
    await downloadFile(server.url('f.bin'), env.dest, { bytesPerSecond: 600000 }); // 300 KB bei 600 KB/s: mindestens ca. 0,4 s
    assert.ok(Date.now() - started >= 350, `zu schnell: ${Date.now() - started} ms`);
    assert.ok(fs.readFileSync(env.dest).equals(env.data));
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('Abbruch per Signal: Fehlercode aborted, Teildatei bleibt für den Resume', async () => {
  const env = setup();
  const server = await startServer(env.dir, { slowChunkMs: 15 });
  try {
    const controller = new AbortController();
    const pending = downloadFile(server.url('f.bin'), env.dest, { signal: controller.signal, onProgress: ({ bytes }) => bytes > 20000 && controller.abort() });
    await assert.rejects(pending, error => error.code === 'aborted');
    const partial = fs.statSync(env.dest).size;
    assert.ok(partial > 0 && partial < env.data.length);
  } finally {
    await server.close();
    env.cleanup();
  }
});

test('Host-Prüfung (guardUrl) greift vor dem Abruf', async () => {
  const env = setup();
  try {
    await assert.rejects(downloadFile('http://127.0.0.1:9/f.bin', env.dest, { guardUrl: () => { throw Object.assign(new Error('x'), { code: 'forbidden-host' }); } }), error => error.code === 'forbidden-host');
    assert.equal(fs.existsSync(env.dest), false);
  } finally {
    env.cleanup();
  }
});
