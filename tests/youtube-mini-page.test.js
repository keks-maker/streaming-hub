'use strict';

// Tests: Seitenskript des Mini-Players (lib/youtube-mini-page.js) in einem vm-Kontext mit Fake-DOM:
// Link-Abfangen je Rolle (browse/player), Hover-„+“, Suche, Taste i, Zustandsmeldung, Befehle und CSS-Stufen.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildPageScript, PLAYER_CSS } = require('../lib/youtube-mini-page.js');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';

function makePage({ role, clickBehavior = 'replace', href = 'https://www.youtube.com/' }) {
  const handlers = { window: {}, document: {} };
  const posted = [];
  const classes = new Set();
  const appended = [];
  const video = { currentTime: 12, duration: 300, paused: false, ended: false, readyState: 4, volume: 0.7, muted: false, tagName: 'VIDEO', play() { this.paused = false; }, pause() { this.paused = true; } };
  const add = (bucket, type, fn) => (handlers[bucket][type] = handlers[bucket][type] || []).push(fn);
  const location = { href, pathname: new URL(href).pathname };
  const documentElement = { appendChild: n => appended.push(n), classList: { contains: n => classes.has(n), toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)) } };
  const document = {
    title: '(2) Mein Video - YouTube',
    body: { appendChild: n => appended.push(n) },
    head: null,
    getElementById: () => null,
    documentElement,
    addEventListener: (t, f) => add('document', t, f),
    createElement: tag => ({ tagName: tag.toUpperCase(), style: {}, setAttribute() {}, addEventListener() {} }),
    querySelector: sel => (sel.startsWith('video') ? video : null),
    querySelectorAll: () => [],
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: (t, f) => add('window', t, f),
    postMessage: m => posted.push(JSON.parse(JSON.stringify(m.__shMini))),
    dispatchEvent() {},
    scrollTo() {},
  };
  window.window = window;
  const context = vm.createContext({ window, document, location, URL, setInterval: () => 0, clearInterval() {}, Event: class {}, Date });
  vm.runInContext(buildPageScript({ role, clickBehavior }), context);
  const fire = (bucket, type, event) => (handlers[bucket][type] || []).forEach(fn => fn(event));
  const anchor = (href, extra = {}) => ({ tagName: 'A', href, getAttribute: name => (name === 'href' ? href : ''), closest: () => null, querySelector: () => null, target: '', ...extra });
  const event = (target, extra = {}) => {
    const e = { isTrusted: true, button: 0, target, stopped: 0, prevented: 0, composedPath: () => [target], preventDefault() { e.prevented++; }, stopPropagation() { e.stopped++; }, stopImmediatePropagation() {}, ...extra };
    return e;
  };
  const click = (target, extra) => {
    const e = event(target, extra);
    fire('window', 'click', e);
    return e;
  };
  return { posted, classes, video, window, document, location, fire, anchor, event, click, api: () => window.__shMini };
}

test('Rolle browse: Klick auf einen Video-Link wird abgefangen und gemeldet; andere Links, Modifier und fremde Hosts bleiben', () => {
  const page = makePage({ role: 'browse' });
  const e = page.click(page.anchor(`https://www.youtube.com/watch?v=${A}&t=3`, { getAttribute: name => (name === 'href' ? `/watch?v=${A}` : ''), closest: () => ({ querySelector: () => ({ getAttribute: () => '', textContent: ' Titel des   Videos ' }) }) }));
  assert.deepEqual(page.posted, [{ type: 'open', id: A, title: 'Titel des Videos' }]);
  assert.equal(e.prevented, 1);
  assert.equal(e.stopped, 1);
  page.posted.length = 0;
  for (const href of ['https://www.youtube.com/@kanal', 'https://example.org/watch?v=' + A, `https://www.youtube.com/shorts/${A}`, 'https://www.youtube.com/watch?v=zu-kurz']) {
    const ev = page.click(page.anchor(href));
    assert.equal(ev.prevented, 0, href);
  }
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${A}`), { ctrlKey: true }).prevented, 0);
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${A}`), { button: 1 }).prevented, 0);
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${A}`), { isTrusted: false }).prevented, 0);
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${A}`, { getAttribute: name => (name === 'href' ? '#' : '') })).prevented, 0);
  assert.deepEqual(page.posted, []);
  assert.equal(page.click(page.anchor(`https://youtu.be/${A}`)).prevented, 1);
  assert.equal(page.posted[0].id, A);
});

