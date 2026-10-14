'use strict';

// Tests: Logo-Anreicherung (scripts/enrich-radio-logos.js) offline mit injiziertem Netzwerk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { imageInfo, iconCandidates, enrichLogos, googleFaviconUrl, toHttps } = require('../scripts/enrich-radio-logos.js');
const { reconcileRadioSources } = require('../lib/post-update-reconcile.js');
const { mergeRadiosources } = require('../lib/radiosources-merge.js');

function png(size, tag = 0) {
  const buffer = Buffer.alloc(33 + tag);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(size, 16);
  buffer.writeUInt32BE(size, 20);
  if (tag) buffer.fill(tag, 33);
  return buffer;
}
const GLOBE = png(128, 9);

/** Fake-Netz: Tabelle url -> { status, contentType, buffer, finalUrl } oder Fehler. */
function fakeNet(table) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      const entry = table[url];
      if (!entry) throw new Error('Server nicht gefunden');
      return { status: 200, contentType: 'image/png', finalUrl: url, truncated: false, ...entry };
    },
  };
}
const html = body => ({ contentType: 'text/html', buffer: Buffer.from(body) });
const GOOGLE_NONE = googleFaviconUrl('logo-pruefung-gibt-es-nicht-4711.de');

test('imageInfo erkennt PNG-Größe, ICO, SVG und lehnt HTML ab', () => {
  assert.deepEqual(imageInfo(png(64)), { type: 'png', width: 64, height: 64 });
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = 32;
  ico[7] = 32;
  assert.equal(imageInfo(ico).width, 32);
  assert.equal(imageInfo(Buffer.from('<svg xmlns="x"></svg>')).type, 'svg');
  assert.equal(imageInfo(Buffer.from('<html><body>x</body></html>')), null);
});

test('toHttps stuft http hoch und lehnt Zugangsdaten und fremde Schemata ab', () => {
  assert.equal(toHttps('http://a.test/x.png'), 'https://a.test/x.png');
  assert.equal(toHttps('//a.test/x.png', 'https://b.test/'), 'https://a.test/x.png');
  assert.equal(toHttps('https://u:p@a.test/x.png'), null);
  assert.equal(toHttps('javascript:alert(1)'), null);
});

test('iconCandidates: apple-touch-icon vor rel=icon, größte zuerst, Standardpfade am Ende', () => {
  const page = '<link rel="icon" sizes="16x16" href="/s.png"><link rel="apple-touch-icon" sizes="180x180" href="/a.png"><link rel="shortcut icon" href="http://x.test/f.ico">';
  assert.deepEqual(iconCandidates(page, 'https://x.test/'), [
    'https://x.test/a.png',
    'https://x.test/s.png',
    'https://x.test/f.ico',
    'https://x.test/apple-touch-icon.png',
    'https://x.test/favicon.ico',
  ]);
});

test('Reihenfolge: Verzeichnis, https-Upgrade, Homepage, Google; Platzhalter und kaputte Links ergeben kein Logo', async () => {
  const net = fakeNet({
    [GOOGLE_NONE]: { buffer: GLOBE },
    'https://dir.test/logo.png': { buffer: png(100) },
    'https://up.test/logo.png': { buffer: png(100) },
    'https://home.test/': html('<link rel="apple-touch-icon" href="/touch.png">'),
    'https://home.test/touch.png': { buffer: png(180) },
    'https://g.test/': html('<html>kein Icon</html>'),
    [googleFaviconUrl('g.test')]: { buffer: png(128, 3) },
    'https://globus.test/': html('<html>kein Icon</html>'),
    [googleFaviconUrl('globus.test')]: { buffer: GLOBE },
    'https://tot.test/logo.png': { status: 404, buffer: Buffer.alloc(0) },
    'https://html.test/logo.png': { contentType: 'text/html', buffer: Buffer.from('<html>') },
  });
  const stations = [
    { id: 'dir', rbUuid: 'u1' },
    { id: 'up', rbUuid: 'u2' },
    { id: 'home', rbUuid: 'u3', homepage: 'http://home.test/' },
    { id: 'g', rbUuid: 'u4', homepage: 'https://g.test/' },
    { id: 'globus', rbUuid: 'u5', homepage: 'https://globus.test/' },
    { id: 'tot', rbUuid: 'u6' },
    { id: 'html', rbUuid: 'u7' },
    { id: 'keep', rbUuid: 'u8', logo: 'https://dir.test/logo.png' },
  ];
  const raw = new Map([
    ['u1', { favicon: 'https://dir.test/logo.png' }],
    ['u2', { favicon: 'http://up.test/logo.png' }],
    ['u6', { favicon: 'https://tot.test/logo.png' }],
    ['u7', { favicon: 'https://html.test/logo.png' }],
  ]);
  const { stations: out, report } = await enrichLogos({ stations, rawByUuid: raw, net });
  const logo = id => out.find(s => s.id === id).logo;
  assert.equal(logo('dir'), 'https://dir.test/logo.png');
  assert.equal(logo('up'), 'https://up.test/logo.png');
  assert.equal(logo('home'), 'https://home.test/touch.png');
  assert.equal(logo('g'), googleFaviconUrl('g.test'));
  assert.equal(logo('globus'), undefined);
  assert.equal(logo('tot'), undefined);
  assert.equal(logo('html'), undefined);
  assert.equal(logo('keep'), 'https://dir.test/logo.png');
  assert.deepEqual(report.bySource, { bestehend: 1, verzeichnis: 1, 'https-upgrade': 1, homepage: 1, google: 1 });
  assert.deepEqual(report.noLogo.sort(), ['globus', 'html', 'tot']);
  assert.equal(report.before, 1);
  assert.equal(report.after, 5);
  assert.deepEqual(stations[0], { id: 'dir', rbUuid: 'u1' }, 'Eingabe bleibt unverändert');
});

