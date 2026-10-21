'use strict';

// Tests: arte FSK-Abruf wie der Web-Player (aus den öffentlichen Bundles): /api/sso/v3/me mit Bearer + client: web liefert
// ageVerificationToken; player/v2/config geht OHNE Authorization nur mit X-Validated-Age. Erfundene Fixtures, Ersatz-Transport.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const { createMediathekHttp } = require('../lib/mediathek/http.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { createMediathekAuth } = require('../lib/mediathek/auth/index.js');
const { createAuthStore } = require('../lib/mediathek/auth/store.js');
const { createArteProvider, parseAgeToken } = require('../lib/mediathek/auth/arte.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');

function response(status, body) {
  return { status, headers: { get: () => null }, async arrayBuffer() { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }, body: { cancel: async () => {} } };
}

function setup(meBody) {
  const store = createAuthStore({ file: null, safeStorage: null });
  store.set('arte', { accessToken: 'FAKE-ACCESS', refreshToken: 'FAKE-REFRESH', expiresAt: NOW + 3600000, since: NOW, state: 'ok', clientId: 'replay' });
  const auth = createMediathekAuth({ providers: { arte: createArteProvider({ net: { postForm: async () => ({}) }, now: () => NOW }) }, store, loginRunner: { run: async () => ({ ok: false, code: 'cancelled' }) }, now: () => NOW });
  const requests = [];
  const http = createMediathekHttp({
    lookup: undefined,
    auth,
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: { ...init.headers } });
      if (url.includes('/api/sso/v3/me')) return response(200, meBody);
      if (url.includes('/player/v2/config/')) return response(200, requests.filter(r => r.url.includes('/player/v2/')).length === 1 && !init.headers['X-Validated-Age'] ? fixture('dl-arte-age') : fixture('dl-arte-player'));
      return response(200, '{}');
    },
  });
  auth.setHttp(http);
  return { auth, http, requests };
}

test('parseAgeToken: Token aus data[0], sonst null', () => {
  assert.equal(parseAgeToken(JSON.stringify({ data: [{ ageVerificationToken: 'T-1', over16: true }] })), 'T-1');
  assert.equal(parseAgeToken(JSON.stringify({ data: [{ ageVerificationToken: null }] })), null);
  assert.equal(parseAgeToken('kein json'), null);
  assert.equal(parseAgeToken(JSON.stringify({ data: [] })), null);
});

test('arte FSK: /me mit Bearer + client, Player-Abruf mit X-Validated-Age und ohne Authorization', async () => {
  const { auth, http, requests } = setup(JSON.stringify({ data: [{ ageVerificationToken: 'FAKE-AGE', over16: true, over18: true }] }));
  const service = createMediathekService({ http, auth });
  const entry = { id: '000001-000-A', title: 'T', sourceId: 'arte' };
  const detail = await service.resolveStreamDetail(entry);
  const me = requests.find(r => r.url.includes('/api/sso/v3/me'));
  assert.equal(me.headers.Authorization, 'Bearer FAKE-ACCESS');
  assert.equal(me.headers.client, 'web');
  const players = requests.filter(r => r.url.includes('/player/v2/config/'));
  assert.equal(players.length, 2);
  assert.equal(players[0].headers.Authorization, undefined);
  assert.equal(players[1].headers['X-Validated-Age'], 'FAKE-AGE');
  assert.equal(players[1].headers.Authorization, undefined, 'kein Bearer an den Player');
  assert.ok(detail.resolution);
});

test('arte FSK: ohne Alters-Token (nicht verifiziert) keine X-Validated-Age-Kopfzeile', async () => {
  const { auth, http, requests } = setup(JSON.stringify({ data: [{ ageVerificationToken: null, over16: false }] }));
  await createMediathekService({ http, auth }).resolveStreamDetail({ id: '000001-000-A', title: 'T', sourceId: 'arte' });
  const players = requests.filter(r => r.url.includes('/player/v2/config/'));
  assert.equal(players[1].headers['X-Validated-Age'], undefined);
  assert.equal(players[1].headers.Authorization, undefined);
});
