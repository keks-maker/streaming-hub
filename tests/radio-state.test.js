'use strict';

// Tests: Zustandsautomat Radio (lib/radio/radio-state.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_RECONNECTS,
  BACKOFF_MS,
  clampVolume,
  createState,
  reduce,
  planReconnect,
  favoriteNeighbor,
  publicState,
} = require('../lib/radio/radio-state.js');

const A = { sourceId: 's', id: 'a', name: 'A', streamUrl: 'http://a/stream', logo: null, genre: 'Pop' };
const B = { sourceId: 's', id: 'b', name: 'B', streamUrl: 'http://b/stream' };

function run(state, ...actions) {
  return actions.reduce((current, action) => reduce(current, action), state);
}

test('Startzustand ist idle mit Standard-Lautstärke', () => {
  const s = createState();
  assert.equal(s.status, 'idle');
  assert.equal(s.station, null);
  assert.equal(s.volume, 0.8);
  assert.equal(createState({ volume: 2 }).volume, 1);
});

test('Normalablauf: select → playing → pause → resume → playing → stop', () => {
  let s = reduce(createState(), { type: 'select', station: A });
  assert.equal(s.status, 'loading');
  assert.equal(s.station, A);
  s = reduce(s, { type: 'playing' });
  assert.equal(s.status, 'playing');
  s = reduce(s, { type: 'pause' });
  assert.equal(s.status, 'paused');
  s = reduce(s, { type: 'resume' });
  assert.equal(s.status, 'loading');
  s = reduce(s, { type: 'playing' });
  assert.equal(s.status, 'playing');
  s = reduce(s, { type: 'stop' });
  assert.equal(s.status, 'idle');
  assert.equal(s.station, A, 'letzter Sender bleibt für "fortsetzen" erhalten');
});

test('ungültige Übergänge ändern nichts (gleiche Objektidentität)', () => {
  const idle = createState();
  for (const type of ['playing', 'pause', 'resume', 'stop', 'reconnecting', 'fail']) {
    assert.equal(reduce(idle, { type, attempt: 1 }), idle, type);
  }
  assert.equal(reduce(idle, { type: 'select' }), idle, 'select ohne Sender');
  assert.equal(reduce(idle, { type: 'unbekannt' }), idle);
  assert.equal(reduce(idle, null), idle);
  const loading = reduce(idle, { type: 'select', station: A });
  assert.equal(reduce(loading, { type: 'pause' }), loading);
  assert.equal(reduce(loading, { type: 'resume' }), loading);
});

test('Eingabezustand bleibt unverändert (immutable)', () => {
  const before = createState();
  const frozen = Object.freeze({ ...before });
  assert.doesNotThrow(() => reduce(frozen, { type: 'select', station: A }));
  assert.equal(before.status, 'idle');
});

test('Sendersuche setzt Titel und Fehler zurück', () => {
  let s = run(createState(), { type: 'select', station: A }, { type: 'playing' }, { type: 'now-playing', nowPlaying: { title: 'T', artist: 'K' } });
  assert.deepEqual(s.nowPlaying, { title: 'T', artist: 'K' });
  s = reduce(s, { type: 'select', station: B });
  assert.equal(s.nowPlaying, null);
  assert.equal(s.station, B);
  assert.equal(s.attempt, 0);
});

test('Now Playing nur bei aktivem Radio', () => {
  const idle = createState();
  assert.equal(reduce(idle, { type: 'now-playing', nowPlaying: { title: 'x' } }), idle);
  const failed = run(createState(), { type: 'select', station: A }, { type: 'fail', message: 'weg' });
  assert.equal(reduce(failed, { type: 'now-playing', nowPlaying: { title: 'x' } }), failed);
});

test('Lautstärke wird begrenzt und gerundet, in jedem Zustand änderbar', () => {
  assert.equal(clampVolume(-1), 0);
  assert.equal(clampVolume(5), 1);
  assert.equal(clampVolume('0.5'), 0.5);
  assert.equal(clampVolume(NaN), 0.8);
  assert.equal(clampVolume(0.123456), 0.12);
  assert.equal(reduce(createState(), { type: 'volume', value: 0.3 }).volume, 0.3);
});