test('kaputtes bestehendes Logo wird ersetzt oder entfernt; IDs und Reihenfolge bleiben', async () => {
  const net = fakeNet({ [GOOGLE_NONE]: { buffer: GLOBE }, 'https://neu.test/f.png': { buffer: png(64) } });
  const stations = [
    { id: 'a', name: 'A', streamUrl: 'http://a/s', rbUuid: 'u1', logo: 'https://alt.test/weg.png' },
    { id: 'b', name: 'B', streamUrl: 'http://b/s', rbUuid: 'u2', logo: 'https://alt.test/weg2.png' },
  ];
  const { stations: out, report } = await enrichLogos({ stations, rawByUuid: new Map([['u1', { favicon: 'https://neu.test/f.png' }]]), net });
  assert.deepEqual(out.map(s => s.id), ['a', 'b']);
  assert.equal(out[0].logo, 'https://neu.test/f.png');
  assert.equal('logo' in out[1], false);
  assert.deepEqual(report.brokenExisting, ['a', 'b']);
});

test('ohne ermittelbaren Google-Platzhalter wird der Google-Fallback nicht benutzt', async () => {
  const net = fakeNet({ 'https://g.test/': html('x'), [googleFaviconUrl('g.test')]: { buffer: png(128, 3) } });
  const { stations: out } = await enrichLogos({ stations: [{ id: 'g', rbUuid: 'u', homepage: 'https://g.test/' }], net });
  assert.equal(out[0].logo, undefined);
});

// ---------- Merge alt -> neu: Bundle-Logo kommt in der Nutzerkopie an, Override gewinnt ----------

const st = (id, extra = {}) => ({ id, name: id.toUpperCase(), streamUrl: `http://${id}.test/s`, ...extra });
const bundled = (stations, extra = {}) => ({ id: 'deutsche-radiosender', name: 'Deutsche Radiosender', type: 'bundled', stations, sortOrder: stations.map(s => s.id), ...extra });

test('neues Bundle-Logo erreicht die Nutzerkopie, Nutzer-Override bleibt, unverändert Logolose bleiben logolos', () => {
  const base = [bundled([st('a'), st('b'), st('c')])];
  const old = [bundled([st('a'), st('b'), st('c')], { stationOverrides: { b: { logo: 'https://mein.test/b.png' } } })];
  const neu = [bundled([st('a', { logo: 'https://l.test/a.png' }), st('b', { logo: 'https://l.test/b.png' }), st('c')])];
  const src = mergeRadiosources(base, old, neu).value[0];
  assert.equal(src.stations.find(s => s.id === 'a').logo, 'https://l.test/a.png');
  assert.equal(src.stations.find(s => s.id === 'b').logo, 'https://l.test/b.png');
  assert.deepEqual(src.stationOverrides, { b: { logo: 'https://mein.test/b.png' } });
  assert.equal('logo' in src.stations.find(s => s.id === 'c'), false);
});

test('reconcile: geänderte Bundle-Logos landen in der Nutzerkopie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-merge-'));
  const userFile = path.join(dir, 'user.json');
  const bundleFile = path.join(dir, 'bundle.json');
  const baseFile = path.join(dir, 'base.json');
  const before = [bundled([st('a')])];
  fs.writeFileSync(userFile, JSON.stringify(before));
  fs.writeFileSync(baseFile, JSON.stringify(before));
  fs.writeFileSync(bundleFile, JSON.stringify([bundled([st('a', { logo: 'https://l.test/a.png' })])]));
  assert.equal(reconcileRadioSources({ userFile, bundleFile, baseFile }).merged, true);
  assert.equal(JSON.parse(fs.readFileSync(userFile, 'utf8'))[0].stations[0].logo, 'https://l.test/a.png');
  fs.rmSync(dir, { recursive: true, force: true });
});
