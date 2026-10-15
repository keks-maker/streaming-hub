'use strict';

// Tests P2: IPC-Validierung der Wiedergabe-Kanäle, Absenderprüfung, Player-Report-Whitelist (time/seek-Aktionen),
// Exklusivität Radio ↔ Podcast, Ton-Konflikt mit Bild, Keep-alive und Standby-Schutz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const v = require('../lib/ipc-validation.js');
const { registerPodcastIpc } = require('../lib/podcast/ipc.js');
const { exclusivityAction, attachExclusivity } = require('../lib/playback-exclusivity.js');
const { radioActionForVideoStart, podcastActionForVideoStart } = require('../radio-tv-conflict-model.js');
const { decideWindowAllClosed, radioKeepsAppAlive } = require('../lib/radio/keep-alive.js');
const { createPlaybackPowerGuard } = require('../lib/podcast/playback-power.js');

// ── Schema ──

test('podcast:play/seek/skip/rate: nur gültige Nutzlasten', () => {
  assert.deepEqual(v.validatePodcastPlay({ podcastId: 'p', episodeId: 'e' }), { podcastId: 'p', episodeId: 'e' });
  assert.deepEqual(v.validatePodcastPlay({ podcastId: 'p', episodeId: 'e', startPosition: 12.5 }), { podcastId: 'p', episodeId: 'e', startPosition: 12.5 });
  for (const bad of [null, 'x', [], {}, { podcastId: 'p' }, { podcastId: 'p', episodeId: 'e', url: 'https://x.test/a.mp3' }, { podcastId: 'p', episodeId: 'e', startPosition: -1 }, { podcastId: 'p', episodeId: 'e', startPosition: '5' }, { podcastId: 'p', episodeId: 'e', startPosition: Infinity }, { podcastId: 'p|q', episodeId: 'e' }]) {
    assert.throws(() => v.validatePodcastPlay(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(v.validatePodcastSeek(0), 0);
  assert.equal(v.validatePodcastSeek(3600.5), 3600.5);
  for (const bad of [-1, NaN, Infinity, '5', null, undefined, 48 * 3600 + 1]) assert.throws(() => v.validatePodcastSeek(bad), undefined, String(bad));
  assert.equal(v.validatePodcastSkip(-15), -15);
  assert.equal(v.validatePodcastSkip(30), 30);
  for (const bad of [0, NaN, 3601, -3601, '30', null]) assert.throws(() => v.validatePodcastSkip(bad), undefined, String(bad));
  for (const ok of [0.75, 1, 1.25, 2]) assert.equal(v.validatePodcastRate(ok), ok);
  for (const bad of [0.5, 2.1, 0, NaN, '1', null]) assert.throws(() => v.validatePodcastRate(bad), undefined, String(bad));
});

test('Player-Meldungen: time und seek-Aktionen werden normalisiert, Ungültiges verworfen', () => {
  assert.deepEqual(v.normalizeRadioPlayerReport({ t: 'time', seq: 2, position: 12.5, duration: 600, evil: 1 }), { t: 'time', seq: 2, position: 12.5, duration: 600 });
  assert.deepEqual(v.normalizeRadioPlayerReport({ t: 'time', seq: 2, position: 3, duration: NaN }), { t: 'time', seq: 2, position: 3 });
  assert.equal(v.normalizeRadioPlayerReport({ t: 'time', position: -1 }), null);
  assert.equal(v.normalizeRadioPlayerReport({ t: 'time' }), null);
  assert.deepEqual(v.normalizeRadioPlayerReport({ t: 'action', action: 'seekto', seekTime: 30 }), { t: 'action', action: 'seekto', seekTime: 30 });
  assert.equal(v.normalizeRadioPlayerReport({ t: 'action', action: 'seekto', seekTime: 'x' }), null);
  assert.equal(v.normalizeRadioPlayerReport({ t: 'action', action: 'seekto' }), null);
  assert.deepEqual(v.normalizeRadioPlayerReport({ t: 'action', action: 'seekforward', offset: 10 }), { t: 'action', action: 'seekforward', offset: 10 });
  assert.deepEqual(v.normalizeRadioPlayerReport({ t: 'action', action: 'seekbackward', offset: 99999 }), { t: 'action', action: 'seekbackward' });
  assert.equal(v.normalizeRadioPlayerReport({ t: 'action', action: 'format' }), null);
});

// ── IPC-Kanäle ──

function fakeController() {
  const calls = [];
  const emitter = new EventEmitter();
  const playerSender = { id: 'player' };
  return Object.assign(emitter, {
    calls,
    playerSender,
    play: async (key, start) => calls.push(['play', key, start]),
    pause: () => calls.push(['pause']),
    resume: () => calls.push(['resume']),
    stop: () => calls.push(['stop']),
    seek: p => calls.push(['seek', p]),
    skip: d => calls.push(['skip', d]),
    setRate: r => calls.push(['rate', r]),
    setVolume: x => calls.push(['volume', x]),
    getState: () => ({ status: 'idle' }),
    playerWebContents: () => playerSender,
    onPlayerReport: report => calls.push(['report', report]),
  });
}

function setupIpc() {
  const handlers = new Map();
  const listeners = new Map();
  const events = [];
  const mainSender = { id: 'main' };
  const controller = fakeController();
  registerPodcastIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => listeners.set(c, fn) },
    library: {},
    refresher: {},
    search: {},
    controller,
    requireMainRenderer: event => {
      if (event.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: (channel, payload) => events.push({ channel, payload }),
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender: mainSender }, ...args);
  return { handlers, listeners, call, controller, events, mainSender };
}

test('IPC: alle Wiedergabe-Kanäle validieren und rufen den Controller', async () => {
  const t = setupIpc();
  await t.call('podcast:play', { podcastId: 'p', episodeId: 'e', startPosition: 5 });
  await t.call('podcast:pause');
  await t.call('podcast:resume');
  await t.call('podcast:stop');
  await t.call('podcast:seek', 90);
  await t.call('podcast:skip', -15);
  await t.call('podcast:rate', 1.5);
  await t.call('podcast:volume', 0.4);
  assert.deepEqual(t.controller.calls, [['play', { podcastId: 'p', episodeId: 'e' }, 5], ['pause'], ['resume'], ['stop'], ['seek', 90], ['skip', -15], ['rate', 1.5], ['volume', 0.4]]);
  assert.deepEqual(await t.call('podcast:get-state'), { status: 'idle' });
});

test('IPC: ungültige Nutzlast wird abgelehnt, der Controller nicht berührt', async () => {
  const t = setupIpc();
  const bad = [['podcast:play', { podcastId: 'p', episodeId: 'e', enclosureUrl: 'https://x.test/a.mp3' }], ['podcast:play', 'p'], ['podcast:seek', -3], ['podcast:skip', 0], ['podcast:rate', 3], ['podcast:volume', 2], ['podcast:pause', 1], ['podcast:stop', {}], ['podcast:get-state', 1]];
  for (const [channel, ...args] of bad) assert.throws(() => t.call(channel, ...args), undefined, channel);
  assert.deepEqual(t.controller.calls, []);
});

test('IPC: Absenderprüfung für jeden Wiedergabe-Kanal', () => {
  const t = setupIpc();
  const channels = ['podcast:play', 'podcast:pause', 'podcast:resume', 'podcast:stop', 'podcast:seek', 'podcast:skip', 'podcast:rate', 'podcast:volume', 'podcast:get-state'];
  for (const channel of channels) {
    assert.ok(t.handlers.has(channel), channel);
    assert.throws(() => t.handlers.get(channel)({ sender: { id: 'fremd' } }), /nicht autorisiert/, channel);
  }
  assert.deepEqual(t.controller.calls, []);
});

test('IPC: Player-Meldungen nur vom Player-WebContents, normalisiert', () => {
  const t = setupIpc();
  const onReport = t.listeners.get('radio-player:report');
  onReport({ sender: { id: 'fremd' } }, { t: 'time', position: 5 });
  onReport({ sender: t.mainSender }, { t: 'time', position: 5 });
  assert.deepEqual(t.controller.calls, [], 'weder fremde Absender noch das Hauptfenster');
  onReport({ sender: t.controller.playerSender }, { t: 'time', seq: 1, position: 5, evil: 1 });
  onReport({ sender: t.controller.playerSender }, { t: 'kaputt' });
  assert.deepEqual(t.controller.calls, [['report', { t: 'time', seq: 1, position: 5 }]]);
});

test('IPC: Zustand und Gehört-Änderungen gehen als Events an das Hauptfenster', () => {
  const t = setupIpc();
  t.controller.emit('state', { status: 'playing' });
  t.controller.emit('listen-changed', { podcastId: 'p', episodeId: 'e', state: { played: true } });
  assert.deepEqual(t.events.map(e => e.channel), ['podcast:state', 'podcast:state-changed']);
});

test('IPC ohne Controller: keine Wiedergabe-Kanäle registriert (P1-Verhalten unverändert)', () => {
  const handlers = new Map();
  registerPodcastIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, library: {}, refresher: {}, search: {}, requireMainRenderer: () => {}, sendToMain: () => {} });
  assert.equal(handlers.has('podcast:play'), false);
  assert.equal(handlers.has('podcast:search'), true);
});

