// v0.5.12 – Versionsauflösung für die App-Anzeige (User-Befund 01.10., Karte t_9f74c461)
//
// Bisher zeigte main.js `git describe --tags --abbrev=0` aus dem Install-
// Checkout. Konnte ein externes Update (install.sh/QA-Procedere) die Tags
// nicht mitziehen, beschrieb describe den neuen Commit mit dem NÄCHSTEN
// ERREICHBAREN ALTEN Tag (v0.5.10-1-g8da8a34) → die App zeigte „v0.5.10",
// obwohl v0.5.11-Code lief.
//
// Diese Kette zeigt nie eine falsche (ältere) Version:
//   1. Tag exakt auf HEAD (git tag --points-at) — nach jedem Updater-/Install-
//      Checkout der Normalfall, eindeutig und aktuell.
//   2. package.json version — im Release-Workflow wird sie mit jedem Tag
//      mitgebump't; nach einem Tag-Checkout immer korrekt, auch ohne lokale
//      Tags. Lieber diese als ein altes describe-Tag.
//   3. Fallback (Electron app.getVersion()) — letzter Ausweis.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION_TIMEOUT_MS = 5000;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Höchstes Tag, das exakt auf HEAD zeigt — oder null. */
function versionFromGitTag(appDir) {
  try {
    const raw = execFileSync('git', ['tag', '--points-at', 'HEAD', '--sort=-v:refname'], {
      cwd: appDir,
      encoding: 'utf-8',
      timeout: VERSION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = String(raw).split('\n').map(line => line.trim()).filter(Boolean)[0] || '';
    const version = first.replace(/^v/i, '');
    return SEMVER_RE.test(version) ? version : null;
  } catch (_) {
    return null;
  }
}

/** package.json version aus dem Checkout — oder null (fehlt/ungültig). */
function versionFromPackageJson(appDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
    const version = String(pkg.version || '');
    return SEMVER_RE.test(version) ? version : null;
  } catch (_) {
    return null;
  }
}

/**
 * Anzeigbare Version ermitteln. Fallback wird verwendet, wenn weder Tag noch
 * package.json liefern (z. B. kein Checkout). Rückgabe: { version, source }.
 */
function resolveAppVersion(appDir, fallbackVersion) {
  const fromTag = versionFromGitTag(appDir);
  if (fromTag) return { version: fromTag, source: 'git-tag' };
  const fromPkg = versionFromPackageJson(appDir);
  if (fromPkg) return { version: fromPkg, source: 'package.json' };
  return { version: String(fallbackVersion || ''), source: 'app-fallback' };
}

module.exports = { resolveAppVersion, versionFromGitTag, versionFromPackageJson };
