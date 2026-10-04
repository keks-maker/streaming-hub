'use strict';

// Uhrzeit-Texte („ab 20:07“) sind lokale Zeit: für reproduzierbare Läufe fest auf Berlin.
process.env.TZ = 'Europe/Berlin';

// Tests: Planungs-UI — Modell (Zukunfts-Regel, Texte, Sortierung) und statische
// Renderer-Invarianten im Stil der recorder-fixset*-Tests (kein innerHTML mit
// EPG-Daten, Whitelist, tv.html unberührt, Fokus-Trap/Esc, Navbar schlank).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../lib/recorder/schedule-ui-model.js');

const ROOT = path.join(__dirname, '..');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MIN = 60 * 1000;

test('Zukunfts-Regel: future / running / past / invalid mit den Meldungen aus §3.7', () => {
  const now = Date.parse('2026-10-05T20:00:00+02:00');
  assert.deepEqual(ui.classifyProgramme(now + MIN, now + 30 * MIN, now), { state: 'future', message: null });
  // Grenzfall: Start in 1 min (kürzer als der Vorlaufpuffer) bleibt planbar
  assert.equal(ui.classifyProgramme(now + 1000, now + 30 * MIN, now).state, 'future');
  // Start == jetzt zählt als laufend (epgStart ≤ jetzt)
  const running = ui.classifyProgramme(now, now + 30 * MIN, now);
  assert.equal(running.state, 'running');
  assert.equal(
    running.message,
    'Diese Sendung läuft bereits und kann nicht mehr geplant werden. Zum Aufnehmen der laufenden Sendung nutze den Aufnahme-Button im Player.',
  );
  assert.equal(ui.classifyProgramme(now - 10 * MIN, now + MIN, now).state, 'running');
  const past = ui.classifyProgramme(now - 60 * MIN, now - 30 * MIN, now);
  assert.equal(past.state, 'past');
  assert.equal(past.message, 'Diese Sendung ist bereits vorbei und kann nicht aufgenommen werden.');
  assert.equal(ui.classifyProgramme(now - MIN, now, now).state, 'past', 'Ende == jetzt ist vorbei');
  assert.equal(ui.classifyProgramme(NaN, now, now).state, 'invalid');
  assert.equal(ui.classifyProgramme(now + MIN, now, now).state, 'invalid');
});

test('ipcErrorMessage entfernt das Electron-Präfix', () => {
  assert.equal(
    ui.ipcErrorMessage(new Error("Error invoking remote method 'schedule:add': ScheduleError: Diese Sendung ist bereits geplant.")),
    'Diese Sendung ist bereits geplant.',
  );
  assert.equal(ui.ipcErrorMessage(new Error("Error invoking remote method 'schedule:add': Error: Titel fehlt")), 'Titel fehlt');
  assert.equal(ui.ipcErrorMessage('einfach'), 'einfach');
});

test('Statustexte: lesbare Meldungen bei missed/failed/Spätstart', () => {
  const base = { epgStart: '2026-10-05T20:00:00+02:00', epgStop: '2026-10-05T20:15:00+02:00' };
  assert.equal(ui.scheduleStatusText({ ...base, state: 'scheduled' }), 'Geplant');
  assert.match(ui.scheduleStatusText({ ...base, state: 'scheduled', allowOverLimit: true }), /Überschreitung bestätigt/);
  assert.equal(
    ui.scheduleStatusText({ ...base, state: 'recording', note: 'Spätstart: Aufnahme ab 20:07 (Sendung begann 20:00)' }),
    'Läuft — Spätstart: Aufnahme ab 20:07 (Sendung begann 20:00)',
  );
  assert.equal(ui.scheduleStatusText({ ...base, state: 'missed', note: 'Verpasst: App war aus' }), 'Verpasst: App war aus');
  assert.equal(ui.scheduleStatusText({ ...base, state: 'missed' }), 'Verpasst');
  assert.equal(ui.scheduleStatusText({ ...base, state: 'failed', note: 'Speicher knapp: nur 100 MB frei' }), 'Speicher knapp: nur 100 MB frei');
  assert.equal(ui.scheduleStatusText({ ...base, state: 'cancelled' }), 'Abgesagt');
  assert.equal(ui.scheduleStatusText({ ...base, state: 'done' }), 'Aufgenommen');
});

