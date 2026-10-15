'use strict';

// Tests: PodcastController (lib/podcast/PodcastController.js) mit Attrappen für Fenster, Timer und Bibliothek.
// Hörzustand über die echte podcast-state-Logik (95 %-Regel). Es öffnet sich nie ein echtes Fenster.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PodcastController } = require('../lib/podcast/PodcastController.js');
const listenState = require('../lib/podcast/podcast-state.js');
const { ManualTimers, createFakeWindowClass } = require('./helpers/radio-fakes.js');

const SUB = { id: 'p1', title: 'Sendung', cover: 'https://a.test/show.jpg' };
const EPISODES = [
  { id: 'e1', title: 'Folge 1', audioUrl: 'https://a.test/e1.mp3', duration: 600, cover: null },
  { id: 'e2', title: 'Folge 2', audioUrl: 'http://a.test/e2.mp3', duration: null, cover: 'https://a.test/e2.jpg' },
  { id: 'e3', title: 'Folge 3', audioUrl: 'ftp://a.test/e3.mp3', duration: 60 },
];

function setup({ initial } = {}) {
  const { FakeWindow, instances } = createFakeWindowClass();
  const timers = new ManualTimers();
  let state = listenState.normalizeState(initial || {});
  const saves = [];
  const library = {
    getSubscription: id => (id === SUB.id ? SUB : null),
    getCachedFeed: id => ({ episodes: id === SUB.id ? EPISODES : [] }),
    getEpisodeState: (p, e) => listenState.getEpisodeState(state, p, e),
    savePosition: (p, e, progress) => {
      saves.push({ p, e, ...progress });
      state = listenState.savePosition(state, p, e, progress, new Date('2026-10-15T10:00:00Z'));
      return listenState.getEpisodeState(state, p, e);
    },
  };
  const controller = new PodcastController({ BrowserWindow: FakeWindow, playerHtml: '/app/radio-player.html', preloadPath: '/app/preload-radio.js', library, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const events = [];
  controller.on('state', s => events.push(s));
  const listens = [];
  controller.on('listen-changed', e => listens.push(e));
  const win = () => instances[instances.length - 1];
  const cmds = name => win().commands().filter(c => c.cmd === name);
  const KEY = { podcastId: 'p1', episodeId: 'e1' };
  /** Startet bis "playing" (Player bereit, Host meldet playing). */
  const startPlaying = async (key = KEY, start) => {
    await controller.play(key, start);
    controller.onPlayerReport({ t: 'ready' });
    const seq = cmds('play').at(-1).seq;
    controller.onPlayerReport({ t: 'playing', seq });
    return seq;
  };
  return { controller, timers, saves, instances, win, cmds, events, listens, startPlaying, KEY, saved: (p, e) => listenState.getEpisodeState(state, p, e) };
}

test('play: Befehl an den Host mit URL, Startposition, Tempo; Cover und Titel als Metadaten', async () => {
  const t = setup();
  const result = await t.controller.play(t.KEY);
  assert.equal(result.status, 'loading');
  assert.equal(t.instances.length, 1);
  assert.equal(t.win().options.webPreferences.sandbox, true);
  assert.equal(t.win().options.show, false);
  t.controller.onPlayerReport({ t: 'ready' }); // zwischengespeicherte Befehle werden zugestellt
  const play = t.cmds('play')[0];
  assert.deepEqual([play.mode, play.url, play.start, play.rate, play.volume], ['file', 'https://a.test/e1.mp3', 0, 1, 0.8]);
  const meta = t.cmds('meta')[0];
  assert.deepEqual([meta.title, meta.artist, meta.artwork], ['Folge 1', 'Sendung', 'https://a.test/show.jpg']);
  assert.deepEqual(t.controller.getState().episode, { podcastId: 'p1', episodeId: 'e1', title: 'Folge 1', show: 'Sendung', cover: 'https://a.test/show.jpg', enclosureUrl: 'https://a.test/e1.mp3' });
  t.controller.onPlayerReport({ t: 'playing', seq: play.seq });
  assert.equal(t.controller.getState().status, 'playing');
});

test('play: unbekanntes Abo/Episode und nicht-http-Audio werden abgelehnt', async () => {
  const t = setup();
  await assert.rejects(() => t.controller.play({ podcastId: 'x', episodeId: 'e1' }), /Abo/);
  await assert.rejects(() => t.controller.play({ podcastId: 'p1', episodeId: 'nope' }), /Episode/);
  await assert.rejects(() => t.controller.play({ podcastId: 'p1', episodeId: 'e3' }), /Audio-Adresse/);
  assert.equal(t.controller.getState().status, 'idle');
  assert.equal(t.instances.length, 0, 'kein Fenster ohne gültige Episode');
});

test('Fortsetzen: gespeicherte Position; von vorn bei gehört und nahem Ende; explizite Startposition gewinnt', async () => {
  const t = setup({ initial: { episodes: { 'p1|e1': { position: 200, duration: 600, played: false, updatedAt: '2026-10-01T00:00:00Z' } } } });
  await t.controller.play(t.KEY);
  assert.equal(t.controller.getState().position, 200);
  t.controller.stop();
  await t.controller.play(t.KEY, 42);
  assert.equal(t.controller.getState().position, 42);
  t.controller.stop();

  const played = setup({ initial: { episodes: { 'p1|e1': { position: 200, duration: 600, played: true, updatedAt: '2026-10-01T00:00:00Z' } } } });
  await played.controller.play(played.KEY);
  assert.equal(played.controller.getState().position, 0);

  const near = setup({ initial: { episodes: { 'p1|e1': { position: 595, duration: 600, played: false, updatedAt: '2026-10-01T00:00:00Z' } } } });
  await near.controller.play(near.KEY);
  assert.equal(near.controller.getState().position, 0);
});

test('Position wird bei Pause, Stopp und alle 10 s gespeichert', async () => {
  const t = setup();
  await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq: t.cmds('play')[0].seq, position: 25, duration: 600 });
  assert.equal(t.timers.pending(10000), 1, 'Speichertakt läuft beim Spielen');
  await t.timers.fire(10000);
  assert.equal(t.saves.length, 1);
  assert.equal(t.saved('p1', 'e1').position, 25);
  assert.equal(t.timers.pending(10000), 1, 'Takt setzt sich fort');
  t.controller.onPlayerReport({ t: 'time', seq: t.cmds('play')[0].seq, position: 70, duration: 600 });
  t.controller.pause();
  assert.equal(t.saved('p1', 'e1').position, 70);
  assert.equal(t.timers.pending(10000), 0, 'in der Pause kein Takt');
  assert.equal(t.cmds('pause').length, 1);
  t.controller.resume();
  assert.equal(t.controller.getState().status, 'loading');
  assert.equal(t.cmds('resume').length, 1);
  t.controller.onPlayerReport({ t: 'time', seq: t.cmds('play')[0].seq, position: 90 });
  t.controller.stop();
  assert.equal(t.saved('p1', 'e1').position, 90);
  assert.equal(t.controller.getState().status, 'idle');
  assert.equal(t.win().closed, true);
});

