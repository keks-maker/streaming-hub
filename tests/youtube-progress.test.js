'use strict';

// Tests: Regeln des YouTube-Wiedergabefortschritts (lib/youtube-progress.js, 1:1 wie YouTubeProgress auf dem iPad),
// Speicher-Format und Adress-Erkennung des Seitenskripts (Wiedergabeseite, Shorts, feste Startzeit).

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ENTRIES, MAX_DONE_MARKS, DONE_RETENTION_SECONDS, recording, resumePosition, clampResume, normalizeEntries } = require('../lib/youtube-progress.js');
const { progressVideoId, progressHasStartTime } = require('../lib/youtube-progress-page.js');

const ID = 'dQw4w9WgXcQ';
const entry = (position, duration = 600, updated = 1, id = ID) => ({ id, position, duration, updated });

test('Aufzeichnen und Fortsetzen', () => {
  const list = recording([], ID, 120, 600, 1);
  assert.deepEqual(list, [entry(120)]);
  assert.equal(resumePosition(list[0]), 120);
});

test('Letzte 10 Sekunden: Eintrag wird zur Marke done, Fortsetzen beginnt bei 0', () => {
  assert.equal(resumePosition(entry(595)), 0);
  assert.equal(resumePosition(entry(590)), 0);
  assert.equal(resumePosition(entry(589)), 589);
  const mark = { id: ID, position: 0, duration: 600, updated: 2, done: true };
  assert.deepEqual(recording([entry(100)], ID, 592, 600, 2), [mark]);
  assert.deepEqual(recording([entry(100)], ID, 600, 600, 2), [mark]);
  assert.deepEqual(recording([], ID, 600, 600, 2), [mark]);
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

const DAY = 24 * 3600;
const vid = n => 'vid' + String(n).padStart(8, '0');
const doneMark = (updated, id = ID) => ({ id, position: 0, duration: 600, updated, done: true });

test('done-Marke: Leser behandeln sie wie nicht vorhanden (Fortsetzen 0), neue Wiedergabe belebt sie wieder', () => {
  assert.equal(resumePosition({ ...doneMark(1), position: 500 }), 0);
  const revived = recording([doneMark(1)], ID, 50, 600, 2);
  assert.deepEqual(revived, [entry(50, 600, 2)]);
  assert.equal(resumePosition(revived[0]), 50);
});

test('normalizeEntries behält done und unbekannte Felder; done nur bei true', () => {
  const raw = [{ ...entry(10, 100, 5), extra: { a: 1 } }, { ...doneMark(6, 'bbbbbbbbbbb'), x: 'y' }, { ...entry(10, 100, 7, 'ccccccccccc'), done: false }, { ...entry(10, 100, 8, 'ddddddddddd'), done: 'ja' }];
  assert.deepEqual(normalizeEntries(raw), [raw[0], raw[1], entry(10, 100, 7, 'ccccccccccc'), entry(10, 100, 8, 'ddddddddddd')]);
});

test('Zusatzfelder überleben recording()', () => {
  const list = recording([{ ...entry(30, 600, 1), extra: 'x' }], ID, 60, 600, 2);
  assert.deepEqual(list, [{ id: ID, position: 60, duration: 600, updated: 2, extra: 'x' }]);
});

test('Marken: höchstens 100 und nur 30 Tage (Grenze: ab 30 Tagen weg); lebende zählen getrennt (200)', () => {
  assert.equal(MAX_DONE_MARKS, 100);
  const now = 100 * DAY;
  const marks = Array.from({ length: 120 }, (_, n) => doneMark(now - 1000 - n, vid(n)));
  const live = Array.from({ length: 210 }, (_, n) => entry(30, 600, n, vid(1000 + n)));
  const out = normalizeEntries([...marks, ...live], now);
  assert.equal(out.filter(e => e.done).length, 100);
  assert.equal(out.filter(e => !e.done).length, 200);
  assert.ok(!out.some(e => e.id === vid(119)));
  assert.equal(normalizeEntries([doneMark(now - DONE_RETENTION_SECONDS)], now).length, 0);
  assert.equal(normalizeEntries([doneMark(now - DONE_RETENTION_SECONDS + 1)], now).length, 1);
  assert.equal(normalizeEntries([doneMark(1)]).length, 1, 'ohne now keine Frist');
});

test('recording kürzt Marken und lebende Einträge getrennt', () => {
  let list = [];
  for (let n = 0; n < 101; n++) list = recording(list, vid(n), 600, 600, 10 + n);
  assert.equal(list.length, 100);
  assert.ok(!list.some(e => e.id === vid(0)));
  list = recording(list, 'zzzzzzzzzzz', 30, 600, 500);
  assert.equal(list.length, 101);
});
