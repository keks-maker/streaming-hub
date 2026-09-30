'use strict';

// Tests: RecorderService.setStorageRoot (Phase 1c, Karte t_bafa7928; §3.4)
// Speicherort-Wechsel zur Laufzeit: Validierung vor Wechsel, Schutz bei
// laufenden Aufnahmen, Store-Neuaufbau.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecorderService } = require('../lib/recorder/RecorderService.js');

// Stummer Logger (Service nutzt lib/logger.js)
const silentHook = () => {};
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function makeService(storageRoot) {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-svc-app-'));
  // Fake-Binaries, damit der Health-Check beim Start durchgeht (hier nicht
  // nötig, aber setStorageRoot braucht keinen ffmpeg-Zugriff)
  const binDir = path.join(appRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const tool of ['ffmpeg', 'ffprobe']) {
    fs.writeFileSync(path.join(binDir, tool), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, tool), 0o755);
  }
  return new RecorderService({ appRoot, storageRoot });
}

test('setStorageRoot: gültiger Root wird übernommen, Store zeigt auf neues Verzeichnis', () => {
  const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-root-old-'));
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-root-new-'));
  const service = makeService(oldRoot);
  const result = service.setStorageRoot(newRoot);
  assert.equal(result, path.resolve(newRoot));
  assert.equal(service.storageRoot, path.resolve(newRoot));
  assert.equal(path.dirname(service.store.library), path.resolve(newRoot));
});

test('setStorageRoot: ungültiger Root (Datei statt Verzeichnis) wird abgelehnt, alter bleibt', () => {
  const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-root-old-'));
  const notADir = path.join(os.tmpdir(), `rec-not-a-dir-${process.pid}.txt`);
  fs.writeFileSync(notADir, 'nope');
  const service = makeService(oldRoot);
  assert.throws(() => service.setStorageRoot(notADir), /Speicherort nicht nutzbar|kein Verzeichnis/i);
  assert.equal(service.storageRoot, path.resolve(oldRoot));
});

test('setStorageRoot: nicht existierender Root wird angelegt (mkdir recursive)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-root-base-'));
  const deep = path.join(base, 'a', 'b', 'Aufnahmen-Root');
  const service = makeService(base);
  const result = service.setStorageRoot(deep);
  assert.equal(result, path.resolve(deep));
  assert.ok(fs.existsSync(deep), 'Verzeichnis angelegt');
});

test.after(() => {
  try {
    fs.rmSync(path.join(os.tmpdir(), 'rec-root-old-'), { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'rec-root-new-'), { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'rec-root-base-'), { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'rec-svc-app-'), { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), `rec-not-a-dir-${process.pid}.txt`), { force: true });
  } catch (_) {}
});
