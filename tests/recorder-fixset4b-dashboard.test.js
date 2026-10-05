'use strict';

// Tests: Aufnahme Fix-Set 4b — „Aufnahmen“ als reguläres Dashboard (Karte t_4c447922)
// Basis: Fix-Set 3 (t_ce5a874b) + User-Ergänzung 01.10: kein Overlay mehr.
// 1) (bis 3.6b) Dashboard-Kachel „Aufnahmen“; seit 3.6b entfernt, Tests prüfen die Abwesenheit
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

test('FIX 3 (3.6b): Startdashboard hat keine Kachel „Aufnahmen“ mehr; Reihenfolge LiveTV → Streaming → Mediatheken → Einstellungen', () => {
  const sectionsLiteral = /const sections = \[[\s\S]*?\];/.exec(rendererJs)?.[0] || '';
  assert.ok(!sectionsLiteral.includes("key: 'recording'"), 'recording darf nicht mehr im Startdashboard stehen');
  const order = ['livetv', 'streaming', 'mediathek', 'settings'].map(k => sectionsLiteral.indexOf(`key: '${k}'`));
  assert.ok(order.every(i => i > -1), 'eine Bereichs-Kachel fehlt');
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'Reihenfolge muss LiveTV → Streaming → Mediatheken → Einstellungen sein');
  assert.ok(!rendererJs.includes("section.key === 'recording'"), 'Sonderfall rec-dot für die Kachel muss entfallen sein');
});

test('FIX 3a (3.6b): Kachel-Reste entfernt (CSS, Bilder); Startdashboard-Grid hat vier Spalten', () => {
  assert.ok(!stylesCss.includes('dashboard-section-recording'), 'CSS der Aufnahmen-Kachel muss entfernt sein');
  assert.ok(!stylesCss.includes('recordings-tile'), 'Verweis auf das Kachelbild muss entfernt sein');
  for (const f of ['recordings-tile.png', 'recordings-tile@2x.png', 'recordings-nav@2x.png']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'assets', 'icons', f)), `${f} ist ungenutzt und muss entfernt sein`);
  }
  assert.match(stylesCss, /\.dashboard-view\.start-page \.dashboard-grid \{[^}]*repeat\(4, minmax\(200px, 262px\)\)/);
});

test('3.6b: Aufnahmen-Bereich bleibt erreichbar (Karte, Strg+R, Tray) und ist in der Tastaturkürzel-Hilfe genannt', () => {
  assert.ok(rendererJs.includes("onOpenRecordings: () => showDashboard('recording')"));
  assert.match(rendererJs, /ctrlKey && \(key === 'r' \|\| key === 'R'\)\) \{\s*showDashboard\('recording'\)/);
  assert.ok(rendererJs.includes('onOpenRecordings?.('));
  assert.ok(/<kbd>R<\/kbd><\/span><span class="shortcut-desc">Aufnahmen öffnen/.test(indexHtml));
  assert.ok(!indexHtml.includes('TV Sidebar umschalten'));
});

test('FIX 3b (3.6b, P21): kein Navbar-Eintrag „Aufnahmen“ mehr; nav-section-item-Stil bleibt für die übrigen Gruppen', () => {
  const groupsLiteral = /const groups = \[[\s\S]*?\];/.exec(rendererJs)?.[0] || '';
  assert.ok(!groupsLiteral.includes("key: 'recording'"), 'recording darf nicht mehr in renderNav stehen');
  assert.ok(groupsLiteral.includes("key: 'livetv'") && groupsLiteral.includes("key: 'mediathek'"), 'übrige Gruppen fehlen');
  assert.ok(rendererJs.includes("btn.className = 'nav-item nav-section-item'"), 'nav-section-item-Klasse nicht gesetzt');
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
