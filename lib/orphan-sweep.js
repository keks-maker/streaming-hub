// v0.5.18 – Orphan-Janitor (Karte t_695bf150)
//
// Problem: Bei App-Quit ohne deterministischen Shutdown-Sweep bleiben
// ffmpeg-Childs als ORPHANS zurück (PPID 1, QA-Befund: 22 GB Zwischenform,
// 15,5 h unbeaufsichtigt). Der Quit-Sweep (RecorderService.quitSweep) schließt
// den produktionsnahen Fall; der Janitor deckt die verbleibenden Fälle ab:
// - App-Crash mitten in der Aufnahme (kein quit-Event gefeuert)
// - ffmpeg, das SIGKILL während 'will-quit' überlebt hat (Race)
//
// Strategie: ps-Scan (POSIX-only bewusst — macOS + Linux sind die
// Distributionen), exaktes Matching gegen die APP-EIGENEN Binaries
// (<appRoot>/bin/ffmpeg|ffprobe), SIGINT → kurze Grace → SIGKILL.
// KEIN Kill von fremden ffmpeg-Instanzen (User hat selbst ffmpeg-Workflows
// — QA-Harness-Leichen aus /tmp/qa_hls_server.py sind bewusst im gleichen
// Root-State gewesen und dürfen nicht berührt werden).
//
// Zustandslos, bewusst ohne Persistenz: jede app-Instanz scannt idempotent
// beim eigenen Start. Orphans, die NACH dem Scan entstehen, kann der
// Lauf-Pfad nicht Erwischt — quitSweep übernimmt dort verlässlich.

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const logger = require('../logger.js');

const SIGINT_GRACE_MS = 1500; // ps-Scan-tolerant, kein sauberer Ausgang nötig

function log(level, message) {
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[fn](`[orphan-sweep] ${message}`);
}

/**
 * Scannt laufende Prozesse (POSIX) und liefert Zeilen { pid, ppid, args }.
 * Bewusst execFileSync + String-Zerlegung: kein driftendes array-NonQuery.
 */
function listProcesses() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  const processes = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return processes;
}

/**
 * Filtert auf App-eigene ffmpeg/ffprobe-Instanzen: Die Binary im args-Feld
 * muss exakt unter dem App-Root liegen.
 */
function findAppFfmpegOrphans({ appRoot, currentPid = process.pid }) {
  const candidates = [];

  let processes;
  try {
    processes = listProcesses();
  } catch (e) {
    log('warn', `ps-Scan fehlgeschlagen: ${e.message}`);
    return candidates;
  }

  let rootReal;
  try {
    rootReal = fs.realpathSync(appRoot);
  } catch (e) {
    log('warn', `App-Root nicht auflösbar: ${e.message}`);
    return candidates;
  }

  for (const probe of processes) {
    if (probe.pid === currentPid) continue;
    // App-eigene ffmpeg/ffprobe-Binaries erkennen — WO auch immer der Binary-
    // Pfad in der Kommandozeile steckt: auf Linux läuft ein Shebang-Skript
    // als "/bin/sh <pfad>/ffmpeg …" (ps zeigt den Interpreter + Skript).
    // Der Boundary-Regex matcht jeden Wortgrenzen-Pfad mit */bin/…-Endung.
    // eslint-disable-next-line no-control-regex -- RegExp läuft auf process-args, nicht auf User-Input
    const binMatch = /(?:^|\s)(\S*\/bin\/(?:ffmpeg|ffprobe))(?=$|\s)/.exec(probe.args);
    if (!binMatch) continue;
    const binPath = binMatch[1];
    let realBinary;
    try {
      realBinary = fs.realpathSync(binPath);
    } catch (_) {
      continue; // Pfad nicht existent/auflösbar → nicht unser Bundle
    }
    if (!realBinary.startsWith(rootReal + '/')) continue;
    candidates.push({
      pid: probe.pid,
      ppid: probe.ppid,
      bin: binPath,
      orphan: probe.ppid === 1 || !pidAlive(probe.ppid),
    });
  }
  return candidates;
}

/**
 * Lebt die PPID-Session noch? PPID 1 oder nicht mehr laufender Parent =
 * verwaist. Bewusst nur ein Existenz-Check (kill0), keine Parent-Identität —
 * der Sweep zielt nur auf App-eigene Binary-Pfade.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Tötet einen PID-Satz deterministisch: SIGINT, dann SIGKILL nach Grace.
 * Idempotent gegen bereits beendete PIDs.
 */
function killProcessIds(pids) {
  const results = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGINT');
      results.push({ pid, signal: 'SIGINT' });
    } catch (e) {
      results.push({ pid, error: e.code === 'ESRCH' ? 'bereits weg' : e.message });
    }
  }
  // Grace → SIGKILL asynchron (Janitor-Aufrufer muss nicht blockieren)
  setTimeout(() => {
    for (const entry of results) {
      if (entry.signal !== 'SIGINT') continue;
      try {
        process.kill(entry.pid, 0); // lebt noch? dann SIGKILL nachschicken
        process.kill(entry.pid, 'SIGKILL');
        log('warn', `ffmpeg (PID ${entry.pid}) überlebte SIGINT — SIGKILL nachgeschickt`);
      } catch (_) {
        // Prozess ist bereits weg (ESRCH bei beiden Checks) — fertig
      }
    }
  }, SIGINT_GRACE_MS);
  return results;
}

/**
 * Einstiegspunkt (App-Start): findet verwaiste App-ffmpeg-Childs und
 * räumt sie auf. Gibt die betroffenen PIDs zurück (Diagnostik/Tests).
 *
 * Bewusst SYCHRON beim Start: execFileSync mit Timeout — der Start-Flow der
 * App wartet keine sichtbare Zeit (ps ~10 ms, kein Dialog).
 */
function sweepOrphans({ appRoot = null } = {}) {
  if (!appRoot) return [];
  try {
    const candidates = findAppFfmpegOrphans({ appRoot });
    const targets = [];
    for (const c of candidates) {
      // Orphan-Kriterium (Janitor-Vertrag): PPID 1 (klassisches Reparenting)
      // ODER Parent existiert nicht mehr (Container/Session-Subreaper ziehen
      // den Reparent an sich — QA-Befund analog, PID 10234 mit PPID 1 auf
      // dem Mac; in anderen Session-Layouts ist der Parent schlicht tot).
      if (c.orphan) targets.push(c.pid);
    }
    if (!targets.length) return [];
    log('warn', `Orphan-Janitor: ${targets.length} verwaiste App-ffmpeg-Instanz(en) beendet (PIDs: ${targets.join(', ')})`);
    killProcessIds(targets);
    return targets;
  } catch (e) {
    log('error', `Orphan-Janitor fehlgeschlagen: ${e.message}`);
    return [];
  }
}

module.exports = { sweepOrphans, findAppFfmpegOrphans, listProcesses, killProcessIds, pidAlive, SIGINT_GRACE_MS };