// ── Exklusivität ──

function fakePlayer(status = 'idle') {
  const player = Object.assign(new EventEmitter(), {
    status,
    stops: 0,
    isActive: () => ['loading', 'playing', 'paused'].includes(player.status),
    stop: () => {
      player.stops += 1;
      player.set('idle');
    },
    set: next => {
      player.status = next;
      player.emit('state', { status: next });
    },
  });
  return player;
}

test('Exklusivität (Regel): Start stoppt das andere, sonst nichts', () => {
  assert.equal(exclusivityAction('podcast', { status: 'loading' }, true), 'stop-other');
  assert.equal(exclusivityAction('podcast', { status: 'playing' }, true), 'stop-other');
  assert.equal(exclusivityAction('radio', { status: 'loading' }, true), 'stop-other');
  for (const status of ['paused', 'idle', 'ended', 'error']) assert.equal(exclusivityAction('podcast', { status }, true), 'none', status);
  assert.equal(exclusivityAction('podcast', { status: 'playing' }, false), 'none');
  assert.equal(exclusivityAction('video', { status: 'playing' }, true), 'none');
  assert.equal(exclusivityAction('radio', null, true), 'none');
});

test('Exklusivität: Podcast-Start stoppt Radio, Radio-Start stoppt Podcast (auch pausiert), keine Schleife', () => {
  const radio = fakePlayer('playing');
  const podcast = fakePlayer();
  const detach = attachExclusivity({ radio, podcast });
  podcast.set('loading');
  assert.deepEqual([radio.stops, radio.status, podcast.status], [1, 'idle', 'loading']);
  podcast.set('playing');
  podcast.set('paused');
  radio.set('loading');
  assert.deepEqual([podcast.stops, podcast.status, radio.status], [1, 'idle', 'loading'], 'pausierter Podcast wird beendet');
  assert.equal(radio.stops, 1);
  detach();
  podcast.set('playing');
  assert.equal(radio.status, 'loading', 'nach dem Lösen keine Wirkung');
});

