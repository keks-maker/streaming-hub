'use strict';

/**
 * Regressionstest: Dock-Icon im Kaltezustand (A-Klasse, v0.5.23-Befund).
 *
 * Root-Cause (bewiesen am installierten Bundle): Info.plist verlangte
 * CFBundleIconFile = "AppIcon.icns", Resources enthielt nur icon.icns →
 * generisches Dock-Icon bei gestoppter App. Regression aus v0.5.18
 * (e5def7a): der Icon-Copy in install.sh las die Quelle aus $INSTALL_DIR,
 * das im Release-Mode erst NACH dem Staging ersetzt wird.
 *
 * Fix: scripts/stage-mac-icon.js garantiert Pointer ↔ Datei-Konsistenz.
 * Diese Suite prüft das Skript gegen echte Bundle-Layouts und die
 * electron-builder-Konfig (build.mac.icon).
 *
 * Nach einem echten build:mac kann zusätzlich die Bundle-Verifikation via
 *   node --test tests/mac-icon-consistency.test.js --bundle <pfad-zu-.app>
 * laufen — geprüft wird dann das produzierte Bundle selbst.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'stage-mac-icon.js');
const { execFileSync } = require('node:child_process');
const repoRoot = path.join(__dirname, '..');

function makeApp({ plistIconValue, resources }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-icon-'));
  const app = path.join(dir, 'Streaming Hub.app');
  const res = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(res, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plistIconValue !== undefined ? `\t<key>CFBundleIconFile</key>\n\t<string>${plistIconValue}</string>\n` : ''}\t<key>CFBundleIdentifier</key>
\t<string>com.streaming-hub.app</string>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist);
  for (const [name, content] of Object.entries(resources)) {
    fs.writeFileSync(path.join(res, name), content);
  }
  return app;
}

function runStage(app, ...sourceDirs) {
  execFileSync(process.execPath, [SCRIPT, app, ...sourceDirs], { cwd: repoRoot });
}

/** Kern-Assertion: CFBundleIconFile referenziert eine existierende Datei in Resources. */
function assertConsistent(app) {
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  const m = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]*)<\/string>/);
  assert.ok(m, 'Info.plist muss CFBundleIconFile enthalten');
  const value = m[1];
  const base = value.endsWith('.icns') ? value.slice(0, -5) : value;
  const resolved = path.join(app, 'Contents', 'Resources', `${base}.icns`);
  assert.ok(
    fs.existsSync(resolved),
    `CFBundleIconFile="${value}" muss auf existierende Datei zeigen (${resolved}) — sonst generisches Dock-Icon im Kaltezustand`
  );
  return value;
}

test('Regression v0.5.23: Release-Mode-Layout (INSTALL_DIR-Quelle fehlt beim Staging, Builder-Icon in Resources)', () => {
  // Reproduziert den defekten Zustand: stage enthält Builder-icon.icns,
  // CFBundleIconFile wurde (alt) auf AppIcon.icns gesetzt, keine assets-Quelle.
  const app = makeApp({ plistIconValue: 'AppIcon.icns', resources: { 'icon.icns': 'FAKE-ICNS' } });
  runStage(app, '/nirgendwo/install-dir'); // Quelle fehlt — exakt der Fehlerzustand
  const value = assertConsistent(app);
  assert.strictEqual(value, 'AppIcon.icns');
  assert.ok(
    fs.existsSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns')),
    'AppIcon.icns muss aus dem Builder-Icon erzeugt werden'
  );
});

test('Release-Mode: assets/icon.icns aus dem Release-Install-Stage wird als Quelle genutzt', () => {
  const app = makeApp({ plistIconValue: 'icon.icns', resources: { 'icon.icns': 'BUILDER-ICNS' } });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-icon-src-'));
  fs.mkdirSync(path.join(stage, 'assets'));
  fs.writeFileSync(path.join(stage, 'assets', 'icon.icns'), 'APP-ICNS');
  runStage(app, '/nirgendwo/install-dir', stage);
  assertConsistent(app);
  assert.strictEqual(
    fs.readFileSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns'), 'utf8'),
    'APP-ICNS',
    'es muss das App-Icon aus dem Install-Stage kopiert werden, nicht das Builder-Fallback'
  );
});

test('Git-Source-Mode: assets/icon.icns aus INSTALL_DIR', () => {
  const app = makeApp({ plistIconValue: 'electron.icns', resources: { 'electron.icns': 'ELECTRON' } });
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-icon-src-'));
  fs.mkdirSync(path.join(installDir, 'assets'));
  fs.writeFileSync(path.join(installDir, 'assets', 'icon.icns'), 'APP-ICNS');
  runStage(app, installDir);
  assertConsistent(app);
  assert.strictEqual(
    fs.readFileSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns'), 'utf8'),
    'APP-ICNS'
  );
});

test('Keine Quelle: Skript failt laut statt ein inkonsistentes Bundle zu hinterlassen', () => {
  const app = makeApp({ plistIconValue: 'icon.icns', resources: {} });
  assert.throws(
    () => runStage(app, '/nirgendwo'),
    /keine Icon-Quelle/
  );
});

test('electron-builder-Konfig: build.mac.icon zeigt auf existierende Datei', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const iconRel = pkg.build && pkg.build.mac && pkg.build.mac.icon;
  assert.ok(iconRel, 'build.mac.icon muss gesetzt sein');
  assert.ok(
    fs.existsSync(path.join(repoRoot, iconRel)),
    `build.mac.icon="${iconRel}" existiert nicht im Repo`
  );
  assert.ok(iconRel.endsWith('.icns'), 'mac icon muss .icns sein');
});

test('install.sh ruft stage-mac-icon.js und setzt CFBundleIconFile nicht mehr unconditionally via plutil', () => {
  const sh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  assert.ok(
    sh.includes('stage-mac-icon.js'),
    'install.sh muss die Icon-Logik über scripts/stage-mac-icon.js ausführen'
  );
  assert.ok(
    !sh.includes('plutil -replace CFBundleIconFile'),
    'install.sh darf CFBundleIconFile nicht mehr ohne Konsistenz-Garantie setzen'
  );
});

// Optional: echtes Bundle prüfen (nach build:mac), falls eines übergeben wurde.
if (process.argv.includes('--bundle')) {
  const appPath = process.argv[process.argv.indexOf('--bundle') + 1];
  test(`Echtes Bundle prüfen: ${appPath}`, () => {
    assertConsistent(appPath);
  });
}