'use strict';

// Tests: RadioController (lib/radio/RadioController.js) mit Attrappen für Fenster, Timer, Netz und Bibliothek.
// Es öffnet sich nie ein echtes Fenster (kein Fokusklau, STREAMING_HUB_E2E_BACKGROUND nicht nötig).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers');
const { RadioController } = require('../lib/radio/RadioController.js');
const { ManualTimers, createFakeWindowClass, createFakeLibrary } = require('./helpers/radio-fakes.js');

const STATIONS = [
  { sourceId: 's', id: 'a', name: 'Alpha', streamUrl: 'http://a.test/stream', logo: null, genre: 'Pop' },
  { sourceId: 's', id: 'b', name: 'Beta', streamUrl: 'http://b.test/stream', logo: null, genre: null },
  { sourceId: 's', id: 'c', name: 'Gamma', streamUrl: 'http://c.test/stream', logo: null, genre: null },
];
const FAVORITES = [{ sourceId: 's', id: 'a' }, { sourceId: 's', id: 'b' }];
const KEY_A = { sourceId: 's', stationId: 'a' };

function setup({ resolve, icy, settings } = {}) {
  const { FakeWindow, instances } = createFakeWindowClass();
  const timers = new ManualTimers();
  const library = createFakeLibrary({ stations: STATIONS, favorites: FAVORITES, settings });
  const resolved = [];
  const controller = new RadioController({
    BrowserWindow: FakeWindow,
    playerHtml: '/app/radio-player.html',
    preloadPath: '/app/preload-radio.js',
    library,
    resolveStream:
      resolve ||
      (async url => {
        resolved.push(url);
        return { streamUrl: `${url}?resolved`, kind: 'direct', contentType: 'audio/mpeg', via: [] };
      }),
    readIcyTitle: icy || (async () => ({ title: 'Lied', artist: 'Band', raw: 'Band - Lied', icyName: 'x', metaint: 16000 })),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    icyIntervalMs: 25000,
  });
  const states = [];
  controller.on('state', s => states.push(s));
  const win = () => instances[instances.length - 1];
  const seq = () => win().commands().find(c => c.cmd === 'play').seq;
  /** Startet Wiedergabe bis "playing" */
  const startPlaying = async (key = KEY_A) => {
    await controller.play(key);
    await controller.connecting;
    controller.onPlayerReport({ t: 'ready' });
    const play = win().commands().filter(c => c.cmd === 'play').at(-1);
    controller.onPlayerReport({ t: 'playing', seq: play.seq });
    return play;
  };
  return { controller, instances, timers, library, resolved, states, win, seq, startPlaying };
}

test('Player-Fenster: unsichtbar, ohne Drosselung, sandboxed, Autoplay erlaubt — und erst beim Abspielen', async () => {
  const { controller, instances } = setup();
  assert.equal(instances.length, 0, 'kein Fenster vor dem ersten Abspielen');
  await controller.play(KEY_A);
  await controller.connecting;
  assert.equal(instances.length, 1);
  const { options, loaded } = instances[0];
  assert.equal(options.show, false);
  assert.equal(options.webPreferences.backgroundThrottling, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.autoplayPolicy, 'no-user-gesture-required');
  assert.equal(options.webPreferences.preload, '/app/preload-radio.js');
  assert.equal(loaded, '/app/radio-player.html');
});

test('play: loading, Auflösung, Befehl erst nach "ready" des Players, dann playing', async () => {
  const { controller, states, win, resolved } = setup();
  const result = await controller.play(KEY_A);
  assert.equal(result.status, 'loading');
  assert.equal(states[0].station.name, 'Alpha');
  await controller.connecting;
  assert.deepEqual(resolved, ['http://a.test/stream']);
  assert.deepEqual(win().commands(), [], 'vor ready wird nichts gesendet');
  controller.onPlayerReport({ t: 'ready' });
  const [play] = win().commands();
  assert.equal(play.cmd, 'play');
  assert.equal(play.url, 'http://a.test/stream?resolved');
  assert.equal(play.kind, 'direct');
  assert.equal(play.volume, 0.8);
  controller.onPlayerReport({ t: 'playing', seq: play.seq });
  assert.equal(controller.getState().status, 'playing');
  assert.equal(controller.isPlaying(), true);
});

test('Zustand veröffentlicht keine Stream-URL', async () => {
  const { controller, states } = setup();
  await controller.play(KEY_A);
  assert.equal(JSON.stringify(states).includes('a.test'), false);
});

