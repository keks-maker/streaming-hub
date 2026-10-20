'use strict';

// Tests: Radio-Mini-Player (R2) — Modell (Sichtbarkeit, Texte, Aktionen), Ton-Konfliktlogik, Ansicht (Fake-DOM)
// und die Verdrahtung in renderer.js/index.html (Vollbild, Konflikt-Hooks, Navigation, kein innerHTML mit Daten).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mini = require('../radio-miniplayer-model.js');
const { radioActionForVideoStart } = require('../radio-tv-conflict-model.js');
const { createRadioMiniPlayer } = require('../radio-miniplayer-view.js');
const { makeDoc, makeFakeRadio } = require('./helpers/fake-dom.js');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const STATION = { sourceId: 'a', id: 'one', name: 'Eins', logo: 'https://x.test/1.png', genre: 'Pop' };
const st = (status, extra = {}) => ({ status, station: STATION, volume: 0.5, nowPlaying: null, error: null, reconnecting: false, ...extra });
const IDLE = { status: 'idle', station: null, volume: 0.5, nowPlaying: null, error: null, reconnecting: false };

// ───────── Modell ─────────

test('Sichtbarkeit: nur wenn Radio nicht idle ist und kein Vollbild unterdrückt', () => {
  assert.equal(mini.miniPlayerModel(IDLE).visible, false);
  assert.equal(mini.miniPlayerModel(null).visible, false);
  for (const status of ['loading', 'playing', 'paused', 'error']) assert.equal(mini.miniPlayerModel(st(status)).visible, true, status);
  assert.equal(mini.miniPlayerModel(st('playing'), { suppressed: true }).visible, false);
});

test('Texte: Titel/Interpret beim Spielen, sonst Status; Fehlertext des Controllers', () => {
  assert.equal(mini.miniPlayerModel(st('playing', { nowPlaying: { artist: 'Band', title: 'Lied' } })).subtitle, 'Band – Lied');
  assert.equal(mini.miniPlayerModel(st('playing')).subtitle, 'Pop');
  assert.equal(mini.miniPlayerModel(st('loading')).subtitle, 'Verbinde …');
  assert.equal(mini.miniPlayerModel(st('loading', { reconnecting: true })).subtitle, 'Verbindung wird neu aufgebaut …');
  assert.equal(mini.miniPlayerModel(st('paused')).subtitle, 'Pausiert');
  assert.equal(mini.miniPlayerModel(st('error', { error: 'HTTP 404' })).subtitle, 'HTTP 404');
  assert.equal(mini.miniPlayerModel(st('error')).subtitle, 'Stream nicht erreichbar');
});

test('Play/Pause-Taste: Aktion und Beschriftung je Status', () => {
  const pick = status => {
    const m = mini.miniPlayerModel(st(status));
    return [m.action, m.playPauseLabel];
  };
  assert.deepEqual(pick('playing'), ['pause', 'Pause']);
  assert.deepEqual(pick('paused'), ['resume', 'Wiedergabe fortsetzen']);
  assert.deepEqual(pick('loading'), ['stop', 'Verbinden abbrechen']);
  assert.deepEqual(pick('error'), ['play', 'Erneut versuchen']);
});

test('Schritt vor/zurück nur bei mehr als einem Favoriten; Lautstärke in Prozent und begrenzt', () => {
  assert.equal(mini.miniPlayerModel(st('playing'), { favoriteCount: 1 }).canStep, false);
  assert.equal(mini.miniPlayerModel(st('playing'), { favoriteCount: 2 }).canStep, true);
  assert.equal(mini.miniPlayerModel(st('playing', { volume: 0.5 })).volumePercent, 50);
  assert.equal(mini.miniPlayerModel(st('playing', { volume: 7 })).volumePercent, 100);
  assert.equal(mini.miniPlayerModel(st('playing', { volume: undefined })).volumePercent, 0);
});

test('aria-live-Meldung: Sender und Status, keine Titelwechsel; leer bei idle', () => {
  assert.equal(mini.liveMessage(st('playing')), 'Eins: spielt');
  assert.equal(mini.liveMessage(st('playing', { nowPlaying: { title: 'A' } })), 'Eins: spielt');
  assert.equal(mini.liveMessage(st('paused')), 'Eins: pausiert');
  assert.equal(mini.liveMessage(st('loading')), 'Eins: Verbinde');
  assert.equal(mini.liveMessage(st('error')), 'Eins: Stream nicht erreichbar');
  assert.equal(mini.liveMessage(IDLE), '');
});

test('Logo: nur sichere URL, sonst Platzhalter mit Anfangsbuchstabe', () => {
  const m = mini.miniPlayerModel(st('playing', { station: { ...STATION, logo: 'javascript:1', name: 'zebra' } }));
  assert.equal(m.logo, null);
  assert.equal(m.initial, 'Z');
});

// ───────── Ton-Konflikt ─────────

