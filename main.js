// v0.3.6.
const { compareVersions, cleanChannelName, parseXMLTV, parseM3UFull, applyChannelOverrides } = require('@streaming-hub/typed-core');
const logger = require('./logger.js');
const { app, BrowserWindow, ipcMain, components, screen, globalShortcut, dialog, shell, protocol, powerMonitor, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const { reconcilePostUpdate } = require('./lib/post-update-reconcile.js');
const { resolveAppVersion } = require('./lib/app-version.js');
const { createUserStorage } = require('./lib/user-storage.js');
const { parseBackup } = require('./lib/backup.js');
const {
  normalizeWebviewKeydown,
  validateDownloadSize,
  validateReleaseMetadata,
  validateVersion,
} = require('./lib/ipc-validation.js');
const { RecorderService } = require('./lib/recorder/RecorderService.js');
const { registerRecorderIpc, ensureDefaultStorageRoot } = require('./lib/recorder/ipc.js');
const { createScheduleStore } = require('./lib/recorder/ScheduleStore.js');
const { Scheduler } = require('./lib/recorder/Scheduler.js');
const { registerScheduleIpc } = require('./lib/recorder/ipc-schedule.js');
const { TrayController } = require('./lib/recorder/TrayController.js');
const { QuitCoordinator } = require('./lib/recorder/QuitCoordinator.js');
const { StandbyGuard } = require('./lib/recorder/StandbyGuard.js');
const { createStreamResolver } = require('./lib/recorder/stream-resolver.js');
const { sweepOrphans } = require('./lib/orphan-sweep.js');
const paths = require('./lib/recorder/paths.js');
const recordingSettingsLib = require('./lib/recorder/recording-settings.js');
const { EpgService } = require('./lib/epg/EpgService.js');
const { registerEpgIpc } = require('./lib/epg/ipc.js');
const { fetchEpgResponse } = require('./lib/epg/download.js');
const { isProbablyNetworkPath } = require('./lib/recorder/ui-model.js');

/**
 * Freier Speicherplatz am Root (bytes) oder null, wenn nicht ermittelbar
 * (Netzwerk-Filesysteme ohne statfs-Antwort — Konzept §3.4).
 */
function storageFreeBytes(root) {
  try {
    const stat = fs.statfsSync(path.resolve(root));
    return stat.bavail * stat.bsize;
  } catch (_) {
    return null;
  }
}

function readRecordingSettingsRaw() {
  try {
    return userStorage.readJson('recordingSettings', null);
  } catch (_) {
    return null;
  }
}

const recordingSettingsResponse = recordingSettingsLib.buildSettingsResponse;

// Aufnahme-Engine (Konzept §2.5) — storageRoot nach app.whenReady gesetzt
let recorder = null;
// Wochen-EPG im Main (Etappe 1, Konzept §3.2) — lebt unabhängig vom Fenster
let epgService = null;
let trayController = null;
// Geplante Aufnahmen (Etappe 2a, Konzept §3.4) — Takt im Main, unabhängig vom Fenster
let scheduler = null;
// Standby-Schutz (Etappe 2b): powerSaveBlocker bei Aufnahme/anstehendem Start
let standbyGuard = null;

// Test-Hook (E2E): STREAMING_HUB_EPG_FIXTURE=<XMLTV-Datei> ersetzt den EPG-Download
// durch die lokale Datei — für Main-EpgService UND fetch-epg. Gilt nur in isolierten
// Läufen (STREAMING_HUB_USER_DATA), nie im Normalbetrieb; es gibt keinen Netzzugriff.
const epgFixtureFile =
  process.env.STREAMING_HUB_USER_DATA && process.env.STREAMING_HUB_EPG_FIXTURE
    ? path.resolve(process.env.STREAMING_HUB_EPG_FIXTURE)
    : null;
const epgFixtureFetch = epgFixtureFile
  ? async () => new Response(fs.readFileSync(epgFixtureFile), { status: 200, headers: { 'content-type': 'application/xml' } })
  : null;

// Wiedergabe-Protokoll der Aufnahmen (Phase 1c, Karte t_bafa7928):
// rec://<recId>/<datei> streamt Dateien aus dem Aufnahmen-Root. hls.js kann
// von einer file://-Seite keine file://-Segmente per XHR laden — rec:// ist
// ein privilegiertes Scheme (supportFetchAPI + stream), jailt auf den Root
// und erlaubt nur die Zwischenform (.m3u8/.ts) und fertige MP4s.
const REC_SCHEME = 'rec';
// Dateinamen der Aufnahmen werden aus Kanal-/Titelnamen gebaut (safeNamePart,
// lib/recorder/meta.js) und enthalten daher Leerzeichen, '@', Unicode — der
// frühere [\w.-]-Inventar hat jede reale MP4 mit 404 bedient (QA-Repro im
// Smoke-Test zu F-FB-05). Die Whitelist verbietet deshalb genau die Zeichen,
// die safeNamePart ebenfalls entfernt: Pfad-Trenner, Windows-Reservierte und
// Steuerzeichen; Traversal ('../') scheitert an der Zeichenklasse UND an der
// Pfad-Kontainment-Prüfung unten.
// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ausschlussziel
const REC_ALLOWED_EXTENSIONS = /^[^\\/:*?"<>|\u0000-\u001f\u007f]+\.(m3u8|ts|mp4)$/i;
const REC_JOB_DIR_PATTERN = /^rec_[A-Za-z0-9._-]+$/;

function isNetworkishPath(p) {
  return isProbablyNetworkPath(p);
}

function registerRecordingProtocol({ protocol, getRoot }) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REC_SCHEME,
      // corsEnabled: true (QA F-FB-04-Rest, t_9372a4b3): Fetches aus Pages mit
      // file://-Origin (Origin "null") an ein privates, non-CORS-fähiges
      // Scheme schneidet Chromium VOR dem Handler ab ("Failed to fetch") —
      // hls.js (XHR/fetch auf .m3u8 + .ts) erreicht rec:// dadurch nie. Das
      // Privileg erlaubt CORS-Fetches aufs Scheme; der Inhalt bleibt lokal
      // auf den Aufnahmen-Root gejailt (Zeichen-Whitelist + Pfad-Kontainment
      // im Handler unten, 18/18-Traversal-Smoke bleibt wirksam).
      privileges: {
        standard: true,
        stream: true,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
  ]);
  // Electron-42 protocol.handle-Konvention: der Handler liefert ein
  // Response-Objekt (oder Promise<Response>) — das alte
  // registerFileProtocol-callback({ path }) existiert hier nicht mehr und
  // führte zu "TypeError: callback is not a function" bei jedem
  // Wiedergabe-Klick (QA F-FB-04/05). Dateiinhalte werden als Node-Stream in
  // die Response gegeben; der Content-Type je Endung sorgt dafür, dass
  // <video> (MP4) und hls.js (.m3u8/.ts) die Daten korrekt dekodieren.
  const REC_CONTENT_TYPES = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.mp4': 'video/mp4',
  };
  function notFound() {
    return new Response(null, { status: 404 });
  }
  async function handler(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    try {
      const url = new URL(request.url);
      const recId = decodeURIComponent(url.hostname || '');
      const rel = decodeURIComponent(url.pathname || '').replace(/^\/+/, '');
      if (!REC_JOB_DIR_PATTERN.test(recId) || !REC_ALLOWED_EXTENSIONS.test(rel)) {
        return notFound();
      }
      const root = path.resolve(getRoot());
      const filePath = path.resolve(root, 'Aufnahmen', recId, rel);
      if (!filePath.startsWith(path.resolve(root, 'Aufnahmen') + path.sep)) {
        return notFound();
      }
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return notFound();
      const headers = { 'Content-Type': REC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' };
      // Content-Length nur für die fertige MP4: Die HLS-Zwischenform
      // (.m3u8/.ts) wächst während der Aufnahme — ein veralteter
      // Content-Length-Wert würde fetch/hls.js auf eine Antwort warten
      // lassen, die nie komplett eintrifft.
      if (filePath.toLowerCase().endsWith('.mp4')) {
        headers['Content-Length'] = String(stat.size);
      }
      return new Response(fs.createReadStream(filePath), { status: 200, headers });
    } catch (e) {
      // ENOENT ist der Normalfall (Zwischenform nach Remux geräumt, während
      // noch ein Player-Lauf drauf zeigt); alles andere sichtbar loggen.
      if (e && e.code !== 'ENOENT') {
        logger.error(`[rec://] ${request.url}: ${e.message}`);
      }
      return notFound();
    }
  }
  return { handler, scheme: REC_SCHEME };
}

