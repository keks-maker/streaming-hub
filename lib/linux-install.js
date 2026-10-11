// lib/linux-install.js — Sichere Installation des Linux-Release-Pakets (entpacktes App-Verzeichnis aus tar.gz)
//
// Gleiches Muster wie die macOS-Installation (lib/bundle-install.js): das neue Verzeichnis wird am
// Staging-Punkt gebaut und geprueft, erst danach per rename getauscht (alter Stand -> Rollback). Bricht
// irgendein Schritt ab, bleibt der alte Stand unberuehrt bzw. wird zurueckgeholt.
//
// Layout des Pakets (electron-builder, asar:false): <root>/streaming-hub (ELF x86-64), chrome-sandbox,
// resources/app/{main.js,package.json,updater.js,...}. Nutzerdaten liegen ausserhalb (app.getPath('userData')),
// das Installationsverzeichnis enthaelt nur Programmcode und optionale ffmpeg-Binaries (bin/).
'use strict';

const fs = require('fs');
const path = require('path');
const { copyBundleTree, listSymlinks, recoverStaleUpdateDirs, sweepStaleUpdateDirs } = require('./bundle-install.js');

const EXECUTABLE = 'streaming-hub';
const EXECUTABLE_FILES = [EXECUTABLE, 'chrome_crashpad_handler', 'chrome-sandbox'];
const KEEP_FROM_OLD = ['bin/ffmpeg', 'bin/ffprobe', 'bin/.ffmpeg-release', 'bin/.ffmpeg-sha256.json'];

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isLinuxX64Elf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(20);
    if (fs.readSync(fd, head, 0, 20, 0) !== 20) return false;
    // ELF-Magic, 64 Bit (EI_CLASS=2), little endian (EI_DATA=1), e_machine = 0x3E (x86-64)
    return head.toString('latin1', 1, 4) === 'ELF' && head[4] === 2 && head[5] === 1 && head.readUInt16LE(18) === 0x3e;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Findet das App-Verzeichnis in einem entpackten Archiv: root selbst oder das einzige Unterverzeichnis,
 * das das Programm `streaming-hub` und resources/app enthaelt. Sonst null.
 */