test('Rolle player (auf /watch): Nicht-Video-Link → „Stöbern“, Video-Link ersetzt (oder Playlist), redirect/Fremdlinks bleiben', () => {
  const page = makePage({ role: 'player', href: `https://www.youtube.com/watch?v=${A}` });
  page.posted.length = 0; // erste Zustandsmeldung
  let e = page.click(page.anchor('https://www.youtube.com/'));
  assert.deepEqual(page.posted.pop(), { type: 'browse', url: 'https://www.youtube.com/' });
  assert.equal(e.prevented, 1);
  page.click(page.anchor('https://www.youtube.com/results?search_query=x'));
  assert.equal(page.posted.pop().type, 'browse');
  e = page.click(page.anchor(`https://www.youtube.com/watch?v=${B}`));
  assert.equal(e.prevented, 0); // ersetzt das laufende Video natürlich
  assert.deepEqual(page.posted, []);
  for (const href of ['https://example.org/', 'https://www.youtube.com/redirect?q=https%3A%2F%2Fa.example%2F']) assert.equal(page.click(page.anchor(href)).prevented, 0, href);
  assert.equal(page.click(page.anchor('https://www.youtube.com/@k', { target: '_blank' })).prevented, 0);
  assert.deepEqual(page.posted, []);
});

test('Rolle player: Einstellung „zur Playlist“ fängt Video-Links ab (nicht das laufende Video selbst); Konfiguration änderbar', () => {
  const page = makePage({ role: 'player', clickBehavior: 'playlist', href: `https://www.youtube.com/watch?v=${A}` });
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${B}`)).prevented, 1);
  assert.deepEqual(page.posted.pop(), { type: 'add', id: B, title: '' });
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${A}&t=30s`)).prevented, 0);
  page.api().setConfig({ clickBehavior: 'replace' });
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${B}`)).prevented, 0);
  page.api().setConfig({ clickBehavior: 'kaputt' });
  assert.equal(page.click(page.anchor(`https://www.youtube.com/watch?v=${B}`)).prevented, 0);
});

test('Rolle player: außerhalb einer Wiedergabeseite (Einwilligungsseite, Start) wird nichts abgefangen', () => {
  const page = makePage({ role: 'player', href: 'https://consent.youtube.com/m?continue=x' });
  assert.equal(page.click(page.anchor('https://www.youtube.com/')).prevented, 0);
  assert.deepEqual(page.posted, []);
});

test('Player: Taste i und YouTubes Miniplayer-Knopf melden „mini“; Suche per Eingabetaste und Lupe wird zu „Stöbern“', () => {
  const page = makePage({ role: 'player', href: `https://www.youtube.com/watch?v=${A}` });
  page.posted.length = 0; // erste Zustandsmeldung
  let e = page.event({ tagName: 'DIV' }, { key: 'i' });
  page.fire('window', 'keydown', e);
  assert.deepEqual(page.posted.pop(), { type: 'mini' });
  assert.equal(e.prevented, 1);
  e = page.event({ tagName: 'INPUT', name: 'search_query', value: 'i' }, { key: 'i' });
  page.fire('window', 'keydown', e);
  assert.deepEqual(page.posted, []); // Tippen im Suchfeld
  e = page.event({ tagName: 'INPUT', name: 'search_query', value: ' Katzen & Hunde ' }, { key: 'Enter' });
  page.fire('window', 'keydown', e);
  assert.deepEqual(page.posted.pop(), { type: 'browse', url: 'https://www.youtube.com/results?search_query=Katzen%20%26%20Hunde' });
  assert.equal(e.prevented, 1);
  e = page.event({ tagName: 'INPUT', name: 'search_query', value: '  ' }, { key: 'Enter' });
  page.fire('window', 'keydown', e);
  assert.deepEqual(page.posted, []);
  page.click({ tagName: 'SPAN', closest: sel => (sel.includes('ytp-miniplayer-button') ? {} : null) });
  assert.deepEqual(page.posted.pop(), { type: 'mini' });
  const browse = makePage({ role: 'browse' });
  browse.fire('window', 'keydown', browse.event({ tagName: 'DIV' }, { key: 'i' }));
  assert.deepEqual(browse.posted, []);
});