test('unbekannter Sender und fehlendes Argument ohne Favoriten werfen', async () => {
  const { controller } = setup();
  await assert.rejects(controller.play({ sourceId: 's', stationId: 'zz' }), /Sender nicht gefunden/);
  const empty = new RadioController({
    BrowserWindow: createFakeWindowClass().FakeWindow,
    library: createFakeLibrary({ stations: STATIONS, favorites: [] }),
  });
  await assert.rejects(empty.play(), /Kein Sender ausgewählt/);
});

test('play ohne Argument: letzter Sender aus den Einstellungen, sonst erster Favorit', async () => {
  const last = setup({ settings: { lastStation: { sourceId: 's', id: 'c' } } });
  await last.controller.play();
  assert.equal(last.controller.getState().station.id, 'c');
  const fresh = setup();
  await fresh.controller.play();
  assert.equal(fresh.controller.getState().station.id, 'a');
});

test('Sendername/Pfad: letzter Sender wird gespeichert', async () => {
  const { controller, library } = setup();
  await controller.play({ sourceId: 's', stationId: 'b' });
  assert.deepEqual(library.calls.updateSettings, [{ lastStation: { sourceId: 's', id: 'b' } }]);
});

test('ICY: Now Playing nach "playing", Wiederholung nach Intervall, Titelwechsel wird gemeldet', async () => {
  let n = 0;
  const titles = [
    { title: 'Eins', artist: 'A', metaint: 16000 },
    { title: 'Zwei', artist: 'B', metaint: 16000 },
  ];
  const { controller, timers, states, win, startPlaying } = setup({ icy: async () => titles[Math.min(n++, 1)] });
  await startPlaying();
  await timers.fire(0); // erste Abfrage
  assert.deepEqual(controller.getState().nowPlaying, { title: 'Eins', artist: 'A' });
  assert.equal(timers.pending(25000), 1, 'nächste Abfrage geplant');
  await timers.fire(25000);
  assert.deepEqual(controller.getState().nowPlaying, { title: 'Zwei', artist: 'B' });
  const meta = win().commands().filter(c => c.cmd === 'meta');
  assert.ok(meta.some(m => m.title === 'Zwei' && m.artist === 'B' && m.album === 'Alpha'));
  assert.ok(states.filter(s => s.nowPlaying).length >= 2);
});

test('ICY: gleicher Titel löst kein neues Zustandsereignis aus', async () => {
  const { controller, timers, states, startPlaying } = setup();
  await startPlaying();
  await timers.fire(0);
  const count = states.length;
  await timers.fire(25000);
  assert.equal(states.length, count);
  assert.equal(controller.getState().nowPlaying.title, 'Lied');
});

test('ICY: Sender ohne ICY (metaint 0) wird nicht weiter abgefragt; Abfragefehler sind kein Fehlerzustand', async () => {
  const none = setup({ icy: async () => ({ title: '', artist: '', metaint: 0 }) });
  await none.startPlaying();
  await none.timers.fire(0);
  assert.equal(none.timers.pending(), 0);
  assert.equal(none.controller.getState().nowPlaying, null);

  const failing = setup({
    icy: async () => {
      throw new Error('kaputt');
    },
  });
  await failing.startPlaying();
  await failing.timers.fire(0);
  assert.equal(failing.controller.getState().status, 'playing');
  assert.equal(failing.timers.pending(25000), 1, 'bei Fehler später erneut versuchen');
});

test('HLS: kein ICY-Abruf', async () => {
  let icyCalls = 0;
  const { startPlaying, timers } = setup({
    resolve: async url => ({ streamUrl: url, kind: 'hls', contentType: 'application/vnd.apple.mpegurl', via: [] }),
    icy: async () => {
      icyCalls += 1;
      return {};
    },
  });
  const play = await startPlaying();
  assert.equal(play.kind, 'hls');
  assert.equal(timers.pending(), 0);
  assert.equal(icyCalls, 0);
});

test('pause: Verbindung und Player-Fenster werden freigegeben, resume verbindet neu', async () => {
  const { controller, instances, startPlaying, timers, resolved } = setup();
  await startPlaying();
  controller.pause();
  assert.equal(controller.getState().status, 'paused');
  assert.equal(instances[0].closed, true);
  assert.equal(timers.pending(), 0, 'ICY-Timer gestoppt');
  assert.equal(controller.isActive(), true);
  assert.equal(controller.isPlaying(), false);
  await controller.play(); // ohne Argument: fortsetzen
  await controller.connecting;
  assert.equal(controller.getState().status, 'loading');
  assert.equal(instances.length, 2, 'neues Player-Fenster');
  assert.equal(resolved.length, 2, 'neu aufgelöst (Tokens können ablaufen)');
});

