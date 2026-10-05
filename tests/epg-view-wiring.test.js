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
  for (const name of ['.epg-grid {', '.epg-row {', '.epg-row.epg-ruler', '.epg-programs-col', '.epg-channel-col', '.epg-time-marker', 'epgFadeIn']) {
    assert.ok(!read('styles.css').includes(name), `styles.css enthält noch ${name}`);
  }
});

test('Verdrahtung: Einstiege und Esc-Kette laufen über epg-view (Einstiege umgehängt)', () => {
  const renderer = read('renderer.js');
  // 3.6b: einziger Einstieg ist die Karte „Programmübersicht“ (ID dashboardEpgOpen, P22) im LiveTV-Hub; die TV-Sidebar ist entfernt
  assert.match(renderer, /onOpenEpg: \(\) => openEpgView\(\)/);
  assert.match(read('dashboard-hub-view.js'), /id: 'dashboardEpgOpen'/);
  assert.ok(!/tvSidebar/.test(renderer), 'renderer.js enthält noch tvSidebar-Reste');
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


test('Raster-Verdrahtung: Modus-Segment, Zoom, kein Hook-Button ohne Handler, goToNow löst die Tag-Bindung', () => {
  const view = read('epg-view.js');
  assert.match(view, /id: 'epgModeList'/);
  assert.match(view, /id: 'epgModeGrid'/);
  assert.match(view, /function setMode\(mode\)/);
  assert.match(view, /async function goToNow\(\) \{(?:\s*if \(searchView\.isShown\(\)\) closeSearch\(\);)?(?:\s*if \(channelState\.active\) \{\s*channelGoToNow\(\);\s*return;\s*\})?\s*dayPin = null;/, 'W1: „Jetzt“ hebt die Tag-Bindung auf');
  const gridView = read('epg-grid-view.js');
  assert.match(gridView, /const clickable = typeof deps\.onChannelClick === 'function';\s*const cell = clickable\s*\?/, 'Sendername nur klickbar, wenn ein Hook vorhanden ist');
  for (const file of ['epg-grid-view.js', 'epg-grid-model.js', 'epg-dom.js', 'epg-genres.js', 'epg-row-dom.js', 'epg-channel-model.js', 'epg-channel-view.js']) {
    const src = read(file);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|tvEpgIndex|decodeEntities/.test(src), file);
  }
  assert.ok(!/onChannelClick/.test(read('renderer.js')), 'Kanalansicht ist ein Modus im Overlay: der Sendername-Hook wird in epg-view.js verdrahtet, nicht im Renderer');
});

test('Raster-Titel brechen nie mitten im Wort um (V1)', () => {
  const css = read('styles.css');
  const block = css.slice(css.indexOf('.epg-block-title {'), css.indexOf('}', css.indexOf('.epg-block-title {')));
  assert.ok(!/overflow-wrap:\s*anywhere|word-break:\s*(break-all|break-word)/.test(block));
  assert.match(block, /-webkit-line-clamp: 2/);
});

test('Senderlogos im Raster: gleiche Quelle und Prüfung wie die Sidebar (Kanalobjekt, safeResourceUrl), img nur per src-Property', () => {
  assert.match(read('renderer.js'), /sanitizeLogoUrl: url => safeResourceUrl\(url\)/);
  // Logo-Aufbau liegt in epg-dom.js (createChannelLogo) und wird von Raster UND Kanalansicht genutzt (kein Duplikat)
  const dom = read('epg-dom.js');
  assert.match(dom, /resolveLogoUrl\(channel, sanitizeLogoUrl\)/);
  assert.match(dom, /img\.src = logoUrl/);
  assert.match(dom, /addEventListener\('error'/);
  assert.match(dom, /loading: 'lazy'/);
  assert.match(read('epg-grid-view.js'), /createChannelLogo\(\{ name, channel: entry\.channel, sanitizeLogoUrl: deps\.sanitizeLogoUrl \}\)/);
  assert.match(read('epg-channel-view.js'), /createChannelLogo\(\{ name: meta\.name, channel, sanitizeLogoUrl: deps\.sanitizeLogoUrl/);
  assert.match(read('epg-view.js'), /sanitizeLogoUrl: typeof deps\.sanitizeLogoUrl === 'function' \? deps\.sanitizeLogoUrl : undefined/);
});

test('Raster bleibt ruhig: Block-Toggle nur bei geplanter/laufender Aufnahme, die Liste behält „Aufnehmen“ je Zeile', () => {
  const view = read('epg-grid-view.js');
  assert.match(view, /const show = wide && toggle\.kind !== 'record';/);
  const list = read('epg-row-dom.js');
  assert.match(list, /const pastOnly = info\.phase === 'past' && toggle\.kind === 'record';/);
  assert.ok(!/kind !== 'record'/.test(list), 'Liste zeigt weiter bei jeder Zeile den Toggle');
});

test('Marker: geplant rot und statisch, laufend rot und pulsierend (reduced-motion schaltet ab)', () => {
  const css = read('styles.css');
  assert.match(css, /\.epg-marker\[data-state="scheduled"\] \{ color: var\(--epg-rec\); \}/);
  const run = css.match(/\.epg-marker\[data-state="recording"\] \{[^}]*\}/)[0];
  assert.match(run, /var\(--epg-rec\)/);
  assert.match(run, /epgPulse/);
  assert.ok(!/animation/.test(css.match(/\.epg-marker\[data-state="scheduled"\] \{[^}]*\}/)[0]));
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.epg-marker\[data-state="recording"\] \{ animation: none; \}/);
});

// ── Etappe 3.4: Kanalansicht ──

test('Kanalansicht: Modus im Overlay, kein Segment-Button dafür, Esc-Kette Rückfrage → Modal → Menü → Suche → Kanalmodus → Overlay', () => {
  const view = read('epg-view.js');
  assert.equal((view.match(/className: 'epg-seg-btn'/g) || []).length, 3, 'Segment: Liste | Raster | Jetzt & Gleich (Etappe 3.5)');
  assert.ok(!/epgModeChannel/.test(view));
  const start = view.indexOf('function handleEscape()');
  const esc = view.slice(start, view.indexOf('return {', start));
  const order = [
    esc.indexOf('closeConfirm()'),
    esc.indexOf('closeDetail()'),
    esc.indexOf('openMenu.close('),
    esc.indexOf('closeSearch('),
    esc.indexOf('exitChannel()'),
    esc.indexOf('close();'),
  ];
  assert.ok(order.every(i => i >= 0), 'alle sechs Stufen vorhanden');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'Reihenfolge der Stufen');
  // Renderer reicht Esc nur durch (epgView.handleEscape): die Kette liegt komplett in epg-view
  assert.match(read('renderer.js'), /if \(epgView\.handleEscape\(\)\) return true;/);
});

test('Kanalansicht: Einstiege nur Sendername (Liste, Raster) und Modal-Link, nicht Dashboard/Player/Sidebar', () => {
  const view = read('epg-view.js');
  assert.match(view, /event\.target\.closest\('\.epg-chan-link'\)[\s\S]*enterChannel\(row\.channel/);
  assert.match(view, /onChannelClick: channel => enterChannel\(channel,/);
  assert.match(view, /addHandler\(dChannel, 'click'[\s\S]*closeDetail\(\{ restoreFocus: false \}\)[\s\S]*enterChannel\(row\.channel/);
  assert.match(view, /text: 'Alle Sendungen des Senders'/);
  assert.equal((view.match(/enterChannel\(/g) || []).length, 5, 'Definition + vier Einstiege (Liste, Raster, Jetzt & Gleich, Modal)');
  assert.match(view, /returnTo: \{ type: 'jng-channel'/);
  const rowDom = read('epg-row-dom.js');
  assert.match(rowDom, /'aria-label': `Alle Sendungen von \$\{senderName\(row\)\}`/);
  assert.match(rowDom, /className: 'epg-chan-link',\s*type: 'button'/, 'Button: Enter/Space nativ');
  assert.match(read('epg-grid-view.js'), /setAttribute\('aria-label', `Alle Sendungen von \$\{name\}`\)/);
  assert.ok(!/enterChannel|epgChannel|(?<![\w-])epg-channel/.test(read('renderer.js')), 'kein Einstieg aus Dashboard/Player/Renderer');
});

test('Kanalansicht: ein Toggle-Weg, Zeilen, Raster, Modal und Kanalansicht rufen runToggle (keine zweite Implementierung)', () => {
  const view = read('epg-view.js');
  assert.match(view, /onToggle: \(row, element\) => runToggle\(row, element\),\s*onAction/);
  assert.equal((view.match(/async function runToggle\(/g) || []).length, 1);
  assert.equal((view.match(/deps\.recordProgramme\(/g) || []).length, 1);
  assert.equal((view.match(/deps\.stopRecording\(/g) || []).length, 1);
  const channelView = read('epg-channel-view.js');
  assert.ok(!/recordProgramme|stopRecording|removeSchedule|askConfirm/.test(channelView), 'Kanal-View enthält keine Aktionslogik');
  // gleiche Darstellung (Beschriftung/Marker) für Liste und Kanalansicht
  assert.match(channelView, /require\('\.\/epg-row-dom\.js'\)/);
  assert.match(view, /require\('\.\/epg-row-dom\.js'\)/);
  // der bestehende Planungsweg bleibt der einzige
  assert.match(read('renderer.js'), /recordProgramme: programme => handleEpgRecordClick\(programme\)/);
});

test('Kanalansicht: keine toten Referenzen, jede Funktion/jedes Element ist verdrahtet, 30-s-Tick baut nichts neu', () => {
  const view = read('epg-view.js');
  for (const name of ['enterChannel', 'exitChannel', 'loadChannel', 'positionChannel', 'followChannel', 'goToChannelDay', 'channelGoToNow', 'toggleExtended', 'onModeClick', 'restoreOrigin', 'captureOrigin', 'originFocusElement', 'applyInert']) {
    assert.ok((view.match(new RegExp(`\\b${name}\\(`, 'g')) || []).length >= 2, `${name} wird definiert und genutzt`);
  }
  for (const id of ['epgChannel', 'epgChannelBack', 'epgChannelList', 'epgChannelName', 'epgChannelNow', 'epgChannelState']) {
    assert.ok(read('epg-channel-view.js').includes(`id: '${id}'`), id);
  }
  const tick = view.slice(view.indexOf('function tick()'), view.indexOf('// ── Zeilen- und Toggle-Aktionen'));
  assert.match(tick, /channelView\.update\(\)/);
  assert.ok(!/channelView\.setData|loadChannel/.test(tick), 'Tick: nur update()');
  assert.match(read('epg-channel-view.js'), /nextSig === signature && nodes\.size > 0/, 'unveränderte Daten: kein Neuaufbau');
  // Fokus-Falle schließt die inerte Herkunftsansicht aus
  assert.match(read('epg-dom.js'), /closest\('\[hidden\], \[inert\]'\)/);
});

test('Kanalansicht: Layer liegt über der Herkunftsansicht, Fokusanzeige am Sendernamen, reduced-motion bleibt', () => {
  const css = read('styles.css');
  assert.match(css, /\.epg-channel \{[^}]*position: absolute;[^}]*inset: 0;/);
  assert.match(css, /\.epg-crow\.is-next/);
  assert.match(css, /\.epg-chan-link:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.epg-marker\[data-state="recording"\] \{ animation: none; \}/);
});

test('Abnahme 3.4 (1): Raster — Marker pulsiert, der Stopp-Knopf rechts ist statisch (■); Reduced-Motion bleibt beachtet', () => {
  const css = read('styles.css');
  const rule = css.slice(css.indexOf('.epg-block-rec[data-kind="stop"] {'), css.indexOf('}', css.indexOf('.epg-block-rec[data-kind="stop"] {')));
  assert.ok(rule && !/animation/.test(rule), 'Stopp-Knopf pulsiert nicht');
  assert.ok(!/\.epg-block-rec[^{]*\{[^}]*animation/.test(css), 'kein .epg-block-rec pulsiert');
  assert.match(css, /\.epg-marker\[data-state="recording"\] \{[^}]*animation: epgPulse/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.epg-marker\[data-state="recording"\] \{ animation: none; \}/);
  assert.match(read('epg-grid-view.js'), /stop: '■'/);
});

test('Abnahme 3.4 (2): Stopp — Rückmeldung, Zwischenzustand und Marker-Filter über einen gemeinsamen Pfad', () => {
  const view = read('epg-view.js');
  // ein Stopp-Weg für Liste, Raster, Kanalansicht und Modal; Ergebnis wird ausgewertet (Erfolg und Fehler)
  assert.equal((view.match(/deps\.stopRecording\(/g) || []).length, 1);
  const fn = view.slice(view.indexOf('async function stopRuns('), view.indexOf('// ── Modal ──'));
  assert.match(fn, /wird beendet …/);
  assert.match(fn, /beendet\. Sie liegt in der Aufnahmen-Bibliothek\./);
  assert.match(fn, /Nachbearbeitung ist fehlgeschlagen/);
  assert.match(fn, /Aufnahme konnte nicht gestoppt werden/);
  assert.match(fn, /await refreshMarkers\(\)/);
  assert.match(fn, /stoppingRecIds\.delete/);
  // Planungseintrag 'recording' zählt nicht mehr, sobald die Bibliothek die Aufnahme nicht mehr als laufend führt
  assert.match(view, /recStatus\.get\(entry\.recId\) !== 'recording'/);
  // alle Marker-Abfragen (Liste, Kanalansicht, Raster, Modal) laufen über matchRowMarkers
  assert.ok(!/grid\.matchMarkers\(/.test(view.replace(/function matchRowMarkers[\s\S]*?\n {2}\}\n/, '')), 'nur matchRowMarkers ruft grid.matchMarkers');
  assert.match(view, /matchMarkers: slots => matchRowMarkers\(slots\)/);
});

test('Abnahme 3.4 (3): Navbar über dem Programmführer — Hook, Zustand sichern/wiederherstellen, Navigation schließt das Overlay', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /onOpenChange: handleEpgOpenChange/);
  assert.match(renderer, /function handleEpgOpenChange\(open\) \{[\s\S]*classList\.toggle\('epg-open', open\)[\s\S]*nav-collapsed[\s\S]*epgBarSaved/);
  assert.match(renderer, /function showDashboard\(groupKey, opts = \{\}\) \{\s*closeEpgForNavigation\(\);/);
  assert.match(renderer, /function navigateTo\(svc\) \{\s*closeEpgForNavigation\(\);/);
  assert.match(renderer, /epgViewReady = true;/);
  const css = read('styles.css');
  const overlayZ = Number(/\.epg-overlay \{[^}]*z-index: (\d+)/.exec(css)[1]);
  const barZ = Number(/body\.epg-open \.overlay-bar \{ z-index: (\d+)/.exec(css)[1]);
  assert.ok(barZ > overlayZ, 'Navbar liegt über dem Overlay');
  const view = read('epg-view.js');
  assert.match(view, /function notifyOpenChange\(open\)/);
});