test('Sortierung: Anstehend nach Start, Verlauf neueste zuerst und begrenzt', () => {
  const e = (id, start, state) => ({ id, state, epgStart: start, epgStop: start });
  const { upcoming, history } = ui.splitScheduleEntries([
    e('b', '2026-10-06T20:00:00+02:00', 'scheduled'),
    e('a', '2026-10-05T20:00:00+02:00', 'recording'),
    e('c', '2026-10-01T20:00:00+02:00', 'done'),
    e('d', '2026-10-03T20:00:00+02:00', 'missed'),
    e('x', '2026-10-02T20:00:00+02:00', 'cancelled'),
  ], { historyLimit: 2 });
  assert.deepEqual(upcoming.map(x => x.id), ['a', 'b']);
  assert.deepEqual(history.map(x => x.id), ['d', 'x']);
});

test('Texte: Konflikt, Mittelpunkt-Regel und „eine durchgehende Aufnahme“ sind sichtbar', () => {
  assert.equal(ui.describeConflict({ exceeds: false }), '');
  const c = ui.describeConflict({ exceeds: true, maxConcurrent: 4, limit: 3, overlapping: [{ label: 'ZDF — heute' }, { label: 'Arte (läuft)' }] });
  assert.match(c, /bis zu 4 Aufnahmen gleichzeitig \(erlaubt sind 3\)/);
  assert.match(c, /ZDF — heute; Arte \(läuft\)/);
  assert.equal(ui.describeAdjacency(null), '');
  const a = ui.describeAdjacency({
    title: 'Tagesschau', position: 'before', midpointIso: '2026-10-05T18:15:00Z',
    firstAfterSec: 0, secondBeforeSec: 120, canMerge: true,
    merged: { title: 'Tagesschau + Tagesthemen', epgStart: '2026-10-05T20:00:00+02:00', epgStop: '2026-10-05T20:45:00+02:00' },
  });
  assert.match(a, /„Tagesschau“ direkt vorher geplant/);
  assert.match(a, /Eine durchgehende Aufnahme/);
  assert.match(a, /Tagesschau \+ Tagesthemen/);
  assert.match(a, /wechseln um/);
});