test('pause ist nur im Zustand playing wirksam', async () => {
  const { controller } = setup();
  assert.equal(controller.pause().status, 'idle');
  assert.equal(controller.resume().status, 'idle');
});

test('stop: idle, Fenster zu, Timer weg; Sender bleibt als letzter Sender', async () => {
  const { controller, instances, timers, startPlaying } = setup();
  await startPlaying();
  controller.stop();
  const state = controller.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.station.id, 'a');
  assert.equal(instances[0].closed, true);
  assert.equal(timers.pending(), 0);
  assert.equal(controller.isActive(), false);
  assert.equal(controller.playerWebContents(), null);
});

test('Sitzungen: Ergebnis einer überholten Auflösung wird verworfen', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let calls = 0;
  const { controller, win, instances } = setup({
    resolve: async url => {
      calls += 1;
      if (calls === 1) await gate;
      return { streamUrl: `${url}?r${calls}`, kind: 'direct', via: [] };
    },
  });
  await controller.play(KEY_A);
  const first = controller.connecting;
  await controller.play({ sourceId: 's', stationId: 'b' });
  await controller.connecting;
  release();
  await first;
  controller.onPlayerReport({ t: 'ready' });
  const plays = win().commands().filter(c => c.cmd === 'play');
  assert.equal(plays.length, 1);
  assert.equal(plays[0].url, 'http://b.test/stream?r2');
  assert.equal(instances.length, 1);
});

test('veraltete Player-Meldungen (andere Sitzung) werden ignoriert', async () => {
  const { controller, startPlaying } = setup();
  const play = await startPlaying();
  controller.onPlayerReport({ t: 'error', seq: play.seq - 1, code: 2 });
  controller.onPlayerReport({ t: 'ended', seq: play.seq + 5 });
  assert.equal(controller.getState().status, 'playing');
});

test('Fehler im Player: 3 Wiederverbindungen mit Backoff, danach error mit Klartext', async () => {
  const { controller, timers, startPlaying, states, instances, win } = setup();
  const play = await startPlaying();
  controller.onPlayerReport({ t: 'error', seq: play.seq, code: 2, fatal: true });
  assert.equal(controller.getState().status, 'loading');
  assert.equal(controller.getState().attempt, 1);
  assert.equal(timers.pending(1000), 1);
  await timers.fire(1000);
  await controller.connecting;
  let current = win().commands().filter(c => c.cmd === 'play').at(-1);
  controller.onPlayerReport({ t: 'error', seq: current.seq, code: 2 });
  assert.equal(controller.getState().attempt, 2);
  await timers.fire(3000);
  await controller.connecting;
  current = win().commands().filter(c => c.cmd === 'play').at(-1);
  controller.onPlayerReport({ t: 'error', seq: current.seq, code: 2 });
  assert.equal(controller.getState().attempt, 3);
  await timers.fire(8000);
  await controller.connecting;
  current = win().commands().filter(c => c.cmd === 'play').at(-1);
  controller.onPlayerReport({ t: 'error', seq: current.seq, code: 2 });
  const end = controller.getState();
  assert.equal(end.status, 'error');
  assert.equal(end.error, 'Stream nicht erreichbar');
  assert.equal(timers.pending(), 0, 'kein Endlos-Retry');
  assert.ok(instances.every(w => w.closed) || win().closed);
  assert.ok(states.some(s => s.reconnecting));
});

test('erfolgreiche Wiedergabe nach Retry setzt die Versuche zurück', async () => {
  const { controller, timers, startPlaying, win } = setup();
  const play = await startPlaying();
  controller.onPlayerReport({ t: 'ended', seq: play.seq });
  await timers.fire(1000);
  await controller.connecting;
  const again = win().commands().filter(c => c.cmd === 'play').at(-1);
  controller.onPlayerReport({ t: 'playing', seq: again.seq });
  assert.equal(controller.getState().status, 'playing');
  assert.equal(controller.getState().attempt, 0);
  assert.equal(controller.getState().reconnecting, false);
});

