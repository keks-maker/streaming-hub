#!/usr/bin/env node
/**
 * stage-mac-icon.js — stellt die Konsistenz zwischen CFBundleIconFile (Info.plist)
 * und der Icon-Datei in Contents/Resources eines macOS-.app-Stagings her.
 *
 * Hintergrund: install.sh setzt CFBundleIconFile auf "AppIcon.icns", aber die
 * Quelle für den Copy kann fehlen (Release-Mode: INSTALL_DIR wird erst NACH
 * dem Staging ersetzt). Ergebnis: Pointer ohne Datei → generisches Dock-Icon
 * im Kaltezustand. Dieses Skript garantiert: Der Pointer zeigt nur auf eine
 * Datei, die auch existiert.
 *
 * Usage:
 *   node scripts/stage-mac-icon.js <appDir> [<assetSourceDir> ...]
 *
 *   <appDir>            Staging-Root des .app-Bundles (Contents/Info.plist + Resources)
 *   <assetSourceDir>    Kandidaten-Verzeichnisse, die assets/icon.icns enthalten
 *                       (z. B. INSTALL_DIR oder Release-Install-Stage)
 *
 * Exit-Codes: 0 = konsistent, 1 = keine Icon-Quelle gefunden (Bundle wäre ohne Icon).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ICON_KEY = 'CFBundleIconFile';

function readPlist(appDir) {
  return fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8');
}

function writePlist(appDir, content) {
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), content);
}

/** Liest den aktuellen CFBundleIconFile-Wert aus einer XML-Info.plist (oder null). */
function getIconFileValue(plistContent) {
  const m = plistContent.match(
    new RegExp(`<key>${ICON_KEY}</key>\\s*<string>([^<]*)</string>`)
  );
  return m ? m[1] : null;
}

/** Setzt CFBundleIconFile; existiert der Key nicht, wird er nach dem ersten <dict> eingefügt. */
function setIconFileValue(plistContent, value) {
  const re = new RegExp(`(<key>${ICON_KEY}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(plistContent)) {
    return plistContent.replace(re, `$1${value}$2`);
  }
  const insertion = `<key>${ICON_KEY}</key>\n\t<string>${value}</string>\n`;
  if (plistContent.includes('<dict>')) {
    return plistContent.replace('<dict>', `<dict>\n\t${insertion}`);
  }
  throw new Error('Info.plist enthält kein <dict> — Format nicht unterstützt');
}

/** Alle .icns-Dateien, die aktuell in Resources liegen. */
function icnsInResources(appDir) {
  const res = path.join(appDir, 'Contents', 'Resources');
  if (!fs.existsSync(res)) return [];
  return fs.readdirSync(res).filter((f) => f.endsWith('.icns'));
}

function main() {
  const [appDir, ...sourceDirs] = process.argv.slice(2);
  if (!appDir) {
    console.error('Usage: node scripts/stage-mac-icon.js <appDir> [<assetSourceDir> ...]');
    process.exit(1);
  }
  const plistPath = path.join(appDir, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    console.error(`stage-mac-icon: Info.plist nicht gefunden: ${plistPath}`);
    process.exit(1);
  }

  const resourcesDir = path.join(appDir, 'Contents', 'Resources');
  fs.mkdirSync(resourcesDir, { recursive: true });

  // 1. Bevorzugte Quelle: assets/icon.icns aus dem Install-Staging.
  let copiedFrom = null;
  for (const dir of sourceDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'assets', 'icon.icns');
    if (fs.existsSync(candidate)) {
      fs.copyFileSync(candidate, path.join(resourcesDir, 'AppIcon.icns'));
      copiedFrom = candidate;
      break;
    }
  }

  // 2. Fallback: ein .icns, das der Builder bereits in Resources abgelegt hat.
  if (!copiedFrom) {
    const existing = icnsInResources(appDir);
    if (existing.length > 0) {
      fs.copyFileSync(
        path.join(resourcesDir, existing[0]),
        path.join(resourcesDir, 'AppIcon.icns')
      );
      copiedFrom = path.join(resourcesDir, existing[0]);
    }
  }

  if (!copiedFrom) {
    console.error(
      'stage-mac-icon: keine Icon-Quelle gefunden (weder assets/icon.icns noch Resources/*.icns)'
    );
    process.exit(1);
  }

  // 3. Pointer auf die garantiert existierende Datei setzen.
  let plist = readPlist(appDir);
  plist = setIconFileValue(plist, 'AppIcon.icns');
  writePlist(appDir, plist);

  // 4. Verifikation innerhalb des Skripts (Fail-loud statt stiller Inkonsistenz).
  const finalValue = getIconFileValue(readPlist(appDir));
  const base = finalValue.endsWith('.icns') ? finalValue.slice(0, -5) : finalValue;
  const resolved = path.join(resourcesDir, `${base}.icns`);
  if (!fs.existsSync(resolved)) {
    console.error(
      `stage-mac-icon: Inkonsistenz nach Staging — CFBundleIconFile="${finalValue}", Datei ${resolved} fehlt`
    );
    process.exit(1);
  }

  console.log(`stage-mac-icon: AppIcon.icns bereit (Quelle: ${copiedFrom}), CFBundleIconFile="${finalValue}"`);
}

main();