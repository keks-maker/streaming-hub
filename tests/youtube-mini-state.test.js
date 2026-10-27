'use strict';

// Tests: Stufenmodell des YouTube-Mini-Players (klein/Seite/app-füllend/Vollbild, Esc), Verlauf („Zurück“) und Exklusivität.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../youtube-mini-state.js');
const T = require('../youtube-nav-trail.js');
const X = require('../lib/youtube-exclusivity.js');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const playing = (state = S.initialState(), videoId = A, stage = 'page') => S.setStatus(S.openVideo(state, { videoId, stage }), 'playing');

test('Video öffnen: Stufe page, Status lädt; aus der Playlist klein (mini); ungültige Angabe ändert nichts', () => {
  const s = S.openVideo(S.initialState(), { videoId: A });
  assert.deepEqual([s.stage, s.status, s.videoId], ['page', 'loading', A]);
  assert.equal(S.openVideo(S.initialState(), { videoId: A, stage: 'mini' }).stage, 'mini');
  const initial = S.initialState();
  assert.equal(S.openVideo(initial, {}), initial);
  assert.equal(S.openVideo(initial, { videoId: '' }), initial);
});

test('Automatisch klein: Navigation weg von der Wiedergabeseite → laufendes Video wird mini, ohne Neuladen', () => {
  const result = S.leavePage(playing());
  assert.equal(result.state.stage, 'mini');
  assert.equal(result.drop, false);
  assert.equal(result.state.videoId, A);
  assert.equal(result.state.status, 'playing');
  const loading = S.leavePage(S.openVideo(S.initialState(), { videoId: A }));
  assert.equal(loading.state.stage, 'mini');
});

test('Pausiertes Video wird NICHT klein: es wird verworfen (wie bisher beim Seitenwechsel)', () => {
  const paused = S.setStatus(playing(), 'paused');
  const result = S.leavePage(paused);
  assert.equal(result.drop, true);
  assert.equal(result.state.stage, 'idle');
  assert.equal(S.leavePage(S.setStatus(playing(), 'ended')).drop, true);
});

test('leavePage wirkt nur auf page und app; mini und idle bleiben', () => {
  const mini = S.leavePage(playing(S.initialState(), A, 'mini'));
  assert.equal(mini.state.stage, 'mini');
  assert.equal(mini.drop, false);
  assert.equal(S.leavePage(S.initialState()).drop, false);
  assert.equal(S.leavePage(S.appFill(playing())).state.stage, 'mini');
});

test('Hochholen: Zurück zum Video (page), App-füllend, Vollbild; Platzierung je Stufe', () => {
  let s = playing(S.initialState(), A, 'mini');
  assert.equal(S.placement(s), 'slot');
  s = S.showPage(s);
  assert.equal(S.placement(s), 'content');
  s = S.appFill(s);
  assert.deepEqual([s.stage, s.back, S.placement(s)], ['app', ['page'], 'window']);
  s = S.enterFullscreen(s);
  assert.deepEqual([s.stage, s.back, S.placement(s)], ['fullscreen', ['page', 'app'], 'window']);
  assert.equal(S.placement(S.initialState()), 'hidden');
  assert.equal(S.showPage(S.initialState()).stage, 'idle');
  assert.equal(S.appFill(S.initialState()).stage, 'idle');
});

test('Esc macht eine Stufe kleiner: Vollbild → app-füllend → Herkunft (mini oder Seite); page und mini nicht behandelt', () => {
  let s = S.enterFullscreen(S.appFill(playing(S.initialState(), A, 'mini')));
  let r = S.escape(s);
  assert.deepEqual([r.handled, r.state.stage], [true, 'app']);
  r = S.escape(r.state);
  assert.deepEqual([r.handled, r.state.stage], [true, 'mini']);
  r = S.escape(r.state);
  assert.equal(r.handled, false);
  // von der Seite aus: app → Seite; YouTubes eigener Vollbild-Knopf auf der Seite: Vollbild → Seite
  s = S.appFill(playing());
  assert.equal(S.escape(s).state.stage, 'page');
  s = S.enterFullscreen(playing());
  assert.equal(S.escape(s).state.stage, 'page');
  assert.equal(S.escape(playing()).handled, false);
  assert.equal(S.escape(S.initialState()).handled, false);
});

test('Vollbild verlassen (Meldung des Webviews) geht zur Herkunft zurück; Manuell klein stellen (Taste i)', () => {
  const s = S.enterFullscreen(S.appFill(playing(S.initialState(), A, 'mini')));
  assert.equal(S.leaveFullscreen(s).stage, 'app');
  assert.equal(S.minimize(playing()).stage, 'mini');
  assert.equal(S.minimize(S.appFill(playing())).stage, 'mini');
  const mini = playing(S.initialState(), A, 'mini');
  assert.equal(S.minimize(mini), mini);
});