// Privileg-Registrierung MUSS vor app ready passieren (Electron-Forderung);
// der Handler selbst wird in whenReady via protocol.handle verdrahtet.
const recordingProtocol = registerRecordingProtocol({ protocol, getRoot: () => (recorder ? recorder.storageRoot : '') });
const {
  MAX_PLAYLIST_BYTES,
  httpUrl,
  remoteHttpUrl,
  readResponseText,
  MAX_EPG_BYTES,
  service: validateService,
  text: validateText,
  tvSource: validateTvSource,
  tvSourceUpdates: validateTvSourceUpdates,
} = require('./lib/input-validation.js');
const { updateMode } = require('./lib/update-mode.js');
const { resolveAllowedM3uPath } = require('./lib/m3u-access.js');
const { describeM3uFetchError } = require('./lib/m3u-fetch-error.js');

if (process.platform === 'darwin') {
  const macPathEntries = [
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.volta/bin'),
    path.join(os.homedir(), '.asdf/shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...String(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);
  process.env.PATH = [...new Set(macPathEntries)].join(path.delimiter);
  app.setName('Streaming Hub');
  app.setPath('userData', path.join(app.getPath('appData'), 'streaming-hub'));
}
// Test-Hook (E2E, e2e/): isoliertes userData-Verzeichnis. Gilt auf allen
// Plattformen und läuft NACH dem macOS-Default, damit er diesen übersteuert.
if (process.env.STREAMING_HUB_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STREAMING_HUB_USER_DATA));
}

let mainWindow;

// ── Beenden-Dialog bei anstehender Planung (Etappe 2b, Konzept §3.5/E2) ──
// Nur bei einer Planung in den nächsten 24 h; Logik in lib/recorder/quit-guard.js,
// Ablauf (Fenster-X, before-quit, Updater-/System-Quit ohne Dialog) im QuitCoordinator.
// Test-Hook (E2E): STREAMING_HUB_TEST_QUIT_DIALOG=mock ersetzt den nativen Dialog
// durch eine Attrappe, die die Dialog-Optionen in globalThis.__streamingHubTest
// aufzeichnet und die dort gesetzte Antwort liefert. Gilt nur in isolierten Läufen
// (STREAMING_HUB_USER_DATA), nie im Normalbetrieb.
const quitDialogMock = process.env.STREAMING_HUB_USER_DATA && process.env.STREAMING_HUB_TEST_QUIT_DIALOG === 'mock';
if (quitDialogMock) {
  globalThis.__streamingHubTest = { quitDialogCalls: [], quitDialogResponse: 0 };
}
const quitCoordinator = new QuitCoordinator({
  app,
  askDialog: (win, options) => {
    if (quitDialogMock) {
      const hook = globalThis.__streamingHubTest;
      hook.quitDialogCalls.push({ message: options.message, detail: options.detail, buttons: options.buttons, hadWindow: !!win });
      return Promise.resolve({ response: hook.quitDialogResponse });
    }
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  },
  getEntries: () => (scheduler ? scheduler.list() : []),
  getActiveCount: () => (recorder ? recorder.activeJobs().length : 0),
  getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  logger,
});

let pipWindow = null;
let userStorage = null;
const selectedM3uFiles = new Set();

// Updater
let updaterProcess = null;
let autoUpdater = null;

function findChromeWidevine() {
  const platform = process.platform;
  let searchPaths = [];

  if (platform === 'linux') {
    searchPaths = [
      '/opt/google/chrome/WidevineCdm',
      path.join(os.homedir(), '.config/google-chrome/WidevineCdm'),
      path.join(os.homedir(), '.config/chromium/WidevineCdm'),
      path.join(os.homedir(), '.config/BraveSoftware/Brave-Browser/WidevineCdm'),
      path.join(os.homedir(), '.config/microsoft-edge/WidevineCdm'),
    ];
  } else if (platform === 'darwin') {
    searchPaths = [
      path.join(os.homedir(), 'Library/Application Support/Google/Chrome/WidevineCdm'),
      '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Libraries/WidevineCdm',
    ];
  } else if (platform === 'win32') {
    searchPaths = [
      path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '', 'Google/Chrome/User Data/WidevineCdm'),
    ];
  }

  for (const basePath of searchPaths) {
    const manifestPath = path.join(basePath, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      return { dir: basePath, manifestPath };
    }
    if (fs.existsSync(basePath)) {
      const entries = fs.readdirSync(basePath, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
        .reverse();
      for (const dir of dirs) {
        const versionPath = path.join(basePath, dir);
        const versionManifest = path.join(versionPath, 'manifest.json');
        if (fs.existsSync(versionManifest)) {
          return { dir: versionPath, manifestPath: versionManifest };
        }
      }
    }
  }
  return null;
}

const chromeWidevine = findChromeWidevine();
if (chromeWidevine) {
  try {
    const raw = fs.readFileSync(chromeWidevine.manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);
    if (manifest.version) {
      app.commandLine.appendSwitch('widevine-cdm-path', chromeWidevine.dir);
      app.commandLine.appendSwitch('widevine-cdm-version', manifest.version);
      logger.info('Using Chrome Widevine:', manifest.version);
    }
  } catch (e) {
    logger.warn('Chrome-Widevine-Manifest fehlerhaft:', e.message);
  }
}

// Keep Chromium's sandbox enabled. DRM failures must be diagnosed explicitly instead
// of weakening isolation for every window and every embedded provider.
app.commandLine.appendSwitch('disable-service-worker-autostart');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-features', 'PlatformEncryptedDolbyVision');
app.commandLine.appendSwitch('disable-features', 'MediaRouterProvider');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function loadServices() {
  try {
    return userStorage.readJson('services', []);
  } catch (error) {
    logger.warn('Dienste konnten nicht geladen werden:', error.message);
    return [];
  }
}

function saveServices(services) {
  userStorage.writeJson('services', services);
}

function broadcastServices() {
  const services = loadServices();
  mainWindow?.webContents.send('services-changed', services);
}

function loadTvSources() {
  const defaults = [
    {
      id: 'deutsche-oeffentlich-rechtliche',
      name: 'Deutsche Öffentlich-Rechtliche',
      url: 'https://iptv-org.github.io/iptv/countries/de.m3u',
      type: 'url',
      color: '#a78bfa',
      epgUrl: 'https://iptv-epg.org/files/epg-de.xml',
      sortOrder: [],
    },
  ];
  try {
    return userStorage.readJson('tvSources', defaults);
  } catch (error) {
    logger.warn('TV-Quellen konnten nicht geladen werden:', error.message);
    return defaults;
  }
}

function saveTvSources(sources) {
  userStorage.writeJson('tvSources', sources);
}

function broadcastTvSources() {
  const sources = loadTvSources();
  mainWindow?.webContents.send('tv-sources-changed', sources);
  // Neue/geänderte EPG-URL: Main-Cache holt sie nach (nur wenn fällig)
  if (epgService) epgService.tick().catch(e => logger.warn('EPG-Tick nach Quellenänderung fehlgeschlagen:', e.message));
}

function parseM3U(content, sourceId) {
  const result = parseM3UFull(content, sourceId || 'tv');
  const channels = result.channels.map(ch => {
    const cleanName = cleanChannelName(ch.name);
    return {
      id: ch.tvgId || cleanName || 'channel-' + Math.random().toString(36).slice(2, 8),
      name: cleanName || 'Unbekannter Sender',
      logo: ch.logo || null,
      group: ch.group,
      tvgId: ch.tvgId || '',
      url: ch.url,
    };
  });
  return { channels, epgUrls: result.epgUrls };
}

function loadHistory() {
  try {
    return userStorage.readJson('history', []);
  } catch (error) {
    logger.warn('Verlauf konnte nicht geladen werden:', error.message);
    return [];
  }
}

