'use strict';

// Tests: Verdrahtung des neuen Programmführers (Etappe 3.3) — Altcode ist ersetzt, ohne tote
// Referenzen; Einstiege, Esc-Kette und Planungsweg laufen über epg-view.js und die bestehende
// Planungs-Logik (handleEpgRecordClick → classifyProgramme → openSchedulePlanningDialog).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Altcode entfernt: keine Referenzen auf Zeitslot-Buttons, altes Raster und altes Detail-Modal', () => {
  const dead = ['epgSlotHours', 'epgRangeLabel', 'epg-slot-btn', 'epg-timeslots', 'renderEpg', 'showEpgDetail', 'closeEpgDetail', 'setEpgDetailNotice', 'epgDetailActions'];
  for (const file of ['renderer.js', 'index.html', 'styles.css']) {
    const src = read(file);
    for (const name of dead) assert.ok(!src.includes(name), `${file} enthält noch ${name}`);
  }
  for (const name of ['epg-grid', 'epg-ruler', 'epg-programs-col', 'epg-channel-col', 'epg-time-marker', 'epgFadeIn']) {
    assert.ok(!read('styles.css').includes(name), `styles.css enthält noch ${name}`);
  }
});

test('Verdrahtung: Einstiege und Esc-Kette laufen über epg-view (Einstiege umgehängt)', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /dashboardEpgOpen\.addEventListener\('click', openEpgView\)/);
  assert.match(renderer, /tvSidebarEpgBtn\.addEventListener\('click', openEpgView\)/);
  assert.match(renderer, /epgView\.handleEscape\(\)/);
  assert.match(renderer, /createEpgView\(epgOverlay,/);
  // Planungsweg bleibt der bestehende: handleEpgRecordClick → classifyProgramme → openSchedulePlanningDialog
  assert.match(renderer, /function handleEpgRecordClick\(programme\)[\s\S]*classifyProgramme[\s\S]*openSchedulePlanningDialog/);
  // Titel/Beschreibung gehen unverändert in den Planungsdialog (kein Doppel-Decode)
  const fn = renderer.slice(renderer.indexOf('function handleEpgRecordClick'), renderer.indexOf('let recSchedulePending'));
  assert.ok(!fn.includes('decodeEntities'));
  const html = read('index.html');
  assert.equal(html.split('id="epgOverlay"').length - 1, 1);
  for (const gone of ['epgDetailBackdrop', 'epgBody', 'epgCloseBtn']) assert.ok(!html.includes(`id="${gone}"`), gone);
});

