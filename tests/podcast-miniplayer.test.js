'use strict';

// Tests P2: Mini-Player im Podcast-Modus — Modell, Ansicht (Fake-DOM), Verdrahtung (renderer/index/preload/styles) und Player-Host.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mini = require('../radio-miniplayer-model.js');
const { createRadioMiniPlayer } = require('../radio-miniplayer-view.js');
const { makeDoc, makeFakeRadio } = require('./helpers/fake-dom.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const EPISODE = { podcastId: 'p1', episodeId: 'e1', title: 'Folge <b>1</b>', show: 'Sendung', cover: 'https://a.test/c.jpg', enclosureUrl: 'https://a.test/e.mp3' };
const ps = (status, extra = {}) => ({ status, episode: EPISODE, position: 125, duration: 3725, rate: 1, volume: 0.5, error: null, ...extra });
const IDLE = { status: 'idle', episode: null, position: 0, duration: 0, rate: 1, volume: 0.5, error: null };

// ── Modell ──

test('Modell: Sichtbarkeit nur bei aktiver Episode ohne Vollbild', () => {
  assert.equal(mini.podcastMiniPlayerModel(IDLE).visible, false);
  assert.equal(mini.podcastMiniPlayerModel(null).visible, false);
  for (const status of ['loading', 'playing', 'paused', 'ended', 'error']) assert.equal(mini.podcastMiniPlayerModel(ps(status)).visible, true, status);
  assert.equal(mini.podcastMiniPlayerModel(ps('playing'), { suppressed: true }).visible, false);
});

test('Modell: Sendung – Episode, Zeiten, Seek-Werte und aria-valuetext', () => {
  const m = mini.podcastMiniPlayerModel(ps('playing'));
  assert.deepEqual([m.name, m.subtitle], ['Sendung', 'Folge <b>1</b>']);
  assert.deepEqual([m.positionText, m.durationText, m.seekValue, m.seekMax, m.canSeek], ['2:05', '1:02:05', 125, 3725, true]);
  assert.equal(m.valueText, '2:05 von 1:02:05');
  assert.equal(m.cover, 'https://a.test/c.jpg');
  const unknown = mini.podcastMiniPlayerModel(ps('playing', { duration: 0 }));
  assert.deepEqual([unknown.canSeek, unknown.durationText, unknown.valueText], [false, '–:–', '2:05']);
});

test('Modell: Status, Play/Pause-Aktion und aria-live-Text', () => {
  const pick = status => {
    const m = mini.podcastMiniPlayerModel(ps(status, { error: 'kaputt' }));
    return [m.action, m.playPauseLabel, m.subtitle, m.live];
  };
  assert.deepEqual(pick('playing'), ['pause', 'Pause', 'Folge <b>1</b>', 'Sendung: spielt']);
  assert.deepEqual(pick('loading'), ['pause', 'Pause', 'Lädt … – Folge <b>1</b>', 'Sendung: lädt']);
  assert.deepEqual(pick('paused'), ['resume', 'Wiedergabe fortsetzen', 'Pausiert – Folge <b>1</b>', 'Sendung: pausiert']);
  assert.deepEqual(pick('ended'), ['replay', 'Erneut abspielen', 'Beendet – Folge <b>1</b>', 'Sendung: Episode beendet']);
  assert.deepEqual(pick('error'), ['retry', 'Erneut versuchen', 'kaputt', 'Sendung: Wiedergabe nicht möglich']);
  assert.equal(mini.podcastMiniPlayerModel(ps('error')).canSeek, false);
});

test('Modell: Tempo-Auswahl, Lautstärke begrenzt, nur https-Cover, Position nie hinter der Dauer', () => {
  assert.deepEqual(mini.PODCAST_RATES, [0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.equal(mini.podcastMiniPlayerModel(ps('playing', { rate: 1.5 })).rate, 1.5);
  assert.equal(mini.podcastMiniPlayerModel(ps('playing', { rate: 1.33 })).rate, 1);
  assert.equal(mini.podcastMiniPlayerModel(ps('playing', { volume: 7 })).volumePercent, 100);
  assert.equal(mini.podcastMiniPlayerModel(ps('playing', { episode: { ...EPISODE, cover: 'http://a.test/c.jpg' } })).cover, null);
  assert.equal(mini.podcastMiniPlayerModel(ps('playing', { episode: { ...EPISODE, cover: 'javascript:1' } })).cover, null);
  assert.equal(mini.podcastMiniPlayerModel(ps('playing', { position: 9999 })).seekValue, 3725);
  assert.equal(mini.rateLabel(1.25), '1,25×');
  assert.equal(mini.formatClock(NaN), '0:00');
});

test('Radio-Modell bleibt unverändert (keine Podcast-Felder)', () => {
  const m = mini.miniPlayerModel({ status: 'playing', station: { name: 'Eins', logo: null, genre: 'Pop' }, volume: 0.5, nowPlaying: null, error: null, reconnecting: false });
  assert.equal(m.visible, true);
  assert.equal(m.mode, undefined);
  assert.equal(m.subtitle, 'Pop');
});

// ── Ansicht ──

function setup({ radioState, withOpen = false } = {}) {
  const doc = makeDoc();
  const el = doc.createElement('div');
  const radio = makeFakeRadio({ state: radioState });
  const calls = [];
  const listeners = new Set();
  const player = {
    state: IDLE,
    getState: async () => player.state,
    onState: cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: next => {
      player.state = next;
      listeners.forEach(cb => cb(next));
    },
  };
  for (const name of ['play', 'pause', 'resume', 'stop', 'seek', 'skip', 'setRate', 'setVolume']) player[name] = async (...args) => calls.push([name, ...args]);
  const notes = [];
  createRadioMiniPlayer(el, { radio, podcasts: player, notify: m => notes.push(m), logger: { warn: () => {} }, onOpenRadio: () => {}, ...(withOpen ? { onOpenPodcast: () => {} } : {}) });
  return { el, radio, player, calls, notes };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Ansicht: Podcast zeigt Cover, Sendung, Episode (nur textContent), Fortschritt, Sprungtasten, Tempo', async () => {
  const { el, player } = setup();
  await tick();
  assert.equal(el.hidden, true);
  player.emit(ps('playing'));
  assert.equal(el.hidden, false);
  assert.equal(el.dataset.mode, 'podcast');
  assert.equal(el.getAttribute('aria-label'), 'Podcast-Wiedergabe');
  assert.equal(el.byClass('radio-mini-name')[0].textContent, 'Sendung');
  assert.equal(el.byClass('radio-mini-subtitle')[0].textContent, 'Folge <b>1</b>', 'Feed-Text bleibt Text');
  const seek = el.byId('radioMiniSeek');
  assert.deepEqual([seek.max, seek.value, seek.getAttribute('aria-valuenow'), seek.getAttribute('aria-valuetext')], ['3725', '125', '125', '2:05 von 1:02:05']);
  assert.equal(el.byId('radioMiniPosition').textContent, '2:05');
  assert.equal(el.byId('radioMiniDuration').textContent, '1:02:05');
  assert.equal(el.byClass('radio-mini-progress')[0].hidden, false);
  assert.equal(el.byId('radioMiniSkipBack').hidden, false);
  assert.equal(el.byId('radioMiniPrev').hidden, true);
  assert.equal(el.byId('radioMiniNext').hidden, true);
  assert.equal(el.byId('radioMiniRate').children.length, 6);
  assert.equal(el.byId('radioMiniLive').textContent, 'Sendung: spielt');
  assert.equal(el.byId('radioMiniStop').getAttribute('aria-label'), 'Podcast stoppen');
  assert.equal(el.byId('radioMiniInfo').disabled, true, 'ohne Ziel (P3) keine Navigation');
});

test('Ansicht: Bedienung ruft die Podcast-Schnittstelle (Pause, Sprünge, Tempo, Lautstärke, Stopp, Seek)', async () => {
  const { el, player, calls } = setup();
  player.emit(ps('playing'));
  el.byId('radioMiniPlayPause').click();
  el.byId('radioMiniSkipBack').click();
  el.byId('radioMiniSkipForward').click();
  el.byId('radioMiniStop').click();
  const rate = el.byId('radioMiniRate');
  rate.value = '1.5';
  rate.dispatch('change');
  const volume = el.byId('radioMiniVolume');
  volume.value = '30';
  volume.dispatch('input');
  const seek = el.byId('radioMiniSeek');
  seek.value = '600';
  seek.dispatch('change');
  await tick();
  assert.deepEqual(calls, [['pause'], ['skip', -15], ['skip', 30], ['stop'], ['setRate', 1.5], ['setVolume', 0.3], ['seek', 600]]);
  assert.equal(el.byId('radioMiniVolume').getAttribute('aria-label'), 'Podcast-Lautstärke');
});

test('Ansicht: Play/Pause je Status (Fortsetzen, erneut abspielen, erneut versuchen)', async () => {
  const { el, player, calls } = setup();
  player.emit(ps('paused'));
  el.byId('radioMiniPlayPause').click();
  player.emit(ps('ended'));
  el.byId('radioMiniPlayPause').click();
  player.emit(ps('error'));
  el.byId('radioMiniPlayPause').click();
  await tick();
  assert.deepEqual(calls, [['resume'], ['play', { podcastId: 'p1', episodeId: 'e1' }], ['play', { podcastId: 'p1', episodeId: 'e1' }]]);
});

test('Ansicht: Seek per Tastatur (Pfeile ±5 s, Pos1/Ende), natives Verhalten verhindert', async () => {
  const { el, player, calls } = setup();
  player.emit(ps('playing'));
  const seek = el.byId('radioMiniSeek');
  const prevented = [];
  const key = k => seek.dispatch('keydown', { key: k, preventDefault: () => prevented.push(k) });
  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'a'].forEach(key);
  await tick();
  assert.deepEqual(calls, [['skip', -5], ['skip', 5], ['skip', 5], ['skip', -5], ['seek', 0], ['seek', 3725]]);
  assert.equal(prevented.length, 6, 'nur die belegten Tasten');
  let stopped = 0;
  el.dispatch('keydown', { key: 'ArrowRight', stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 1, 'kein Seitenkürzel dahinter');
});

test('Ansicht: ohne Dauer ist Seek gesperrt; Statuswechsel melden sich über aria-live', async () => {
  const { el, player } = setup();
  player.emit(ps('loading', { duration: 0, position: 0 }));
  assert.equal(el.byId('radioMiniSeek').disabled, true);
  assert.equal(el.byId('radioMiniSkipBack').disabled, true);
  assert.equal(el.byId('radioMiniLive').textContent, 'Sendung: lädt');
  player.emit(ps('paused'));
  assert.equal(el.byId('radioMiniLive').textContent, 'Sendung: pausiert');
  assert.equal(el.byId('radioMiniSeek').disabled, false);
});

test('Ansicht: nach Podcast wieder Radio unverändert; Radio-Bedienung ruft window.radio', async () => {
  const station = { sourceId: 'a', id: 'one', name: 'Eins', logo: null, genre: 'Pop' };
  const { el, radio, player } = setup({ radioState: { status: 'playing', station, volume: 0.5, nowPlaying: null, error: null, reconnecting: false } });
  await tick();
  assert.equal(el.dataset.mode, 'radio');
  assert.equal(el.byId('radioMiniSkipBack').hidden, true);
  assert.equal(el.byId('radioMiniPrev').hidden, false);
  assert.equal(el.byClass('radio-mini-progress')[0].hidden, true);
  assert.equal(el.byClass('radio-mini-name')[0].textContent, 'Eins');
  player.emit(ps('playing'));
  assert.equal(el.dataset.mode, 'podcast');
  player.emit(IDLE);
  assert.equal(el.dataset.mode, 'radio');
  assert.equal(el.byClass('radio-mini-name')[0].textContent, 'Eins');
  el.byId('radioMiniStop').click();
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['stop']);
  assert.equal(el.byId('radioMiniStop').getAttribute('aria-label'), 'Radio stoppen');
});

test('Ansicht: Podcast-Seite öffnen nur mit Ziel (P3)', async () => {
  const { el, player } = setup({ withOpen: true });
  player.emit(ps('playing'));
  assert.equal(el.byId('radioMiniInfo').disabled, false);
});

// ── Verdrahtung ──

test('Verdrahtung: preload.player, renderer (Vollbild/Konflikt), index.html, CSS (reduced motion), kein innerHTML mit Daten', () => {
  const preload = read('preload.js');
  for (const channel of ['podcast:play', 'podcast:pause', 'podcast:resume', 'podcast:stop', 'podcast:seek', 'podcast:skip', 'podcast:rate', 'podcast:volume', 'podcast:get-state', 'podcast:state']) {
    assert.ok(preload.includes(`'${channel}'`), channel);
  }
  assert.match(preload, /player: \{/);
  const renderer = read('renderer.js');
  assert.match(renderer, /podcasts: window\.podcasts\.player/);
  assert.match(renderer, /podcastActionForVideoStart/);
  assert.match(renderer, /async function pauseRadioForVideo\(\) \{\s*pausePodcastForVideo\(\);/);
  assert.match(renderer, /radioMiniPlayerView\.setSuppressed\(htmlFullscreenActive \|\| Boolean\(document\.fullscreenElement\)\)/);
  assert.match(read('index.html'), /id="radioMiniPlayer" hidden/);
  const css = read('styles.css');
  assert.match(css, /\.radio-miniplayer\[data-mode="podcast"\]/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*\.radio-mini-btn \{ transition:none; \}/);
  for (const file of ['radio-miniplayer-view.js', 'radio-miniplayer-model.js']) {
    const lines = read(file).split('\n').filter(line => /innerHTML/.test(line) && !/^\s*\/\//.test(line));
    for (const line of lines) assert.match(line, /ICONS\[|SVG|statisches SVG/, `${file}: ${line.trim()}`);
  }
});

test('Player-Host: Datei-Modus mit Seek, Tempo, gedrosselten Zeitmeldungen, mediaSession; Radiopfad unverändert', () => {
  const host = read('radio-player.js');
  assert.match(host, /command\.mode === 'file'/);
  assert.match(host, /TIME_REPORT_INTERVAL_MS = 1000/);
  assert.match(host, /t: 'time'/);
  assert.match(host, /setPositionState/);
  assert.match(host, /'seekbackward', 'seekforward', 'seekto'/);
  assert.match(host, /playbackRate/);
  assert.match(host, /command\.cmd === 'seek'/);
  assert.match(host, /artwork/);
  assert.match(host, /audio\.addEventListener\('ended'/);
  assert.match(host, /\['play', 'pause', 'stop', 'nexttrack', 'previoustrack'\]/);
  assert.match(host, /else if \(command\.kind === 'hls'\)/);
  assert.match(read('radio-player.html'), /img-src http: https:/);
});

test('main.js: PodcastController, Exklusivität, Standby-Schutz, Keep-alive und Beenden verdrahtet', () => {
  const main = read('main.js');
  assert.match(main, /new PodcastController\(/);
  assert.match(main, /attachExclusivity\(\{ radio: radioController, podcast: podcastController/);
  assert.match(main, /createPlaybackPowerGuard\(\{ powerSaveBlocker/);
  assert.match(main, /podcast: podcastKeepAliveContext\(\)/);
  assert.match(main, /podcastController\.dispose\(\)/);
});