test('Fehler: fail setzt Meldung, select startet neu', () => {
  let s = run(createState(), { type: 'select', station: A }, { type: 'fail', message: 'Stream nicht erreichbar' });
  assert.equal(s.status, 'error');
  assert.equal(s.error, 'Stream nicht erreichbar');
  assert.equal(reduce(s, { type: 'playing' }), s, 'error → playing nicht erlaubt');
  s = reduce(s, { type: 'select', station: A });
  assert.equal(s.status, 'loading');
  assert.equal(s.error, null);
  assert.equal(reduce(createState(), { type: 'select', station: A }).error, null);
  assert.equal(run(createState(), { type: 'select', station: A }, { type: 'fail' }).error, 'Stream nicht erreichbar');
});

test('Wiederverbindung: höchstens 3 Versuche mit wachsendem Backoff', () => {
  let s = run(createState(), { type: 'select', station: A }, { type: 'playing' });
  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    const plan = planReconnect(s);
    if (!plan.retry) break;
    delays.push(plan.delayMs);
    assert.equal(plan.attempt, i + 1);
    s = reduce(s, { type: 'reconnecting', attempt: plan.attempt });
    assert.equal(s.status, 'loading');
    assert.equal(s.reconnecting, true);
  }
  assert.deepEqual(delays, BACKOFF_MS.slice(0, MAX_RECONNECTS));
  assert.equal(MAX_RECONNECTS, 3);
  assert.equal(planReconnect(s).retry, false);
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2]);
});

test('erfolgreiches Playing setzt den Versuchszähler zurück', () => {
  let s = run(createState(), { type: 'select', station: A }, { type: 'reconnecting', attempt: 2 });
  assert.equal(s.attempt, 2);
  s = reduce(s, { type: 'playing' });
  assert.equal(s.attempt, 0);
  assert.equal(s.reconnecting, false);
  assert.equal(planReconnect(s).attempt, 1);
});

test('kein Wiederverbindungsplan in idle, paused, error oder ohne Sender', () => {
  assert.equal(planReconnect(createState()).retry, false);
  const paused = run(createState(), { type: 'select', station: A }, { type: 'playing' }, { type: 'pause' });
  assert.equal(planReconnect(paused).retry, false);
  const failed = run(createState(), { type: 'select', station: A }, { type: 'fail', message: 'x' });
  assert.equal(planReconnect(failed).retry, false);
});

test('Favoriten next/prev mit Umlauf', () => {
  const list = [{ sourceId: 's', id: 'a' }, { sourceId: 's', id: 'b' }, { sourceId: 't', id: 'c' }];
  assert.deepEqual(favoriteNeighbor(list, list[0], 1), list[1]);
  assert.deepEqual(favoriteNeighbor(list, list[2], 1), list[0]);
  assert.deepEqual(favoriteNeighbor(list, list[0], -1), list[2]);
  assert.deepEqual(favoriteNeighbor(list, list[1], -1), list[0]);
});

test('Favoriten next/prev: Sender in anderer Quelle mit gleicher ID ist ein anderer Eintrag', () => {
  const list = [{ sourceId: 's', id: 'x' }, { sourceId: 't', id: 'x' }];
  assert.deepEqual(favoriteNeighbor(list, { sourceId: 't', id: 'x' }, 1), list[0]);
});

test('Favoriten next/prev: kein Favorit aktiv → erster bzw. letzter; leer → null', () => {
  const list = [{ sourceId: 's', id: 'a' }, { sourceId: 's', id: 'b' }];
  assert.deepEqual(favoriteNeighbor(list, null, 1), list[0]);
  assert.deepEqual(favoriteNeighbor(list, null, -1), list[1]);
  assert.deepEqual(favoriteNeighbor(list, { sourceId: 's', id: 'zz' }, 1), list[0]);
  assert.equal(favoriteNeighbor([], list[0], 1), null);
  assert.equal(favoriteNeighbor(undefined, list[0], 1), null);
  assert.equal(favoriteNeighbor(list, list[0], 2), null);
  assert.deepEqual(favoriteNeighbor([list[0]], list[0], 1), list[0]);
});

test('publicState reduziert den Sender auf Anzeigefelder (keine Stream-URL)', () => {
  const s = run(createState(), { type: 'select', station: A }, { type: 'playing' });
  const pub = publicState(s);
  assert.deepEqual(pub.station, { sourceId: 's', id: 'a', name: 'A', logo: null, genre: 'Pop' });
  assert.equal(JSON.stringify(pub).includes('http://a/stream'), false);
  assert.equal(pub.status, 'playing');
  assert.equal(publicState(createState()).station, null);
});
