'use strict';

// Tests: Controller des YouTube-Mini-Players mit Attrappen für die zwei Webviews: Video öffnen, automatisch klein,
// Zurück zum Video, Playlist (Ende → nächstes, leer → Ende), Klickverhalten, Exklusivität, Esc-Stufen, Zurück, Einstellungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createYoutubeMini } = require('../youtube-mini-controller.js');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';
const url = id => `https://www.youtube.com/watch?v=${id}`;

function fakeView(initialUrl = 'about:blank') {
  const handlers = {};
  const classes = new Set();
  const v = {
    loaded: [],
    executed: [],
    reloads: 0,
    backs: 0,
    history: [initialUrl],
    style: {},
    classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)), add: n => classes.add(n), remove: n => classes.delete(n), has: n => classes.has(n) },
    addEventListener: (type, fn) => (handlers[type] = handlers[type] || []).push(fn),
    emit: (type, event = {}) => (handlers[type] || []).forEach(fn => fn(event)),
    loadURL(target) {
      v.loaded.push(target);
      v.history.push(target);
      return Promise.resolve();
    },
    getURL: () => v.history[v.history.length - 1],
    canGoBack: () => v.history.length > 1,
    goBack() {
      v.backs++;
      v.history.pop();
    },
    reload() {
      v.reloads++;
    },
    executeJavaScript(code) {
      v.executed.push(code);
      return Promise.resolve();
    },
    getWebContentsId: () => 5,
    message: payload => v.emit('ipc-message', { channel: 'youtube-mini', args: [payload] }),
    place: () => ['hidden', 'content', 'slot', 'window'].find(n => classes.has(`yt-place-${n}`)),
  };
  return v;
}

async function setup({ settings = { enabled: true, clickBehavior: 'replace' }, playlist = [] } = {}) {
  const content = fakeView('https://www.youtube.com/');
  const player = fakeView();
  const saved = [];
  const notes = [];
  const hookCalls = [];
  const registered = [];
  let clock = 1000;
  const api = {
    getYoutubeMiniSettings: async () => settings,
    setYoutubeMiniSettings: async patch => (settings = { ...settings, ...patch }),
    getYoutubePlaylist: async () => playlist,
    setYoutubePlaylist: async list => saved.push(list),
    registerYoutubePlayer: async id => registered.push(id),
    resolveYoutubeTitle: async ({ id }) => `Titel ${id[0]}`,
    onYoutubeContextAction: cb => (api.contextAction = cb),
  };
  const slot = { getBoundingClientRect: () => ({ left: 20, top: 500, width: 160, height: 90 }) };
  const win = { addEventListener() {}, setTimeout: () => 0 };
  const ctl = createYoutubeMini({
    contentView: content,
    playerView: player,
    api,
    logger: { warn() {} },
    notify: m => notes.push(m),
    now: () => clock,
    win,
    hooks: {
      beforePlay: () => hookCalls.push('beforePlay'),
      enterYoutubeArea: () => hookCalls.push('enter'),
      isYoutubeArea: () => true,
      onPlacement: place => hookCalls.push(`place:${place}`),
      onHtmlFullscreen: active => hookCalls.push(`fs:${active}`),
    },
  });
  await ctl.init();
  ctl.setVideoSlot(slot);
  player.emit('did-attach');
  await new Promise(resolve => setImmediate(resolve));
  const tick = ms => (clock += ms);
  const state = (id, extra = {}) => player.message({ type: 'state', id, title: 'T', time: 5, duration: 100, paused: false, ended: false, volume: 1, ...extra });
  return { ctl, content, player, saved, notes, hookCalls, registered, state, tick, getSettings: () => settings, contextAction: payload => api.contextAction(payload) };
}

test('Start: Player-Webview wird angemeldet, Einstellungen und gespeicherte Playlist werden geladen', async () => {
  const t = await setup({ playlist: [{ id: A, title: 'Eins' }, { id: 'kaputt' }] });
  assert.deepEqual(t.registered, [5]);
  assert.deepEqual(t.ctl.getView().playlist, [{ id: A, title: 'Eins' }]);
  assert.equal(t.ctl.getView().stage, 'idle');
  assert.equal(t.player.place(), 'hidden');
});

