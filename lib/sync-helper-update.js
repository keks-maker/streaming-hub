// Updater-Teil für den Mac-Helfer StreamingHubSync (D10): eigenes Release-Asset StreamingHubSync-<Version>.zip.
// Ablauf: entpacken in Staging, Signatur prüfen (codesign --verify --deep --strict, Identifier/Team, spctl), erst dann
// atomar (rename) nach <SyncHelper>/StreamingHubSync.app tauschen. Bei jedem Prüffehler bleibt der alte Helfer unberührt.
// Der Helfer wird NIE neu signiert (keine Ad-hoc-Neusignierung): Developer-ID-Signatur und Notarisierung müssen erhalten bleiben.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HELPER_IDENTIFIER = 'tv.streaminghub.desktopsync';
const HELPER_TEAM = 'LXXDCD6K7Z';
const HELPER_APP = 'StreamingHubSync.app';

/** Findet StreamingHubSync.app direkt im Staging-Ordner (genau eine, kein Suchen in Tiefe). */
function findHelperApp(root) {
  const direct = path.join(root, HELPER_APP);
  return fs.existsSync(direct) && fs.statSync(direct).isDirectory() ? direct : null;
}

function runTool(file, args) {
  const result = { stdout: '', stderr: '' };
  try {
    result.stdout = String(execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, encoding: 'utf8' }));
  } catch (error) {
    error.message = `${path.basename(file)} ${args[0]}: ${String(error.stderr || error.message).trim()}`;
    throw error;
  }
  return result;
}

/** codesign -dv schreibt auf stderr; execFileSync liefert es nur im Fehlerfall, daher über spawnSync-ähnlichen Weg. */
function describeSignature(codesignPath, app) {
  const { spawnSync } = require('child_process');
  const out = spawnSync(codesignPath, ['-dv', '--verbose=2', app], { encoding: 'utf8', timeout: 120000 });
  if (out.status !== 0) throw new Error(`codesign -dv: ${String(out.stderr).trim()}`);
  return `${out.stdout}\n${out.stderr}`;
}

/**
 * Wirft bei jedem Prüffehler. Prüft Signatur (strict), Identifier und Team und die Gatekeeper-Bewertung (Notarisierung).
 * Pfade der Werkzeuge sind für Tests austauschbar.
 */
function verifyHelperApp(app, { codesignPath = 'codesign', spctlPath = 'spctl' } = {}) {
  try {
    runTool(codesignPath, ['--verify', '--deep', '--strict', app]);
  } catch (error) {
    throw new Error(`Helfer-Signatur ungültig: ${error.message}`);
  }
  const info = describeSignature(codesignPath, app);
  if (!new RegExp(`^Identifier=${HELPER_IDENTIFIER.replace(/\./g, '\\.')}$`, 'm').test(info)) throw new Error(`Helfer hat nicht den Identifier ${HELPER_IDENTIFIER}`);
  if (!new RegExp(`^TeamIdentifier=${HELPER_TEAM}$`, 'm').test(info)) throw new Error(`Helfer stammt nicht von Team ${HELPER_TEAM}`);
  let assessment;
  try {
    const out = require('child_process').spawnSync(spctlPath, ['-a', '-vv', '-t', 'exec', app], { encoding: 'utf8', timeout: 120000 });
    assessment = `${out.stdout}\n${out.stderr}`;
    if (out.status !== 0) throw new Error(assessment.trim());
  } catch (error) {
    throw new Error(`Helfer von Gatekeeper abgelehnt: ${error.message}`);
  }
  if (!assessment.includes(`(${HELPER_TEAM})`)) throw new Error(`Gatekeeper-Herkunft passt nicht zu Team ${HELPER_TEAM}`);
}

/**
 * Installiert den Helfer aus dem heruntergeladenen ZIP.
 * deps: unzip(zipPath, destDir) (Standard: /usr/bin/unzip), verify(app) (Standard verifyHelperApp), log.
 * Rückgabe { installed: true } oder wirft (alter Helfer bleibt dann unverändert).
 */
function installSyncHelper({ zipPath, helperDir, unzip, verify = verifyHelperApp, log = () => {}, pid = process.pid }) {
  const staging = path.join(helperDir, `.update-staging-${pid}`);
  const rollback = path.join(helperDir, `.update-rollback-${pid}`);
  const target = path.join(helperDir, HELPER_APP);
  fs.mkdirSync(helperDir, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true }); // nur eigene Staging-/Rollback-Ordner dieses Laufs
  fs.rmSync(rollback, { recursive: true, force: true });
  fs.mkdirSync(staging);
  try {
    (unzip || ((zip, dest) => runTool('/usr/bin/unzip', ['-q', zip, '-d', dest])))(zipPath, staging);
    const app = findHelperApp(staging);
    if (!app) throw new Error(`Helfer-Asset enthält kein ${HELPER_APP}`);
    verify(app);
    if (fs.existsSync(target)) fs.renameSync(target, rollback);
    try {
      fs.renameSync(app, target);
    } catch (error) {
      if (fs.existsSync(rollback)) fs.renameSync(rollback, target);
      throw error;
    }
    fs.rmSync(rollback, { recursive: true, force: true });
    log(`Sync-Helfer installiert: ${target}`);
    return { installed: true };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Sichert den Helferordner vor dem App-Austausch (der ersetzt das ganze Support-Verzeichnis) und stellt ihn danach wieder her. */
function stashSyncHelper(helperDir, stashDir) {
  if (!fs.existsSync(helperDir)) return false;
  fs.rmSync(stashDir, { recursive: true, force: true }); // nur der eigene Stash dieses Laufs
  fs.renameSync(helperDir, stashDir);
  return true;
}

function restoreSyncHelper(helperDir, stashDir) {
  if (!fs.existsSync(stashDir)) return false;
  if (fs.existsSync(helperDir)) {
    // Die neue App brachte (unerwartet) einen eigenen Ordner mit: Stash-Inhalt nur ergänzen, nie überschreiben.
    for (const name of fs.readdirSync(stashDir)) {
      const dest = path.join(helperDir, name);
      if (!fs.existsSync(dest)) fs.renameSync(path.join(stashDir, name), dest);
    }
    fs.rmSync(stashDir, { recursive: true, force: true });
    return true;
  }
  fs.mkdirSync(path.dirname(helperDir), { recursive: true });
  fs.renameSync(stashDir, helperDir);
  return true;
}

/** Installierte Helfer-Version aus Contents/Info.plist (XML), null wenn nicht lesbar. */
function installedHelperVersion(helperDir) {
  try {
    const plist = fs.readFileSync(path.join(helperDir, HELPER_APP, 'Contents', 'Info.plist'), 'utf8');
    const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+)<\/string>/);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

module.exports = { installedHelperVersion, HELPER_IDENTIFIER, HELPER_TEAM, HELPER_APP, verifyHelperApp, installSyncHelper, stashSyncHelper, restoreSyncHelper, findHelperApp };