function saveHistory(history) {
  userStorage.writeJson('history', history);
}

// ── Updater ──

const UPDATE_API_BASE = process.env.STREAMING_HUB_UPDATE_URL || 'https://api.github.com';
const UPDATE_OWNER = 'keks-maker';
const UPDATE_REPO = 'streaming-hub';
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;
const UPDATE_APPLY_TIMEOUT_MS = 15 * 60 * 1000;
const UPDATE_RELEASE_PATH = `/keks-maker/streaming-hub/releases/download/`;

async function updateApi(path) {
  const url = `${UPDATE_API_BASE}/repos/${UPDATE_OWNER}/${UPDATE_REPO}/${path}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Streaming-Hub' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Update API ${res.status}`);
  return res.json();
}

function startUpdater() {
  if (process.env.APPIMAGE) {
    // AppImage: use Gitea API for updates
    autoUpdater = {
      check: async () => {
        try {
          const release = await updateApi('releases/latest');
          const tag = release.tag_name?.replace(/^v/i, '');
          if (!tag) return { hasUpdate: false, error: 'no tag' };
          return {
            hasUpdate: compareVersions(tag, app.getVersion()) > 0,
            latestVersion: tag,
            releaseId: release.id,
          };
        } catch (e) {
          return { hasUpdate: false, error: e.message };
        }
      },
      download: async version => {
        try {
          const release = await updateApi('releases/latest');
          const metadata = validateReleaseMetadata(
            release,
            version,
            new URL(UPDATE_API_BASE).origin,
            `${UPDATE_RELEASE_PATH}${version}/`,
          );
          const asset = metadata.asset;

          const currentAppImage = process.env.APPIMAGE;
          const appDir = path.dirname(currentAppImage);
          const tmpDest = path.join(appDir, `.update-${Date.now()}-${process.pid}.AppImage`);
          const finalDest = path.join(appDir, `Streaming Hub-${version}.AppImage`);
          mainWindow?.webContents.send('update-status', { type: 'progress', percent: 0 });
          const res = await fetch(asset.browser_download_url, {
            signal: AbortSignal.timeout(300000),
            redirect: 'error',
          });
          if (!res.ok) throw new Error(`Download ${res.status}`);
          const total = validateDownloadSize(res.headers.get('content-length'), MAX_UPDATE_BYTES);
          if (!res.body) throw new Error('Update-Download ohne Datenstrom');
          const reader = res.body.getReader();
          const ws = fs.createWriteStream(tmpDest, { flags: 'wx', mode: 0o600 });
          let received = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              received += value.byteLength;
              if (received > MAX_UPDATE_BYTES) throw new Error('Update-Datei ist zu groß');
              if (!ws.write(value))
                await new Promise((resolve, reject) => {
                  ws.once('drain', resolve);
                  ws.once('error', reject);
                });
              if (total) {
                mainWindow?.webContents.send('update-status', {
                  type: 'progress',
                  percent: Math.min(100, (received / total) * 100),
                });
              }
            }
            await new Promise((resolve, reject) => {
              ws.once('finish', resolve);
              ws.once('error', reject);
              ws.end();
            });
            if (total && received !== total) throw new Error('Unvollständiger Update-Download');
            fs.chmodSync(tmpDest, 0o755);
            if (currentAppImage !== finalDest) {
              try {
                fs.unlinkSync(finalDest);
              } catch (e) {
                if (e.code !== 'ENOENT') throw e;
              }
            }
            fs.renameSync(tmpDest, finalDest);
            return finalDest;
          } catch (error) {
            ws.destroy();
            throw error;
          } finally {
            try {
              fs.unlinkSync(tmpDest);
            } catch (e) {
              if (e.code !== 'ENOENT') logger.warn('Temporäre Update-Datei konnte nicht entfernt werden:', e.message);
            }
          }
        } catch (e) {
          throw e;
        }
      },
    };
  } else if (updateMode() === 'mac-release') {
    const updaterPath = path.join(__dirname, 'updater.js');
    if (fs.existsSync(updaterPath)) {
      updaterProcess = fork(updaterPath, [__dirname], {
        env: { ...process.env, ELECTRON_NO_ASAR: '1' },
      });
      updaterProcess.on('exit', () => {
        updaterProcess = null;
      });
    }
  }
}

ipcMain.handle('check-for-update', async event => {
  requireMainRenderer(event);
  if (process.env.APPIMAGE) {
    if (!autoUpdater) return { hasUpdate: false, error: 'kein updater' };
    return autoUpdater.check();
  }
  if (updateMode() === 'unsupported') {
    return { hasUpdate: false, error: 'Updates sind auf dieser Plattform nicht verfügbar' };
  }
  if (!updaterProcess) return { hasUpdate: false, error: 'kein update-prozess' };
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      updaterProcess?.removeListener('message', onMsg);
      resolve({ hasUpdate: false, error: 'timeout' });
    }, 20000);
    const onMsg = msg => {
      if (msg.type !== 'result') return;
      clearTimeout(timer);
      updaterProcess.removeListener('message', onMsg);
      resolve({ hasUpdate: msg.hasUpdate, latestVersion: msg.latest, error: msg.error });
    };
    updaterProcess.on('message', onMsg);
    updaterProcess.send({ type: 'check', currentVersion: app.getVersion() });
  });
});

ipcMain.handle('apply-update', async (event, version) => {
  requireMainRenderer(event);
  const updateVersion = validateVersion(version);
  if (process.env.APPIMAGE) {
    if (!autoUpdater) return { success: false, error: 'kein updater' };
    try {
      const newAppImage = await autoUpdater.download(updateVersion);
      // Remove old AppImage if replaced by a differently-named version
      const oldAppImage = process.env.APPIMAGE;
      if (oldAppImage && oldAppImage !== newAppImage) {
        try {
          fs.unlinkSync(oldAppImage);
        } catch (e) {}
      }
      mainWindow?.webContents.send('update-status', { type: 'downloaded' });
      setTimeout(() => {
        app.relaunch({ execPath: newAppImage });
        quitCoordinator.allowQuit('updater');
        app.quit();
      }, 2000);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  if (updateMode() === 'unsupported') {
    return { success: false, error: 'Updates sind auf dieser Plattform nicht verfügbar' };
  }
  const updaterLogDir = app.getPath('logs');
  const updaterLogPath = path.join(updaterLogDir, 'updater.log');
  fs.mkdirSync(updaterLogDir, { recursive: true });
  const updaterLog = fs.createWriteStream(updaterLogPath, { flags: 'a' });
  updaterLog.write(`\n=== Update gestartet ${new Date().toISOString()} v${updateVersion} ===\n`);
  const proc = fork(path.join(__dirname, 'updater.js'), [__dirname], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', STREAMING_HUB_UPDATER_LOG: updaterLogPath },
  });
  proc.stdout?.on('data', chunk => updaterLog.write(`[stdout] ${chunk}`));
  proc.stderr?.on('data', chunk => updaterLog.write(`[stderr] ${chunk}`));
  proc.on('error', error => updaterLog.write(`[spawn-error] ${error.stack || error.message}\n`));
  return new Promise(resolve => {
    // Muss über dem Download-Timeout des Updaters (300 s) plus Entpacken,
    // Signatur- und Integritätsprüfung liegen. Bei Ablauf wird der Updater
    // beendet, damit er nicht unbemerkt im Hintergrund weiterinstalliert.
    const timer = setTimeout(() => {
      proc.removeListener('message', onMsg);
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve({ success: false, error: 'timeout' });
    }, UPDATE_APPLY_TIMEOUT_MS);
    const onMsg = msg => {
      if (msg.type === 'progress') {
        mainWindow?.webContents.send('update-status', { type: 'progress', step: msg.step, percent: msg.percent });
      } else if (msg.type === 'applied') {
        clearTimeout(timer);
        proc.removeListener('message', onMsg);
        if (msg.error) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Update fehlgeschlagen',
            message: 'Das Update konnte nicht angewendet werden.',
            detail: msg.error,
          }).catch(() => {});
        }
        resolve({ success: !msg.error, error: msg.error });
        if (!msg.error) {
          setTimeout(() => {
            app.relaunch();
            quitCoordinator.allowQuit('updater');
            app.quit();
          }, 500);
        }
      }
    };
    proc.on('message', onMsg);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      proc.removeListener('message', onMsg);
      updaterLog.write(`[exit] code=${code} signal=${signal}\n`);
      updaterLog.end();
      resolve({ success: false, error: `Updater unerwartet beendet (code=${code}, signal=${signal || 'none'})` });
    });
    proc.send({ type: 'apply', version: updateVersion });
  });
});