test('Vollbild nicht zustande gekommen: bleibt app-füllend, Esc geht wie gewohnt zurück', () => {
  const fromMini = S.enterFullscreen(playing(S.initialState(), A, 'mini'));
  const failed = S.fullscreenFailed(fromMini);
  assert.equal(failed.stage, 'app');
  assert.equal(S.escape(failed).state.stage, 'mini');
  const fromApp = S.enterFullscreen(S.appFill(playing(S.initialState(), A, 'mini')));
  assert.equal(S.fullscreenFailed(fromApp).stage, 'app');
  assert.equal(S.escape(S.fullscreenFailed(fromApp)).state.stage, 'mini');
  assert.equal(S.fullscreenFailed(playing()).stage, 'page');
});

test('Neues Video ersetzt das laufende; app-füllend/Vollbild bleiben beim nächsten Playlist-Video erhalten', () => {
  const next = S.openVideo(S.appFill(playing()), { videoId: B, stage: 'mini' });
  assert.deepEqual([next.stage, next.videoId, next.status], ['app', B, 'loading']);
  assert.equal(S.openVideo(playing(), { videoId: B, stage: 'mini' }).stage, 'mini');
  assert.equal(S.setVideoId(playing(), B).videoId, B);
});

test('Schließen (X) beendet; Status nur für aktive Videos und gültige Werte', () => {
  assert.equal(S.close().stage, 'idle');
  const idle = S.initialState();
  assert.equal(S.setStatus(idle, 'playing'), idle);
  const s = playing();
  assert.equal(S.setStatus(s, 'kaputt'), s);
  assert.equal(S.isPlaying(S.setStatus(s, 'paused')), false);
});

// ───────── Verlauf ─────────

test('Verlauf: Besuche, doppelte Meldungen, Zurück nach eigenem goBack entfernt den obersten Eintrag', () => {
  let t = T.createTrail();
  t = T.visit(t, 'https://www.youtube.com/');
  t = T.visit(t, 'https://www.youtube.com/');
  t = T.visit(t, 'https://www.youtube.com/results?search_query=x');
  assert.equal(t.entries.length, 2);
  t = T.visit(T.markBack(t), 'https://www.youtube.com/');
  assert.deepEqual(t.entries.map(e => e.url), ['https://www.youtube.com/']);
  assert.equal(t.pendingBack, false);
});

test('Zurück: von der Wiedergabeseite → Stöbern zeigen; aus dem Stöbern auf die Seite des laufenden Videos → Player wieder groß', () => {
  let t = T.resetTrail('https://www.youtube.com/');
  assert.deepEqual(T.backAction(t, { stage: 'page', videoId: A, playerAlive: true }), { kind: 'show-browse' });
  assert.deepEqual(T.backAction(T.createTrail(), { stage: 'page', videoId: A, playerAlive: true }), { kind: 'none' });
  // Klick auf das Logo im Player: Seite wird aus Video A erreicht
  t = T.visit(t, 'https://www.youtube.com/@kanal', A);
  assert.deepEqual(T.backAction(t, { stage: 'mini', videoId: A, playerAlive: true }), { kind: 'show-player' });
  // anderes Video läuft inzwischen / Player weg: normales Zurück im Stöbern
  assert.deepEqual(T.backAction(t, { stage: 'mini', videoId: B, playerAlive: true }), { kind: 'webview-back' });
  assert.deepEqual(T.backAction(t, { stage: 'idle', videoId: '', playerAlive: false }), { kind: 'webview-back' });
  assert.deepEqual(T.backAction(T.resetTrail('https://www.youtube.com/'), { stage: 'mini', videoId: A, playerAlive: true }), { kind: 'none' });
});

// ───────── Exklusivität ─────────

test('Exklusivität: Streamingdienst, LiveTV, Aufnahme, Mediathek stoppen das Video sofort; Radio/Podcast erst bei loading/playing', () => {
  for (const source of ['service', 'livetv', 'recording', 'mediathek', 'dashboard-preview']) {
    assert.equal(X.shouldStopVideo({ source, videoActive: true }), true, source);
    assert.equal(X.shouldStopVideo({ source, videoActive: false }), false, source);
  }
  for (const source of ['radio', 'podcast']) {
    for (const status of ['loading', 'playing']) assert.equal(X.shouldStopVideo({ source, sourceState: { status }, videoActive: true }), true, `${source} ${status}`);
    for (const status of ['paused', 'idle', 'error', 'ended']) assert.equal(X.shouldStopVideo({ source, sourceState: { status }, videoActive: true }), false, `${source} ${status}`);
  }
  assert.equal(X.shouldStopVideo({ source: 'unbekannt', videoActive: true }), false);
  assert.equal(X.shouldStopVideo({ source: 'radio', videoActive: true }), false);
});

test('Exklusivität: nur der Wechsel nach loading/playing zählt als Start, nicht jede Titelmeldung', () => {
  assert.equal(X.startedPlayback('idle', { status: 'loading' }), true);
  assert.equal(X.startedPlayback('paused', { status: 'playing' }), true);
  assert.equal(X.startedPlayback('loading', { status: 'playing' }), false);
  assert.equal(X.startedPlayback('playing', { status: 'playing' }), false);
  assert.equal(X.startedPlayback('playing', { status: 'paused' }), false);
  assert.equal(X.startedPlayback('idle', null), false);
});
