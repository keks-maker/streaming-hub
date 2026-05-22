const { app, BrowserWindow, ipcMain, components, screen, globalShortcut, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

let mainWindow;
let pipWindow = null;
const servicesPath = path.join(__dirname, 'services.json');
const historyPath = path.join(__dirname, 'history.json');
const tvSourcesPath = path.join(__dirname, 'tvsources.json');

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
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
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
      console.log('Using Chrome Widevine:', manifest.version);
    }
  } catch (e) {
    console.log('Failed to parse Chrome Widevine manifest:', e.message);
  }
}

if (chromeWidevine) {
  app.commandLine.appendSwitch('no-sandbox');
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-zygote');
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
    const defaults = [{
      id: 'deutsche-oeffentlich-rechtliche',
      name: 'Deutsche Öffentlich-Rechtliche',
      url: 'https://iptv-org.github.io/iptv/countries/de.m3u',
      type: 'url',
      color: '#a78bfa',
      epgUrl: 'https://iptv-epg.org/files/epg-de.xml',
      sortOrder: [],
    }];
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

function cleanChannelName(raw) {
  return raw
    .replace(/\s*\[Geo-Blocked\]\s*/gi, '')
    .replace(/\s*\(\d{3,4}p\)\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
        const extract = (name) => {
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

function parseEPG(xml) {
  const programmes = [];
  const blockRe = /<programme\s+([\s\S]*?)<\/programme>/g;
  let block;
  while ((block = blockRe.exec(xml)) !== null) {
    const tag = block[1];
    const ch = tag.match(/channel="([^"]*)"/);
    const st = tag.match(/start="([^"]*)"/);
    const sp = tag.match(/stop="([^"]*)"/);
    const ti = tag.match(/<title[^>]*>(?:<!\[CDATA\[)?([^\]<]*?)(?:\]\]>)?<\/title>/);
    if (!ch || !st || !sp || !ti) continue;
    const de = tag.match(/<desc[^>]*>(?:<!\[CDATA\[)?([^\]<]*?)(?:\]\]>)?<\/desc>/);
    programmes.push({
      channelId: ch[1],
      start: st[1],
      stop: sp[1],
      title: ti[1].trim(),
      description: de ? de[1].trim() : '',
    });
  }
  return programmes;
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
    } catch (_) { /* key not available on this platform */ }
  }
}

app.whenReady().then(async () => {
  try {
    await components.whenReady();
    console.log('Widevine CDM status:', components.status());
  } catch (e) {
    console.log('Component updater failed (expected without sandbox), using system Widevine if available');
  }
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
  const pipH = Math.min(320, Math.round(pipW * 9 / 16) + 32);

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

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.on('toggle-fullscreen', () => {
  mainWindow?.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.handle('get-services', () => loadServices());

ipcMain.handle('add-service', (_e, service) => {
  const services = loadServices();
  service.id = service.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
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
  source.id = source.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
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
      logo: ch.logo && !ch.logo.startsWith('http://') && !ch.logo.startsWith('https://') && !ch.logo.startsWith('file://')
        ? baseUrl + ch.logo
        : ch.logo,
    }));
    return { channels, epgUrls: result.epgUrls };
  } catch (err) {
    throw new Error(`Fehler beim Laden der M3U: ${err.message}`);
  }
});

ipcMain.handle('get-app-path', () => __dirname);

ipcMain.handle('fetch-epg', async (_e, url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    return parseEPG(xml);
  } catch (err) {
    throw new Error(`Fehler beim Laden des EPG: ${err.message}`);
  }
});
