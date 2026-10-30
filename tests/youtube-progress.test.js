'use strict';

// Tests: Regeln des YouTube-Wiedergabefortschritts (lib/youtube-progress.js, 1:1 wie YouTubeProgress auf dem iPad),
// Speicher-Format und Adress-Erkennung des Seitenskripts (Wiedergabeseite, Shorts, feste Startzeit).

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ENTRIES, recording, resumePosition, clampResume, normalizeEntries } = require('../lib/youtube-progress.js');
const { progressVideoId, progressHasStartTime } = require('../lib/youtube-progress-page.js');

const ID = 'dQw4w9WgXcQ';
const entry = (position, duration = 600, updated = 1, id = ID) => ({ id, position, duration, updated });

test('Aufzeichnen und Fortsetzen', () => {
  const list = recording([], ID, 120, 600, 1);
  assert.deepEqual(list, [entry(120)]);
  assert.equal(resumePosition(list[0]), 120);
});

test('Letzte 10 Sekunden: Eintrag wird gelöscht, Fortsetzen beginnt bei 0', () => {
  assert.equal(resumePosition(entry(595)), 0);
  assert.equal(resumePosition(entry(590)), 0);
  assert.equal(resumePosition(entry(589)), 589);
  assert.deepEqual(recording([entry(100)], ID, 592, 600, 2), []);
  assert.deepEqual(recording([entry(100)], ID, 600, 600, 2), []);
});

test('Anfang unter 3 Sekunden wird nicht gemerkt und ändert einen bestehenden Eintrag nicht', () => {
  const old = [entry(100)];
  assert.equal(recording(old, ID, 1, 600, 2), old);
  assert.deepEqual(recording([], ID, 2.9, 600, 2), []);
  assert.equal(resumePosition(entry(2)), 0);
  assert.equal(recording([], ID, 3, 600, 2).length, 1);
});

test('Ungültige Eingaben werden ignoriert; unbekannte Dauer (NaN/Infinity) wird 0 und setzt trotzdem fort', () => {
  assert.deepEqual(recording([], 'kurz', 50, 100, 1), []);
  assert.deepEqual(recording([], ID, NaN, 100, 1), []);
  assert.deepEqual(recording([], ID, Infinity, 100, 1), []);
  assert.deepEqual(recording([], ID, -5, 100, 1), []);
  assert.equal(resumePosition(null), 0);
  assert.equal(resumePosition(entry(NaN)), 0);
  for (const d of [NaN, Infinity, -1]) {
    const list = recording([], ID, 50, d, 1);
    assert.equal(list[0].duration, 0);
    assert.equal(resumePosition(list[0]), 50);
  }
});

test('Höchstens 200 Einträge: die ältesten nach updated fallen heraus', () => {
  let list = [];
  for (let n = 0; n < 205; n++) list = recording(list, 'vid' + String(n).padStart(8, '0'), 30, 600, n);
  assert.equal(list.length, MAX_ENTRIES);
  assert.ok(!list.some(e => e.id === 'vid00000000'));
  assert.ok(list.some(e => e.id === 'vid00000204'));
});

test('Aktualisieren verschiebt statt zu verdoppeln', () => {
  let list = recording([], ID, 30, 600, 1);
  list = recording(list, ID, 60, 600, 2);
  assert.equal(list.length, 1);
  assert.equal(list[0].position, 60);
});

test('Fortsetzen höchstens bis Dauer − 11 s; nichts unter 3 s', () => {
  assert.equal(clampResume(100, 600), 100);
  assert.equal(clampResume(595, 600), 589);
  assert.equal(clampResume(50, 20), 9);
  assert.equal(clampResume(5, 8), 0);
  assert.equal(clampResume(50, NaN), 50);
  assert.equal(clampResume(50, Infinity), 50);
  assert.equal(clampResume(2, 600), 0);
  assert.equal(clampResume(NaN, 600), 0);
});

test('Laden im iPad-Format: Array in Sekunden; unlesbar → leer, ungültige IDs verworfen, höchstens 200 (die letzten)', () => {
  assert.deepEqual(normalizeEntries([{ id: ID, position: 12.5, duration: 300, updated: 1766000000 }]), [{ id: ID, position: 12.5, duration: 300, updated: 1766000000 }]);
  for (const bad of [null, undefined, 'x', 5, {}, { version: 1, items: [entry(10)] }]) assert.deepEqual(normalizeEntries(bad), []);
  assert.deepEqual(normalizeEntries([entry(10, 100, 1, 'kurz'), null, entry(NaN), { id: ID }, entry(10)]), [entry(10)]);
  const many = Array.from({ length: 250 }, (_, n) => entry(10, 100, n, 'vid' + String(n).padStart(8, '0')));
  const kept = normalizeEntries(many);
  assert.equal(kept.length, 200);
  assert.equal(kept[0].id, 'vid00000050');
});

test('Seitenskript: Video-ID nur von der Wiedergabeseite (keine Shorts, Start, Suche, fremde Hosts)', () => {
  assert.equal(progressVideoId(`https://www.youtube.com/watch?v=${ID}&list=PLx`), ID);
  assert.equal(progressVideoId(`https://m.youtube.com/watch?v=${ID}`), ID);
  for (const href of [`https://www.youtube.com/shorts/${ID}`, 'https://www.youtube.com/', 'https://www.youtube.com/results?search_query=x', `https://example.org/watch?v=${ID}`, 'https://www.youtube.com/watch?v=zu-kurz', 'kaputt', '']) {
    assert.equal(progressVideoId(href), '', href);
  }
});

test('Seitenskript: feste Startzeit (t= oder start=) in der Adresse wird erkannt', () => {
  assert.equal(progressHasStartTime(`https://www.youtube.com/watch?v=${ID}&t=90s`), true);
  assert.equal(progressHasStartTime(`https://www.youtube.com/watch?v=${ID}&t=90`), true);
  assert.equal(progressHasStartTime(`https://www.youtube.com/embed/${ID}?start=30`), true);
  assert.equal(progressHasStartTime(`https://www.youtube.com/watch?v=${ID}`), false);
  assert.equal(progressHasStartTime(`https://www.youtube.com/watch?v=${ID}&list=PLx&index=2`), false);
  assert.equal(progressHasStartTime('kaputt'), false);
});
