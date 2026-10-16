'use strict';

// Tests: automatische Dienst-Logos (lib/service-icon.js) offline mit injiziertem Netzwerk.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveServiceIcon, applyServiceIcon, DEFAULT_ICON } = require('../lib/service-icon.js');
const { service } = require('../lib/input-validation.js');

function png(size, tag = 0) {
  const buffer = Buffer.alloc(33 + tag);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(size, 16);
  buffer.writeUInt32BE(size, 20);
  return buffer;
}

function fakeNet(routes, calls = []) {
  return {
    async get(url) {
      calls.push(url);
      const hit = routes[url];
      if (!hit) return { status: 404, contentType: 'text/html', buffer: Buffer.alloc(0), truncated: false, finalUrl: url };
      return { status: 200, finalUrl: url, truncated: false, ...hit };
    },
  };
}

const PLEX = 'http://192.168.4.125:32400/web/index.html#!/';

test('privater Dienst: link rel=icon der Seite wird als data-URI übernommen, kein Google-Abruf', async () => {
  const calls = [];
  const net = fakeNet(
    {
      [PLEX]: { contentType: 'text/html', buffer: Buffer.from('<link rel="icon" href="/web/x.png">') },
      'http://192.168.4.125:32400/web/x.png': { contentType: 'image/png', buffer: png(64) },
    },
    calls,
  );
  const icon = await resolveServiceIcon(PLEX, { net });
  assert.match(icon, /^data:image\/png;base64,/);
  assert.ok(!calls.some(u => u.includes('google.com')));
});

test('privater Dienst: Plex-Fallback /web/favicon.ico', async () => {
  const ico = Buffer.alloc(40);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = 64;
  ico[7] = 64;
  const net = fakeNet({ 'http://192.168.4.125:32400/web/favicon.ico': { contentType: 'image/x-icon', buffer: ico } });
  assert.match(await resolveServiceIcon(PLEX, { net }), /^data:image\/x-icon;base64,/);
});

test('Fehlschlag liefert null (kein Fehler)', async () => {
  assert.equal(await resolveServiceIcon(PLEX, { net: fakeNet({}) }), null);
  const broken = { get: async () => { throw new Error('ECONNREFUSED'); } };
  assert.equal(await resolveServiceIcon(PLEX, { net: broken }), null);
  assert.equal(await resolveServiceIcon('kein url', { net: fakeNet({}) }), null);
});

test('applyServiceIcon: setzt nur bei Standard-Icon, manuelles Icon hat Vorrang', async () => {
  const resolve = async () => 'data:image/png;base64,AAAA';
  let stored = null;
  let notified = 0;
  const run = list => applyServiceIcon({ id: 'a', url: 'http://x.test/', net: {}, resolve, load: () => list, save: s => { stored = s; }, notify: () => { notified += 1; } });
  assert.equal(await run([{ id: 'a', url: 'http://x.test/', icon: DEFAULT_ICON }]), true);
  assert.equal(stored[0].icon, 'data:image/png;base64,AAAA');
  assert.equal(notified, 1);
  stored = null;
  assert.equal(await run([{ id: 'a', url: 'http://x.test/', icon: 'mein.png' }]), false);
  assert.equal(await run([{ id: 'b', url: 'http://x.test/', icon: DEFAULT_ICON }]), false);
  assert.equal(stored, null);
});

test('service(): data-Bild-Icon erlaubt, andere data-URIs abgelehnt', () => {
  const ok = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(service({ name: 'P', url: 'http://192.168.1.2/', icon: ok }).icon, ok);
  assert.throws(() => service({ name: 'P', url: 'http://192.168.1.2/', icon: 'data:text/html;base64,AAAA' }), /Dienst-Icon/);
  assert.throws(() => service({ name: 'P', url: 'http://192.168.1.2/', icon: 'data:image/png;base64,' + 'A'.repeat(100000) }), /Dienst-Icon/);
});
