'use strict';

// Tests nutzen Fake-Bundles unter <appRoot>/bin — System-ffmpeg-Präferenz aus.
process.env.STREAMING_HUB_FFMPEG = 'bundled';

// Tests: Fix-Set 4 (Karte t_18d3dbb2)
// Player-Fehleranzeige bei nicht lesbarer/korrupter Aufnahme-MP4:
// 1) MP4-Player-Overlay hat Fehlerbanner + aria/notification-Semantik
// 2) renderer.js: MediaError-Texttabelle, error/decoding-error-Monitor,
//    Banner-Reset beim Öffnen/Schließen, Toast-Fallback
// 3) RemuxJob.decodeCheckMp4: Zählt stderr-Fehlerzeilen der Decode-Verify
// 4) meta.js-Schema nimmt decodeErrors/decodeErrorSample normiert auf
// 5) RecorderService: Decode-Verify läuft nach Remux + schreibt Felder

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const { decodeCheckMp4 } = require('../lib/recorder/RemuxJob.js');
const { normalizeMeta } = require('../lib/recorder/meta.js');

// ── 1) Markup + CSS ──

test('FIX: Player-Overlay bekommt Fehlerbanner (hidden, role=alert)', () => {
  assert.ok(
    /<div class="recording-player-error" id="recordingPlayerError" hidden role="alert">/.test(indexHtml),
    'Fehlerbanner fehlt im recording-player-Markup',
  );
  assert.match(stylesCss, /\.recording-player-error/);
  // CSS-Review-Pflicht: Banner muss sichtbar schaltbar sein, nicht von
  // globalen Killern (display:none/opacity:0) erschlagen werden.
  assert.match(stylesCss, /\.recording-player-error\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  const zIndexMatch = /\.recording-player-error\s*\{[^}]*z-index:\s*2/.exec(stylesCss);
  assert.ok(zIndexMatch, 'Banner braucht z-index über dem <video>');
  assert.match(stylesCss, /\.recording-player\s*\{[^}]*position:\s*fixed/, 'Overlay als Positionskontext');
});

// ── 2) renderer.js-Fehlermonitor ──

test('FIX: media-Error-Mapper deckt MediaError-Codes 1-4 mit Nutzer-Texten ab', () => {
  assert.match(rendererJs, /MEDIA_ERROR_CODE_TEXTS\s*=\s*\{/);
  for (const code of [1, 2, 3, 4]) {
    assert.match(rendererJs, new RegExp(`\\b${code}:\\s*'`), `Text für Code ${code} fehlt`);
  }
  assert.match(rendererJs, /Die Aufnahme ist nicht lesbar/, 'Kernbotschaft für code=4 (korrupte Datei)');
});

test('FIX: video error + decoding-error beide zeigen den Fehlerbanner', () => {
  assert.match(
    rendererJs,
    /recordingPlayerVideo\.addEventListener\('error'/,
    "Media-'error'-Monitoring fehlt",
  );
  assert.match(
    rendererJs,
    /recordingPlayerVideo\.addEventListener\('decoding-error'/,
    'decoding-error-Monitor fehlt (Decode-Fehler feuern KEIN MediaError)',
  );
  assert.match(rendererJs, /showRecordingPlayerError\(/);
  assert.match(rendererJs, /recordingPlayerError\.hidden = false/, 'Banner-Schaltung fehlt');
  assert.match(rendererJs, /showTvToast\(/, 'Toast-Parallel-Anzeige fehlt');
  assert.match(rendererJs, /logger\.warn\('\[recording playback\] '/, 'Diagnose-Log fehlt');
});

test('FIX: Banner-Reset beim Öffnen und Schließen des Players', () => {
  assert.match(
    rendererJs,
    /closeRecordingPlayback\(\);\s*\n\s*hideRecordingPlayerError\(\);/,
    'openRecordingPlayback muss Banner zurücksetzen',
  );
  const closeFn = /function closeRecordingPlayback\(\)\s*\{[\s\S]*?\n\}/.exec(rendererJs)?.[0] || '';
  assert.ok(closeFn.includes('hideRecordingPlayerError();'), 'closeRecordingPlayback muss Banner verstecken');
});

// ── 3) decodeCheckMp4 (echtes ffmpeg und fehlerfreier Fallback-Pfad) ──

function findFfmpeg() {
  // Lokaler ffmpeg aus dem Hermes-Toolstock (Linux-x64); Umgebung: kein Mac.
  const candidates = [
    process.env.HERMES_FFMPEG,
    '/home/hermes/.hermes/tools/ffmpeg-9.0.1-linux-x64/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_e) {
      /* weiter */
    }
  }
  return null;
}

test('FIX: decodeCheckMp4 meldet 0 Fehlerzeilen für eine saubere MP4', { skip: !findFfmpeg() }, async () => {
  const ffmpegPath = findFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decodecheck-ok-'));
  const out = path.join(dir, 'ok.mp4');
  await new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(ffmpegPath, [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=128x72:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', out,
    ], { stdio: 'ignore' });
    child.on('close', code => (code === 0 ? resolve() : reject(new Error('fixture-encode failed ' + code))));
    child.on('error', reject);
  });
  const check = await decodeCheckMp4(ffmpegPath, out, 30000);
  assert.equal(check.exitCode, 0);
  assert.equal(check.decodeErrors, 0);
  assert.equal(check.decodeErrorSample || null, null);
});

// ── 4) meta.js-Schema ──

test('FIX: normalizeMeta normiert decodeErrors/decodeErrorSample', () => {
  const base = { id: 'rec_20261001_abc-def', status: 'completed' };
  const withData = normalizeMeta({ ...base, decodeErrors: 12, decodeErrorSample: 'Invalid NAL unit size' });
  assert.equal(withData.decodeErrors, 12);
  assert.equal(withData.decodeErrorSample, 'Invalid NAL unit size');

  const zero = normalizeMeta({ ...base, decodeErrors: 0, decodeErrorSample: null });
  assert.equal(zero.decodeErrors, 0);
  assert.equal(zero.decodeErrorSample, null);

  const without = normalizeMeta(base);
  assert.equal(without.decodeErrors, null);
  assert.equal(without.decodeErrorSample, null);

  const badType = normalizeMeta({ ...base, decodeErrors: 'x', decodeErrorSample: 42 });
  assert.equal(badType.decodeErrors, null);
  assert.equal(badType.decodeErrorSample, null);

  const negative = normalizeMeta({ ...base, decodeErrors: -3 });
  assert.equal(negative.decodeErrors, null);
});

// ── 5) RecorderService-Integration ──

test('FIX: RecorderService führt Decode-Verify nach Remux aus und persistiert', () => {
  const svc = fs.readFileSync(path.join(ROOT, 'lib/recorder/RecorderService.js'), 'utf8');
  assert.match(svc, /decodeCheckMp4/, 'Decode-Verify-Import fehlt');
  const remuxBlock = /decodeCheckMp4\(ffmpegLib\.resolveBinaryPath\('ffmpeg', this\.appRoot\), outputPath(?:,\s*\d+,\s*onChild)?\)/.test(svc);
  assert.ok(remuxBlock, 'Decode-Verify-Aufruf nach dem Remux fehlt');
  assert.match(svc, /decodeErrors,\s*\n\s*decodeErrorSample,/, 'Persistierung der Verify-Felder fehlt');
  // Entscheidend: Kein Status-Fallback — Datei bleibt completed.
  assert.doesNotMatch(
    svc.slice(0, svc.indexOf('const completedMeta')),
    /-decodeErrors.*failed/,
    'Decode-Fehler darf die Datei NICHT auf failed werfen',
  );
});
