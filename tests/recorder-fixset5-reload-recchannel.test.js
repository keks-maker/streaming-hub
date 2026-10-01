'use strict';

// Tests: Aufnahme Fix-Set 5 — Record-Button channelId-Verlust nach
// tv.html-Reload (A-Fail R2-FB-01, Karte t_d6ee955e).
//
// Root-Cause: der loadURL-Pfad in selectTvChannel baute die tv.html-URL ohne
// channelId-Param → setupChannel bekam recChannelCtx.channelId = '' →
// applyRecordingState fand activeHere = null → Record-Button weiß mit
// Start-Dialog trotz laufender Aufnahme auf demselben Kanal.
//
// Die Assertions prüfen Quelltext-Invarianten (kein Electron nötig), gleiche
// Methode wie recorder-fixset3-ui.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tvHtml = fs.readFileSync(path.join(ROOT, 'tv.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(ROOT, 'preload-content.js'), 'utf8');

// ── Fix 1: channelId als URL-Param im loadURL-Pfad ──

test('FIX 1: selectTvChannel loadURL-Pfad hängt channelId an die tv.html-URL', () => {
  // Der else-Zweig (Cold-Load/Reload) muss den Param bauen.
  const idx = rendererJs.indexOf("'/tv.html?channel='");
  assert.ok(idx !== -1, 'loadURL-Pfad (tv.html?channel=) nicht gefunden');
  const loadUrlBlock = rendererJs.slice(idx, idx + 2200);
  assert.ok(
    loadUrlBlock.includes("'&channelId=' +"),
    "loadURL-Pfad muss '&channelId=' anhängen (R2-FB-01)",
  );
  assert.ok(
    /'&channelId=' \+\s*\n\s*encodeURIComponent\(ch\.id\)/.test(loadUrlBlock),
    'channelId-Param muss encodeURIComponent(ch.id) nutzen',
  );
  assert.ok(
    loadUrlBlock.includes("params.get('channelId')") === false &&
      loadUrlBlock.indexOf("'&hls='") > loadUrlBlock.indexOf("'&channelId='"),
    'channelId muss vor dem hls-Param in der URL stehen',
  );
});

test('FIX 1: tv.html liest channelId aus dem URL-Param in setupChannel (Initial-Load)', () => {
  assert.ok(
    /setupChannel\(\s*\n?\s*params\.get\('channel'\)[\s\S]{0,200}params\.get\('channelId'\) \|\| ''\s*\n?\s*\);/.test(tvHtml),
    'Initial setupChannel muss channelId aus URL-Param lesen',
  );
});

// ── Fix 2: channel-context Fallback (Setup-Routefrag → Renderer antwortet
//    mit contextOnly-switch-channel → recChannelCtx ohne setupChannel-Replay) ──

test('FIX 2: tv.html fragt nach dem Initial-Load nach Kanal-Kontext', () => {
  const ctxIdx = tvHtml.indexOf("action: 'channel-context'");
  assert.ok(ctxIdx !== -1, 'channel-context-Anfrage fehlt in tv.html');
  // Die Anfrage muss NACH dem Initial-setupChannel und VOR der recording-status-
  // Anfrage stehen (gleiche Setup-Route).
  const setupIdx = tvHtml.indexOf("params.get('channelId') || ''");
  const recIdx = tvHtml.indexOf("action: 'recording-status'");
  assert.ok(
    setupIdx !== -1 && ctxIdx > setupIdx && ctxIdx < recIdx,
    'channel-context muss zwischen Initial-Setup und recording-status liegen',
  );
});

test('FIX 2: preload-content Whitelist lässt channel-context durch', () => {
  assert.ok(
    preloadJs.includes("e.data.action === 'channel-context'"),
    'channel-context fehlt in der preload action-Whitelist',
  );
});

test('FIX 2: renderer beantwortet channel-context mit switch-channel (contextOnly)', () => {
  assert.ok(
    rendererJs.includes("action === 'channel-context'") &&
      rendererJs.includes('pushChannelContextToTvView()'),
    'ipc-Handler muss channel-context auf pushChannelContextToTvView mappen',
  );
  const fnIdx = rendererJs.indexOf('function pushChannelContextToTvView()');
  assert.ok(fnIdx !== -1, 'pushChannelContextToTvView fehlt');
  const body = rendererJs.slice(fnIdx, fnIdx + 1600);
  assert.ok(body.includes("type: 'switch-channel'"), 'Antwort-Typ muss switch-channel sein');
  assert.ok(body.includes('channelId: ch.id'), 'Antwort muss die channelId tragen');
  assert.ok(body.includes('contextOnly: true'), 'Antwort muss contextOnly:true setzen');
});

test('FIX 2: tv.html wendet contextOnly-switch-channel OHNE setupChannel an', () => {
  const branchIdx = tvHtml.indexOf('if (data.contextOnly) {');
  assert.ok(branchIdx !== -1, 'contextOnly-Zweig fehlt in tv.html');
  const branch = tvHtml.slice(branchIdx, branchIdx + 900);
  // Der Zweig setzt recChannelCtx und kehrt zurück, BEVOR setupChannel läuft.
  assert.ok(
    /recChannelCtx = \{[\s\S]*?channelId:[\s\S]*?\};/.test(branch),
    'contextOnly-Zweig muss recChannelCtx (inkl. channelId) setzen',
  );
  assert.ok(
    branch.includes('applyRecordingState(recordingStatus)'),
    'contextOnly-Zweig muss applyRecordingState aufrufen (Button-Färbung)',
  );
  assert.ok(
    /return;[\s\S]{0,80}setupChannel\(data\.url/.test(branch) === false ||
      branch.indexOf('return;') < branch.indexOf('setupChannel'),
    'contextOnly-Zweig muss VOR setupChannel zurückkehren (kein HLS-Replay)',
  );
});

// ── Regression: switch-channel-Normalfall bleibt unverändert ──

test('REGRESSION: voller switch-channel läuft weiter über setupChannel', () => {
  const idx = tvHtml.indexOf('if (data.type === \'switch-channel\') {');
  assert.ok(idx !== -1);
  const handler = tvHtml.slice(idx, idx + 1400);
  assert.ok(
    handler.includes('data.contextOnly') && handler.includes('setupChannel(data.url'),
    'Normalfall (ohne contextOnly) muss setupChannel aufrufen',
  );
});

test('REGRESSION: isTvPage-Pfad (tvView.send) im selectTvChannel unverändert', () => {
  const idx = rendererJs.indexOf('const isTvPage = tvView.getURL()');
  assert.ok(idx !== -1);
  const livePath = rendererJs.slice(idx, idx + 2600);
  assert.ok(livePath.includes("type: 'switch-channel'"), 'live-Pfad sendet switch-channel');
  assert.ok(livePath.includes('channelId: ch.id'), 'live-Pfad trägt channelId');
  assert.ok(livePath.includes("tvView.send('tv-player-command', msg)"), 'live-Pfad nutzt tvView.send');
});
