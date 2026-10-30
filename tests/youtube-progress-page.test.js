'use strict';

// Tests: Seitenskript des Fortschritts (lib/youtube-progress-page.js) in einem vm-Kontext mit Fake-DOM:
// Meldungen (Pause, Ende, Seitenwechsel, 5-s-Takt), Fortsetzen (einmal, Deckel Dauer − 11 s), feste Startzeit, Shorts, Livestream, Werbung.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildProgressScript } = require('../lib/youtube-progress-page.js');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';

function makePage(href, { ready = false, extraVideos = [] } = {}) {
  const posted = [];
  const doc = {};
  const win = {};
  const intervals = [];
  const video = { tagName: 'VIDEO', closest: () => null, currentTime: 0, duration: 300, readyState: ready ? 4 : 0, paused: false, ended: false };
  let ad = false;
  const location = { href };
  const document = {
    addEventListener: (t, f) => (doc[t] = doc[t] || []).push(f),
    querySelector: sel => (sel.includes('ad-showing') ? (ad ? {} : null) : video),
    // extraVideos (z. B. Hover-Vorschau) stehen in DOM-Reihenfolge vor dem Hauptvideo
    querySelectorAll: sel => [...extraVideos, video].filter(v => (v === video ? sel.includes('video') : sel.includes('video'))),
  };
  const sync = [];
  const window = {
    addEventListener: (t, f) => (win[t] = win[t] || []).push(f),
    postMessage: m => posted.push(JSON.parse(JSON.stringify(m.__shProgress))),
    dispatchEvent: e => sync.push(JSON.parse(e.detail).__shProgress),
  };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  window.window = window;
  const context = vm.createContext({ window, document, location, URL, CustomEvent, setInterval: (fn, ms) => intervals.push({ fn, ms }) });
  vm.runInContext(buildProgressScript(), context);
  const fire = (type, target = video) => (doc[type] || []).forEach(f => f({ target }));
  const tick = ms => intervals.filter(i => i.ms === ms).forEach(i => i.fn());
  return {
    posted, sync, video, window, location,
    fire, tick,
    pagehide: () => (win.pagehide || []).forEach(f => f()),
    setAd: v => (ad = v),
    reports: () => posted.filter(m => m.type === 'report'),
  };
}

test('Start auf /watch: Position wird angefordert, nach loadedmetadata gesetzt (einmal), 5-s-Takt und Pause melden', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`);
  assert.deepEqual(p.posted, [{ type: 'need', id: A }]);
  p.window.__shProgressResume(A, 100);
  assert.equal(p.video.currentTime, 0); // Player trägt noch nichts: erst nach loadedmetadata
  p.video.readyState = 4;
  p.fire('loadedmetadata');
  assert.equal(p.video.currentTime, 100);
  p.video.currentTime = 105;
  p.fire('timeupdate');
  p.fire('canplay');
  assert.equal(p.video.currentTime, 105); // nur einmal je Aufruf
  p.tick(5000);
  assert.deepEqual(p.reports().pop(), { type: 'report', id: A, t: 105, d: 300 });
  p.video.paused = true;
  p.video.currentTime = 110;
  p.fire('pause');
  assert.deepEqual(p.reports().pop(), { type: 'report', id: A, t: 110, d: 300 });
  p.video.currentTime = 120;
  p.fire('seeked');
  assert.equal(p.reports().pop().t, 120);
  p.pagehide();
  assert.equal(p.reports().pop().t, 120);
});

test('Fortsetzen höchstens bis Dauer − 11 s', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`);
  p.window.__shProgressResume(A, 295);
  p.video.readyState = 4;
  p.fire('loadedmetadata');
  assert.equal(p.video.currentTime, 289);
});

test('Feste Startzeit in der Adresse (t=) gewinnt: kein Fortsetzen', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}&t=30s`);
  p.window.__shProgressResume(A, 100);
  p.fire('loadedmetadata');
  assert.equal(p.video.currentTime, 0);
});

test('Ende: Meldung mit Position = Dauer (Main löscht den Eintrag)', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`, { ready: true });
  p.fire('loadedmetadata');
  p.video.currentTime = 299;
  p.video.ended = true;
  p.fire('ended');
  assert.deepEqual(p.reports().pop(), { type: 'report', id: A, t: 300, d: 300 });
});