test('Dauer aus dem Audio-Element wird übernommen und mitgespeichert, wenn der Feed keine liefert', async () => {
  const t = setup();
  const seq = await t.startPlaying({ podcastId: 'p1', episodeId: 'e2' });
  assert.equal(t.controller.getState().duration, 0);
  t.controller.onPlayerReport({ t: 'time', seq, position: 5, duration: 1800.4 });
  assert.equal(t.controller.getState().duration, 1800.4);
  t.controller.pause();
  assert.equal(t.saved('p1', 'e2').duration, 1800);
});

test('Auto-„gehört“ ab 95 %: Event listen-changed, Position wird auf 0 zurückgesetzt', async () => {
  const t = setup();
  const seq = await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq, position: 569, duration: 600 }); // 94,8 %
  t.controller.pause();
  assert.equal(t.saved('p1', 'e1').played, false);
  assert.equal(t.listens.length, 0);
  t.controller.resume();
  t.controller.onPlayerReport({ t: 'time', seq, position: 570, duration: 600 }); // 95 %
  t.controller.pause();
  assert.equal(t.saved('p1', 'e1').played, true);
  assert.equal(t.listens.length, 1);
  assert.deepEqual([t.listens[0].podcastId, t.listens[0].episodeId, t.listens[0].state.played], ['p1', 'e1', true]);
});

test('Ende: Status ended, Position = Dauer gespeichert (gehört), Fenster frei, keine Wiederverbindung', async () => {
  const t = setup();
  const seq = await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq, position: 590, duration: 600 });
  t.controller.onPlayerReport({ t: 'ended', seq });
  const state = t.controller.getState();
  assert.deepEqual([state.status, state.position], ['ended', 600]);
  assert.equal(t.saved('p1', 'e1').played, true);
  assert.equal(t.win().closed, true);
  assert.equal(t.instances.length, 1, 'kein neues Fenster');
  assert.equal(t.timers.pending(), 0);
  assert.equal(t.controller.isActive(), false);
  // erneut abspielen beginnt von vorn
  t.controller.resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.controller.getState().status, 'loading');
  assert.equal(t.controller.getState().position, 0);
});

test('Fehler des Hosts: Status error, Position gesichert, kein Wiederverbinden', async () => {
  const t = setup();
  const seq = await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq, position: 33, duration: 600 });
  t.controller.onPlayerReport({ t: 'error', seq, code: 4, fatal: true, message: '' });
  const state = t.controller.getState();
  assert.deepEqual([state.status, state.error], ['error', 'Format nicht unterstützt']);
  assert.equal(t.saved('p1', 'e1').position, 33);
  assert.equal(t.timers.pending(), 0);
  assert.equal(t.instances.length, 1);
});