function findLinuxAppRoot(extractDir) {
  const looksLikeRoot = dir => fs.existsSync(path.join(dir, EXECUTABLE)) && fs.existsSync(path.join(dir, 'resources', 'app'));
  if (looksLikeRoot(extractDir)) return extractDir;
  const dirs = fs.readdirSync(extractDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const candidates = dirs.map(entry => path.join(extractDir, entry.name)).filter(looksLikeRoot);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Pruefung eines (entpackten oder installierten) Linux-App-Verzeichnisses.
 * Rueckgabe: { ok: true } oder { ok: false, errors: [string] }.
 * options.version: erwartete Version (package.json in resources/app).
 */
function verifyLinuxInstall(root, options = {}) {
  const errors = [];
  const exe = path.join(root, EXECUTABLE);
  if (!fs.existsSync(exe)) errors.push(`Programm ${EXECUTABLE} fehlt`);
  else {
    if ((fs.statSync(exe).mode & 0o111) === 0) errors.push(`${EXECUTABLE} ist nicht ausfuehrbar`);
    if (!isLinuxX64Elf(exe)) errors.push(`${EXECUTABLE} ist kein x86-64-ELF-Programm`);
  }
  const app = path.join(root, 'resources', 'app');
  for (const rel of ['main.js', 'preload.js', 'updater.js', 'package.json']) {
    if (!fs.existsSync(path.join(app, rel))) errors.push(`resources/app/${rel} fehlt`);
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf-8'));
    if (pkg.name !== 'streaming-hub') errors.push(`package.json gehoert nicht zu Streaming Hub (name=${pkg.name})`);
    if (options.version && pkg.version !== options.version) {
      errors.push(`Version im Paket (${pkg.version}) stimmt nicht mit dem Release (${options.version}) ueberein`);
    }
  } catch (_) {
    // fehlende/kaputte package.json ist oben bzw. hier gemeldet
    if (fs.existsSync(path.join(app, 'package.json'))) errors.push('resources/app/package.json nicht lesbar');
  }
  try {
    for (const { link, target } of listSymlinks(root)) {
      const resolved = path.resolve(path.dirname(link), target);
      if (path.isAbsolute(target) || !isInside(root, resolved)) {
        errors.push(`Symlink verlaesst das App-Verzeichnis: ${path.relative(root, link)} -> ${target}`);
      } else if (!fs.existsSync(resolved)) {
        errors.push(`toter Symlink: ${path.relative(root, link)} -> ${target}`);
      }
    }
  } catch (error) {
    errors.push(`Verzeichnis nicht lesbar: ${error.message}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * Setzt die Ausfuehrbar-Bits fuer Programm und Helfer (tar bewahrt sie normalerweise; das schuetzt vor
 * Archiven, die mit umask/Dateisystem ohne Modus-Bits entpackt wurden). chrome-sandbox bleibt ohne
 * SUID-Bit (ohne root nicht setzbar).
 */
function ensureExecutableBits(root) {
  for (const name of EXECUTABLE_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const mode = fs.statSync(file).mode;
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, (mode & 0o7777) | 0o755);
  }
}

// Uebernimmt gebuendelte ffmpeg-Binaries der alten Installation, sofern das neue Paket keine mitbringt
// (spart den erneuten Download; ensureBinaries prueft Version und Pruefsumme beim App-Start ohnehin).
function carryOverFfmpeg(oldRoot, stagingRoot) {
  for (const rel of KEEP_FROM_OLD) {
    const from = path.join(oldRoot, 'resources', 'app', rel);
    const to = path.join(stagingRoot, 'resources', 'app', rel);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to) || !fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      fs.chmodSync(to, fs.statSync(from).mode);
    } catch (_) {
      // Komfortfunktion — fehlende Binaries werden beim Start nachgeladen
    }
  }
}

/**
 * Installiert das entpackte Release `newRoot` nach `installRoot` (vollstaendiger Austausch des Verzeichnisses).
 * - Staging: newRoot wird per rename (gleiches Dateisystem) oder Kopie zu `${installRoot}.update-staging-<pid>`.
 * - Gate am Staging-Punkt (Layout, ELF, Version, Symlinks); danach Swap mit Rollback und End-Verifikation.
 * options.version: erwartete Version; options.afterSwap(info): Test-Hook direkt nach dem Swap.
 */
function installLinuxRelease(newRoot, installRoot, options = {}) {
  const staging = `${installRoot}.update-staging-${process.pid}`;
  const rollback = `${installRoot}.update-rollback-${process.pid}`;
  const recovery = recoverStaleUpdateDirs(installRoot, null);
  if (recovery.restored.length && options.log) options.log(`Selbstheilung: zurueckgeholt aus Rollback: ${recovery.restored.join(', ')}`);
  fs.mkdirSync(path.dirname(installRoot), { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(rollback, { recursive: true, force: true });
  let swapped = false;
  try {
    try {
      fs.renameSync(newRoot, staging);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      copyBundleTree(newRoot, staging);
    }
    ensureExecutableBits(staging);
    if (fs.existsSync(installRoot)) carryOverFfmpeg(installRoot, staging);
    const gate = verifyLinuxInstall(staging, { version: options.version });
    if (!gate.ok) throw new Error(`Integritaetspruefung des neuen Pakets fehlgeschlagen: ${gate.errors.join('; ')}`);
    if (fs.existsSync(installRoot)) fs.renameSync(installRoot, rollback);
    swapped = true;
    fs.renameSync(staging, installRoot);
    if (options.afterSwap) options.afterSwap({ installRoot, rollback });
    const finalGate = verifyLinuxInstall(installRoot, { version: options.version });
    if (!finalGate.ok) throw new Error(`Integritaetspruefung am Ziel fehlgeschlagen: ${finalGate.errors.join('; ')}`);
    fs.rmSync(rollback, { recursive: true, force: true });
    sweepStaleUpdateDirs(installRoot, null);
  } catch (error) {
    if (swapped && fs.existsSync(rollback)) {
      fs.rmSync(installRoot, { recursive: true, force: true });
      fs.renameSync(rollback, installRoot);
    }
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { EXECUTABLE, findLinuxAppRoot, verifyLinuxInstall, installLinuxRelease, ensureExecutableBits, isLinuxX64Elf };
