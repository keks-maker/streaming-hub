'use strict';

// Tests: Podcast-Wiedergabezustand (lib/podcast/podcast-playback-state.js): Übergänge, Fortsetzungsregel, Tempo-Grenzen.

const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../lib/podcast/podcast-playback-state.js');

const EPISODE = { podcastId: 'p1', episodeId: 'e1', title: 'Folge', show: 'Sendung', cover: null, enclosureUrl: 'https://a.test/e.mp3' };
const loaded = (extra = {}) => ps.reduce(ps.createState(), { type: 'select', episode: EPISODE, position: 30, duration: 600, ...extra });
const playing = () => ps.reduce(loaded(), { type: 'playing' });

test('Übergänge: select → loading → playing → paused → loading (resume) → playing → ended', () => {
  let s = ps.createState();
  assert.equal(s.status, 'idle');
  s = ps.reduce(s, { type: 'select', episode: EPISODE, position: 30, duration: 600 });
  assert.deepEqual([s.status, s.position, s.duration], ['loading', 30, 600]);
  s = ps.reduce(s, { type: 'playing' });
  assert.equal(s.status, 'playing');
  s = ps.reduce(s, { type: 'pause' });
  assert.equal(s.status, 'paused');
  s = ps.reduce(s, { type: 'resume' });
  assert.equal(s.status, 'loading');
  s = ps.reduce(s, { type: 'playing' });
  s = ps.reduce(s, { type: 'ended' });
  assert.deepEqual([s.status, s.position], ['ended', 600]);
});

test('ungültige Übergänge ändern nichts (gleiches Objekt)', () => {
  const idle = ps.createState();
  for (const type of ['playing', 'pause', 'resume', 'stop', 'ended', 'fail', 'time', 'seek']) assert.equal(ps.reduce(idle, { type, position: 5 }), idle, type);
  assert.equal(ps.reduce(idle, { type: 'select' }), idle);
  const p = playing();
  assert.equal(ps.reduce(p, { type: 'resume' }), p);
  assert.equal(ps.reduce(p, { type: 'playing' }), p);
  assert.equal(ps.reduce(p, { type: 'unbekannt' }), p);
  const ended = ps.reduce(p, { type: 'ended' });
  assert.equal(ps.reduce(ended, { type: 'time', position: 1 }), ended);
  assert.equal(ps.reduce(ended, { type: 'pause' }), ended);
});

test('stop und fail: stop räumt auf, fail behält Episode und Fehlertext', () => {
  const stopped = ps.reduce(playing(), { type: 'stop' });
  assert.deepEqual([stopped.status, stopped.episode, stopped.position, stopped.duration], ['idle', null, 0, 0]);
  const failed = ps.reduce(playing(), { type: 'fail', message: 'kaputt' });
  assert.deepEqual([failed.status, failed.error, failed.episode.episodeId], ['error', 'kaputt', 'e1']);
  assert.equal(ps.reduce(failed, { type: 'select', episode: EPISODE, position: 0 }).error, null);
});

test('time: Position begrenzt, Dauer aus dem Audio-Element nachgetragen', () => {
  let s = ps.reduce(ps.createState(), { type: 'select', episode: EPISODE, position: 0, duration: 0 });
  assert.equal(s.duration, 0);
  s = ps.reduce(s, { type: 'playing' });
  s = ps.reduce(s, { type: 'time', position: 12.5, duration: 300 });
  assert.deepEqual([s.position, s.duration], [12.5, 300]);
  s = ps.reduce(s, { type: 'time', position: 999 });
  assert.equal(s.position, 300, 'nie hinter der Dauer');
  s = ps.reduce(s, { type: 'time', position: -4 });
  assert.equal(s.position, 0);
  assert.equal(ps.reduce(s, { type: 'time', position: 0 }), s, 'unverändert: kein neues Objekt');
});

test('Tempo: 0,75–2 begrenzt und gerastert; Lautstärke 0–1', () => {
  assert.equal(ps.clampRate(0.1), 0.75);
  assert.equal(ps.clampRate(5), 2);
  assert.equal(ps.clampRate(1.26), 1.25);
  assert.equal(ps.clampRate('x'), 1);
  assert.equal(ps.clampRate(undefined), 1);
  assert.equal(ps.reduce(ps.createState(), { type: 'rate', value: 1.5 }).rate, 1.5);
  assert.equal(ps.reduce(ps.createState(), { type: 'rate', value: 9 }).rate, 2);
  assert.equal(ps.reduce(ps.createState(), { type: 'volume', value: 3 }).volume, 1);
  assert.equal(ps.reduce(ps.createState(), { type: 'volume', value: -1 }).volume, 0);
  assert.equal(ps.createState({ rate: 0.5 }).rate, 0.75);
});

test('Fortsetzungsregel: gespeicherte Position, außer bei gehört, ohne Position oder nahem Ende', () => {
  assert.equal(ps.resumePosition({ position: 120, duration: 600, played: false }), 120);
  assert.equal(ps.resumePosition({ position: 120, duration: 600, played: true }), 0, 'gehört: von vorn');
  assert.equal(ps.resumePosition({ position: 0, duration: 600, played: false }), 0);
  assert.equal(ps.resumePosition({ position: 590, duration: 600, played: false }), 0, 'Ende nahe (≤15 s): von vorn');
  assert.equal(ps.resumePosition({ position: 584, duration: 600, played: false }), 584);
  assert.equal(ps.resumePosition({ position: 580, duration: null, played: false }, 590), 0, 'Dauer aus Feed');
  assert.equal(ps.resumePosition({ position: 580, duration: null, played: false }), 580, 'ohne Dauer fortsetzen');
  assert.equal(ps.resumePosition(null), 0);
  assert.equal(ps.resumePosition({ position: -5 }), 0);
});

test('skipTarget: −15/+30 innerhalb [0, Dauer]', () => {
  const s = { ...playing(), position: 100, duration: 120 };
  assert.equal(ps.skipTarget(s, -15), 85);
  assert.equal(ps.skipTarget(s, 30), 120);
  assert.equal(ps.skipTarget({ ...s, position: 5 }, -15), 0);
});

test('publicState: flache Kopie mit gerundeten Sekunden', () => {
  const s = { ...playing(), position: 12.34, duration: 600.06 };
  const pub = ps.publicState(s);
  assert.deepEqual([pub.position, pub.duration], [12.3, 600.1]);
  pub.episode.title = 'x';
  assert.equal(s.episode.title, 'Folge');
});
