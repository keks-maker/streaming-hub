const { app, BrowserWindow, BrowserView, ipcMain, screen, components } = require('electron');
const path = require('path');

const fs = require('fs');

let mainWindow;
let contentView;
let sidebarCollapsed = false;

const SIDEBAR_W = 240;
const SIDEBAR_W_MIN = 56;
const TITLEBAR_H = 40;

// Use Chrome's Widevine as fallback since component updater may fail without sandbox
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

  // Manual bounds management for smooth sidebar animation
  // setAutoResize conflicts with sidebar collapse animation

  // Inject custom scrollbar CSS into all pages
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

  mainWindow.setBrowserView(contentView);
  updateContentBounds();

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  // Debounced resize handler for window resizing (not sidebar animation)
  let resizeTimer;
  mainWindow.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateContentBounds, 100);
  });
}

function updateContentBounds() {
  if (!mainWindow || !contentView) return;
  const bounds = mainWindow.getContentBounds();
  const sw = sidebarCollapsed ? SIDEBAR_W_MIN : SIDEBAR_W;
  contentView.setBounds({
    x: sw,
    y: TITLEBAR_H,
    width: bounds.width - sw,
    height: bounds.height - TITLEBAR_H,
  });
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

ipcMain.on('toggle-sidebar', () => {
  sidebarCollapsed = !sidebarCollapsed;
  mainWindow?.webContents.send('sidebar-state', sidebarCollapsed);
  
  // Update BrowserView bounds immediately to fill new space
  // CSS animation runs in parallel on the sidebar
  updateContentBounds();
});

ipcMain.on('navigate', (_e, url) => {
  contentView?.webContents.loadURL(url);
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