test('Klick auf ein Video im Stöbern: lädt in der Player-Webview (Stufe Seite), Radio/Podcast pausieren, Inhalts-Webview bleibt', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A, title: 'Mein Video' });
  assert.deepEqual(t.player.loaded, [url(A)]);
  assert.equal(t.content.loaded.length, 0);
  assert.equal(t.ctl.getView().stage, 'page');
  assert.equal(t.ctl.getView().title, 'Mein Video');
  assert.equal(t.player.place(), 'content');
  assert.ok(t.hookCalls.includes('beforePlay'));
  assert.ok(t.hookCalls.includes('enter'));
  assert.equal(t.ctl.isPlayerShown(), true);
  // ungültige Nachrichten ändern nichts
  t.content.message({ type: 'open', id: 'kaputt' });
  t.content.message({ type: 'open' });
  t.content.message(null);
  assert.deepEqual(t.player.loaded, [url(A)]);
});

test('Automatisch klein: Logo-Klick im Player lädt die Seite im Stöbern, das Video läuft ohne Neuladen in der Leiste weiter', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  assert.equal(t.ctl.getView().status, 'playing');
  t.player.message({ type: 'browse', url: 'https://www.youtube.com/@kanal' });
  assert.deepEqual(t.content.loaded, ['https://www.youtube.com/@kanal']);
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.player.place(), 'slot');
  assert.deepEqual([t.player.style.left, t.player.style.top, t.player.style.width, t.player.style.height], ['20px', '500px', '160px', '90px']);
  assert.deepEqual(t.player.loaded, [url(A)]); // kein erneutes Laden
  assert.ok(t.player.executed.some(code => code.includes('setMode("mini")')));
  // Nicht-Browse-Adressen aus dem Player werden nicht ins Stöbern geladen
  t.player.message({ type: 'browse', url: 'https://example.org/' });
  t.player.message({ type: 'browse', url: url(B) });
  assert.equal(t.content.loaded.length, 1);
});

test('Pausiertes Video wird NICHT automatisch klein, sondern verworfen', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A, { paused: true });
  t.player.message({ type: 'browse', url: 'https://www.youtube.com/' });
  assert.equal(t.ctl.getView().stage, 'idle');
  assert.equal(t.player.loaded[t.player.loaded.length - 1], 'about:blank');
  assert.equal(t.content.loaded.length, 1);
});

test('Manuell klein (Taste i / Knopf): Stufe mini, Stöbern bleibt sichtbar; Zurück zum Video holt die Seite wieder hoch', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.player.message({ type: 'mini' });
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.player.place(), 'slot');
  t.hookCalls.length = 0;
  t.ctl.actions.back();
  assert.equal(t.ctl.getView().stage, 'page');
  assert.equal(t.player.place(), 'content');
  assert.ok(t.hookCalls.includes('enter'));
  assert.equal(t.player.loaded.length, 1);
});

test('App-füllend, Vollbild und Esc: jeweils eine Stufe kleiner, zurück zur Herkunft', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.player.message({ type: 'mini' });
  t.ctl.actions.appFill();
  assert.equal(t.player.place(), 'window');
  assert.equal(t.ctl.getView().stage, 'app');
  t.player.emit('enter-html-full-screen');
  assert.equal(t.ctl.getView().stage, 'fullscreen');
  assert.ok(t.hookCalls.includes('fs:true'));
  t.player.emit('leave-html-full-screen');
  assert.equal(t.ctl.getView().stage, 'app');
  assert.ok(t.hookCalls.includes('fs:false'));
  // dieselbe Esc-Taste direkt nach dem Verlassen des Vollbilds zählt nicht doppelt
  assert.equal(t.ctl.handleEscape(), true);
  assert.equal(t.ctl.getView().stage, 'app');
  t.tick(500);
  assert.equal(t.ctl.handleEscape(), true);
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.ctl.handleEscape(), false);
  // Vollbild per Knopf aus der Leiste
  t.ctl.actions.fullscreen();
  assert.equal(t.ctl.getView().stage, 'fullscreen');
  assert.ok(t.player.executed.some(code => code.includes('.fullscreen()')));
  t.tick(500);
  assert.equal(t.ctl.handleEscape(), true);
  assert.equal(t.ctl.getView().stage, 'mini');
});

test('Videoende: nächster Eintrag der Playlist startet in derselben Stufe und verlässt die Liste; gespeichert', async () => {
  const t = await setup({ playlist: [{ id: B, title: 'Zwei' }, { id: C, title: 'Drei' }] });
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.player.message({ type: 'mini' });
  t.state(A, { ended: true });
  assert.equal(t.player.loaded[t.player.loaded.length - 1], url(B));
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.ctl.getView().videoId, B);
  assert.deepEqual(t.ctl.getView().playlist.map(p => p.id), [C]);
  assert.deepEqual(t.saved[t.saved.length - 1].map(p => p.id), [C]);
  // wiederholte Ende-Meldungen des alten Videos starten nichts doppelt
  t.state(A, { ended: true });
  assert.equal(t.player.loaded.filter(u => u === url(C)).length, 0);
  t.state(B);
  t.state(B, { ended: true });
  assert.equal(t.ctl.getView().videoId, C);
  assert.deepEqual(t.ctl.getView().playlist, []);
});

