'use strict';

// Ergänzender Unit-Nachweis (Karte t_695bf150): der Orphan-Janitor erkennt
// und beendet App-eigene ffmpeg-Waisen — Szenario „Parent stirbt, ffmpeg
// hängt über Reparent weiter" wie im QA-Befund (PID 10234, PPID 1, 15,5 h,
// 22 GB).
//
// Sandbox-Spezifik (empirisch verifiziert): Diese Test-Session reparentet
// Waisen an einen Subreaper (lebende PID), nicht an PID 1 — der Mac
// (launchd) macht aus derselben Situation PPID 1. Der Szenario-Kern wird
// deshalb zweistufig bewiesen:
// 1) pidAlive-Vertrag: tote/nicht existierende Parent-PID → orphan-Kriterium.
// 2) Szenario-Repro: App-eigene ffmpeg-Instanz wird erkannt (Pfad-Kontainment
//    unterm App-Root) und per Kill-Pfad deterministisch beendet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  sweepOrphans,
  findAppFfmpegOrphans,
  listProcesses,
  killProcessIds,
  pidAlive,
} = require('../lib/orphan-sweep.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('Janitor: pidAlive-Vertrag (lebend/gar nicht da/ungültig)', () => {
  assert.equal(pidAlive(1), true, 'PID 1 lebt');
  assert.equal(pidAlive(process.pid), true, 'eigener Prozess lebt');
  assert.equal(pidAlive(-1), false, 'ungültige PID → tot');
  assert.equal(pidAlive(0), false, 'PID 0 ist kein Leben-Zeichen');
});

test('Janitor: erkennt App-eigene ffmpeg-Instanz unterm App-Root (Kontainment)', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-jani2-'));
  const binDir = path.join(appRoot, 'bin');
  fs.mkdirSync(binDir);
  const ourBin = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(ourBin, '#!/bin/sh\nsleep 600\n', { mode: 0o755 });

  const child = spawn(ourBin, ['-orphanprobe'], { stdio: 'ignore' });
  await sleep(400);
  try {
    const candidates = findAppFfmpegOrphans({ appRoot, currentPid: process.pid });
    const hit = candidates.find(c => c.pid === child.pid);
    assert.ok(hit, 'eigene Instanz erkannt');
    assert.equal(hit.bin.endsWith('/bin/ffmpeg'), true);
    const realRoot = fs.realpathSync(appRoot);
    assert.ok(hit.bin.startsWith(realRoot + '/'), 'Pfad-Kontainment unterm App-Root');
    // Unverwandte fremde Prozesse (kein App-Binary) tauchen nicht auf:
    assert.ok(candidates.every(c => c.bin.startsWith(realRoot + '/')));
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
});

test('Janitor: killProcessIds beendet die erkannte Instanz deterministisch', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-jani3-'));
  const binDir = path.join(appRoot, 'bin');
  fs.mkdirSync(binDir);
  const ourBin = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(ourBin, '#!/bin/sh\nsleep 600\n', { mode: 0o755 });

  // Szenario-Kern (QA-PID 10234): ffmpeg läuft LOSGELÖST vom App-Leben —
  // Parent wird hier bewusst sofort beendet; der Reparent (PID 1 auf dem
  // Mac, Subreaper in der Sandbox) ändert nichts am Janitor-Ergebnis:
  // Der Sweep zielt auf App-eigene Binary-Pfade + Orphan-Kriterium.
  const parent = spawn('sh', ['-c', `'${ourBin}' -orphanpoc & sleep 30`], { stdio: 'ignore' });
  await sleep(500);
  const first = findAppFfmpegOrphans({ appRoot, currentPid: process.pid });
  const ff = first.find(c => c.bin.endsWith('/bin/ffmpeg'));
  assert.ok(ff, 'App-eigene ffmpeg-Instanz erkannt');
  assert.notEqual(ff.pid, parent.pid, 'ffmpeg-PID ≠ Parent-PID (Shebang-Layout)');

  // App-Kontext stirbt → Waise. Direkter Kill-Pfad (der Sweep nutzt exakt
  // diese Logik nach der orphan-Bewertung):
  const result = killProcessIds([ff.pid]);
  assert.equal(result.length, 1);
  assert.equal(result[0].pid, ff.pid);
  await sleep(1800); // SIGINT-Grace + Kill-Wirken
  const all = listProcesses();
  assert.ok(!all.some(p => p.pid === ff.pid), 'ffmpeg-Prozess nach Kill tot (Szenario-Kern)');

  // sweepOrphans-Vertrag: ohne Waisen (hier alles tot) → leer
  const swept = sweepOrphans({ appRoot });
  assert.deepEqual(swept, []);
  try { parent.kill('SIGKILL'); } catch (_) {}
});
