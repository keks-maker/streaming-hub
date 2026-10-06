'use strict';

// Regressionstests (Qualitätsprüfung 2026-10): Eingabevalidierung, M3U-Dateizugriff,
// Pfad-Containment, EPG-Limit, HTML-Escaping.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const iv = require('../lib/input-validation.js');
const { resolveAllowedM3uPath } = require('../lib/m3u-access.js');
const { isInsideDir } = require('../lib/recorder/paths.js');

const ROOT = path.join(__dirname, '..');

test('tvSourceUpdates: Teil-Update einer Datei-Quelle ohne type akzeptiert Dateipfad', () => {
  assert.equal(iv.tvSourceUpdates({ url: '/home/u/liste.m3u' }, 'file').url, '/home/u/liste.m3u');
  assert.throws(() => iv.tvSourceUpdates({ url: '/home/u/liste.m3u' }, 'url'));
  assert.throws(() => iv.tvSourceUpdates({ url: '/home/u/liste.m3u' }));
  assert.equal(iv.tvSourceUpdates({ url: 'https://example.org/a.m3u' }, 'url').url, 'https://example.org/a.m3u');
  // explizites type gewinnt über existingType
  assert.equal(iv.tvSourceUpdates({ type: 'file', url: '/x/a.m3u' }, 'url').url, '/x/a.m3u');
});

test('EPG-Limit ist begrenzt und wird in main.js verwendet (kein Infinity)', () => {
  assert.ok(Number.isFinite(iv.MAX_EPG_BYTES) && iv.MAX_EPG_BYTES > 0);
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
  assert.ok(!/readResponseText\([^)]*Infinity\)/.test(src));
  // Der EPG-Download läuft nur noch im Main-EpgService (Etappe 3.7), dort mit dem begrenzten Limit
  const service = fs.readFileSync(path.join(ROOT, 'lib/epg/EpgService.js'), 'utf-8');
  assert.match(service, /maxBytes = MAX_EPG_BYTES/);
});

test('M3U-Zugriff: gewählte Datei und persistierte Datei-Quelle erlaubt, fremde nicht', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u-access-'));
  const picked = path.join(dir, 'a.m3u');
  const saved = path.join(dir, 'b.m3u');
  const other = path.join(dir, 'c.m3u');
  for (const f of [picked, saved, other]) fs.writeFileSync(f, '#EXTM3U\n');
  const real = f => fs.realpathSync.native(f);
  const selected = new Set([real(picked)]);
  const sources = [
    { type: 'file', url: saved },
    { type: 'url', url: other },
  ];
  assert.equal(resolveAllowedM3uPath(picked, selected, []), real(picked));
  // Nach App-Neustart: selected leer, Datei nur als gespeicherte Quelle bekannt
  assert.equal(resolveAllowedM3uPath(saved, new Set(), sources), real(saved));
  assert.equal(resolveAllowedM3uPath(other, new Set(), sources), null, 'URL-Quelle zählt nicht');
  assert.equal(resolveAllowedM3uPath(path.join(dir, 'fehlt.m3u'), selected, sources), null);
});

test('isInsideDir: nur Pfade strikt unterhalb des Ordners', () => {
  const lib = '/data/Aufnahmen';
  assert.equal(isInsideDir(lib, '/data/Aufnahmen/a.mp4'), true);
  assert.equal(isInsideDir(lib, '/data/Aufnahmen/rec_1/../a.mp4'), true);
  assert.equal(isInsideDir(lib, '/data/Aufnahmen/../geheim.txt'), false);
  assert.equal(isInsideDir(lib, '/etc/passwd'), false);
  assert.equal(isInsideDir(lib, '/data/Aufnahmen'), false);
  assert.equal(isInsideDir(lib, '/data/AufnahmenX/a.mp4'), false);
  assert.equal(isInsideDir(lib, null), false);
});

test('recording:delete prüft Containment vor dem Löschen', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
  const del = src.slice(src.indexOf("'recording:delete'"));
  assert.ok(del.indexOf('paths.isInsideDir(lib, meta.outputFile)') !== -1);
  assert.ok(del.indexOf('paths.isInsideDir') < del.indexOf('fs.rmSync(meta.outputFile'));
});

test('tv.html showFatalError escaped Meldung und Sendername', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tv.html'), 'utf-8');
  const start = src.indexOf('function showFatalError');
  assert.ok(start !== -1);
  const fn = src.slice(start, src.indexOf('errorDiv.style.display', start));
  assert.match(fn, /esc\(msg\)/);
  assert.match(fn, /esc\(channelNameEl\.textContent/);
  assert.ok(!/'\s*\+\s*msg\s*\+/.test(fn), 'msg darf nicht roh konkateniert werden');
});

test('renderer: Live-TV-Kachel setzt Logo nicht per Template-HTML', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf-8');
  assert.ok(!src.includes('<img src="${ch.logo'));
  assert.match(src, /safeResourceUrl\(ch\.logo\)/);
});
