const { app, BrowserWindow, ipcMain, components, screen } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;
let pipWindow = null;

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
app.commandLine.appendSwitch('disable-service-worker-autostart');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-features', 'PlatformEncryptedDolbyVision');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaRouterProvider');

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

  pipWindow.loadFile('pip.html');

  pipWindow.webContents.on('did-finish-load', () => {
    pipWindow.webContents.executeJavaScript(`
      window.postMessage({ type: 'load-url', url: ${JSON.stringify(url)} }, '*');
    `);
  });

  pipWindow.on('closed', () => {
    pipWindow = null;
    mainWindow.webContents.send('pip-state', false);
  });

  mainWindow.webContents.send('pip-state', true);
});