// ── Ton-Konflikt mit Bild ──

test('Ton-Konflikt: Podcast pausiert bei Bildwiedergabe wie Radio (pauseOnTv)', () => {
  for (const status of ['playing', 'loading', 'paused', 'idle', 'ended', 'error']) {
    assert.equal(podcastActionForVideoStart({ status }, {}), radioActionForVideoStart({ status }, {}), status);
  }
  assert.equal(podcastActionForVideoStart({ status: 'playing' }, { pauseOnTv: true }), 'pause');
  assert.equal(podcastActionForVideoStart({ status: 'loading' }, undefined), 'stop');
  assert.equal(podcastActionForVideoStart({ status: 'playing' }, { pauseOnTv: false }), 'none');
  assert.equal(podcastActionForVideoStart(null, {}), 'none');
});

// ── Keep-alive ──

test('Keep-alive: aktiver Podcast hält die App im Tray (mit Option und Tray), sonst nicht', () => {
  const active = { isActive: () => true };
  const idle = { isActive: () => false };
  const base = { recorder: { activeJobs: () => [] }, scheduler: { hasPendingSchedules: () => false } };
  assert.deepEqual(decideWindowAllClosed({ ...base, radio: { controller: idle, hasTray: true }, podcast: { controller: active, hasTray: true } }), { quit: false, reason: 'podcast' });
  assert.deepEqual(decideWindowAllClosed({ ...base, radio: { controller: active, hasTray: true }, podcast: { controller: active, hasTray: true } }), { quit: false, reason: 'radio' });
  assert.deepEqual(decideWindowAllClosed({ ...base, radio: { controller: idle, hasTray: true }, podcast: { controller: active, hasTray: false } }), { quit: true, reason: null }, 'ohne Tray kein Weiterspielen');
  assert.deepEqual(decideWindowAllClosed({ ...base, radio: {}, podcast: { controller: active, hasTray: true, settings: { keepPlayingWhenClosed: false } } }), { quit: true, reason: null });
  assert.deepEqual(decideWindowAllClosed({ ...base, radio: {} }), { quit: true, reason: null }, 'ohne podcast-Eintrag unverändert');
  assert.equal(radioKeepsAppAlive({ controller: active, hasTray: true }), true);
});

// ── Standby-Schutz ──

test('Standby-Schutz: Blocker nur bei loading/playing, genau einmal, danach freigegeben', () => {
  const started = [];
  const stopped = [];
  const live = new Set();
  const powerSaveBlocker = {
    start: type => {
      started.push(type);
      live.add(started.length);
      return started.length;
    },
    stop: id => {
      stopped.push(id);
      live.delete(id);
    },
    isStarted: id => live.has(id),
  };
  const guard = createPlaybackPowerGuard({ powerSaveBlocker });
  guard.sync('idle');
  assert.equal(started.length, 0);
  guard.sync('loading');
  guard.sync('playing');
  assert.deepEqual(started, ['prevent-app-suspension']);
  assert.equal(guard.isHeld(), true);
  guard.sync('paused');
  assert.deepEqual(stopped, [1]);
  assert.equal(guard.isHeld(), false);
  guard.sync('playing');
  guard.release();
  assert.deepEqual([started.length, stopped.length, guard.isHeld()], [2, 2, false]);
  guard.release();
  assert.equal(stopped.length, 2, 'doppeltes Freigeben ist folgenlos');
});

test('Standby-Schutz: Fehler des Blockers werfen nicht', () => {
  const guard = createPlaybackPowerGuard({ powerSaveBlocker: { start: () => { throw new Error('nein'); }, stop: () => {}, isStarted: () => false } });
  assert.doesNotThrow(() => guard.sync('playing'));
});