test('veraltete Sitzung (seq) wird verworfen; Episodenwechsel sichert die vorige Position', async () => {
  const t = setup();
  const oldSeq = await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq: oldSeq, position: 77, duration: 600 });
  await t.controller.play({ podcastId: 'p1', episodeId: 'e2' });
  assert.equal(t.saved('p1', 'e1').position, 77);
  t.controller.onPlayerReport({ t: 'ended', seq: oldSeq });
  t.controller.onPlayerReport({ t: 'error', seq: oldSeq, code: 4 });
  assert.equal(t.controller.getState().status, 'loading', 'alte Meldungen ändern nichts');
  assert.equal(t.controller.getState().episode.episodeId, 'e2');
});

test('dieselbe Episode: laufende nicht neu gestartet, pausierte fortgesetzt', async () => {
  const t = setup();
  await t.startPlaying();
  await t.controller.play(t.KEY);
  assert.equal(t.cmds('play').length, 1);
  t.controller.pause();
  await t.controller.play(t.KEY);
  assert.equal(t.cmds('play').length, 1);
  assert.equal(t.cmds('resume').length, 1);
});

test('seek, skip, Tempo, Lautstärke: Zustand und Befehle an den Host', async () => {
  const t = setup();
  await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq: t.cmds('play')[0].seq, position: 100, duration: 600 });
  t.controller.skip(-15);
  assert.equal(t.controller.getState().position, 85);
  t.controller.skip(30);
  assert.equal(t.controller.getState().position, 115);
  t.controller.seek(9999);
  assert.equal(t.controller.getState().position, 600, 'auf die Dauer begrenzt');
  t.controller.seek(-5);
  assert.equal(t.controller.getState().position, 0);
  assert.deepEqual(t.cmds('seek').map(c => c.position), [85, 115, 600, 0]);
  t.controller.setRate(1.5);
  t.controller.setRate(9);
  assert.deepEqual(t.cmds('rate').map(c => c.rate), [1.5, 2]);
  t.controller.setVolume(0.3);
  assert.equal(t.cmds('volume').at(-1).volume, 0.3);
  assert.equal(t.controller.getState().volume, 0.3);
});

test('ohne Wiedergabe: Lautstärke/Tempo öffnen kein Player-Fenster', () => {
  const t = setup();
  t.controller.setVolume(0.5);
  t.controller.setRate(1.25);
  t.controller.pause();
  t.controller.seek(10);
  assert.equal(t.instances.length, 0);
  assert.deepEqual([t.controller.getState().volume, t.controller.getState().rate], [0.5, 1.25]);
});

test('Medientasten: seekto/seekbackward/seekforward/pause/play über action-Meldungen', async () => {
  const t = setup();
  await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq: t.cmds('play')[0].seq, position: 100, duration: 600 });
  t.controller.onPlayerReport({ t: 'action', action: 'seekto', seekTime: 300 });
  assert.equal(t.controller.getState().position, 300);
  t.controller.onPlayerReport({ t: 'action', action: 'seekbackward' });
  assert.equal(t.controller.getState().position, 285);
  t.controller.onPlayerReport({ t: 'action', action: 'seekforward', offset: 10 });
  assert.equal(t.controller.getState().position, 295);
  t.controller.onPlayerReport({ t: 'action', action: 'pause' });
  assert.equal(t.controller.getState().status, 'paused');
  t.controller.onPlayerReport({ t: 'action', action: 'play' });
  assert.equal(t.controller.getState().status, 'loading');
});

test('Player-Fenster geht verloren: Fehler statt Wiederverbinden, Position gesichert', async () => {
  const t = setup();
  const seq = await t.startPlaying();
  t.controller.onPlayerReport({ t: 'time', seq, position: 12, duration: 600 });
  t.win().close();
  assert.equal(t.controller.getState().status, 'error');
  assert.equal(t.saved('p1', 'e1').position, 12);
});

test('isActive/isPlaying und dispose', async () => {
  const t = setup();
  assert.equal(t.controller.isActive(), false);
  await t.startPlaying();
  assert.deepEqual([t.controller.isActive(), t.controller.isPlaying()], [true, true]);
  t.controller.onPlayerReport({ t: 'time', seq: t.cmds('play')[0].seq, position: 5, duration: 600 });
  t.controller.pause();
  assert.deepEqual([t.controller.isActive(), t.controller.isPlaying()], [true, false]);
  t.controller.dispose();
  assert.equal(t.saved('p1', 'e1').position, 5);
  assert.equal(t.controller.listenerCount('state'), 0);
});