test('Renderer: Planungs-Code rendert EPG-Daten nie über innerHTML', () => {
  const from = rendererJs.indexOf('// ── Planung: „Aufnehmen“ im EPG-Detail');
  const to = rendererJs.indexOf('// ── TV Keyboard shortcut');
  assert.ok(from > 0 && to > from);
  const dialogCode = rendererJs.slice(from, to);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(dialogCode), 'Planungsdialog: kein innerHTML');
  const listFrom = rendererJs.indexOf('// ── Planungsliste „Geplant“');
  const listTo = rendererJs.indexOf('/**\n * Wiedergabe über bestehenden Player');
  assert.ok(listFrom > 0 && listTo > listFrom);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(rendererJs.slice(listFrom, listTo)), 'Planungsliste: kein innerHTML');
  // Dashboard-Kopf/Tabs ebenfalls nur textContent
  const dashFrom = rendererJs.indexOf('function renderRecordingDashboard()');
  assert.ok(!/innerHTML\s*=\s*`/.test(rendererJs.slice(dashFrom, listFrom).replace("dashboardGrid.innerHTML = ''", '')));
  // Vorbelegung des EPG-Detail-Hinweises ebenfalls als Text
  assert.match(rendererJs, /epgDetailNotice\.textContent = message/);
});

test('Renderer: Zukunfts-Regel im EPG-Detail — Button immer sichtbar, Meldungen ersetzen den Dialog', () => {
  assert.match(rendererJs, /recordBtn\.textContent = '● Aufnehmen'/);
  assert.match(rendererJs, /handleEpgRecordClick\(data\)/);
  const fn = rendererJs.slice(rendererJs.indexOf('function handleEpgRecordClick'), rendererJs.indexOf('let recSchedulePending'));
  assert.match(fn, /classifyProgramme/);
  assert.match(fn, /verdict\.state !== 'future'/);
  assert.match(fn, /setEpgDetailNotice\(verdict\.message\);\s*return;/, 'bei running/past: Meldung und Abbruch vor dem Dialog');
  assert.match(fn, /openSchedulePlanningDialog/);
});

test('Renderer: Planungsdialog — Esc, Fokus-Trap, Verwerfen/„Trotzdem planen“, Hinweistext, kein Dialog-Duplikat', () => {
  const code = rendererJs.slice(rendererJs.indexOf('function openSchedulePlanningDialog'), rendererJs.indexOf('// ── TV Keyboard shortcut'));
  assert.match(code, /ev\.key === 'Escape'/);
  assert.match(code, /ev\.key === 'Tab'/);
  assert.match(code, /if \(recSchedulePending\) return;/, 'kein zweites Listener-Paar');
  assert.match(code, /'Trotzdem planen'/);
  assert.match(code, /allowOverLimit: true/);
  assert.match(code, /mergeWithId: state\.adjacency\.entryId/);
  assert.match(code, /findEpg\(key, ctx\.startMs\)/, 'Plausibilisierung gegen den Main-EPG-Cache');
  assert.match(code, /MSG_NO_EPG/);
  assert.match(indexHtml, /Streaming Hub muss zur Startzeit laufen \(das Fenster darf geschlossen sein\)\./);
  for (const id of ['recScheduleOverlay', 'recScheduleBefore', 'recScheduleAfter', 'recScheduleDiscard', 'recScheduleMerge', 'recScheduleConfirm', 'recScheduleAdjacency', 'recScheduleConflict']) {
    assert.ok(indexHtml.includes(`id="${id}"`), id);
  }
  assert.match(indexHtml, /role="dialog" aria-modal="true" aria-labelledby="recScheduleTitle"/);
});

test('Renderer/HTML: Tabs „Bibliothek“/„Geplant“, Live-Update, Leerzustand, Settings-Karte „Planung“', () => {
  assert.match(rendererJs, /\[\['library', 'Bibliothek'\], \['planned', 'Geplant'\]\]/);
  assert.match(rendererJs, /onScheduleChanged\?\.\(/);
  assert.match(rendererJs, /Keine Aufnahmen geplant\./);
  assert.match(rendererJs, /scheduleRowButton\('Bearbeiten'/);
  assert.match(rendererJs, /scheduleRowButton\('Absagen'/);
  assert.match(indexHtml, /<h4 class="settings-card-title">Planung<\/h4>/);
  for (const id of ['recBufferBeforeInput', 'recBufferAfterInput', 'recLateStartInput']) assert.ok(indexHtml.includes(`id="${id}"`), id);
  assert.match(rendererJs, /bufferBeforeMin/);
  assert.match(rendererJs, /patch\.lateStart = recLateStartInput\.checked/);
});

test('Randbedingungen: tv.html unberührt (kein Aufnahme-Button für Planung im Player), Navbar schlank', () => {
  const tvHtml = fs.readFileSync(path.join(ROOT, 'tv.html'), 'utf8');
  assert.ok(!/schedule|Aufnahme planen|recSchedule/i.test(tvHtml), 'tv.html enthält keine Planungs-Elemente');
  const nav = indexHtml.slice(indexHtml.indexOf('id="overlayNav"'), indexHtml.indexOf('id="overlayNav"') + 600);
  assert.ok(!/Geplant|schedule/i.test(nav), 'Navbar bekommt keinen Planungs-Eintrag');
});