test('"Format nicht unterstützt" wird nicht wiederholt', async () => {
  const { controller, timers, startPlaying } = setup();
  const play = await startPlaying();
  controller.onPlayerReport({ t: 'error', seq: play.seq, code: 4 });
  const state = controller.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'Format nicht unterstützt');
  assert.equal(timers.pending(), 0);
});

test('Auflösungsfehler: Wiederverbindung, am Ende die Fehlermeldung des Servers', async () => {
  const { controller, timers } = setup({
    resolve: async () => {
      throw new Error('Server antwortet mit HTTP 404');
    },
  });
  await controller.play(KEY_A);
  await controller.connecting;
  for (const delay of [1000, 3000, 8000]) {
    assert.equal(controller.getState().status, 'loading');
    await timers.fire(delay);
    await controller.connecting;
  }
  const state = controller.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'Server antwortet mit HTTP 404');
});

test('stop während des Backoffs bricht die Wiederverbindung ab', async () => {
  const { controller, timers, startPlaying } = setup();
  const play = await startPlaying();
  controller.onPlayerReport({ t: 'ended', seq: play.seq });
  assert.equal(timers.pending(1000), 1);
  controller.stop();
  assert.equal(timers.pending(), 0);
  assert.equal(controller.getState().status, 'idle');
});

test('Player-Fenster geht unerwartet zu: Wiederverbindung mit neuem Fenster', async () => {
  const { controller, timers, startPlaying, instances } = setup();
  await startPlaying();
  instances[0].close();
  assert.equal(controller.getState().status, 'loading');
  assert.equal(controller.getState().reconnecting, true);
  await timers.fire(1000);
  await controller.connecting;
  assert.equal(instances.length, 2);
});

test('next/prev laufen über die Favoritenreihenfolge mit Umlauf', async () => {
  const { controller } = setup();
  await controller.play(KEY_A);
  await controller.next();
  assert.equal(controller.getState().station.id, 'b');
  await controller.next();
  assert.equal(controller.getState().station.id, 'a');
  await controller.prev();
  assert.equal(controller.getState().station.id, 'b');
});

test('next ohne Favoriten ändert nichts', async () => {
  const library = createFakeLibrary({ stations: STATIONS, favorites: [] });
  const controller = new RadioController({ BrowserWindow: createFakeWindowClass().FakeWindow, library });
  const state = await controller.next();
  assert.equal(state.status, 'idle');
});

test('Lautstärke: sofort im Player, Speichern verzögert und zusammengefasst', async () => {
  const { controller, timers, library, startPlaying, win } = setup({ settings: { volume: 0.5 } });
  assert.equal(controller.getState().volume, 0.5);
  await startPlaying();
  library.calls.updateSettings.length = 0;
  controller.setVolume(0.2);
  controller.setVolume(0.35);
  assert.equal(controller.getState().volume, 0.35);
  assert.deepEqual(win().commands().filter(c => c.cmd === 'volume').map(c => c.volume), [0.2, 0.35]);
  assert.equal(library.calls.updateSettings.length, 0);
  assert.equal(timers.pending(500), 1);
  await timers.fire(500);
  assert.deepEqual(library.calls.updateSettings, [{ volume: 0.35 }]);
});

test('Medientasten-Aktionen des Players steuern den Controller', async () => {
  const { controller, startPlaying } = setup();
  await startPlaying();
  controller.onPlayerReport({ t: 'action', action: 'pause' });
  assert.equal(controller.getState().status, 'paused');
  controller.onPlayerReport({ t: 'action', action: 'play' });
  await controller.connecting;
  assert.equal(controller.getState().status, 'loading');
  controller.onPlayerReport({ t: 'action', action: 'nexttrack' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().station.id, 'b');
  controller.onPlayerReport({ t: 'action', action: 'stop' });
  assert.equal(controller.getState().status, 'idle');
});

test('playerWebContents liefert nur das aktuelle Player-Fenster (für die IPC-Absenderprüfung)', async () => {
  const { controller, win } = setup();
  assert.equal(controller.playerWebContents(), null);
  await controller.play(KEY_A);
  assert.equal(controller.playerWebContents(), win().webContents);
  controller.stop();
  assert.equal(controller.playerWebContents(), null);
});

test('dispose beendet Wiedergabe und entfernt Listener (kein Folge-Event)', async () => {
  const { controller, instances, states, startPlaying } = setup();
  await startPlaying();
  const count = states.length;
  controller.dispose();
  assert.equal(instances[0].closed, true);
  assert.equal(states.length, count, 'dispose löst kein Zustandsereignis mehr aus');
});