test('Videoende bei leerer Playlist: klein → Wiedergabe endet; auf der Wiedergabeseite bleibt die Seite stehen', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.state(A, { ended: true });
  assert.equal(t.ctl.getView().stage, 'page');
  assert.equal(t.ctl.getView().status, 'ended');
  const u = await setup();
  u.content.message({ type: 'open', id: A });
  u.state(A);
  u.player.message({ type: 'mini' });
  u.state(A, { ended: true });
  assert.equal(u.ctl.getView().stage, 'idle');
  assert.equal(u.player.loaded[u.player.loaded.length - 1], 'about:blank');
});

test('Playlist: Hinzufügen (Duplikate, Titel nachladen, Als Nächstes), Abspielen per Klick, Entfernen, Umsortieren; alles gespeichert', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.content.message({ type: 'add', id: B, title: 'Zwei' });
  t.content.message({ type: 'add', id: C });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(t.ctl.getView().playlist, [{ id: B, title: 'Zwei' }, { id: C, title: 'Titel c' }]);
  t.content.message({ type: 'add', id: B });
  assert.equal(t.notes[t.notes.length - 1], 'Schon in der Playlist');
  t.content.message({ type: 'add', id: A });
  assert.equal(t.notes[t.notes.length - 1], 'Dieses Video läuft gerade');
  t.ctl.actions.moveEntry(C, B);
  assert.deepEqual(t.ctl.getView().playlist.map(p => p.id), [C, B]);
  t.ctl.actions.moveBy(C, 1);
  assert.deepEqual(t.ctl.getView().playlist.map(p => p.id), [B, C]);
  t.ctl.actions.removeEntry(B);
  t.ctl.actions.playEntry(C);
  assert.equal(t.ctl.getView().videoId, C);
  assert.deepEqual(t.ctl.getView().playlist, []);
  assert.ok(t.saved.length >= 4);
});

test('Hinzufügen ohne laufendes Video und ohne wartende Einträge: das Video startet sofort klein; Kontextmenü-Aktionen', async () => {
  const t = await setup();
  t.content.message({ type: 'add', id: A, title: 'Eins' });
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.player.loaded[0], url(A));
  assert.equal(t.player.place(), 'slot');
  assert.equal(t.content.loaded.length, 0);
});

test('Kontextmenü: „Als Nächstes abspielen“ geht an den Anfang, „Zur Playlist hinzufügen“ ans Ende; ungültige Adressen und ausgeschalteter Mini-Player ändern nichts', async () => {
  const t = await setup({ playlist: [{ id: B, title: 'Zwei' }] });
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.contextAction({ action: 'next', url: `${url(C)}&list=PL1`, title: 'Drei' });
  assert.deepEqual(t.ctl.getView().playlist.map(p => p.id), [C, B]);
  const D = 'ddddddddddd';
  t.contextAction({ action: 'add', url: url(D), title: 'Vier' });
  assert.deepEqual(t.ctl.getView().playlist.map(p => p.id), [C, B, D]);
  t.contextAction({ action: 'add', url: 'https://example.org/watch?v=' + D });
  t.contextAction({ action: 'add', url: 'https://www.youtube.com/@kanal' });
  t.contextAction({ action: 'quatsch', url: url(A) });
  assert.equal(t.ctl.getView().playlist.length, 3);
  await t.ctl.applySettings({ enabled: false });
  t.contextAction({ action: 'add', url: url(C) });
  assert.equal(t.ctl.getView().playlist.length, 3);
});

test('Einstellung „zur Playlist“: Klick auf ein Video, während eines läuft, fügt hinzu statt zu ersetzen; ohne laufendes Video wird gespielt', async () => {
  const t = await setup({ settings: { enabled: true, clickBehavior: 'playlist' } });
  t.content.message({ type: 'open', id: A });
  assert.equal(t.ctl.getView().videoId, A);
  t.state(A);
  t.content.message({ type: 'open', id: B, title: 'Zwei' });
  assert.equal(t.ctl.getView().videoId, A);
  assert.deepEqual(t.ctl.getView().playlist, [{ id: B, title: 'Zwei' }]);
  assert.deepEqual(t.player.loaded, [url(A)]);
  const r = await setup();
  r.content.message({ type: 'open', id: A });
  r.state(A);
  r.content.message({ type: 'open', id: B });
  assert.equal(r.ctl.getView().videoId, B); // Standard: ersetzen
  assert.equal(r.ctl.getView().stage, 'page');
});

