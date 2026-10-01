'use strict';

// Tests: Aufnahme Fix-Set 4b — „Aufnahmen“ als reguläres Dashboard (Karte t_4c447922)
// Basis: Fix-Set 3 (t_ce5a874b) + User-Ergänzung 01.10: kein Overlay mehr.
// 1) Dashboard-Kachel „Aufnahmen“ zwischen Mediatheken und Einstellungen
// 2) Navbar-Eintrag „Aufnahmen“ im Mediatheken-Stil (nav-section-item, kein Button-Addon)
// 3) PiP- und Settings-Buttons in der Navbar ENTFERNT (UI), Funktion schläft
// 4) Aufnahmen-Dashboard rendert regulär in dashboardGrid (showDashboard-Route)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('FIX 1: Navbar hat keinen PiP-Button mehr (Markup)', () => {
  assert.ok(!indexHtml.includes('id="pipBtn"'), 'pipBtn-Markup muss entfernt sein');
});

test('FIX 2: Navbar hat keinen Settings-Button mehr (Markup)', () => {
  assert.ok(!indexHtml.includes('id="settingsBtn"'), 'settingsBtn-Markup muss entfernt sein');
});

test('FIX 3: Startdashboard-Kachel „Aufnahmen“ zwischen Mediatheken und Einstellungen', () => {
  const sectionsLiteral = /const sections = \[[\s\S]*?\];/.exec(rendererJs)?.[0] || '';
  const mIdx = sectionsLiteral.indexOf("key: 'mediathek'");
  const rIdx = sectionsLiteral.indexOf("key: 'recording'");
  const sIdx = sectionsLiteral.indexOf("key: 'settings'");
  assert.ok(rIdx > -1, 'recording-Section fehlt im Startdashboard');
  assert.ok(mIdx < rIdx && rIdx < sIdx, 'Reihenfolge muss Mediatheken → Aufnahmen → Einstellungen sein');
});

test('FIX 3a: Kachel-Art nutzt generiertes Bild im Familien-Stil', () => {
  assert.ok(
    /\.dashboard-section-recording \.dashboard-section-tile-art \{[^}]*url\('assets\/icons\/recordings-tile\.png'\)/.test(stylesCss),
    'recording-Kachel-Art muss das generierte Bild als background referenzieren',
  );
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'icons', 'recordings-tile.png')), 'Kachel-Bild fehlt in assets/icons/');
});

test('FIX 3b: Navbar-Eintrag „Aufnahmen“ im Mediatheken-Stil (nav-section-item)', () => {
  const groupsLiteral = /const groups = \[[\s\S]*?\];/.exec(rendererJs)?.[0] || '';
  assert.ok(groupsLiteral.includes("key: 'recording'"), 'recording-Gruppe fehlt in renderNav');
  // gleicher nav-section-item-Stil wie Mediatheken:
  assert.ok(rendererJs.includes("btn.className = 'nav-item nav-section-item'"), 'nav-section-item-Klasse nicht gesetzt');
  assert.ok(rendererJs.includes("label: 'Aufnahmen'"), 'Label „Aufnahmen“ fehlt in renderNav');
});

test('FIX 3c: showDashboard behandelt recording als Dashboard-Gruppe (kein Overlay)', () => {
  assert.ok(
    rendererJs.includes("classList.toggle('recordings-dashboard', groupKey === 'recording'"),
    'dashboardView recordings-dashboard-Klassen-Toggle fehlt',
  );
  assert.ok(
    /groupKey === 'recording'[\s\S]{0,40}\? 'Aufnahmen'/.test(rendererJs),
    'overlayLocation/Title-Zweig für recording fehlt',
  );
  assert.ok(
    rendererJs.includes('renderRecordingDashboard()'),
    'renderRecordingDashboard-Pfad fehlt',
  );
  // kein Overlay mehr:
  assert.ok(!rendererJs.includes("recordingsOverlay"), 'recordingsOverlay-Referenzen sind obsolet (Dashboard statt Overlay)');
});

test('FIX 4: recordings-Overlay-Markup entfernt', () => {
  assert.ok(!indexHtml.includes('id="recordingsOverlay"'), 'Overlay-Markup muss entfernt sein');
});