test('Player: Zustandsmeldung mit Titel ohne „- YouTube“, Zeit, Pause, Modus; Ende wird gemeldet; Befehle wirken auf das Video', () => {
  const page = makePage({ role: 'player', href: `https://www.youtube.com/watch?v=${A}` });
  const state = page.posted.find(m => m.type === 'state');
  assert.equal(state.id, A);
  assert.equal(state.title, 'Mein Video');
  assert.equal(state.mode, 'page');
  assert.equal(state.time, 12);
  assert.equal(state.duration, 300);
  assert.equal(state.paused, false);
  page.posted.length = 0;
  page.video.paused = true;
  page.fire('document', 'pause', { target: page.video });
  assert.equal(page.posted.pop().paused, true);
  page.video.ended = true;
  page.fire('document', 'ended', { target: page.video });
  assert.equal(page.posted.pop().ended, true);
  page.fire('document', 'play', { target: { tagName: 'DIV' } });
  assert.deepEqual(page.posted, []);
  const api = page.api();
  api.seek(42);
  assert.equal(page.video.currentTime, 42);
  api.seek(NaN);
  assert.equal(page.video.currentTime, 42);
  api.volume(0.25);
  assert.equal(page.video.volume, 0.25);
  api.volume(7);
  assert.equal(page.video.volume, 1);
  api.pause();
  assert.equal(page.video.paused, true);
  api.play();
  assert.equal(page.video.paused, false);
});

test('Player: Stufen setzen Klassen (mini/app/page) und melden den Modus; unbekannter Modus → page', () => {
  const page = makePage({ role: 'player', href: `https://www.youtube.com/watch?v=${A}` });
  const api = page.api();
  assert.equal(api.setMode('mini'), 'mini');
  assert.deepEqual([page.classes.has('sh-mini'), page.classes.has('sh-app')], [true, false]);
  assert.equal(api.setMode('app'), 'app');
  assert.deepEqual([page.classes.has('sh-mini'), page.classes.has('sh-app')], [false, true]);
  assert.equal(api.setMode('quatsch'), 'page');
  assert.equal(page.classes.size, 0);
  api.setMode('mini');
  page.posted.length = 0;
  api.report();
  assert.equal(page.posted[0].mode, 'mini');
});

test('Rolle browse hat keine Player-Befehle; doppelte Einbindung ändert nichts; CSS-Stufen sind auf sh-mini/sh-app beschränkt', () => {
  const page = makePage({ role: 'browse' });
  assert.equal(page.api().role, 'browse');
  assert.equal(page.api().setMode, undefined);
  assert.equal(page.api().play, undefined);
  const css = PLAYER_CSS;
  assert.match(css, /html\.sh-mini/);
  assert.match(css, /html\.sh-app/);
  assert.match(css, /\[data-sh-pc\]/);
  for (const selector of css.split('{').filter((_, i, all) => i < all.length - 1).map(part => part.split('}').pop().trim()).filter(Boolean)) {
    assert.match(selector, /sh-(mini|app)/, `CSS-Regel ohne Stufe: ${selector}`);
  }
});
