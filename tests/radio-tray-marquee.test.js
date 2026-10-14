'use strict';

// Tests: Lauftext neben dem Tray-Symbol (lib/radio/tray-marquee.js): statisch bei kurzem Text, Pausen, Neustart,
// Schnitt nach Graphemen (Flaggen/Emoji/Umlaute), konstante Fensterbreite, Randfälle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { marqueeWindow, needsMarquee, clipGraphemes, graphemes, TRAY_WINDOW_WIDTH, MARQUEE_STEP_MS } = require('../lib/radio/tray-marquee.js');

const LONG = 'Radio Eins · Interpret – ein sehr langer Titel'; // 46 Zeichen
const frames = (text, count, options) => Array.from({ length: count }, (_, step) => marqueeWindow(text, step, options).text);

test('kurzer Text (≤ Fenster) bleibt statisch, kein Scrollen', () => {
  for (const text of ['', 'a', 'Zwei · I – T1', 'x'.repeat(TRAY_WINDOW_WIDTH)]) {
    const result = marqueeWindow(text, 7);
    assert.equal(result.text, text);
    assert.equal(result.scrolling, false);
    assert.equal(result.cycleSteps, 0);
    assert.equal(needsMarquee(text), false);
  }
  assert.equal(needsMarquee('x'.repeat(TRAY_WINDOW_WIDTH + 1)), true);
});

test('Ablauf: 2 s Pause am Anfang, dann ein Zeichen pro Schritt, 1,5 s Pause am Ende, Neustart', () => {
  const startPause = Math.ceil(2000 / MARQUEE_STEP_MS); // 5
  const endPause = Math.ceil(1500 / MARQUEE_STEP_MS); // 4
  const graphemeCount = graphemes(LONG).length;
  const maxOffset = graphemeCount - TRAY_WINDOW_WIDTH;
  const cycle = startPause + maxOffset - 1 + endPause;
  const all = frames(LONG, cycle + 3);
  const head = Array.from(LONG).slice(0, TRAY_WINDOW_WIDTH).join('');
  for (let i = 0; i < startPause; i++) assert.equal(all[i], head, `Schritt ${i}: Anfang gehalten`);
  assert.equal(all[startPause], Array.from(LONG).slice(1, TRAY_WINDOW_WIDTH + 1).join(''), 'danach 1 Zeichen pro Schritt');
  assert.equal(all[startPause + 1], Array.from(LONG).slice(2, TRAY_WINDOW_WIDTH + 2).join(''));
  const tail = Array.from(LONG).slice(-TRAY_WINDOW_WIDTH).join('');
  for (let i = startPause + maxOffset - 1; i < cycle; i++) assert.equal(all[i], tail, `Schritt ${i}: Ende gehalten`);
  assert.equal(marqueeWindow(LONG, 0).cycleSteps, cycle);
  assert.equal(all[cycle], head, 'Neustart am Anfang');
  assert.equal(marqueeWindow(LONG, -1).text, tail, 'negativer Schritt läuft zyklisch zurück');
});

test('Fensterbreite beim Scrollen konstant (Grapheme), auch mit Flaggen, Emoji, ZWJ und Umlauten', () => {
  const texts = [
    LONG,
    'Radio 🇩🇪 Deutschland · Ärger über Übergrößen – Straße 👨‍👩‍👧‍👦 Familie 👍🏽 ok',
    'é'.repeat(40), // e + kombinierender Akzent
  ];
  for (const text of texts) {
    const cycle = marqueeWindow(text, 0).cycleSteps;
    assert.ok(cycle > 0, 'scrollt');
    for (let step = 0; step < cycle; step++) {
      assert.equal(graphemes(marqueeWindow(text, step).text).length, TRAY_WINDOW_WIDTH, `Schritt ${step} von „${text.slice(0, 8)}“`);
    }
  }
});

test('Schnitt nach Graphemen: Flagge, Hautton-Emoji und ZWJ-Familie werden nie zerrissen', () => {
  const text = `${'a'.repeat(10)}🇩🇪👍🏽👨‍👩‍👧‍👦${'b'.repeat(40)}`;
  const cycle = marqueeWindow(text, 0).cycleSteps;
  const seen = new Set();
  for (let step = 0; step < cycle; step++) {
    const win = marqueeWindow(text, step).text;
    // Jede enthaltene Flagge/Familie ist vollständig, nie nur eine Hälfte
    assert.ok(!/(^|[^\u{1F1E6}-\u{1F1FF}])[\u{1F1E6}-\u{1F1FF}]([^\u{1F1E6}-\u{1F1FF}]|$)/u.test(win), `halbe Flagge in „${win}“`);
    assert.ok(!win.startsWith('‍') && !win.endsWith('‍'), 'ZWJ am Rand');
    assert.ok(!/^[\u{1F3FB}-\u{1F3FF}]/u.test(win), 'Hautton ohne Emoji am Anfang');
    for (const g of graphemes(win)) if (/[\u{1F1E6}-\u{1F1FF}]{2}|‍/u.test(g)) seen.add(g);
  }
  assert.ok(seen.has('🇩🇪') && seen.has('👨‍👩‍👧‍👦'));
  assert.equal(graphemes('🇩🇪👍🏽').length, 2);
});

test('clipGraphemes: kürzt nach Graphemen mit „…“, kurzer Text unverändert, Mindestbreite 2', () => {
  assert.equal(clipGraphemes('kurz'), 'kurz');
  const clipped = clipGraphemes('🇩🇪'.repeat(40));
  assert.equal(graphemes(clipped).length, TRAY_WINDOW_WIDTH);
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipGraphemes('Ärger Übel Öl', 5), 'Ärge…');
  assert.equal(clipGraphemes('abc', 1), 'a…');
  assert.equal(clipGraphemes(undefined), '');
});

test('einstellbare Breite und Pausen; Länge 0 und 1; ungültige Eingaben', () => {
  const opts = { width: 5, startPauseMs: 0, endPauseMs: 0, stepMs: 100 };
  assert.deepEqual(frames('abcdefg', 5, opts), ['abcde', 'bcdef', 'cdefg', 'abcde', 'bcdef'], 'Pausen mindestens ein Schritt');
  assert.equal(marqueeWindow('abcdefg', 0, { width: 5, startPauseMs: 200, endPauseMs: 100, stepMs: 100 }).cycleSteps, 2 + 2 - 1 + 1);
  assert.equal(marqueeWindow('', 3).text, '');
  assert.equal(marqueeWindow('x', 3).text, 'x');
  assert.equal(marqueeWindow(null, 3).text, '');
  assert.equal(marqueeWindow(LONG, NaN).text, marqueeWindow(LONG, 0).text);
  assert.equal(marqueeWindow(LONG, 2.9).text, marqueeWindow(LONG, 2).text);
});
