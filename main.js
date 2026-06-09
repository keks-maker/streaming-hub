// v0.3.6.
const { compareVersions, cleanChannelName, parseXMLTV } = require('@streaming-hub/typed-core');
const logger = require('./logger.js');
const { app, BrowserWindow, ipcMain, components, screen, globalShortcut, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, execSync } = require('child_process');

let mainWindow;
let pipWindow = null;
const servicesPath = path.join(__dirname, 'services.json');
const historyPath = path.join(__dirname, 'history.json');
const tvSourcesPath = path.join(__dirname, 'tvsources.json');

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

// Widevine ohne Sandbox: Castlabs Electron benötigt i.d.R. keinen --no-sandbox
// für DRM, aber das System-Widevine aus Chrome kann ohne Sandbox-Zugriff lahmlegen.
// --no-sandbox ist ein Security-Tradeoff – nur setzen wenn nötig.
if (chromeWidevine) {
  const isCastlabs =
    process.env.ELECTRON_CUSTOM_VERSION?.includes('castlabs') ||
    (process.execPath || '').toLowerCase().includes('castlabs');
  if (!isCastlabs) {
    app.commandLine.appendSwitch('no-sandbox');
    if (process.platform === 'linux') {
      app.commandLine.appendSwitch('no-zygote');
    }
  }
}
app.commandLine.appendSwitch('disable-service-worker-autostart');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-features', 'PlatformEncryptedDolbyVision');
app.commandLine.appendSwitch('disable-features', 'MediaRouterProvider');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function loadServices() {
  try {
    const raw = fs.readFileSync(servicesPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveServices(services) {
  fs.writeFileSync(servicesPath, JSON.stringify(services, null, 2), 'utf-8');
}

function broadcastServices() {
  const services = loadServices();
  mainWindow?.webContents.send('services-changed', services);
}

function loadTvSources() {
  try {
    const raw = fs.readFileSync(tvSourcesPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
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
    saveTvSources(defaults);
    return defaults;
  }
}

function saveTvSources(sources) {
  fs.writeFileSync(tvSourcesPath, JSON.stringify(sources, null, 2), 'utf-8');
}

function broadcastTvSources() {
  const sources = loadTvSources();
  mainWindow?.webContents.send('tv-sources-changed', sources);
}

function parseM3U(content) {
  const channels = [];
  const lines = content.split('\n');
  let currentExtinf = null;
  const epgUrls = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for x-tvg-url in #EXTM3U line or standalone
    const tvgUrlMatch = trimmed.match(/x-tvg-url="([^"]+)"/i);
    if (tvgUrlMatch && !epgUrls.includes(tvgUrlMatch[1])) {
      epgUrls.push(tvgUrlMatch[1]);
    }
    // Check for #URLTV-SOURCE or similar EPG source tags
    const sourceMatch = trimmed.match(/^(?:#URLTV-SOURCE|#EPG-URL)\s*:\s*(\S+)/i);
    if (sourceMatch && !epgUrls.includes(sourceMatch[1])) {
      epgUrls.push(sourceMatch[1]);
    }

    if (trimmed.startsWith('#EXTM3U')) continue;

    if (trimmed.startsWith('#EXTINF:')) {
      const match = trimmed.match(/#EXTINF:-?\d+\s+(.*?)(?:,(.*))?$/);
      if (match) {
        const attrs = match[1];
        const displayName = match[2] ? match[2].trim() : '';
        const extract = name => {
          const re = new RegExp(`${name}="([^"]*)"`);
          const m = attrs.match(re);
          return m ? m[1] : null;
        };
        const tvgId = extract('tvg-id');
        const tvgName = extract('tvg-name');
        const tvgLogo = extract('tvg-logo');
        const groupTitle = extract('group-title') || 'Unsortiert';

        const cleanDisplay = cleanChannelName(displayName);
        const cleanTvgName = tvgName ? cleanChannelName(tvgName) : '';
        currentExtinf = {
          id: tvgId || cleanDisplay || 'channel-' + Math.random().toString(36).slice(2, 8),
          name: cleanTvgName || cleanDisplay || 'Unbekannter Sender',
          logo: tvgLogo || null,
          group: groupTitle,
          tvgId: tvgId || '',
        };
      }
    } else if (trimmed && !trimmed.startsWith('#') && currentExtinf) {
      channels.push({ ...currentExtinf, url: trimmed });
      currentExtinf = null;
    }
  }
  return { channels, epgUrls };
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
}

// ── Updater ──

const GITEA_BASE = 'http://192.168.4.105:3000';
const GITEA_OWNER = 'kekskarlo';
const GITEA_REPO = 'Streaming-Hub';

async function giteaApi(path) {
  const token = process.env.GITEA_TOKEN;
  const url = `${GITEA_BASE}/api/v1/repos/${GITEA_OWNER}/${GITEA_REPO}/${path}`;
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `token ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Gitea API ${res.status}`);
  return res.json();
}

function startUpdater() {
  if (process.env.APPIMAGE) {
    // AppImage: use Gitea API for updates
    autoUpdater = {
      check: async () => {
        try {
          const release = await giteaApi('releases/latest');
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
          const release = await giteaApi('releases/latest');
          const asset = release.assets?.find(a => a.name.endsWith('.AppImage'));
          if (!asset) throw new Error('keine AppImage in Release gefunden');

          const currentAppImage = process.env.APPIMAGE;
          const appDir = path.dirname(currentAppImage);
          const tmpDest = path.join(appDir, `.update-${Date.now()}.AppImage`);
          const finalDest = path.join(appDir, `Streaming Hub-${version}.AppImage`);
          const token = process.env.GITEA_TOKEN;
          const headers = {};
          if (token) headers.Authorization = `token ${token}`;

          mainWindow?.webContents.send('update-status', { type: 'progress', percent: 0 });
          const res = await fetch(asset.browser_download_url, { headers, signal: AbortSignal.timeout(300000) });
          if (!res.ok) throw new Error(`Download ${res.status}`);
          const total = parseInt(res.headers.get('content-length') || '0');
          const reader = res.body.getReader();
          const ws = fs.createWriteStream(tmpDest);
          let received = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.write(value);
            received += value.length;
            if (total)
              mainWindow?.webContents.send('update-status', { type: 'progress', percent: (received / total) * 100 });
          }
          ws.end();
          await new Promise(r => ws.on('finish', r));
          fs.chmodSync(tmpDest, 0o755);

          if (currentAppImage !== finalDest) {
            try {
              fs.unlinkSync(finalDest);
            } catch (e) {}
          }
          fs.renameSync(tmpDest, finalDest);
          return finalDest;
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

ipcMain.handle('check-for-update', async () => {
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

ipcMain.handle('apply-update', async (_e, version) => {
  if (process.env.APPIMAGE) {
    if (!autoUpdater) return { success: false, error: 'kein updater' };
    try {
      const newAppImage = await autoUpdater.download(version);
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
  const proc = fork(path.join(__dirname, 'updater.js'), [__dirname], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ success: false, error: 'timeout' }), 180000);
    const onMsg = msg => {
      if (msg.type === 'progress') {
        mainWindow?.webContents.send('update-status', { type: 'progress', step: msg.step, percent: msg.percent });
      } else if (msg.type === 'applied') {
        clearTimeout(timer);
        proc.removeListener('message', onMsg);
        resolve({ success: !msg.error, error: msg.error });
        if (!msg.error) {
          setTimeout(() => {
            const { execSync } = require('child_process');
            execSync(
              `setsid env ELECTRON_DISABLE_SANDBOX=1 DISPLAY="${process.env.DISPLAY || ''}" nohup "${process.execPath}" "${__dirname}" >/dev/null 2>&1 &`,
              { cwd: __dirname }
            );
            app.exit(0);
          }, 500);
        }
      }
    };
    proc.on('message', onMsg);
    proc.on('exit', () => {
      clearTimeout(timer);
      proc.removeListener('message', onMsg);
      resolve({ success: false, error: 'prozess unerwartet beendet' });
    });
    proc.send({ type: 'apply', version });
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0a0a0f',
    title: 'Streaming Hub',
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

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

app.whenReady().then(async () => {
  try {
    await components.whenReady();
    logger.info('Widevine CDM status:', components.status());
  } catch (e) {
    logger.warn('Component updater failed (expected without sandbox), using system Widevine if available');
  }
  startUpdater();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

ipcMain.on('toggle-pip', (_e, url) => {
  if (pipWindow) {
    pipWindow.close();
    pipWindow = null;
    mainWindow.webContents.send('pip-state', false);
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const pipW = Math.min(480, Math.round(width * 0.3));
  const pipH = Math.min(320, Math.round((pipW * 9) / 16) + 32);

  pipWindow = new BrowserWindow({
    width: pipW,
    height: pipH,
    alwaysOnTop: true,
    frame: false,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      webviewTag: true,
    },
  });

  // Detect TV stream URL (ends with .m3u8 or contains common streaming patterns)
  const isStreamUrl = /\.m3u8$|\.mpd$|\.ts$|mpegts/i.test(url);

  if (isStreamUrl) {
    // Load a player page for TV streams
    pipWindow.loadFile('pip.html');

    pipWindow.webContents.on('did-finish-load', () => {
      pipWindow.webContents.executeJavaScript(`
        window.postMessage({ type: 'load-tv-stream', url: ${JSON.stringify(url)} }, '*');
      `);
    });
  } else {
    pipWindow.loadFile('pip.html');

    pipWindow.webContents.on('did-finish-load', () => {
      pipWindow.webContents.executeJavaScript(`
        window.postMessage({ type: 'load-url', url: ${JSON.stringify(url)} }, '*');
      `);
    });
  }

  pipWindow.on('closed', () => {
    pipWindow = null;
    mainWindow.webContents.send('pip-state', false);
  });

  mainWindow.webContents.send('pip-state', true);
});

ipcMain.on('webview-keydown', (_e, data) => {
  mainWindow?.webContents.send('webview-keydown', data);
});

ipcMain.handle('get-app-version', () => {
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

ipcMain.on('toggle-fullscreen', () => {
  mainWindow?.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.handle('get-services', () => loadServices());

ipcMain.handle('add-service', (_e, service) => {
  const services = loadServices();
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

ipcMain.handle('remove-service', (_e, id) => {
  let services = loadServices();
  services = services.filter(s => s.id !== id);
  saveServices(services);
  broadcastServices();
});

// History
ipcMain.handle('get-history', () => loadHistory());

ipcMain.handle('save-history-entry', (_e, entry) => {
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

ipcMain.handle('clear-history', () => {
  saveHistory([]);
  return [];
});

// TV Sources
ipcMain.handle('get-tv-sources', () => loadTvSources());

ipcMain.handle('add-tv-source', (_e, source) => {
  const sources = loadTvSources();
  // Existierende Quelle mit gleicher URL wiedererkennen → ID + Overrides erhalten
  const existing = sources.find(s => s.url === source.url);
  if (existing) {
    // Eigenschaften mergen, aber Overrides/Favoriten/SortOrder aus bestehender Quelle erhalten
    existing.name = source.name || existing.name;
    existing.epgUrl = source.epgUrl || existing.epgUrl;
    existing.sortOrder = source.sortOrder || existing.sortOrder || [];
    // favorites und channelOverrides bleiben unangetastet
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

ipcMain.handle('remove-tv-source', (_e, id) => {
  let sources = loadTvSources();
  sources = sources.filter(s => s.id !== id);
  saveTvSources(sources);
  broadcastTvSources();
});

ipcMain.handle('update-tv-source', (_e, id, updates) => {
  const sources = loadTvSources();
  const idx = sources.findIndex(s => s.id === id);
  if (idx !== -1) {
    sources[idx] = { ...sources[idx], ...updates };
    saveTvSources(sources);
    broadcastTvSources();
    return sources[idx];
  }
  return null;
});

ipcMain.handle('pick-m3u-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('fetch-and-parse-m3u', async (_e, urlOrPath) => {
  try {
    let content;
    let baseUrl = '';
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      const response = await fetch(urlOrPath);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      content = await response.text();
      baseUrl = urlOrPath.substring(0, urlOrPath.lastIndexOf('/') + 1);
    } else {
      content = fs.readFileSync(urlOrPath, 'utf-8');
      baseUrl = path.dirname(urlOrPath) + path.sep;
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

ipcMain.handle('get-app-path', () => __dirname);

// ── Backup / Restore ──

ipcMain.handle('backup-settings', async () => {
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

ipcMain.handle('restore-settings', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Sicherungsdatei', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { success: false };
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
    const data = JSON.parse(raw);
    if (!data.services && !data.tvsources) throw new Error('ungültiges Backup-Format');
    if (data.services) {
      saveServices(data.services);
      broadcastServices();
    }
    if (data.tvsources) {
      saveTvSources(data.tvsources);
      broadcastTvSources();
    }
    if (data.history) saveHistory(data.history);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fetch-epg', async (_e, url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    return parseXMLTV(xml);
  } catch (err) {
    throw new Error(`Fehler beim Laden des EPG: ${err.message}`);
  }
});