test('Ersetzen im Player: ein anderes Video auf der Wiedergabeseite führt die Kennung nach; veraltete Meldungen nach dem Öffnen werden ignoriert', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(B); // alte Seite meldet noch ein anderes Video, bevor A geladen ist
  assert.equal(t.ctl.getView().videoId, A);
  t.state(A);
  t.state(B); // Klick auf ein Vorschlagsvideo im Player
  assert.equal(t.ctl.getView().videoId, B);
});

test('Exklusivität: andere Wiedergabe beendet das Video, Seiten-Verlassen für Dienste: YouTube klein, anderer Dienst Ende', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.ctl.stopForOtherPlayback();
  assert.equal(t.ctl.getView().stage, 'idle');
  assert.equal(t.player.loaded[t.player.loaded.length - 1], 'about:blank');
  assert.equal(t.player.place(), 'hidden');
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.ctl.onServiceNavigate(true);
  assert.equal(t.ctl.getView().stage, 'mini');
  t.ctl.onServiceNavigate(false);
  assert.equal(t.ctl.getView().stage, 'idle');
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.ctl.onLeaveArea();
  assert.equal(t.ctl.getView().stage, 'mini');
});

test('X-Knopf des Players („shrink“) wirkt wie Esc: App-füllend → Herkunft, Vollbild → Herkunft mit exitFullscreen; sonst nichts', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.player.message({ type: 'shrink' });
  assert.equal(t.ctl.getView().stage, 'page', 'Seite: nichts zu verkleinern');
  t.ctl.actions.appFill();
  assert.equal(t.ctl.getView().stage, 'app');
  t.player.message({ type: 'shrink' });
  assert.equal(t.ctl.getView().stage, 'page');
  t.ctl.actions.appFill();
  t.ctl.actions.fullscreen();
  assert.equal(t.ctl.getView().stage, 'fullscreen');
  t.player.message({ type: 'shrink' });
  assert.equal(t.ctl.getView().stage, 'app');
  assert.ok(t.player.executed.some(code => code.includes('exitFullscreen')));
});

test('Pausiertes Video in App-füllend bleibt beim Wechsel in einen anderen App-Bereich erhalten (Mini-Player, pausiert)', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  t.ctl.actions.appFill();
  t.state(A, { paused: true });
  t.ctl.onLeaveArea();
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.ctl.getView().status, 'paused');
  assert.equal(t.ctl.getView().videoId, A);
});

test('Schließen (X) beendet die Wiedergabe; Leiste und Medientasten steuern das kleine Video', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  assert.equal(t.ctl.handleMediaKey('playpause'), false); // nur das kleine Video
  t.player.message({ type: 'mini' });
  assert.equal(t.ctl.handleMediaKey('playpause'), true);
  assert.ok(t.player.executed.some(code => code.includes('.pause()')));
  t.ctl.actions.seek(30);
  t.ctl.actions.skip(5);
  t.ctl.actions.setVolume(0.4);
  assert.ok(t.player.executed.some(code => code.includes('.seek(30)')));
  assert.ok(t.player.executed.some(code => code.includes('.seek(10)'))); // Position 5 + 5
  assert.ok(t.player.executed.some(code => code.includes('.volume(0.4)')));
  t.ctl.actions.close();
  assert.equal(t.ctl.getView().stage, 'idle');
  assert.equal(t.ctl.handleMediaKey('playpause'), false);
});

test('Zurück: aus der Wiedergabeseite → Stöbern; aus dem Stöbern auf die Seite des laufenden Videos → Player wieder groß', async () => {
  const t = await setup();
  t.content.emit('did-navigate', { url: 'https://www.youtube.com/' });
  t.content.message({ type: 'open', id: A });
  t.state(A);
  // Zurück von der Wiedergabeseite: Stöbern zeigen, Video wird klein
  assert.equal(t.ctl.canGoBack(), true);
  assert.equal(t.ctl.handleBack(), true);
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.content.backs, 0);
  // wieder hoch, dann Logo-Klick im Player: Seite im Stöbern entsteht aus Video A
  t.ctl.actions.back();
  t.player.message({ type: 'browse', url: 'https://www.youtube.com/@kanal' });
  t.content.emit('did-navigate', { url: 'https://www.youtube.com/@kanal' });
  assert.equal(t.ctl.getView().stage, 'mini');
  assert.equal(t.ctl.handleBack(), true);
  assert.equal(t.content.backs, 1);
  assert.equal(t.ctl.getView().stage, 'page');
  t.content.emit('did-navigate', { url: 'https://www.youtube.com/' }); // Ereignis nach dem eigenen Zurück
  // normales Zurück im Stöbern (ohne Bezug zum Video)
  t.ctl.actions.back();
  t.player.message({ type: 'mini' });
  for (const q of ['a', 'b']) {
    t.content.history.push(`https://www.youtube.com/results?search_query=${q}`);
    t.content.emit('did-navigate', { url: `https://www.youtube.com/results?search_query=${q}` });
  }
  assert.equal(t.ctl.handleBack(), true);
  assert.equal(t.content.backs, 2);
});

