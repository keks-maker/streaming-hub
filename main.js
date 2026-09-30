// v0.3.6.
const { compareVersions, cleanChannelName, parseXMLTV, parseM3UFull } = require('@streaming-hub/typed-core');
const logger = require('./logger.js');
const { app, BrowserWindow, ipcMain, components, screen, globalShortcut, dialog, shell, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, execSync } = require('child_process');
const { reconcilePostUpdate } = require('./lib/post-update-reconcile.js');
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
const paths = require('./lib/recorder/paths.js');
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

// Aufnahme-Engine (Konzept §2.5) — storageRoot nach app.whenReady gesetzt
let recorder = null;

// Wiedergabe-Protokoll der Aufnahmen (Phase 1c, Karte t_bafa7928):
// rec://<recId>/<datei> streamt Dateien aus dem Aufnahmen-Root. hls.js kann
// von einer file://-Seite keine file://-Segmente per XHR laden — rec:// ist
// ein privilegiertes Scheme (supportFetchAPI + stream), jailt auf den Root
// und erlaubt nur die Zwischenform (.m3u8/.ts) und fertige MP4s.
const REC_SCHEME = 'rec';
const REC_ALLOWED_EXTENSIONS = /^[\w.-]+\.(m3u8|ts|mp4)$/i;
const REC_JOB_DIR_PATTERN = /^rec_[A-Za-z0-9._-]+$/;

function isNetworkishPath(p) {
  return isProbablyNetworkPath(p);
}