test('Konflikt: laufendes Radio wird bei Bildstart pausiert, verbindendes gestoppt, sonst nichts', () => {
  const on = { pauseOnTv: true };
  assert.equal(radioActionForVideoStart(st('playing'), on), 'pause');
  assert.equal(radioActionForVideoStart(st('loading'), on), 'stop');
  for (const status of ['idle', 'paused', 'error']) assert.equal(radioActionForVideoStart(st(status), on), 'none', status);
});

test('Konflikt: Einstellung pauseOnTv=false lässt das Radio spielen; Standard ist an', () => {
  assert.equal(radioActionForVideoStart(st('playing'), { pauseOnTv: false }), 'none');
  assert.equal(radioActionForVideoStart(st('playing'), {}), 'pause');
  assert.equal(radioActionForVideoStart(st('playing'), undefined), 'pause');
  assert.equal(radioActionForVideoStart(null, { pauseOnTv: true }), 'none');
});

// ───────── Ansicht (Fake-DOM) ─────────

function setup({ state = IDLE, favoriteCount = 3 } = {}) {
  const doc = makeDoc();
  const el = doc.createElement('div');
  const radio = makeFakeRadio({ state });
  const notes = [];
  let opened = 0;
  const view = createRadioMiniPlayer(el, {
    radio,
    getFavoriteCount: () => favoriteCount,
    onOpenRadio: () => (opened += 1),
    notify: m => notes.push(m),
    logger: { warn: () => {} },
  });
  return { el, radio, view, notes, opened: () => opened };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Ansicht: bei idle verborgen, bei Wiedergabe sichtbar mit Sender, Titel, Logo', async () => {
  const { el, radio } = setup();
  await tick();
  assert.equal(el.hidden, true);
  radio.emitState(st('playing', { nowPlaying: { artist: 'Band', title: 'Lied' } }));
  assert.equal(el.hidden, false);
  assert.equal(el.byClass('radio-mini-name')[0].textContent, 'Eins');
  assert.equal(el.byClass('radio-mini-subtitle')[0].textContent, 'Band – Lied');
  assert.equal(el.find(n => n.tagName === 'img')[0].src, 'https://x.test/1.png');
  assert.equal(el.byId('radioMiniLive').textContent, 'Eins: spielt');
  radio.emitState(IDLE);
  assert.equal(el.hidden, true);
  assert.equal(el.byId('radioMiniLive').textContent, '');
});

test('Ansicht: Tasten steuern das Radio (Play/Pause je Status, Vorheriger, Nächster, Stopp, Lautstärke)', async () => {
  const { el, radio } = setup({ state: st('playing') });
  await tick();
  el.byId('radioMiniPlayPause').click();
  radio.emitState(st('paused'));
  el.byId('radioMiniPlayPause').click();
  radio.emitState(st('error'));
  el.byId('radioMiniPlayPause').click();
  el.byId('radioMiniPrev').click();
  el.byId('radioMiniNext').click();
  el.byId('radioMiniStop').click();
  const vol = el.byId('radioMiniVolume');
  vol.value = '25';
  vol.dispatch('input');
  await tick();
  assert.deepEqual(radio.calls, [['pause'], ['play', undefined], ['play', { sourceId: 'a', stationId: 'one' }], ['prev'], ['next'], ['stop'], ['setVolume', 0.25]]);
});

test('Ansicht: Schrittsteuerung bei einem Favoriten deaktiviert; Lautstärke folgt dem Zustand', async () => {
  const { el } = setup({ state: st('playing', { volume: 0.4 }), favoriteCount: 1 });
  await tick();
  assert.equal(el.byId('radioMiniPrev').disabled, true);
  assert.equal(el.byId('radioMiniNext').disabled, true);
  assert.equal(el.byId('radioMiniVolume').value, '40');
});

test('Ansicht: Vollbild unterdrückt die Leiste, Ende des Vollbilds zeigt sie wieder', async () => {
  const { el, view } = setup({ state: st('playing') });
  await tick();
  assert.equal(el.hidden, false);
  view.setSuppressed(true);
  assert.equal(el.hidden, true);
  view.setSuppressed(false);
  assert.equal(el.hidden, false);
});

test('Ansicht: Logo-Fehler zeigt den Platzhalter-Buchstaben und lädt das Bild nicht erneut', async () => {
  const { el, radio } = setup({ state: st('playing') });
  await tick();
  const logo = el.byClass('radio-mini-logo')[0];
  assert.equal(logo.classList.contains('has-error'), false);
  el.find(n => n.tagName === 'img')[0].dispatch('error');
  assert.equal(logo.classList.contains('has-error'), true);
  radio.emitState(st('playing', { nowPlaying: { title: 'Neu' } }));
  assert.equal(el.find(n => n.tagName === 'img').length, 0);
  assert.equal(logo.classList.contains('has-error'), true);
  assert.equal(el.byClass('radio-mini-logo-fallback')[0].textContent, 'E');
  radio.emitState(st('playing', { station: { ...STATION, logo: null } }));
  assert.equal(logo.classList.contains('has-error'), true);
});

