'use strict';

// Tests: Logo-Suche (lib/radio/radio-logo-finder.js, radio:find-logo, icy-url im Probe) offline mit injiziertem Netzwerk.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findLogo, createLogoFinder, googleFaviconUrl, homepageIcon } = require('../lib/radio/radio-logo-finder.js');
const { icyHomepage, probeStream } = require('../lib/radio/radio-resolve.js');
const { registerRadioIpc } = require('../lib/radio/ipc.js');
const { validateRadioFindLogo } = require('../lib/ipc-validation.js');
const { radioStation, radioStationUpdates, radioHomepageUrlError } = require('../lib/input-validation.js');
const { validateBackup } = require('../lib/backup.js');
const logic = require('../lib/radio/radio-sources-logic.js');

function png(size, tag = 0) {
  const buffer = Buffer.alloc(33 + tag);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(size, 16);
  buffer.writeUInt32BE(size, 20);
  if (tag) buffer.fill(tag, 33);
  return buffer;
}
const GLOBE = png(128, 9);
const GOOGLE_NONE = googleFaviconUrl('logo-pruefung-gibt-es-nicht-4711.de');

function fakeNet(table, { delay = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const entry = table[url];
      if (!entry) throw new Error('Server nicht gefunden');
      return { status: 200, contentType: 'image/png', finalUrl: url, truncated: false, ...entry };
    },
  };
}
const html = body => ({ contentType: 'text/html', buffer: Buffer.from(body) });

test('Fund über die Homepage (apple-touch-icon)', async () => {
  const net = fakeNet({
    'https://radio.test/': html('<link rel="apple-touch-icon" href="/a.png">'),
    'https://radio.test/a.png': { buffer: png(180) },
  });
  assert.deepEqual(await findLogo({ homepage: 'https://radio.test/', net }), { logo: 'https://radio.test/a.png', source: 'homepage' });
});

test('Fund über Google, wenn die Homepage kein Icon liefert; Globus wird nicht als Logo genommen', async () => {
  const net = fakeNet({
    'https://radio.test/': html('<p>nichts</p>'),
    [googleFaviconUrl('radio.test')]: { buffer: png(128, 3) },
    [googleFaviconUrl('globus.test')]: { buffer: GLOBE },
    [GOOGLE_NONE]: { buffer: GLOBE },
  });
  const finder = createLogoFinder({ net });
  assert.deepEqual(await finder.find('https://radio.test/'), { logo: googleFaviconUrl('radio.test'), source: 'google' });
  assert.deepEqual(await finder.find('https://globus.test/'), { logo: null, source: null }, 'Globus erkannt');
  assert.equal(net.calls.filter(u => u === GOOGLE_NONE).length, 1, 'Globus-Hash nur einmal ermittelt (gecacht)');
});

test('Globus-Hash nicht ermittelbar: Google-Fallback bleibt aus', async () => {
  const net = fakeNet({ 'https://radio.test/': html('<p>x</p>'), [googleFaviconUrl('radio.test')]: { buffer: png(128, 3) } });
  assert.deepEqual(await createLogoFinder({ net }).find('https://radio.test/'), { logo: null, source: null });
  assert.equal(net.calls.includes(googleFaviconUrl('radio.test')), false);
});

test('kein Fund und kaputter Link (404, Nicht-Bild) ergeben null', async () => {
  const net = fakeNet({
    'https://radio.test/': html('<link rel="icon" href="/kaputt.png"><link rel="apple-touch-icon" href="/seite.png">'),
    'https://radio.test/kaputt.png': { status: 404 },
    'https://radio.test/seite.png': { contentType: 'text/html', buffer: Buffer.from('<html>') },
    [GOOGLE_NONE]: { buffer: GLOBE },
    [googleFaviconUrl('radio.test')]: { buffer: GLOBE },
  });
  assert.deepEqual(await createLogoFinder({ net }).find('https://radio.test/'), { logo: null, source: null });
});

