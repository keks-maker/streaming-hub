const { app, BrowserWindow, BrowserView, ipcMain, screen, components } = require('electron');
const path = require('path');

const fs = require('fs');

let mainWindow;
let contentView;
let isFullscreen = false;

const OVERLAY_H = 64;

const chromeWidevineDir = '/opt/google/chrome/WidevineCdm';
const chromeWidevineManifest = path.join(chromeWidevineDir, 'manifest.json');
if (fs.existsSync(chromeWidevineManifest)) {
  const manifest = JSON.parse(fs.readFileSync(chromeWidevineManifest, 'utf-8'));
  app.commandLine.appendSwitch('widevine-cdm-path', chromeWidevineDir);
  app.commandLine.appendSwitch('widevine-cdm-version', manifest.version);
  console.log('Using Chrome Widevine:', manifest.version);
}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('no-zygote');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-service-worker-autostart');
app.commandLine.appendSwitch('enable-features', 'PlatformEncryptedDolbyVision');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaRouterProvider');

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1280, width),
    height: Math.min(850, height),
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hidden',
    title: 'Streaming Hub',
    frame: false,
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('resize', () => {
    updateContentBounds();
  });
}

function showContent(url) {
  if (contentView) {
    mainWindow.removeBrowserView(contentView);
    contentView.webContents.destroy();
  }

  contentView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      plugins: true,
      webSecurity: true,
      partition: 'persist:streaming',
      preload: path.join(__dirname, 'preload-content.js'),
    },
  });

  contentView.webContents.on('did-finish-load', () => {
    contentView.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
      ::-webkit-scrollbar-corner { background: transparent; }
      * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
    `).catch(() => {});
  });

  const chromeUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  contentView.webContents.setUserAgent(chromeUA);

  contentView.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystemAccess') {
      callback(true);
    } else {
      callback(false);
    }
  });

  contentView.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'mediaKeySystemAccess';
  });

  mainWindow.addBrowserView(contentView);
  contentView.webContents.loadURL(url);
  updateContentBounds();
}

function updateContentBounds() {
  if (!mainWindow || !contentView) return;
  const bounds = mainWindow.getContentBounds();
  if (isFullscreen) {
    contentView.setBounds({
      x: 0,
      y: 24,
      width: bounds.width,
      height: bounds.height - 24,
    });
  } else {
    contentView.setBounds({
      x: 0,
      y: OVERLAY_H,
      width: bounds.width,
      height: bounds.height - OVERLAY_H,
    });
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

ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('close-window', () => mainWindow?.close());

ipcMain.on('toggle-fullscreen', (_e, state) => {
  isFullscreen = state;
  mainWindow.webContents.send('fullscreen-state', state);
  updateContentBounds();
});

ipcMain.on('navigate', (_e, url, provider) => {
  showContent(url);
  mainWindow.webContents.send('navigate-overlay', provider);
});

ipcMain.on('go-back', () => {
  if (contentView?.webContents.canGoBack()) contentView.webContents.goBack();
});

ipcMain.on('go-forward', () => {
  if (contentView?.webContents.canGoForward()) contentView.webContents.goForward();
});

ipcMain.on('reload', () => contentView?.webContents.reload());

ipcMain.on('get-current-url', (e) => {
  e.returnValue = contentView?.webContents.getURL() || '';
});
