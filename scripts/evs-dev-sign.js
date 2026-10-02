#!/usr/bin/env node
/**
 * evs-dev-sign.js — postinstall EVS/VMP-Signierung der dev-Klon-Binary.
 *
 * Root-Cause (Fix-Set 8, S-Klasse): electron-builder afterPack (evs-afterPack.js)
 * signiert nur die Release-Area-Kopie (release/mac-arm64/…). Die
 * node_modules/electron/dist/Electron.app aus dem castlabs-Zip ist
 * adhoc/linker-signed und liefert auf macOS KEIN Widevine-L1-DRM
 * (Netflix E100, Prime 403, CDM-Init fail: "ilegale binary").
 *
 * Fix: Nach dem electron-Download signiert dieser Hook dieselbe Binary mit
 * castlabs_evs.vmp sign-pkg ("streaming"-Profil), sodass `npm start` / `predev`
 * eine DRM-valide Basis bereit. Fail-open: Ohne castlabs_evs
 * (kein ~/evs-venv, EVS_PYTHON unset) läuft der Hook still durch — Release-*
 * Builds bleiben über install.sh (verify-pkg vor jedem Austausch) und
 * updater.js (EVS-Verify vor Import) fail-closed gedeckt.
 *
 * Namenskontrakt: castlabs signiert gegen den Bundle-Namen, der im
 * Signier-Server-Profil registriert ist ("Streaming Hub"). Wir stagen deshalb
 * unter "Streaming Hub.app", signieren, und kopieren nur die .sig zurück —
 * der Bundle-Ordner-Name von Electron.app bleibt unverändert (npm-Kontrakt).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

const dev = path.join(__dirname, '..');
const app = path.join(dev, 'node_modules', 'electron', 'dist', 'Electron.app');
const sigRel = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Electron Framework.sig';
const sigDst = path.join(app, sigRel);

if (!fs.existsSync(app)) {
  console.log('[EVS-dev] electron dist fehlt — kein Signieren (Install-Schritt?).');
  process.exit(0);
}

// EVS-Umgebung finden (install.sh-Konvention: ~/evs-venv oder EVS_PYTHON).
let evsPy = process.env.EVS_PYTHON || path.join(os.homedir(), 'evs-venv', 'bin', 'python3');
if (!fs.existsSync(evsPy)) evsPy = 'python3';
const probe = spawnSync(evsPy, ['-c', 'import castlabs_evs'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[EVS-dev] castlabs_evs nicht verfügbar (' + evsPy + ') — dev-Klon-Binary bleibt unsigniert. Release-/Install-Pfad ist davon unberührt (fail-closed).');
  process.exit(0);
}

// Bereits signiert? sign-pkg/verify-pkg matchen das Bundle am Finder-Namen
// ("Streaming Hub.app"), nicht am Pfad-Argument — verify am rohen
// Electron.app-Pfad failt immer mit "No matching executable found"
// (R1-RC1: Skip wäre toter Code). Der Skip-Check läuft daher über dasselbe
// Symlink-Staging wie die Verifikation unten.
let alreadySigned = false;
const skipStage = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-evs-dev-skip.'));
try {
  fs.symlinkSync(app, path.join(skipStage, 'Streaming Hub.app'));
  const verifySkip = spawnSync(evsPy, ['-m', 'castlabs_evs.vmp', '-n', 'verify-pkg', skipStage], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (verifySkip.status === 0 && /streaming/.test((verifySkip.stdout || '') + (verifySkip.stderr || ''))) {
    alreadySigned = true;
  }
} finally {
  fs.rmSync(skipStage, { recursive: true, force: true });
}
if (alreadySigned) {
  console.log('[EVS-dev] Binary bereits EVS-streaming-signiert — überspringe.');
  process.exit(0);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-evs-dev.'));
const stagedApp = path.join(stage, 'Streaming Hub.app');
fs.cpSync(app, stagedApp, { recursive: true, verbatimSymlinks: true });

// CFBundleName → "Streaming Hub" (Signier-Profil-Bindung), danach zurücksetzen.
const plist = path.join(stagedApp, 'Contents', 'Info.plist');
const plutil = (key, value) => {
  const r = spawnSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('plutil failed: ' + (r.stderr || r.stdout));
};
let exitCode = 0;
try {
  plutil('CFBundleName', 'Streaming Hub');
  let r = spawnSync(evsPy, ['-m', 'castlabs_evs.vmp', '-n', 'sign-pkg', stage], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    console.error('[EVS-dev] sign-pkg fehlgeschlagen:\n' + (r.stdout || '') + (r.stderr || ''));
    console.error('[EVS-dev] dev-Klon-Binary bleibt unverändert — DRM im dev-Klon eingeschränkt.');
    exitCode = 1; // fail-closed für dev-Rückkanal (npm-Fail sichtbar); Release-Pfad ist zusätzlich install.sh-seitig fail-closed
  } else {
    console.log((r.stdout || '').trim());

    // Echtes Rollback-Original JETZT sichern, vor dem ersten Austausch
    // (R1-RC2: der alte Code kopierte die neue .sig VOR dem Verify und loggte
    // "zurückgerollt", ohne je zurückzurollen).
    const sigBak = path.join(stage, 'sig-backup.sig');
    let hadSig = false;
    try {
      fs.copyFileSync(sigDst, sigBak); // wirft, wenn keine alte .sig existiert
      hadSig = true;
    } catch (_) { hadSig = false; }

    // .sig zurückkopieren (Signatur bindet an Framework-Binary-Inhalt, nicht an
    // Bundle-Ordnernamen) — Austausch atomar: erst daneben kopieren, dann rename.
    const tmpSig = sigDst + '.evs-new';
    fs.mkdirSync(path.dirname(tmpSig), { recursive: true });
    fs.copyFileSync(path.join(stagedApp, sigRel), tmpSig);
    fs.renameSync(tmpSig, sigDst);

    // Verifikation: verify-pkg via gleichem Namens-Staging (Symlink,
    // npm-Layout unverändert).
    let ok = false;
    const verifyStage = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-evs-dev-verify.'));
    try {
      fs.symlinkSync(app, path.join(verifyStage, 'Streaming Hub.app'));
      r = spawnSync(evsPy, ['-m', 'castlabs_evs.vmp', '-n', 'verify-pkg', verifyStage], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status === 0 && /streaming/.test((r.stdout || '') + (r.stderr || ''))) {
        console.log('[EVS-dev] dev-Klon-Binary EVS-signiert: ' + ((r.stdout || '').trim().split('\n').pop() || 'streaming'));
        ok = true;
      }
    } finally {
      fs.rmSync(verifyStage, { recursive: true, force: true });
    }
    if (!ok) {
      // Echter Rollback (R1-RC2): Backup-.sig zurück — oder Artefakt entfernen,
      // wenn es vorher keine gab.
      try {
        if (hadSig) fs.copyFileSync(sigBak, sigDst);
        else fs.rmSync(sigDst, { force: true });
        console.error('[EVS-dev] verify-pkg fehlgeschlagen — .sig zurückgerollt, dist ist im Ausgangszustand.');
      } catch (rbErr) {
        console.error('[EVS-dev] verify-pkg fehlgeschlagen UND Rollback fehlgeschlagen (' + ((rbErr && rbErr.message) || rbErr) + ') — dist-.sig manuell prüfen.');
      }
      console.error((r.stderr || '') + (r.stdout || ''));
      exitCode = 1;
    }
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
process.exit(exitCode);