function requireMainRenderer(event) {
  if (!mainWindow || event?.sender !== mainWindow.webContents) {
    throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
  }
}

function requireWebviewRenderer(event) {
  const sender = event?.sender;
  if (!mainWindow || !sender || sender.getType?.() !== 'webview' || sender.hostWebContents !== mainWindow.webContents) {
    throw new Error('WebView-IPC-Aufruf von nicht autorisiertem Renderer');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0a0a0f',
    title: 'Streaming Hub',
  });

  const createdWindow = mainWindow;
  createdWindow.once('ready-to-show', () => {
    createdWindow.show();
    createdWindow.focus();
  });
  // Fenster-X: Beenden-Dialog bei Planung < 24 h (sonst schließt das Fenster wie bisher)
  createdWindow.on('close', event => {
    quitCoordinator.handleWindowClose(event, createdWindow);
  });
  // Nach „Fenster zu, App im Tray“ kein zerstörtes Fenster mehr referenzieren
  // (Tray „App öffnen“/„Planung öffnen“ und das Dock-Icon erzeugen es neu).
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode !== -3) logger.error('Hauptfenster konnte nicht geladen werden:', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer-Prozess beendet:', details.reason, details.exitCode);
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html')).catch(error => {
    logger.error('Hauptfenster konnte nicht geladen werden:', error.message);
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => {
    event.preventDefault();
  });

  // Global media keys (Play/Pause, Next, Previous, Stop)
  const mediaActions = [
    ['MediaPlayPause', 'playpause'],
    ['MediaNextTrack', 'nexttrack'],
    ['MediaPreviousTrack', 'previoustrack'],
    ['MediaStop', 'stop'],
  ];
  for (const [key, action] of mediaActions) {
    try {
      globalShortcut.register(key, () => {
        mainWindow?.webContents.send('media-key', action);
      });
    } catch (_) {
      /* key not available on this platform */
    }
  }
}