test('Ansicht: Sendername öffnet das Radio-Dashboard; Aktionsfehler erscheinen als Hinweis', async () => {
  const { el, radio, notes, opened } = setup({ state: st('playing') });
  await tick();
  el.byId('radioMiniInfo').click();
  assert.equal(opened(), 1);
  radio.stop = async () => {
    throw new Error('weg');
  };
  el.byId('radioMiniStop').click();
  await tick();
  assert.deepEqual(notes, ['Radio: Stopp nicht möglich']);
});

test('Ansicht: Pfeiltasten in der Leiste erreichen keine Seitenkürzel; Stream-Daten nur per textContent', async () => {
  const { el, radio } = setup({ state: st('playing', { station: { ...STATION, name: '<b>X</b>' } }) });
  await tick();
  let stopped = 0;
  el.dispatch('keydown', { key: 'ArrowUp', stopPropagation: () => (stopped += 1) });
  el.dispatch('keydown', { key: 'a', stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 1);
  radio.emitState(st('playing', { station: { ...STATION, name: '<b>X</b>' }, nowPlaying: { artist: '', title: '<script>1</script>' } }));
  assert.equal(el.byClass('radio-mini-name')[0].textContent, '<b>X</b>');
  assert.equal(el.byClass('radio-mini-subtitle')[0].textContent, '<script>1</script>');
  assert.ok(el.find(n => /<b>|<script>/.test(n.innerHTML || '')).length === 0);
  assert.equal(el.getAttribute('role'), 'region');
  assert.equal(el.byId('radioMiniLive').getAttribute('aria-live'), 'polite');
});

// ───────── Verdrahtung ─────────

test('Verdrahtung: Navigation, Startkachel, Ort, Konflikt-Hooks und Vollbild-Ausblendung', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /\{ key: 'radio', label: 'Radio', icon: NAV_ICONS\.radio \}/);
  assert.match(renderer, /\{ key: 'radio', label: 'Radio', icon: 'radio-icon\.png', color: '#f59e0b' \}/);
  assert.ok(renderer.indexOf("key: 'livetv', label: 'LiveTV', icon: NAV_ICONS.livetv }") < renderer.indexOf("key: 'radio', label: 'Radio', icon: NAV_ICONS.radio }"));
  assert.match(renderer, /groupKey === 'radio'\s*\? 'Radio'/);
  assert.match(renderer, /if \(groupKey === 'radio'\) radioDashboardView\.refresh\(\)/);
  // Konflikt-Hooks: TV-Kanal, Streamingdienst, Aufnahme-Wiedergabe, Dashboard-Vollbildplayer
  const hooks = renderer.match(/pauseRadioForVideo\(\);/g) || [];
  assert.equal(hooks.length, 4);
  assert.match(renderer, /currentProvider = '__tv__';\s*switchWebview\(true\);\s*pauseRadioForVideo\(\);/);
  assert.match(renderer, /recordingPlayer\.style\.display = 'flex';\s*pauseRadioForVideo\(\);/);
  // Vollbild: Webview-Events und fullscreenchange blenden die Leiste aus
  assert.equal((renderer.match(/setHtmlFullscreen\((true|false)\)/g) || []).length, 4);
  assert.match(renderer, /radioMiniPlayerView\.setSuppressed\(htmlFullscreenActive \|\| Boolean\(document\.fullscreenElement\)\)/);
  // Radio-Start pausiert keine TV-Webviews: kein Radio-Aufruf in switchWebview/selectTvChannel außer dem Hook
  assert.ok(!/window\.radio\.play[\s\S]{0,80}switchWebview/.test(renderer));
  const html = read('index.html');
  assert.match(html, /id="radioMiniPlayer"[^>]*hidden/);
  assert.match(html, /id="radioDashboard"[^>]*hidden/);
  assert.ok(fs.existsSync(path.join(root, 'assets/icons/radio-icon.png')));
});

test('Verdrahtung: kein Strg+R/Strg+T-Konflikt — Radio bekommt kein eigenes Tastenkürzel', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /ctrlKey && \(key === 'r' \|\| key === 'R'\)\) \{\s*showDashboard\('recording'\)/);
  assert.match(renderer, /ctrlKey && \(key === 't' \|\| key === 'T'\)\) \{\s*showDashboard\('livetv'\)/);
  assert.ok(!/showDashboard\('radio'\);\s*return true/.test(renderer));
});

test('Verdrahtung: Radio-Ansichten setzen keine Daten per innerHTML (nur statische SVG-Icons)', () => {
  for (const file of ['radio-dashboard-view.js', 'radio-miniplayer-view.js']) {
    const lines = read(file).split('\n').filter(line => /innerHTML/.test(line) && !/^\s*\/\//.test(line));
    for (const line of lines) assert.match(line, /ICON|ICONS|statisches SVG/, `${file}: ${line.trim()}`);
  }
});
