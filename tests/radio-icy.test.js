'use strict';

// Tests: ICY-Metadaten (lib/radio/icy-parser.js): reine Parser und Zweitverbindung gegen lokalen Testserver.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStreamTitle, splitArtistTitle, createIcyExtractor, readIcyTitle, decodeMetadata } = require('../lib/radio/icy-parser.js');
const { startRadioServer, icyBody } = require('./helpers/radio-server.js');

let server;
test.before(async () => {
  server = await startRadioServer();
});
test.after(async () => {
  await server.close();
});

test('parseStreamTitle: Standard, weitere Felder, Apostroph im Titel, leer', () => {
  assert.equal(parseStreamTitle("StreamTitle='Artist - Song';StreamUrl='http://x';"), 'Artist - Song');
  assert.equal(parseStreamTitle("StreamTitle='Don't Stop - Band';"), "Don't Stop - Band");
  assert.equal(parseStreamTitle("StreamTitle='';"), null);
  assert.equal(parseStreamTitle("StreamTitle=' - ';"), null);
  assert.equal(parseStreamTitle("StreamUrl='x';"), null);
  assert.equal(parseStreamTitle("StreamTitle='Ohne Semikolon'"), 'Ohne Semikolon');
  assert.equal(parseStreamTitle("StreamTitle='Mit NUL';\0\0\0"), 'Mit NUL');
});

test('parseStreamTitle: Steuerzeichen werden bereinigt, Länge begrenzt, Platzhalter "-" ignoriert', () => {
  assert.equal(parseStreamTitle("StreamTitle='A\nB\tC';"), 'A B C');
  assert.equal(parseStreamTitle("StreamTitle='-';"), null);
  assert.equal(parseStreamTitle(`StreamTitle='${'x'.repeat(1000)}';`).length, 300);
});

test('splitArtistTitle: erster " - " trennt, sonst nur Titel', () => {
  assert.deepEqual(splitArtistTitle('Artist - Song'), { artist: 'Artist', title: 'Song' });
  assert.deepEqual(splitArtistTitle('A - B - C'), { artist: 'A', title: 'B - C' });
  assert.deepEqual(splitArtistTitle('Nur Titel'), { artist: '', title: 'Nur Titel' });
  assert.deepEqual(splitArtistTitle('- Song'), { artist: '', title: '- Song' });
  assert.deepEqual(splitArtistTitle(''), { artist: '', title: '' });
});

test('decodeMetadata: UTF-8, Rückfall auf Latin-1', () => {
  assert.equal(decodeMetadata(Buffer.from('Björk', 'utf8')), 'Björk');
  assert.equal(decodeMetadata(Buffer.from('Björk', 'latin1')), 'Björk');
});

test('Extraktor: Titel nach leerem ersten Block, auch bei beliebig zerstückelten Chunks', () => {
  const body = icyBody(100, [null, null, 'Band - Lied']);
  for (const size of [1, 7, 99, 100, 101, 1000]) {
    const extractor = createIcyExtractor(100);
    let result = { done: false };
    for (let pos = 0; pos < body.length && !result.done; pos += size) result = extractor.feed(body.subarray(pos, pos + size));
    assert.equal(result.done, true, `chunk ${size}`);
    assert.equal(result.title, 'Band - Lied', `chunk ${size}`);
    assert.equal(extractor.blocks, 3, `chunk ${size}`);
  }
});

test('Extraktor: ohne Titel nie fertig, ungültiges metaint wird abgelehnt', () => {
  const extractor = createIcyExtractor(50);
  assert.equal(extractor.feed(icyBody(50, [null, null, null])).done, false);
  for (const bad of [0, -1, 1.5, 'x', 2 * 1024 * 1024]) assert.throws(() => createIcyExtractor(bad), /metaint/);
});

test('readIcyTitle: Zweitverbindung mit Icy-MetaData:1 liefert Titel, Interpret und Sendername', async () => {
  const r = await readIcyTitle(`${server.base}/icy.mp3`);
  assert.equal(r.title, 'Lied');
  assert.equal(r.artist, 'Interpret');
  assert.equal(r.raw, 'Interpret - Lied');
  assert.equal(r.icyName, 'ICY Test');
  assert.equal(r.metaint, 4096);
  assert.equal(server.log.icyRequests.at(-1), '1');
});

test('readIcyTitle: Latin-1-Metadaten', async () => {
  const r = await readIcyTitle(`${server.base}/icy-latin1.mp3`);
  assert.equal(r.raw, 'Björk - Jóga');
});

test('readIcyTitle: Sender ohne icy-metaint ist kein Fehler', async () => {
  const r = await readIcyTitle(`${server.base}/icy-none.mp3`);
  assert.equal(r.metaint, 0);
  assert.equal(r.title, '');
  assert.equal(r.artist, '');
});

test('readIcyTitle: bricht ohne Titel am Leselimit ab und schließt die Verbindung', async () => {
  const before = server.log.bytesSent;
  const r = await readIcyTitle(`${server.base}/icy-endless.mp3`, { maxBytes: 16 * 1024, timeoutMs: 5000 });
  assert.equal(r.title, '');
  await new Promise(resolve => setTimeout(resolve, 80));
  const sent = server.log.bytesSent - before;
  assert.ok(sent < 1024 * 1024, `gesendet ${sent}`);
});

test('readIcyTitle: Fehlerstatus, Timeout und Protokollprüfung', async () => {
  await assert.rejects(readIcyTitle(`${server.base}/missing`), /HTTP 404/);
  await assert.rejects(readIcyTitle(`${server.base}/hang`, { timeoutMs: 100 }), /Zeitüberschreitung/);
  await assert.rejects(readIcyTitle('file:///etc/passwd'), /http/);
});
