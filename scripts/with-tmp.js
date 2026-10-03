#!/usr/bin/env node
// Führt ein Kommando mit eigenem, kurzlebigem Temp-Verzeichnis aus und löscht genau
// dieses Verzeichnis danach wieder (Erfolg, Fehler, Kind-Abbruch, SIGINT/SIGTERM/SIGHUP).
//
//   node scripts/with-tmp.js [--] <kommando> [args…]
//
// - Das Verzeichnis liegt direkt unter os.tmpdir() und hat einen kurzen Namen
//   (macOS-Unix-Socket-Pfadlimit ~104 Zeichen).
// - TMPDIR/TMP/TEMP zeigen für das Kind darauf; dort landen mkdtemp-Ordner der Tests,
//   Playwright-Artefakte usw.
// - Exit-Code des Kindes wird durchgereicht (Signal-Abbruch = 128 + Signalnummer).
// - Gelöscht wird NUR das selbst angelegte Verzeichnis. Vorher wird geprüft: Pfad liegt
//   direkt unter dem (aufgelösten) Temp-Root, trägt den erwarteten Präfix und ist kein
//   Symlink. Fremde, bereits vorhandene Ordner im Temp-Root werden nie angefasst.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PREFIX = 'shtest-';

function createRunTmp(root = os.tmpdir(), prefix = PREFIX) {
  const realRoot = fs.realpathSync(root);
  return fs.mkdtempSync(path.join(realRoot, prefix));
}

// Rechte wiederherstellen (Tests legen teils read-only Ordner an), ohne Symlinks zu folgen.
function makeWritable(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  try {
    fs.chmodSync(target, st.isDirectory() ? 0o700 : 0o600);
  } catch {
    /* best effort */
  }
  if (st.isDirectory()) {
    let entries = [];
    try {
      entries = fs.readdirSync(target);
    } catch {
      return;
    }
    for (const entry of entries) makeWritable(path.join(target, entry));
  }
}

// Gibt true zurück, wenn gelöscht wurde; wirft bei verweigerter Sicherheitsprüfung.
function removeRunTmp(dir, root = os.tmpdir(), prefix = PREFIX) {
  const realRoot = fs.realpathSync(root);
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== realRoot) {
    throw new Error(`Löschen verweigert: ${resolved} liegt nicht direkt unter ${realRoot}`);
  }
  if (!path.basename(resolved).startsWith(prefix) || path.basename(resolved) === prefix) {
    throw new Error(`Löschen verweigert: ${resolved} trägt nicht den erwarteten Präfix ${prefix}`);
  }
  let st;
  try {
    st = fs.lstatSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Löschen verweigert: ${resolved} ist kein echtes Verzeichnis`);
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    makeWritable(resolved);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  return true;
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function run(argv, { root = os.tmpdir(), prefix = PREFIX, env = process.env } = {}) {
  return new Promise(resolve => {
    const args = argv[0] === '--' ? argv.slice(1) : argv;
    if (!args.length) {
      console.error('Aufruf: node scripts/with-tmp.js [--] <kommando> [args…]');
      resolve(2);
      return;
    }
    const dir = createRunTmp(root, prefix);
    let done = false;
    const handlers = [];

    const finish = code => {
      if (done) return;
      done = true;
      for (const [sig, fn] of handlers) process.removeListener(sig, fn);
      try {
        removeRunTmp(dir, root, prefix);
      } catch (e) {
        console.error(`[with-tmp] Aufräumen fehlgeschlagen: ${e.message}`);
        if (code === 0) code = 1;
      }
      resolve(code);
    };

    const child = spawn(args[0], args.slice(1), {
      stdio: 'inherit',
      env: { ...env, TMPDIR: dir, TMP: dir, TEMP: dir },
    });

    for (const sig of Object.keys(SIGNALS)) {
      const fn = () => {
        try {
          child.kill(sig);
        } catch {
          /* Kind bereits beendet */
        }
      };
      handlers.push([sig, fn]);
      process.on(sig, fn);
    }

    child.on('error', err => {
      console.error(`[with-tmp] Kommando konnte nicht gestartet werden: ${err.message}`);
      finish(127);
    });
    child.on('close', (code, signal) => {
      finish(signal ? 128 + (SIGNALS[signal] || os.constants.signals[signal] || 1) : (code ?? 1));
    });
  });
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = { PREFIX, createRunTmp, removeRunTmp, run };