test('http-Icons werden in Produktion nicht übernommen (nur https), allowHttp nur für Testläufe', async () => {
  const table = {
    'http://localhost:1/': html('<link rel="apple-touch-icon" href="/a.png">'),
    'http://localhost:1/a.png': { buffer: png(180) },
  };
  assert.deepEqual(await findLogo({ homepage: 'http://localhost:1/', net: fakeNet(table), httpFallback: false }), { logo: null, source: null });
  assert.deepEqual(await findLogo({ homepage: 'http://localhost:1/', net: fakeNet(table), allowHttp: true }), { logo: 'http://localhost:1/a.png', source: 'homepage' });
  const icon = await homepageIcon('http://localhost:1/', fakeNet(table), { allowHttp: true });
  assert.equal(icon.good, 'http://localhost:1/a.png');
});

test('Timeout: die Suche bricht nach dem Gesamtlimit ab', async () => {
  const net = fakeNet({ 'https://radio.test/': html('x') }, { delay: 200 });
  await assert.rejects(createLogoFinder({ net, deadlineMs: 30 }).find('https://radio.test/'), /Zeitüberschreitung/);
});

test('icyHomepage: nur http/https ohne Zugangsdaten', () => {
  assert.equal(icyHomepage('https://detektor.fm'), 'https://detektor.fm/');
  assert.equal(icyHomepage(' http://x.test/a '), 'http://x.test/a');
  for (const bad of [undefined, '', 'javascript:alert(1)', 'ftp://x.test', 'x.test', 'https://u:p@x.test/', null]) assert.equal(icyHomepage(bad), undefined, String(bad));
});

test('probeStream liefert homepage aus icy-url, sonst kein Feld', async () => {
  const make = headers => async () => new Response(Buffer.alloc(64, 1), { status: 200, headers: { 'content-type': 'audio/mpeg', ...headers } });
  const withUrl = await probeStream('http://r.test/s', { fetch: make({ 'icy-url': 'https://detektor.fm/' }) });
  assert.equal(withUrl.homepage, 'https://detektor.fm/');
  const without = await probeStream('http://r.test/s', { fetch: make({}) });
  assert.equal('homepage' in without, false);
  const bad = await probeStream('http://r.test/s', { fetch: make({ 'icy-url': 'javascript:1' }) });
  assert.equal('homepage' in bad, false);
});

// ── Validierung ──

test('Webseite: Validierung, Sender-Eingabe, Update (null entfernt), Backup', () => {
  assert.equal(radioHomepageUrlError('https://detektor.fm'), null);
  assert.match(radioHomepageUrlError('ftp://x.test'), /Webseite/);
  assert.match(radioHomepageUrlError('https://u:p@x.test'), /Zugangsdaten/);
  assert.deepEqual(radioStation({ name: 'A', streamUrl: 'http://x.test/s', homepage: 'https://a.test' }), { name: 'A', streamUrl: 'http://x.test/s', homepage: 'https://a.test' });
  assert.throws(() => radioStation({ name: 'A', streamUrl: 'http://x.test/s', homepage: 'javascript:1' }), /Webseite/);
  assert.deepEqual(radioStationUpdates({ homepage: '' }), { homepage: null });
  const sources = logic.addCustomStation(logic.ensureCustomSource([]), { name: 'A', streamUrl: 'http://x.test/s', homepage: 'https://a.test' }).sources;
  assert.equal(logic.ensureCustomSource(sources).find(s => s.id === logic.CUSTOM_SOURCE_ID).stations[0].homepage, 'https://a.test');
  const backup = hp => ({ services: [], tvSources: [], radioSources: [{ id: 'eigene-radiosender', name: 'E', type: 'user', stations: [{ id: 'c', name: 'A', streamUrl: 'http://x.test/s', ...(hp ? { homepage: hp } : {}) }] }] });
  assert.equal(validateBackup(backup()).ok, true, 'altes Backup ohne Webseite');
  assert.equal(validateBackup(backup('https://a.test')).ok, true);
  assert.equal(validateBackup(backup('javascript:1')).ok, false);
});

