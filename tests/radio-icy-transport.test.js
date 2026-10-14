'use strict';

// Tests: Radio-Transport (node:http mit insecureHTTPParser) gegen einen rohen TCP-Server mit LF-only-Statuszeile (wie streamabc.net).
// Regression: Electrons eingebauter fetch (undici) wirft hier "Missing expected CR after response line".

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStream, probeStream } = require('../lib/radio/radio-resolve.js');
const { readIcyTitle } = require('../lib/radio/icy-parser.js');
const { nodeFetch, describeFetchError } = require('../lib/radio/radio-http.js');
const { startRadioServer } = require('./helpers/radio-server.js');

let server;
test.before(async () => {
  server = await startRadioServer();
});
test.after(async () => {
  await server.close();
});

test('nodeFetch liest eine Roh-Statuszeilen-Antwort und liefert Header und Body', async () => {
  const response = await nodeFetch(`${server.rawBase}/icy.mp3`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('icy-name'), 'Roher ICY');
  assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, 8192);
});

test('resolveStream: LF-Statuszeile direkt und hinter 302-Redirect', async () => {
  const direct = await resolveStream(`${server.rawBase}/icy.mp3`);
  assert.equal(direct.kind, 'direct');
  const viaRedirect = await resolveStream(`${server.rawBase}/redirect`);
  assert.equal(viaRedirect.kind, 'direct');
  assert.equal(viaRedirect.streamUrl, `${server.rawBase}/icy.mp3?sABC=token`);
});

test('probeStream: erreichbar mit icyName, auch hinter Redirect', async () => {
  const result = await probeStream(`${server.rawBase}/redirect`);
  assert.equal(result.ok, true);
  assert.equal(result.icyName, 'Roher ICY');
  assert.ok(result.bytes > 0);
});

test('readIcyTitle: Titel aus Roh-Statuszeilen-Stream hinter Redirect', async () => {
  const result = await readIcyTitle(`${server.rawBase}/redirect`);
  assert.equal(result.raw, 'Roh - Titel');
  assert.equal(result.artist, 'Roh');
  assert.equal(result.title, 'Titel');
});

test('Protokollfehler und Verbindungsfehler haben konkrete Texte', async () => {
  const garbage = await probeStream(`${server.rawBase}/garbage`);
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /Protokollfehler/);
  const refused = await probeStream('http://127.0.0.1:1/x');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Verbindung abgelehnt');
  assert.equal(describeFetchError({ code: 'ENOTFOUND' }), 'Server nicht gefunden');
});
