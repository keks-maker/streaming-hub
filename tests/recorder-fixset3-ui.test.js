'use strict';

// Tests: Aufnahme Fix-Set 3 (Karte t_ce5a874b)
// 1) formatRecTime: hh:mm:ss immer (auch < 1 h), 1-s-Auflösung
// 2) rec-Anchor-Mathematik: 1s-Tick zwischen Engine-Snapshots (5 s Raster)
// 3) tv.html-Invarianten: REC-Chip hh:mm:ss-Initial, Tooltips, Verwaltungs-Menü
//
// Die tv.html-Assertionen parsen das Markup/DOM-Scripte als Text — kein
// Electron; DOM-Logik selbst bleibt über die UI-Modelle (ui-model.js) getestet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tvHtml = fs.readFileSync(path.join(ROOT, 'tv.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

// ── Den Format-Helfer aus tv.html extrahieren und isoliert testen ──
// (tv.html ist ein Inline-Script im IIFE; die scoped Funktion wird als
//  Quelltext-Muster verifiziert + die Mathematik hier gespiegelt getestet.)

function pad(n) { return String(n).padStart(2, '0'); }
function formatRecTime(totalSec) {
  if (!totalSec || !isFinite(totalSec)) totalSec = 0;
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

test('FIX C: formatRecTime zeigt hh:mm:ss inkl. Stundenfeld unter 1 h', () => {
  assert.equal(formatRecTime(0), '00:00:00');
  assert.equal(formatRecTime(5), '00:00:05');
  assert.equal(formatRecTime(323), '00:05:23'); // User-Beispiel aus der Karte
  assert.equal(formatRecTime(3600), '01:00:00');
  assert.equal(formatRecTime(3661), '01:01:01');
  assert.equal(formatRecTime(7325), '02:02:05');
  assert.equal(formatRecTime(NaN), '00:00:00');
  assert.equal(formatRecTime(-3), '00:00:00');
});

test('FIX C: tv.html enthält formatRecTime und nutzt sie im Chip-Ticker', () => {
  assert.ok(tvHtml.includes('function formatRecTime('), 'formatRecTime-Definition fehlt');
  assert.ok(/recTimeEl\.textContent = formatRecTime\(/.test(tvHtml), 'Chip-Setzung nutzt formatRecTime');
  assert.ok(tvHtml.includes('id="tvRecTime">00:00:00<'), 'Chip-Initialwert zeigt hh:mm:ss');
});

test('FIX C: Chip-Ticker läuft 1-s-basiert mit Anchoring gegen Engine-Drift', () => {
  assert.ok(/setInterval\(recTick, 1000\)/.test(tvHtml), 'Tick-Intervall muss 1000 ms sein');
  assert.ok(tvHtml.includes('recTickAnchor'), 'Anchor-Mechanik fehlt');
  assert.ok(tvHtml.includes('recordRecTickAnchorFrom('), 'Anchor-Update aus Snapshot fehlt');
});

// ── FIX A: Bibliotheks-Einstieg sichtbar ──

test('FIX A: overlay-actions (Aufnahmen-Button) auf always-visible Top-Bar sichtbar', () => {
  assert.ok(
    /\.overlay-bar\.always-visible \.overlay-actions \{[^}]*display:\s*flex !important/.test(stylesCss),
    'overlay-actions muss auf .always-visible explizit sichtbar geschaltet sein',
  );
  assert.ok(
    /\.overlay-bar\.always-visible \.overlay-actions \.add-btn[\s\S]*?opacity:\s*1/.test(stylesCss),
    'Aufnahmen-Button (add-btn) muss opacity:1 auf always-visible haben',
  );
  // Der alte Global-Killer darf nicht mehr alleine stehen:
  assert.ok(
    !/^\.overlay-actions \{ display:none !important; \}$/m.test(stylesCss),
    'Global display:none !important für .overlay-actions muss entfernt sein',
  );
});

test('FIX A: Strg+R öffnet Aufnahmen-Dashboard (Fix-Set 4: kein Overlay mehr)', () => {
  assert.ok(
    /ctrlKey && \(key === 'r' \|\| key === 'R'\)\) \{\s*\n\s*showDashboard\('recording'\)/.test(rendererJs),
    'Strg+R muss showDashboard("recording") aufrufen',
  );
});

// ── FIX B/D: Tooltips + Verwaltung vs Start-Dialog ──

test('FIX B: Record-Button + REC-Chip mit Wirkungs-Tooltips', () => {
  assert.ok(tvHtml.includes('title="Aufnahme starten"'), 'Idle-Tooltip „Aufnahme starten" fehlt');
  assert.ok(tvHtml.includes("'Aufnahme stoppen (R)"), 'Aktiv-Tooltip „Aufnahme stoppen" fehlt');
  assert.ok(
    tvHtml.includes('title="Laufende Aufnahme: Klicken zum Verwalten/Beenden"'),
    'REC-Chip-Verwaltungs-Tooltip fehlt',
  );
});

test('FIX D: REC-Chip öffnet Verwaltungs-Modus (manage), Record-Button den Start-Dialog', () => {
  assert.ok(/openRecMenu\('manage'\)/.test(tvHtml), 'REC-Chip muss openRecMenu("manage") rufen');
  assert.ok(/openRecMenu\('start'\)/.test(tvHtml), 'Record-Button muss openRecMenu("start") rufen');
  assert.ok(/recMenuMode = mode === 'manage' \? 'manage' : 'start'/.test(tvHtml), 'Modus-Schalter fehlt');
});

test('FIX D: Record-Button stoppt DIREKT bei aktiver Aufnahme dieses Kanals', () => {
  const btnHandler = /recordBtn\.addEventListener\('click'[\s\S]*?\}\);/.exec(tvHtml)?.[0] || '';
  assert.ok(btnHandler.includes('activeRecordingForCurrentChannel()'), 'Keine aktive-Aufnahme-Prüfung im Button-Handler');
  assert.ok(btnHandler.includes("sendRecordingRequest('stop'"), 'Klick-auf-rot muss Stop-Request senden');
});

test('FIX D: Verwaltungs-Menü listet AKTIVE Aufnahmen dynamisch (nicht nur aktiver Kanal)', () => {
  assert.ok(tvHtml.includes('id="tvRecEntries"'), 'Dynamischer Menü-Container fehlt');
  assert.ok(tvHtml.includes("getElementById('tvRecEntries')"), 'recMenuEntries-Verkabelung fehlt');
  assert.ok(/list\.forEach\(function\(a\)/.test(tvHtml), 'Dynamische Stop-Entries fehlen');
});

// ── FIX E: Stopp-Feedback ──

test('FIX E: Phase-Bridge stopping/done von renderer.js an tv.html', () => {
  assert.ok(rendererJs.includes('pushRecordingPhaseToTvView('), 'Phase-Push an tv.html fehlt');
  assert.ok(rendererJs.includes("'recording-phase'"), 'recording-phase-Kanal fehlt');
  assert.ok(tvHtml.includes("'recording-phase'"), 'tv.html verarbeitet recording-phase nicht');
  assert.ok(tvHtml.includes('updateChipStopping('), 'Chip-Beenden-Zustand fehlt');
  assert.ok(tvHtml.includes('Aufnahme wird beendet…'), 'Beenden-Text fehlt');
});

test('FIX E: MP4-Fertig-Meldung (done → completed) als Abschluss-Feedback', () => {
  assert.ok(
    rendererJs.includes("showTvToast('Aufnahme beendet — MP4 bereit: '"),
    'Fertig-Meldung fehlt',
  );
});