test('validateRadioFindLogo: genau eine Angabe, nur bekannte Felder', () => {
  assert.deepEqual(validateRadioFindLogo({ homepage: 'https://a.test' }), { homepage: 'https://a.test' });
  assert.deepEqual(validateRadioFindLogo({ streamUrl: 'http://a.test/s' }), { streamUrl: 'http://a.test/s' });
  for (const bad of [null, 'x', [], {}, { homepage: 'https://a.test', streamUrl: 'http://a.test/s' }, { homepage: 'ftp://a.test' }, { streamUrl: 'x' }, { homepage: 'https://a.test', evil: 1 }, { homepage: 5 }]) {
    assert.throws(() => validateRadioFindLogo(bad), Error, JSON.stringify(bad));
  }
});

// ── IPC ──

function ipcSetup({ findLogo, probe } = {}) {
  const handlers = new Map();
  const MAIN = { id: 'main' };
  const noop = () => {};
  registerRadioIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: noop },
    controller: { on: noop, getState: () => ({}), playerWebContents: () => null },
    library: {},
    requireMainRenderer: event => {
      if (!event || event.sender !== MAIN) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: noop,
    probe,
    findLogo,
  });
  const call = (...args) => handlers.get('radio:find-logo')({ sender: MAIN }, ...args);
  return { call, handler: handlers.get('radio:find-logo'), MAIN };
}

test('radio:find-logo: Absender, Schema, Ergebnis, Fehler, Doppelstart pro Fenster', async () => {
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const { call, handler, MAIN } = ipcSetup({
    findLogo: async homepage => {
      if (homepage.includes('slow')) await gate;
      if (homepage.includes('boom')) throw new Error('Zeitüberschreitung nach 25000 ms');
      return { logo: 'https://l.test/a.png', source: 'google' };
    },
    probe: async url => (url.includes('mit') ? { ok: true, homepage: 'https://seite.test/' } : { ok: true }),
  });
  await assert.rejects(handler({ sender: { id: 'webview' } }, { homepage: 'https://a.test' }), /nicht autorisiertem/);
  await assert.rejects(call({ homepage: 'ftp://a.test' }), /Webseite/);
  await assert.rejects(call({ homepage: 'https://a.test' }, 'extra'), /ungültig/);
  assert.deepEqual(await call({ homepage: 'https://a.test' }), { ok: true, logo: 'https://l.test/a.png', source: 'google', homepage: 'https://a.test' });
  assert.deepEqual(await call({ streamUrl: 'http://mit.test/s' }), { ok: true, logo: 'https://l.test/a.png', source: 'google', homepage: 'https://seite.test/' });
  assert.deepEqual(await call({ streamUrl: 'http://ohne.test/s' }), { ok: true, logo: null, source: null, homepage: null, reason: 'no-homepage' });
  assert.deepEqual(await call({ homepage: 'https://boom.test' }), { ok: false, error: 'Zeitüberschreitung nach 25000 ms' });
  const slow = call({ homepage: 'https://slow.test' });
  const second = await call({ homepage: 'https://a.test' });
  assert.equal(second.ok, false);
  assert.match(second.error, /bereits/);
  const otherWindow = ipcSetup({ findLogo: async () => ({ logo: null, source: null }) });
  assert.equal((await otherWindow.call({ homepage: 'https://a.test' })).ok, true, 'anderes Fenster/Setup unabhängig');
  release();
  assert.equal((await slow).ok, true);
  assert.equal((await handler({ sender: MAIN }, { homepage: 'https://a.test' })).ok, true, 'danach wieder frei');
});

test('radio:find-logo ohne verdrahtete Suche meldet „nicht verfügbar“', async () => {
  const { call } = ipcSetup();
  assert.deepEqual(await call({ homepage: 'https://a.test' }), { ok: false, error: 'Logo-Suche nicht verfügbar' });
});