test('Videowechsel in der Seite (SPA): alter Stand wird bei yt-navigate-start gesichert, das neue Video fordert seine Position an', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`, { ready: true });
  p.fire('loadedmetadata');
  p.video.currentTime = 77;
  p.fire('timeupdate');
  p.fire('yt-navigate-start', null);
  assert.deepEqual(p.reports().pop(), { type: 'report', id: A, t: 77, d: 300 });
  p.location.href = `https://www.youtube.com/watch?v=${B}`;
  p.fire('yt-navigate-finish', null);
  assert.deepEqual(p.posted.pop(), { type: 'need', id: B });
  // Player trägt noch das alte Video: nichts darf unter der neuen ID gemeldet werden
  p.video.currentTime = 77;
  p.fire('timeupdate');
  p.tick(5000);
  assert.equal(p.reports().filter(r => r.id === B).length, 0);
  p.window.__shProgressResume(B, 40);
  p.video.currentTime = 0;
  p.video.duration = 500;
  p.video.readyState = 4;
  p.fire('loadedmetadata');
  assert.equal(p.video.currentTime, 40);
  p.video.currentTime = 41;
  p.fire('pause');
  assert.deepEqual(p.reports().pop(), { type: 'report', id: B, t: 41, d: 500 });
});

test('Wechsel ohne yt-navigate-start (nur Adressänderung): letzter bekannter Stand des alten Videos geht raus', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`, { ready: true });
  p.fire('loadedmetadata');
  p.video.currentTime = 60;
  p.fire('timeupdate');
  p.location.href = `https://www.youtube.com/watch?v=${B}`;
  p.tick(800);
  assert.deepEqual(p.reports().pop(), { type: 'report', id: A, t: 60, d: 300 });
});

test('Shorts, Startseite, Livestream und Werbung: nichts wird gemeldet oder gesetzt', () => {
  const shorts = makePage(`https://www.youtube.com/shorts/${A}`);
  shorts.fire('loadedmetadata');
  shorts.video.currentTime = 20;
  shorts.fire('pause');
  shorts.tick(5000);
  assert.deepEqual(shorts.posted, []);

  const live = makePage(`https://www.youtube.com/watch?v=${A}`);
  live.video.duration = Infinity;
  live.window.__shProgressResume(A, 100);
  live.fire('loadedmetadata');
  live.video.currentTime = 50;
  live.fire('pause');
  live.tick(5000);
  assert.equal(live.video.currentTime, 50);
  assert.deepEqual(live.reports(), []);

  const ads = makePage(`https://www.youtube.com/watch?v=${A}`);
  ads.fire('loadedmetadata');
  ads.setAd(true);
  ads.video.currentTime = 4;
  ads.video.duration = 15;
  ads.fire('pause');
  assert.deepEqual(ads.reports().filter(r => r.d !== 300), []); // nie die Werte der Werbung
});

test('Skript startet nur einmal je Seite', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`);
  const before = p.posted.length;
  vm.runInContext(buildProgressScript(), vm.createContext({ window: p.window, document: {}, location: p.location, URL, setInterval() {} }));
  assert.equal(p.posted.length, before);
});

test('Hauptvideo eindeutig: Hover-Vorschau-Video vor dem Hauptvideo in DOM-Reihenfolge wird verworfen', () => {
  const preview = { tagName: 'VIDEO', closest: sel => (sel.includes('ytd-video-preview') ? {} : null), currentTime: 9, duration: 30, readyState: 4, paused: false, ended: false };
  const p = makePage(`https://www.youtube.com/watch?v=${A}`, { ready: true, extraVideos: [preview] });
  p.fire('loadedmetadata');
  p.video.currentTime = 60;
  p.fire('pause');
  assert.deepEqual(p.reports().pop(), { type: 'report', id: A, t: 60, d: 300 });
  p.fire('pause', preview); // Ereignis der Vorschau zählt nicht
  assert.equal(p.reports().filter(r => r.d === 30).length, 0);
});

test('Werbung mit anderer Dauer bei t = Ende löscht keinen Eintrag (kein Report unter der Video-ID)', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`);
  p.setAd(true);
  p.video.duration = 15;
  p.video.readyState = 4;
  p.fire('loadedmetadata'); // Werbung: Dauer wird nicht als Hauptvideo festgehalten
  p.video.currentTime = 15;
  p.fire('timeupdate');
  p.fire('ended');
  p.setAd(false); // Klasse schon weg, Player trägt noch die Werbung (Dauer 15)
  p.fire('timeupdate');
  p.fire('ended');
  p.tick(5000);
  assert.deepEqual(p.reports(), []);
  p.video.duration = 300; // Hauptvideo
  p.video.currentTime = 0;
  p.fire('loadedmetadata');
  p.video.currentTime = 12;
  p.fire('pause');
  assert.deepEqual(p.reports().pop(), { type: 'report', id: A, t: 12, d: 300 });
});

test('pagehide: letzte Meldung kommt synchron per CustomEvent (nicht per postMessage)', () => {
  const p = makePage(`https://www.youtube.com/watch?v=${A}`, { ready: true });
  p.fire('loadedmetadata');
  p.video.currentTime = 77;
  p.fire('timeupdate');
  const before = p.reports().length;
  p.pagehide();
  assert.deepEqual(p.sync, [{ type: 'report', id: A, t: 77, d: 300 }]);
  assert.equal(p.reports().length, before);
});
