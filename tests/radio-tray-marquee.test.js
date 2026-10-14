'use strict';

// Tests: Lauftext neben dem Tray-Symbol (lib/radio/tray-marquee.js): statisch bei kurzem Text, Pausen, Neustart,
// Schnitt nach Graphemen (Flaggen/Emoji/Umlaute), konstante Fensterbreite, Randfälle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { marqueeWindow, needsMarquee, clipGraphemes, graphemes, TRAY_WINDOW_WIDTH, MARQUEE_STEP_MS, pixelMarqueeOffset, PIXEL_WINDOW_WIDTH, PIXEL_SPEED } = require('../lib/radio/tray-marquee.js');

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

// ── Pixelweiser Lauf (Modus „smooth“) ──

test('Pixel: Text im Fenster bleibt statisch (Versatz 0, kein Scrollen)', () => {
  for (const width of [0, 10, PIXEL_WINDOW_WIDTH]) {
    assert.deepEqual(pixelMarqueeOffset(5000, width), { scrolling: false, offset: 0, maxOffset: 0, cycleMs: 0 });
  }
  assert.equal(pixelMarqueeOffset(0, PIXEL_WINDOW_WIDTH + 1).scrolling, true);
  assert.equal(pixelMarqueeOffset(0, undefined).scrolling, false, 'ungültige Breite: statisch');
});

test('Pixel: 2 s Pause, dann ganze Pixel mit PIXEL_SPEED, 1,5 s Pause am Ende, Neustart', () => {
  const textWidth = PIXEL_WINDOW_WIDTH + 64; // 64 pt Weg
  const travelMs = (64 / PIXEL_SPEED) * 1000;
  const at = ms => pixelMarqueeOffset(ms, textWidth);
  assert.equal(at(0).offset, 0);
  assert.equal(at(1999).offset, 0, 'Anfangspause');
  assert.equal(at(2000).offset, 0);
  assert.equal(at(2000 + 1000 / PIXEL_SPEED + 1).offset, 1, 'erster Pixel nach 1/Speed Sekunden');
  assert.equal(at(2000 + 1000).offset, PIXEL_SPEED);
  assert.equal(at(2000 + travelMs).offset, 64, 'Ende des Weges');
  assert.equal(at(2000 + travelMs + 1400).offset, 64, 'Endpause');
  const cycle = at(0).cycleMs;
  assert.equal(cycle, 2000 + travelMs + 1500);
  assert.equal(at(cycle).offset, 0, 'Neustart am Anfang');
  assert.equal(at(cycle + 2000 + 1000).offset, PIXEL_SPEED, 'zweiter Durchlauf identisch');
  assert.equal(at(-1).offset, at(cycle - 1).offset, 'negative Zeit rechnet zyklisch');
  // monoton, ganzzahlig, nie außerhalb
  let previous = 0;
  for (let ms = 0; ms < cycle; ms += 16) {
    const { offset } = at(ms);
    assert.ok(Number.isInteger(offset) && offset >= 0 && offset <= 64);
    assert.ok(offset >= previous, 'kein Rückwärtslauf im Zyklus');
    previous = offset;
  }
});

test('Pixel: Breite wird aufgerundet, Optionen ersetzen Fenster, Tempo und Pausen', () => {
  assert.equal(pixelMarqueeOffset(0, 100.2, { windowWidth: 100 }).maxOffset, 1);
  const quick = pixelMarqueeOffset(0, 200, { windowWidth: 100, speed: 100, startPauseMs: 0, endPauseMs: 0 });
  assert.equal(quick.cycleMs, 1000);
  assert.equal(pixelMarqueeOffset(500, 200, { windowWidth: 100, speed: 100, startPauseMs: 0, endPauseMs: 0 }).offset, 50);
});