/** Hauptfenster zeigen; nach „Fenster zu, App im Tray“ wird es neu erzeugt. */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Aufnahmen-Dashboard im Renderer öffnen (Tab 'library' | 'planned'), auch bei frisch erzeugtem Fenster. */
function openRecordingsTab(tab) {
  showMainWindow();
  const win = mainWindow;
  if (!win) return;
  const send = () => {
    try {
      win.webContents.send('recordings:open', { tab });
    } catch (_) {
      // Fenster zwischendurch weg
    }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets/icon.png'));
  }

  userStorage = createUserStorage({
    userDataPath: app.getPath('userData'),
    bundlePath: __dirname,
  });
  try {
    reconcilePostUpdate(__dirname, app.getVersion());
  } catch (e) {
    logger.error('Nach-Update-Reconciliation fehlgeschlagen (Start läuft weiter):', e.message);
  }
  // Selbstheilungs-Netz (Karte t_ea243f43, Schritt 5): Beim Start prüfen, ob
  // die eigene Bundle-Integrität intakt ist (keine toten/externen Symlinks,
  // Frameworks vorhanden). Bei Schaden NIEMALS still weiterlaufen — sauberer
  // Fehlerdialog mit Reparaturanleitung. (Toter Electron-Framework-Symlink
  // verhindert sogar diesen Code-Pfad — deshalb zusätzlich Updater-seitige
  // Recovery über recoverStaleUpdateDirs beim nächsten Update-Lauf.)
  if (process.platform === 'darwin') {
    try {
      const { verifyBundleIntegrity } = require('./lib/bundle-install.js');
      const exeBundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..');
      const gate = verifyBundleIntegrity(exeBundle, {
        symlinks: true,
        resolvable: true,
        frameworks: true,
        allowedAbsoluteTargets: [path.join(os.homedir(), 'Library', 'Application Support', 'Streaming Hub')],
      });
      if (!gate.ok) {
        logger.error('Bundle-Integrität beim Start beschädigt:', gate.errors.join('; '));
        dialog.showErrorBox(
          'Streaming Hub — Installation beschädigt',
          'Die App-Installation ist beschädigt (defekte interne Verweise).\n\n' +
            'Bitte die App über install.sh neu installieren:\n\n' +
            '  curl -fsSL <Installations-URL> | sh\n\n' +
            'oder das Update in den Einstellungen erneut ausführen.\n\n' +
            `Details: ${gate.errors.join('; ').slice(0, 400)}`
        );
      }
    } catch (e) {
      logger.warn('Bundle-Integritätscheck beim Start fehlgeschlagen (Start läuft weiter):', e.message);
    }
  }
  startUpdater();
  createWindow();
  components.whenReady()
    .then(() => logger.info('Widevine CDM status:', components.status()))
    .catch(() => logger.warn('Component updater failed (expected without sandbox), using system Widevine if available'));

  // ── Wochen-EPG im Main (Etappe 1, Konzept §3.2) ──
  // Cache in userData, Start sofort aus dem Cache nutzbar, Refresh im
  // Hintergrund (beim Start + alle 12 h) — auch ohne offenes Fenster (Tray).
  // Unabhängig von den ffmpeg-Binaries (kein Bezug zur Aufnahme-Engine).
  try {
    epgService = new EpgService({
      dir: app.getPath('userData'),
      getSources: () => loadTvSources().map(({ id, name, epgUrl }) => ({ id, name, epgUrl })),
      logger,
      // Isolierte Testläufe (STREAMING_HUB_USER_DATA, E2E) laden nicht automatisch
      // aus dem Netz; STREAMING_HUB_EPG_REFRESH=on schaltet es dort wieder ein.
      // Mit Test-Fixture (epgFixtureFetch) wird aus der lokalen Datei geladen, nie aus dem Netz.
      fetchImpl: epgFixtureFetch || fetch,
      autoRefresh:
        !process.env.STREAMING_HUB_USER_DATA || process.env.STREAMING_HUB_EPG_REFRESH === 'on' || !!epgFixtureFetch,
    });
    registerEpgIpc({ ipcMain, epg: epgService, requireMainRenderer });
    epgService.start().catch(e => logger.warn('EPG-Dienst konnte nicht starten:', e.message));
  } catch (e) {
    logger.error('EPG-Dienst konnte nicht eingerichtet werden:', e.message);
  }

  // ffmpeg/ffprobe (Konzept §2.2 "Selbstheilung beim App-Start"): Prüfung
  // "vorhanden + ausführbar + -version ok". Fehlschlag wird als sichtbarer
  // Fehlerdialog gemeldet — Aufnahme-Features degradieren erkennbar statt still.
  // Die Nachbereitung (Download) läuft zusätzlich asynchron, damit ein
  // vorübergehender Netzwerkfehler die Session nicht blockiert.
  const { checkHealth, ensureBinaries } = require('./lib/ffmpeg.js');
  const health = checkHealth(__dirname);
  if (!health.ok) {
    const detail = `ffmpeg/ffprobe fehlen oder sind defekt: ${health.missing.join(', ')}`;
    logger.error(detail, '— Aufnahme-Funktionen sind deaktiviert.');
    dialog.showErrorBox(
      'Streaming Hub — Aufnahme nicht verfügbar',
      `${detail}\n\nDie Aufnahme-Funktion benötigt die mitgelieferten ffmpeg/ffprobe-Binaries.\n\n` +
        'Die App versucht jetzt, sie automatisch nachzuladen. Falls das fehlschlägt ' +
        '(z. B. ohne Internetverbindung): App erneut starten oder Installation reparieren.\n\n' +
        'Alle anderen Funktionen laufen weiter.',
    );
    ensureBinaries(__dirname)
      .then(result => {
        if (result.ok) logger.info('ffmpeg/ffprobe nachgeladen, Aufnahme-Funktionen wieder verfügbar.');
        else logger.error('ffmpeg/ffprobe Nachladen fehlgeschlagen:', result.error);
      })
      .catch(e => logger.error('ffmpeg/ffprobe Nachladen crashte:', e.message));
  } else {
    logger.info('ffmpeg/ffprobe OK (Release', health.release + ')');
  }

  // ── Aufnahme-Engine (Konzept §2.5) ──
  // Start nur bei gesunden Binaries; bei Defekt bleibt Aufnahme deaktiviert
  // (Fehlerdialog oben meldet das bereits sichtbar). Recovery (remux-pending
  // → nachholender Remux) läuft asynchron nach Fenster-Start.
  if (health.ok) {
    try {
      // Persistierten Speicherort (Settings, Konzept §3.4) laden — Fallback:
      // Default ~/Videos/Streaming Hub. Ungültig persistierte Pfade fallen
      // auf den Default zurück (App bleibt startbar, Fehler geloggt).
      let storageRoot = ensureDefaultStorageRoot(logger);
      let persisted = null;
      try {
        persisted = userStorage.readJson('recordingSettings', null);
      } catch (_) {
        persisted = null;
      }
      if (persisted && typeof persisted.storageRoot === 'string' && persisted.storageRoot.trim()) {
        const check = paths.validateStorageRoot(persisted.storageRoot.trim());
        if (check.ok) {
          storageRoot = path.resolve(persisted.storageRoot.trim());
        } else {
          logger.warn('Persistierter Aufnahmen-Speicherort nicht nutzbar (' + check.error + ') — Default bleibt aktiv');
        }
      }
      // Limits (Parallel-Limit, Höchstdauer, Reserve) aus den persistierten
      // Settings — Altdaten ohne die Felder laden mit Defaults, Werte werden
      // beim Laden geklemmt (Reserve-Minimum auch hier, nicht nur in der UI).
      const normalizedSettings = recordingSettingsLib.normalizeRecordingSettings(persisted).settings;
      recorder = new RecorderService({
        appRoot: __dirname,
        storageRoot,
        maxParallel: normalizedSettings.maxParallel,
        maxDurationHours: normalizedSettings.maxDurationHours,
        reserveMB: normalizedSettings.reserveMB,
      });
      // Orphan-Janitor (Karte t_695bf150, Sweep beim App-Start): Bereinigt
      // App-eigene verwaiste ffmpeg/ffprobe-Prozesse (PPID 1 / toter Parent)
      // vom letzten Crash bzw. von einem Quit-Race — QA-Befund: Orphan lief
      // 15,5 h und schrieb 22 GB Zwischenform. Der Sweep zielt exakt auf
      // <appRoot>/bin/-(ffmpeg|ffprobe)-Instanzen; fremde ffmpegs (User-
      // Workflows, QA-Harness in /tmp) bleiben unangetastet.
      try {
        const swept = sweepOrphans({ appRoot: __dirname });
        if (swept.length) logger.warn(`Orphan-Janitor: ${swept.length} verwaiste ffmpeg/ffprobe-Prozesse beendet`, swept);
      } catch (e) {
        logger.warn('Orphan-Janitor fehlgeschlagen (App startet weiter):', e.message);
      }
      registerRecorderIpc({ ipcMain, recorder, mainWindow, getMainWindow: () => mainWindow });
      // Wiedergabeprotokoll rec:// (Bibliothek, Phase 1c)
      protocol.handle(recordingProtocol.scheme, recordingProtocol.handler);
      // Bibliotheks-IPC (Phase 1c): Dateiinfo + Löschen
      ipcMain.handle('recording:get-file', (event, recId) => {
        requireMainRenderer(event);
        if (typeof recId !== 'string' || !REC_JOB_DIR_PATTERN.test(recId)) {
          throw new Error('Ungültige Aufnahme-ID');
        }
        const meta = recorder.store.readMeta(recId);
        if (!meta) throw new Error('Aufnahme nicht gefunden: ' + recId);
        const lib = path.join(recorder.storageRoot, 'Aufnahmen');
        const jobDir = path.join(lib, recId);
        const playlist = path.join(jobDir, 'index.m3u8');
        // Nicht fertig konvertierte Aufnahmen (läuft / Remux zurückgestellt,
        // z. B. „Speicher knapp“) bleiben über die HLS-Zwischenform abspielbar.
        if (
          ['recording', 'remux-pending', 'aborted'].includes(meta.status) &&
          !(meta.outputFile && fs.existsSync(meta.outputFile)) &&
          fs.existsSync(playlist)
        ) {
          // Laufende Aufnahme: HLS-Zwischenform live abspielbar (hls.js-Pfad
          // mit corsEnabled-Scheme — im Isolat + App verifiziert)
          return { kind: 'hls', url: `${REC_SCHEME}://${recId}/index.m3u8` };
        }
        if (meta.outputFile && fs.existsSync(meta.outputFile)) {
          // Fertige MP4: Media-Element-Ladepfad ist ein anderer als der
          // Fetch-Pfad — <video src="rec://…"> schlägt auch mit corsEnabled
          // fehl (MEDIA_ELEMENT_ERROR code=4, QA-Privilegien-Matrix F-FB-04).
          // Die MP4 liegt innerhalb des App-gebundenen Aufnahmen-Roots; aus
          // der file://-Page des Players lädt eine file://-URL dieselbe Datei
          // nativ (QA-Gegenprobe: dieselbe MP4 via file:// spielt einwandfrei).
          // Die rec://-Jails (Whitelist + Kontainment) schützen weiterhin den
          // Fetch-Pfad; hier zusätzlich: Pfad muss unterm Bibliotheks-Root
          // liegen und .mp4 sein.
          const resolved = path.resolve(meta.outputFile);
          if (
            resolved.toLowerCase().endsWith('.mp4') &&
            resolved.startsWith(path.resolve(lib) + path.sep)
          ) {
            return { kind: 'mp4', url: `file://${resolved.split(path.sep).map(encodeURIComponent).join('/')}` };
          }
          throw new Error('Ungültiger MP4-Pfad für diese Aufnahme');
        }
        throw new Error('Keine abspielbare Datei für diese Aufnahme');
      });
      ipcMain.handle('recording:delete', async (event, recId) => {
        requireMainRenderer(event);
        if (typeof recId !== 'string' || !REC_JOB_DIR_PATTERN.test(recId)) {
          throw new Error('Ungültige Aufnahme-ID');
        }
        if (recorder.getJob(recId)) throw new Error('Aufnahme läuft noch — erst stoppen');
        const meta = recorder.store.readMeta(recId);
        if (!meta) throw new Error('Aufnahme nicht gefunden: ' + recId);
        const lib = path.join(recorder.storageRoot, 'Aufnahmen');
        const jobDir = path.join(lib, recId);
        // 1) MP4 löschen (falls vorhanden) — nur innerhalb der Bibliothek
        //    (manipulierte Meta darf keine fremden Dateien löschen)
        if (meta.outputFile && !paths.isInsideDir(lib, meta.outputFile)) {
          throw new Error('Ungültiger MP4-Pfad für diese Aufnahme');
        }
        if (meta.outputFile && fs.existsSync(meta.outputFile)) {
          try { fs.rmSync(meta.outputFile, { force: true }); } catch (e) {
            throw new Error(`MP4 konnte nicht gelöscht werden: ${e.message}`);
          }
        }
        // 2) Job-Verzeichnis löschen — nach t_f36663be existiert es bei
        //    COMPLETED-Aufnahmen regulär NICHT mehr (post-Remux-Komplett-
        //    Räumung); bei remux-pending/failed (Zwischenstände) ist es da
        //    und enthält auch die Legacy-Meta-Datei.
        if (fs.existsSync(jobDir)) {
          try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {
            throw new Error(`Aufnahmeverzeichnis konnte nicht gelöscht werden: ${e.message}`);
          }
        }
        // 3) Meta-Datei in BEIDEN Lagen entfernen (migriert + Legacy) —
        //    Deckt den Fall "completed ohne JobDir" NACH t_f36663be ab.
        recorder.store.removeMeta(recId);
        // 4) Index-Eintrag entfernen
        recorder.store.removeFromIndex(recId);
        // 5) Platz ist frei geworden: zurückgestellte Remuxes („Speicher knapp“) nachholen
        recorder
          .retryDeferredRemuxes({
            afterRemux: ({ meta: done }) => {
              mainWindow?.webContents.send('recording:changed', { recId: done.id, meta: done });
            },
          })
          .catch(e => logger.warn('Nachholender Remux nach Löschen fehlgeschlagen:', e.message));
        return { success: true };
      });
      // ── Settings: Speicherort (Konzept §3.4, Phase 1c) ──
      ipcMain.handle('recording:get-storage-root', event => {
        requireMainRenderer(event);
        return {
          root: recorder.storageRoot,
          isDefault: recorder.storageRoot === paths.defaultRecordingsRoot(),
          network: isNetworkishPath(recorder.storageRoot),
          freeBytes: storageFreeBytes(recorder.storageRoot),
        };
      });
      ipcMain.handle('recording:pick-folder', async event => {
        requireMainRenderer(event);
        const result = await dialog.showOpenDialog(mainWindow, {
          title: 'Aufnahmen-Speicherort wählen',
          defaultPath: recorder.storageRoot,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return result.filePaths[0];
      });
      ipcMain.handle('recording:set-storage-root', (event, root) => {
        requireMainRenderer(event);
        if (typeof root !== 'string' || !root.trim()) throw new Error('Kein Speicherort angegeben');
        if (root.length > 1024) throw new Error('Speicherort-Pfad zu lang');
        const resolved = recorder.setStorageRoot(root.trim());
        // Merge statt Überschreiben: Limits/Reserve bleiben erhalten
        userStorage.writeJson('recordingSettings', {
          ...recordingSettingsLib.normalizeRecordingSettings(readRecordingSettingsRaw()).settings,
          storageRoot: resolved,
        });
        return {
          root: resolved,
          isDefault: resolved === paths.defaultRecordingsRoot(),
          network: isNetworkishPath(resolved),
          freeBytes: storageFreeBytes(resolved),
        };
      });
      // Settings „Aufnahmen“: Parallel-Limit, Höchstdauer, Reserve (Etappe 1).
      // Validierung/Clamp im Main; die Antwort enthält die tatsächlich
      // gespeicherten Werte + Clamp-Hinweise (UI zeigt die Reserve-Warnung).
      ipcMain.handle('recording:get-settings', event => {
        requireMainRenderer(event);
        return recordingSettingsResponse(recordingSettingsLib.normalizeRecordingSettings(readRecordingSettingsRaw()));
      });
      ipcMain.handle('recording:set-settings', (event, patch) => {
        requireMainRenderer(event);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Ungültige Aufnahme-Einstellungen');
        const result = recordingSettingsLib.applyRecordingSettingsPatch(readRecordingSettingsRaw(), patch);
        const current = recordingSettingsLib.normalizeRecordingSettings(readRecordingSettingsRaw()).settings;
        userStorage.writeJson('recordingSettings', {
          ...result.settings,
          ...(current.storageRoot ? { storageRoot: current.storageRoot } : {}),
        });
        recorder.setLimits(result.settings);
        return recordingSettingsResponse(result);
      });
      // ffmpeg-Diagnose (Konzept §3.4): Version/ok/Fehler für die Settings.
      // Meldet zusätzlich die SHA-256 der installierten ffmpeg-Binary und den
      // Release-Tag (QA F-FB-03: Abweichungen von der Pinnung sichtbar machen;
      // UI-Anzeige später möglich — nur API, kein UI-Zwang).
      ipcMain.handle('recording:ffmpeg-status', event => {
        requireMainRenderer(event);
        const { checkHealth, sha256File, FFMPEG_STATIC_RELEASE } = require('./lib/ffmpeg.js');
        const health = checkHealth(__dirname);
        let version = null;
        let sha256 = null;
        if (health.ok) {
          try {
            const { execFileSync } = require('child_process');
            version = execFileSync(health.ffmpegPath, ['-version'], { encoding: 'utf-8', timeout: 5000 })
              .split('\n')[0].trim();
          } catch (_) {
            version = null;
          }
          try {
            sha256 = sha256File(health.ffmpegPath);
          } catch (_) {
            sha256 = null;
          }
        }
        return {
          ok: health.ok,
          missing: health.missing,
          release: health.release || FFMPEG_STATIC_RELEASE || null,
          version,
          sha256,
        };
      });
      // Default-Speicherort (für Reset-Button der Settings)
      ipcMain.handle('recording:get-default-root', event => {
        requireMainRenderer(event);
        return paths.defaultRecordingsRoot();
      });
      recorder
        .recover({
          afterRemux: ({ meta }) => {
            mainWindow?.webContents.send('recording:changed', { recId: meta.id, meta });
          },
        })
        .then(result => {
          if (result.reaped.length) {
            logger.warn(`Aufnahme-Recovery: ${result.reaped.length} Zombie-Aufnahme(n) → aborted`);
          }
          if (result.recovered.length) {
            logger.info(`Aufnahme-Recovery: ${result.recovered.length} Remux nachgeholt`);
          }
        })
        .catch(e => logger.error('Aufnahme-Recovery fehlgeschlagen:', e.message));

      // Karte t_f36663be (Meldung 4): DVR-Rückstand > Fenster während des
      // Starts → main wandelt das Engine-Event in einen Renderer-Broadcast
      // (Toast/Dialog „Aufnahme läuft am frühersten DVR-Segment weiter").
      recorder.on('recording:seek-degraded', payload => {
        mainWindow?.webContents.send('recording:seek-degraded', payload);
      });

      // Tray (Konzept §3.2): Icon-Wechsel, Menü je Aufnahme, Ordner öffnen,
      // Shutdown-/Beenden-Verhalten. Erst nach Recorder-Setup.
      trayController = new TrayController({
        recorder,
        getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
        showWindow: showMainWindow,
        getStorageRoot: () => recorder.storageRoot,
        openLibrary: () => openRecordingsTab('library'),
        openPlanning: () => openRecordingsTab('planned'),
        getPlanned: () => (scheduler ? scheduler.list() : []),
        confirmQuit: () => quitCoordinator.confirmQuit(),
        appRoot: __dirname,
      });
      trayController.create();
      // macOS/Linux: System-Shutdown darf nie am Beenden-Dialog hängen bleiben
      powerMonitor.on('shutdown', () => quitCoordinator.markSystemShutdown());

      // ── Planung (Etappe 2a, Konzept §3.4) ──
      // ScheduleStore in userData, Scheduler nach dem Recorder-Setup (recover()
      // hat hängende Aufnahmen oben bereits auf `aborted` gesetzt). Läuft im
      // Main und ist vom Fenster unabhängig; Standby-Resume löst eine
      // Neubewertung aus (powerMonitor).
      try {
        const scheduleStore = createScheduleStore({ dir: app.getPath('userData'), logger });
        scheduler = new Scheduler({
          store: scheduleStore,
          recorder,
          resolveStream: resolveScheduledStream,
          getSettings: () => recordingSettingsLib.normalizeRecordingSettings(readRecordingSettingsRaw()).settings,
          epgLookup: ({ key, atMs }) => (epgService ? epgService.find(key, atMs) : null),
          // Schedule-Slip (Etappe 2b): gezielter Refresh der Quelle + Abgleich mit dem frischen Cache
          refreshEpg: ({ entry }) =>
            epgService ? epgService.refreshForSource(entry.sourceId) : Promise.resolve({ ok: false, error: 'EPG-Dienst nicht verfügbar' }),
          epgRange: ({ key, fromMs, toMs }) => (epgService ? epgService.range(key, fromMs, toMs) : []),
          logger,
        });
        registerScheduleIpc({
          ipcMain,
          scheduler,
          requireMainRenderer,
          broadcast: (channel, payload) => {
            try {
              mainWindow?.webContents.send(channel, payload);
            } catch (_) {
              // Fenster zwischendurch geschlossen — Planung läuft im Main weiter
            }
          },
        });
        // Benachrichtigungen (Planung) und Menü-Aktualisierung laufen über den TrayController
        // (gemeinsamer Notifier, bereinigte Texte)
        trayController.attachScheduler(scheduler);
        // Standby-Schutz: Blocker bei laufender Aufnahme und ab 5 min vor einem geplanten Start
        standbyGuard = new StandbyGuard({
          powerSaveBlocker,
          getActiveCount: () => recorder.activeJobs().length,
          getWindows: () => scheduler.upcomingWindows(),
          logger,
        });
        standbyGuard.attach({ scheduler, recorder });
        powerMonitor.on('resume', () => {
          // Neubewertung (Spätstart/verpasst, Slip-Prüfung) — der Takt sync't danach den Blocker
          scheduler.onResume().catch(e => logger.warn('Planung nach Standby fehlgeschlagen:', e.message));
          standbyGuard.sync();
        });
        scheduler.start().catch(e => logger.error('Planung konnte nicht gestartet werden:', e.message));
      } catch (e) {
        logger.error('Planung konnte nicht eingerichtet werden:', e.message);
      }
    } catch (e) {
      logger.error('Aufnahme-Engine konnte nicht gestartet werden:', e.message);
    }
  }
});

app.on('window-all-closed', () => {
  // Konzept §3.2: Fenster schließen ≠ App beenden, solange ≥ 1 Aufnahme
  // läuft — die App geht in den Tray (TrayController übernimmt). Ohne
  // aktive Aufnahmen gilt das normale Quit-Verhalten.
  if (recorder && recorder.activeJobs().length > 0) {
    logger.info('Fenster geschlossen — App bleibt wegen laufender Aufnahme(n) im Tray aktiv');
    return;
  }
  // Etappe 2a (§3.5): auch anstehende Planungen (state scheduled, Ende in der
  // Zukunft) halten die App im Tray — der Scheduler läuft im Main.
  if (scheduler && scheduler.hasPendingSchedules()) {
    logger.info('Fenster geschlossen — App bleibt wegen geplanter Aufnahme(n) im Tray aktiv');
    return;
  }
  app.quit();
});

// Quit-Cleanup (Karte t_695bf150): JEDER Quit-Weg (Cmd+Q/Dock ohne Tray-
// Umweg, app.quit() aus Tray/powerMonitor/Updater-Relaunch) läuft durch
// before-quit — hier werden laufende Aufnahmen SYNCHRON abgewürgt
// (RecordJob.finalizeForQuit: SIGKILL auf ffmpeg + Meta → aborted +
// ENDLIST in der Zwischenplaylist) und Background-Childs (Remux/probe/
// decode) über die PID-Registry gekillt. Der vorlaggende E2E-Befund
// (Orphan mit PPID 1 schrieb 22 GB / 15,5 h) entsteht genau hier nicht
// mehr: Nodeprozess und seine Childs sterben im selben Quit-Sweep.
// Recovery-Remux (RecorderService.recover) holt die Aufnahme beim
// nächsten Start nach (F-FB-10).
app.on('before-quit', event => {
  // Beenden-Dialog bei Planung < 24 h (Etappe 2b): Quit wird dafür zunächst abgebrochen;
  // der Cleanup unten läuft erst, wenn der Quit wirklich durchgeht.
  if (quitCoordinator.handleBeforeQuit(event)) return;
  if (standbyGuard) standbyGuard.release();
  if (epgService) epgService.stop();
  if (scheduler) scheduler.stop();
  if (!recorder) return;
  try {
    recorder.quitSweep();
  } catch (e) {
    logger.error('Quit-Cleanup fehlgeschlagen (Beenden läuft weiter):', e.message);
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
// macOS: Dock-Klick bei „Fenster zu, App im Tray“ bringt das Fenster zurück
app.on('activate', () => {
  if (app.isReady()) showMainWindow();
});

ipcMain.on('toggle-pip', (event, url) => {
  requireMainRenderer(event);
  if (pipWindow) {
    pipWindow.close();
    pipWindow = null;
    mainWindow.webContents.send('pip-state', false);
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const pipW = Math.min(480, Math.round(width * 0.3));
  const pipH = Math.min(320, Math.round((pipW * 9) / 16) + 32);

  const pipUrl = remoteHttpUrl(url, 'PiP-URL');
  pipWindow = new BrowserWindow({
    width: pipW,
    height: pipH,
    alwaysOnTop: true,
    frame: false,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  pipWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowPipNavigation = (_event, navigationUrl) => {
    try {
      const target = new URL(navigationUrl);
      if (target.protocol !== 'file:') _event.preventDefault();
    } catch (_) {
      _event.preventDefault();
    }
  };
  pipWindow.webContents.on('will-navigate', allowPipNavigation);
  pipWindow.webContents.on('will-redirect', allowPipNavigation);

  // Detect TV stream URL (ends with .m3u8 or contains common streaming patterns)
  const isStreamUrl = /\.m3u8$|\.mpd$|\.ts$|mpegts/i.test(pipUrl);

  if (isStreamUrl) {
    // Load a player page for TV streams
    pipWindow.loadFile(path.join(__dirname, 'pip.html'));

    pipWindow.webContents.on('did-finish-load', () => {
      pipWindow.webContents.executeJavaScript(`
        window.postMessage({ type: 'load-tv-stream', url: ${JSON.stringify(pipUrl)} }, window.location.origin);
      `);
    });
  } else {
    pipWindow.loadFile(path.join(__dirname, 'pip.html'));

    pipWindow.webContents.on('did-finish-load', () => {
      pipWindow.webContents.executeJavaScript(`
        window.postMessage({ type: 'load-url', url: ${JSON.stringify(pipUrl)} }, window.location.origin);
      `);
    });
  }

  pipWindow.on('closed', () => {
    pipWindow = null;
    mainWindow?.webContents.send('pip-state', false);
  });

  mainWindow.webContents.send('pip-state', true);
});

ipcMain.on('webview-keydown', (event, data) => {
  requireWebviewRenderer(event);
  const normalized = normalizeWebviewKeydown(data);
  if (!normalized) return;
  mainWindow.webContents.send('webview-keydown', normalized);
});

ipcMain.handle('get-app-version', event => {
  requireMainRenderer(event);
  // Nie eine falsche (ältere) Version anzeigen: erst exaktes HEAD-Tag, dann
  // package.json (wird im Release-Workflow mitgebump't), dann Electron-Fallback.
  // (Bisher: git describe --tags --abbrev=0 — beschrieb ohne lokale Tags den
  // neuen Commit mit dem nächsten erreichbaren ALTEN Tag → Anzeige „v0.5.10"
  // trotz v0.5.11-Code. User-Befund 01.10.)
  return resolveAppVersion(__dirname, app.getVersion()).version;
});

ipcMain.on('toggle-fullscreen', event => {
  requireMainRenderer(event);
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

function sendFullscreenState() {
  mainWindow?.webContents.send('fullscreen-state', mainWindow.isFullScreen());
}

app.on('browser-window-created', (_event, window) => {
  window.on('enter-full-screen', sendFullscreenState);
  window.on('leave-full-screen', sendFullscreenState);
});

ipcMain.handle('get-services', event => {
  requireMainRenderer(event);
  return loadServices();
});

ipcMain.handle('add-service', (event, input) => {
  requireMainRenderer(event);
  const services = loadServices();
  const service = validateService(input);
  service.id = service.name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  if (services.find(s => s.id === service.id)) {
    service.id = service.id + '-' + Date.now();
  }
  services.push(service);
  saveServices(services);
  broadcastServices();
  return service;
});

ipcMain.handle('remove-service', (event, id) => {
  requireMainRenderer(event);
  const serviceId = validateText(id, 'Dienst-ID', 200);
  let services = loadServices();
  services = services.filter(s => s.id !== serviceId);
  saveServices(services);
  broadcastServices();
});

// History
ipcMain.handle('get-history', event => {
  requireMainRenderer(event);
  return loadHistory();
});

ipcMain.handle('save-history-entry', (event, entry) => {
  requireMainRenderer(event);
  let history = loadHistory();
  const idx = history.findIndex(e => e.title === entry.title && e.serviceKey === entry.serviceKey);
  if (idx !== -1) {
    history[idx].timestamp = new Date().toISOString();
  } else {
    entry.timestamp = new Date().toISOString();
    history.unshift(entry);
    if (history.length > 20) history = history.slice(0, 20);
  }
  saveHistory(history);
  return history;
});

ipcMain.handle('clear-history', event => {
  requireMainRenderer(event);
  saveHistory([]);
  return [];
});

// TV Sources
ipcMain.handle('get-tv-sources', event => {
  requireMainRenderer(event);
  return loadTvSources();
});

ipcMain.handle('add-tv-source', (event, input) => {
  requireMainRenderer(event);
  const source = validateTvSource(input);
  const sources = loadTvSources();
  // Datei-Quellen nur über den Dateiauswahldialog (oder bereits bekannte Pfade) —
  // sonst könnte ein beliebiger Pfad persistiert und später lesbar werden.
  if (source.type === 'file' && !resolveAllowedM3uPath(source.url, selectedM3uFiles, sources)) {
    throw new Error('Datei muss zuerst über den Dateiauswahldialog gewählt werden');
  }
  // Existierende Quelle mit gleicher URL wiedererkennen → ID + Overrides erhalten
  const existing = sources.find(s => s.url === source.url);
  if (existing) {
    // Eigenschaften mergen, aber Overrides/Favoriten/SortOrder aus bestehender Quelle erhalten
    existing.name = source.name || existing.name;
    existing.epgUrl = source.epgUrl || existing.epgUrl;
    existing.sortOrder = source.sortOrder || existing.sortOrder || [];
    // Fix: Merge auch persistieren + broadcasten – vorher gingen die
    // aktualisierten Felder beim Neustart verloren.
    saveTvSources(sources);
    broadcastTvSources();
    return existing;
  }
  // Neue Quelle – stabile ID aus dem Namen generieren
  source.id = source.name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  if (sources.find(s => s.id === source.id)) {
    source.id = source.id + '-' + Date.now();
  }
  if (!source.sortOrder) source.sortOrder = [];
  sources.push(source);
  saveTvSources(sources);
  broadcastTvSources();
  return source;
});

ipcMain.handle('remove-tv-source', (event, id) => {
  requireMainRenderer(event);
  const sourceId = validateText(id, 'Quellen-ID', 200);
  let sources = loadTvSources();
  sources = sources.filter(s => s.id !== sourceId);
  saveTvSources(sources);
  broadcastTvSources();
});

ipcMain.handle('update-tv-source', (event, id, updates) => {
  requireMainRenderer(event);
  const sourceId = validateText(id, 'Quellen-ID', 200);
  const sources = loadTvSources();
  const idx = sources.findIndex(s => s.id === sourceId);
  const source = validateTvSourceUpdates(
    updates,
    idx !== -1 ? sources[idx].type : undefined,
    idx !== -1 ? sources[idx].channelOverrides : undefined,
  );
  if (
    source.url !== undefined &&
    (source.type || (idx !== -1 ? sources[idx].type : undefined)) === 'file' &&
    !resolveAllowedM3uPath(source.url, selectedM3uFiles, sources)
  ) {
    throw new Error('Datei muss zuerst über den Dateiauswahldialog gewählt werden');
  }
  if (idx !== -1) {
    sources[idx] = { ...sources[idx], ...source };
    saveTvSources(sources);
    broadcastTvSources();
    return sources[idx];
  }
  return null;
});

ipcMain.handle('pick-m3u-file', async event => {
  requireMainRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selectedPath = path.resolve(result.filePaths[0]);
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || !/\.m3u8?$/i.test(selectedPath)) throw new Error('Nur M3U-Dateien sind erlaubt');
  const realPath = fs.realpathSync.native(selectedPath);
  selectedM3uFiles.add(realPath);
  return realPath;
});

// Lädt und parst eine M3U-Quelle (URL oder erlaubte Datei). Wirft bei Lade-/
// Eingabefehlern. Geteilt von fetch-and-parse-m3u (Renderer) und der frischen
// Stream-Auflösung geplanter Aufnahmen (resolveScheduledStream).
async function loadM3uChannels(urlOrPath) {
  const input = validateText(urlOrPath, 'M3U-Quelle', 4096);
  let content;
  let baseUrl = '';
  if (/^https?:\/\//i.test(input)) {
    const sourceUrl = httpUrl(input, 'M3U-URL');
    const response = await fetch(remoteHttpUrl(sourceUrl, 'M3U-URL'), {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    content = await readResponseText(response, MAX_PLAYLIST_BYTES);
    baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
  } else {
    const realPath = resolveAllowedM3uPath(input, selectedM3uFiles, loadTvSources());
    if (!realPath) throw new Error('Datei muss zuerst über den Dateiauswahldialog gewählt werden');
    const stat = fs.statSync(realPath);
    if (!stat.isFile() || !/\.m3u8?$/i.test(realPath)) throw new Error('Nur M3U-Dateien sind erlaubt');
    if (stat.size > MAX_PLAYLIST_BYTES) throw new Error('Datei ist zu groß');
    content = fs.readFileSync(realPath, 'utf-8');
    baseUrl = path.dirname(realPath) + path.sep;
  }
  const result = parseM3U(content);
  // Resolve relative URLs for logos
  const channels = result.channels.map(ch => ({
    ...ch,
    logo:
      ch.logo && !ch.logo.startsWith('http://') && !ch.logo.startsWith('https://') && !ch.logo.startsWith('file://')
        ? baseUrl + ch.logo
        : ch.logo,
  }));
  return { channels, epgUrls: result.epgUrls, baseUrl };
}

// Rückgabe: { channels, epgUrls, baseUrl } bei Erfolg, { error } bei Lade-/Eingabefehlern
// (Netz, HTTP, Datei nicht erlaubt, ungültige Quelle). So meldet Electron abgelehnte
// Handler nicht als rote Fehler im Terminal; der Renderer markiert die Quelle als
// fehlerhaft. Nur die Absender-Prüfung (requireMainRenderer) wirft weiterhin.
ipcMain.handle('fetch-and-parse-m3u', async (event, urlOrPath) => {
  requireMainRenderer(event);
  try {
    return await loadM3uChannels(urlOrPath);
  } catch (err) {
    // Keine URL/Zugangsdaten in Meldung oder Log (describeM3uFetchError gibt nur feste Texte aus).
    return { error: `Fehler beim Laden der M3U: ${describeM3uFetchError(err)}` };
  }
});

// Stream-URL einer geplanten Aufnahme beim Start FRISCH aus der Senderliste
// auflösen (Konzept §3.3) — Logik in lib/recorder/stream-resolver.js (testbar).
const resolveScheduledStream = createStreamResolver({
  loadTvSources: () => loadTvSources(),
  loadM3uChannels: urlOrPath => loadM3uChannels(urlOrPath),
  applyChannelOverrides,
  describeM3uFetchError,
  logger,
});

ipcMain.handle('get-app-path', event => {
  requireMainRenderer(event);
  return __dirname;
});

// ── Backup / Restore ──

ipcMain.handle('backup-settings', async event => {
  requireMainRenderer(event);
  const data = {
    version: app.getVersion(),
    date: new Date().toISOString(),
    services: loadServices(),
    tvsources: loadTvSources(),
    history: loadHistory(),
  };
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `streaming-hub-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Sicherungsdatei', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { success: false };
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
  return { success: true, path: result.filePath };
});

ipcMain.handle('restore-settings', async event => {
  requireMainRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Sicherungsdatei', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { success: false };
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
    const data = parseBackup(raw);
    userStorage.writeJsonBatch({
      services: data.services,
      tvSources: data.tvsources,
      history: data.history,
    });
    broadcastServices();
    broadcastTvSources();
    mainWindow?.webContents.send('history-changed', data.history);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fetch-epg', async (event, url) => {
  requireMainRenderer(event);
  try {
    // Download-Validierung (remoteHttpUrl, Redirect-Handling) ist mit dem
    // Main-EpgService geteilt: lib/epg/download.js
    const response = await fetchEpgResponse(url, epgFixtureFetch ? { fetchImpl: epgFixtureFetch } : undefined);
    const xml = await readResponseText(response, MAX_EPG_BYTES);
    const entries = parseXMLTV(xml);
    if (!entries.length) throw new Error('Die XMLTV-Datei enthält keine gültigen Sendungen');
    return entries;
  } catch (err) {
    logger.warn('EPG-Abruf fehlgeschlagen:', url, err.message);
    throw new Error(`Fehler beim Laden des EPG (${url}): ${err.message}`);
  }
});