test('Eine Video-Seite in der Inhalts-Webview (nicht abgefangen) wandert in die Player-Webview und die Inhalts-Webview geht zurück', async () => {
  const t = await setup();
  t.content.emit('did-navigate', { url: 'https://www.youtube.com/' });
  t.content.history.push(url(A));
  t.content.emit('did-navigate-in-page', { url: url(A) });
  assert.deepEqual(t.player.loaded, [url(A)]);
  assert.equal(t.content.backs, 1);
  t.content.emit('did-navigate-in-page', { url: url(A) }); // Doppelmeldung
  assert.deepEqual(t.player.loaded, [url(A)]);
});

test('Navigation zu einer Video-Adresse (navigateTo) gehört in die Player-Webview; nur bei eingeschaltetem Mini-Player', async () => {
  const t = await setup();
  assert.equal(t.ctl.interceptNavigate('https://www.youtube.com/'), false);
  assert.equal(t.ctl.interceptNavigate('https://www.netflix.com/title/1'), false);
  assert.equal(t.ctl.interceptNavigate(url(A)), true);
  assert.equal(t.ctl.getView().videoId, A);
  const off = await setup({ settings: { enabled: false, clickBehavior: 'replace' } });
  assert.equal(off.ctl.interceptNavigate(url(A)), false);
});

test('Ausgeschaltet: Nachrichten der Seiten bleiben wirkungslos; Ausschalten beendet das Video, lädt neu und meldet die Einstellung', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.state(A);
  const saved = await t.ctl.applySettings({ enabled: false });
  assert.equal(saved.enabled, false);
  assert.equal(t.ctl.getView().stage, 'idle');
  assert.equal(t.content.reloads, 1);
  t.content.message({ type: 'open', id: B });
  t.content.message({ type: 'add', id: B });
  assert.equal(t.ctl.getView().stage, 'idle');
  assert.deepEqual(t.ctl.getView().playlist, []);
  assert.equal(t.ctl.handleBack(), false);
  await t.ctl.applySettings({ enabled: true });
  assert.equal(t.content.reloads, 2);
  await t.ctl.applySettings({ clickBehavior: 'playlist' });
  assert.ok(t.content.executed.some(code => code.includes('setConfig') && code.includes('playlist')));
  assert.ok(t.player.executed.some(code => code.includes('setConfig')));
});

test('Fehler der Player-Webview: Laden schlägt fehl oder Absturz → Video beendet, Hinweis; Abbruch durch neues Laden (-3) wird ignoriert', async () => {
  const t = await setup();
  t.content.message({ type: 'open', id: A });
  t.player.emit('did-fail-load', { errorCode: -3, isMainFrame: true, errorDescription: 'ERR_ABORTED' });
  assert.equal(t.ctl.getView().stage, 'page');
  t.player.emit('did-fail-load', { errorCode: -105, isMainFrame: false, errorDescription: 'x' });
  assert.equal(t.ctl.getView().stage, 'page');
  t.player.emit('did-fail-load', { errorCode: -105, isMainFrame: true, errorDescription: 'ERR_NAME_NOT_RESOLVED' });
  assert.equal(t.ctl.getView().stage, 'idle');
  assert.equal(t.notes[t.notes.length - 1], 'Video konnte nicht geladen werden');
  t.content.message({ type: 'open', id: A });
  t.player.emit('crashed');
  assert.equal(t.ctl.getView().stage, 'idle');
});

test('Nur http(s) in der Player-Webview; Medienberechtigung erlaubt, alles andere abgelehnt', async () => {
  const t = await setup();
  let prevented = 0;
  t.player.emit('will-navigate', { url: 'file:///etc/passwd', preventDefault: () => prevented++ });
  t.player.emit('will-navigate', { url: 'https://www.youtube.com/watch?v=x', preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  const calls = [];
  const request = { allow: () => calls.push('allow'), deny: () => calls.push('deny') };
  t.player.emit('permissionrequest', { permission: 'media', request });
  t.player.emit('permissionrequest', { permission: 'geolocation', request });
  assert.deepEqual(calls, ['allow', 'deny']);
});
