'use strict';

// Plattformspezifisches für die E2E-Specs (macOS, Linux, Windows) an einer Stelle.
// Der macOS-Zweig ist der ursprüngliche Stand; Linux/Windows sind additive Zweige.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'streaming-hub'; // app.getName() ohne productName (Dev-Start und Linux/Windows-Pakete)
const TEST_HOOK = 'STREAMING_HUB_USER_DATA';

// Nicht startbare Dateien im entpackten Linux-Paket (electron-builder `--linux dir`).
const NON_APP_BINARIES = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Verzeichnis (z.B. release/linux-unpacked) -> darin liegende App-Binary.
function binaryInDir(dir) {
  const names = fs.readdirSync(dir).filter(n => !NON_APP_BINARIES.has(n) && !n.endsWith('.so') && isExecutableFile(path.join(dir, n)));
  if (names.includes(APP_NAME)) return path.join(dir, APP_NAME);
  if (!names.length) throw new Error(`E2E_APP_PATH: kein Executable in ${dir}`);
  return path.join(dir, names[0]);
}

// Pfad zur main.js im gepackten Bundle (asar: false) oder null, wenn nicht prüfbar.
//  - macOS:  <Name>.app/Contents/Resources/app/main.js
//  - Linux/Windows entpackt: <Verzeichnis der Binary>/resources/app/main.js
//  - AppImage (Squashfs, nicht ohne Mounten lesbar) und portable .exe: null -> keine Vorab-Prüfung.
function bundledMainPath(custom, exe) {
  if (custom.endsWith('.app')) return path.join(path.resolve(custom), 'Contents', 'Resources', 'app', 'main.js');
  const unpacked = path.join(path.dirname(exe), 'resources', 'app', 'main.js');
  return fs.existsSync(unpacked) ? unpacked : null;
}

// Launch-Ziel für electron.launch. E2E_APP_PATH (optional):
//  - macOS: gepackte .app (-> Contents/MacOS/<Binary>) oder die Binary selbst
//  - Linux: AppImage, entpacktes Verzeichnis (release/linux-unpacked) oder dessen Binary
//  - sonst: Pfad direkt (z.B. Windows-.exe)
// Default: `electron .` aus node_modules.
function resolveLaunchTarget() {
  const custom = process.env.E2E_APP_PATH;
  if (!custom) {
    // electron/index.js liefert den Pfad zur Binary des (Castlabs-)Electron.
    return { executablePath: require('electron'), args: [ROOT], packaged: false };
  }
  let exe = path.resolve(custom);
  if (exe.endsWith('.app')) {
    const macosDir = path.join(exe, 'Contents', 'MacOS');
    const bins = fs.existsSync(macosDir) ? fs.readdirSync(macosDir) : [];
    if (!bins.length) throw new Error(`E2E_APP_PATH: kein Executable in ${macosDir}`);
    exe = path.join(macosDir, bins[0]);
  } else if (fs.existsSync(exe) && fs.statSync(exe).isDirectory()) {
    exe = binaryInDir(exe);
  }
  if (!fs.existsSync(exe)) throw new Error(`E2E_APP_PATH existiert nicht: ${exe}`);
  // Vorab-Schutz (vor dem Start!): Ein Build ohne userData-Hook würde sonst die ECHTEN
  // Nutzerdaten öffnen. Gepackte Bundles haben asar: false, main.js ist also lesbar.
  const bundledMain = bundledMainPath(custom, exe);
  if (bundledMain && (!fs.existsSync(bundledMain) || !fs.readFileSync(bundledMain, 'utf8').includes(TEST_HOOK))) {
    throw new Error(`E2E_APP_PATH: ${custom} enthält den Test-Hook ${TEST_HOOK} nicht (zu alter Build?) — Abbruch zum Schutz echter Nutzerdaten`);
  }
  return { executablePath: exe, args: [], packaged: true };
}

// Plattformspezifische Chromium-Schalter.
function platformArgs() {
  if (process.platform === 'darwin') {
    // --use-mock-keychain: HOME zeigt auf ein temp-Verzeichnis ohne Login-Keychain; ohne den Schalter
    // erscheint auf macOS gelegentlich der Dialog "Schlüsselbund nicht gefunden".
    return ['--use-mock-keychain'];
  }
  if (process.platform === 'linux') {
    // Linux: Im gemessenen Testlauf (CachyOS, Wayland+XWayland, aus der Agent-Sandbox gestartet) konnte
    // Chromium keinen Kindprozess starten: "GPU process launch failed: error_code=1002", danach
    // "GPU process isn't usable" und ERR_FAILED beim Laden des Hauptfensters. --disable-gpu,
    // --disable-gpu-sandbox, --ozone-platform=x11 und --in-process-gpu helfen allein nicht,
    // --no-zygote genügt. Playwright setzt --no-sandbox selbst.
    return ['--no-zygote'];
  }
  return [];
}

// Vollständige Argumente für electron.launch: App-Argumente, Netz sperren, Plattform-Schalter.
function launchArgs(target) {
  return [...target.args, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', ...platformArgs()];
}

// Pfad des updater.log eines ECHTEN Nutzers (app.getPath('logs') ohne Test-Umbiegung des userData-Pfads).
//  - macOS:   ~/Library/Logs/Streaming Hub/updater.log
//  - Linux:   <userData>/logs = $XDG_CONFIG_HOME bzw. ~/.config/streaming-hub/logs/updater.log
//  - Windows: %APPDATA%/streaming-hub/logs/updater.log
function realUpdaterLogPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Logs', 'Streaming Hub', 'updater.log');
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME, 'logs', 'updater.log');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME, 'logs', 'updater.log');
}

module.exports = { ROOT, resolveLaunchTarget, platformArgs, launchArgs, realUpdaterLogPath };