function registerRecordingProtocol({ protocol, getRoot }) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REC_SCHEME,
      privileges: { standard: true, stream: true, supportFetchAPI: true, bypassCSP: false },
    },
  ]);
  function handler(request, callback) {
    try {
      const url = new URL(request.url);
      const recId = decodeURIComponent(url.hostname || '');
      const rel = decodeURIComponent(url.pathname || '').replace(/^\/+/, '');
      if (!REC_JOB_DIR_PATTERN.test(recId) || !REC_ALLOWED_EXTENSIONS.test(rel)) {
        callback({ error: -6 }); // ERR_FILE_NOT_FOUND
        return;
      }
      const root = path.resolve(getRoot());
      const filePath = path.resolve(root, 'Aufnahmen', recId, rel);
      if (!filePath.startsWith(path.resolve(root, 'Aufnahmen') + path.sep)) {
        callback({ error: -6 });
        return;
      }
      callback({ path: filePath });
    } catch (_) {
      callback({ error: -6 });
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
  service: validateService,
  text: validateText,
  tvSource: validateTvSource,
  tvSourceUpdates: validateTvSourceUpdates,
} = require('./lib/input-validation.js');

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

let mainWindow;
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
  } else {
    const updaterPath = path.join(__dirname, 'updater.js');
    if (fs.existsSync(updaterPath)) {
      updaterProcess = fork(updaterPath, [__dirname]);
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
  if (!updaterProcess) return { hasUpdate: false, error: 'kein update-prozess' };
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ hasUpdate: false, error: 'timeout' }), 20000);
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
        app.quit();
      }, 2000);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  const updaterLogDir = app.getPath('logs');
  const updaterLogPath = path.join(updaterLogDir, 'updater.log');
  fs.mkdirSync(updaterLogDir, { recursive: true });
  const updaterLog = fs.createWriteStream(updaterLogPath, { flags: 'a' });
  updaterLog.write(`\n=== Update gestartet ${new Date().toISOString()} v${updateVersion} ===\n`);
  const proc = fork(path.join(__dirname, 'updater.js'), [__dirname], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STREAMING_HUB_UPDATER_LOG: updaterLogPath },
  });
  proc.stdout?.on('data', chunk => updaterLog.write(`[stdout] ${chunk}`));
  proc.stderr?.on('data', chunk => updaterLog.write(`[stderr] ${chunk}`));
  proc.on('error', error => updaterLog.write(`[spawn-error] ${error.stack || error.message}\n`));
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ success: false, error: 'timeout' }), 180000);
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
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
  startUpdater();
  createWindow();
  components.whenReady()
    .then(() => logger.info('Widevine CDM status:', components.status()))
    .catch(() => logger.warn('Component updater failed (expected without sandbox), using system Widevine if available'));

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
      recorder = new RecorderService({ appRoot: __dirname, storageRoot });
      registerRecorderIpc({ ipcMain, recorder, mainWindow });
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
        const base = `rec://${recId}`;
        if (meta.status === 'recording' && fs.existsSync(playlist)) {
          // Laufende Aufnahme: HLS-Zwischenform live abspielbar
          return { kind: 'hls', url: `${base}/index.m3u8` };
        }
        if (meta.outputFile && fs.existsSync(meta.outputFile)) {
          return { kind: 'mp4', url: `${base}/${encodeURIComponent(path.basename(meta.outputFile))}` };
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
        // 1) MP4 löschen (falls vorhanden)
        if (meta.outputFile && fs.existsSync(meta.outputFile)) {
          try { fs.rmSync(meta.outputFile, { force: true }); } catch (e) {
            throw new Error(`MP4 konnte nicht gelöscht werden: ${e.message}`);
          }
        }
        // 2) Job-Verzeichnis (Zwischenform + Meta-Datei)
        if (fs.existsSync(jobDir)) {
          try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {
            throw new Error(`Aufnahmeverzeichnis konnte nicht gelöscht werden: ${e.message}`);
          }
        }
        // 3) Index-Eintrag entfernen
        recorder.store.removeFromIndex(recId);
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
        userStorage.writeJson('recordingSettings', { storageRoot: resolved });
        return {
          root: resolved,
          isDefault: resolved === paths.defaultRecordingsRoot(),
          network: isNetworkishPath(resolved),
          freeBytes: storageFreeBytes(resolved),
        };
      });
      // ffmpeg-Diagnose (Konzept §3.4): Version/ok/Fehler für die Settings
      ipcMain.handle('recording:ffmpeg-status', event => {
        requireMainRenderer(event);
        const { checkHealth } = require('./lib/ffmpeg.js');
        const health = checkHealth(__dirname);
        let version = null;
        if (health.ok) {
          try {
            const { execFileSync } = require('child_process');
            version = execFileSync(health.ffmpegPath, ['-version'], { encoding: 'utf-8', timeout: 5000 })
              .split('\n')[0].trim();
          } catch (_) {
            version = null;
          }
        }
        return {
          ok: health.ok,
          missing: health.missing,
          release: health.release || null,
          version,
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
    } catch (e) {
      logger.error('Aufnahme-Engine konnte nicht gestartet werden:', e.message);
    }
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

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
    mainWindow.webContents.send('pip-state', false);
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
  try {
    const raw = execSync('git describe --tags --abbrev=0', {
      cwd: __dirname,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return raw.replace(/^v/i, '');
  } catch (e) {
    return app.getVersion();
  }
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
  const source = validateTvSourceUpdates(updates);
  const sources = loadTvSources();
  const idx = sources.findIndex(s => s.id === sourceId);
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

ipcMain.handle('fetch-and-parse-m3u', async (event, urlOrPath) => {
  requireMainRenderer(event);
  try {
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
      const selectedPath = path.resolve(input);
      if (!selectedM3uFiles.has(selectedPath))
        throw new Error('Datei muss zuerst über den Dateiauswahldialog gewählt werden');
      const realPath = fs.realpathSync.native(selectedPath);
      if (!selectedM3uFiles.has(realPath)) throw new Error('Dateipfad ist nicht mehr gültig');
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
  } catch (err) {
    throw new Error(`Fehler beim Laden der M3U: ${err.message}`);
  }
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
    let epgUrl = remoteHttpUrl(url, 'EPG-URL');
    let response;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      response = await fetch(epgUrl, {
        signal: AbortSignal.timeout(20_000),
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} ohne Redirect-Ziel`);
      if (redirectCount === 5) throw new Error('Zu viele Redirects');
      epgUrl = remoteHttpUrl(new URL(location, epgUrl).toString(), 'EPG-Redirect-Ziel');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await readResponseText(response, Infinity);
    const entries = parseXMLTV(xml);
    if (!entries.length) throw new Error('Die XMLTV-Datei enthält keine gültigen Sendungen');
    return entries;
  } catch (err) {
    logger.warn('EPG-Abruf fehlgeschlagen:', url, err.message);
    throw new Error(`Fehler beim Laden des EPG (${url}): ${err.message}`);
  }
});
