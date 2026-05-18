const { app, BrowserWindow, ipcMain, components } = require('electron');
const path = require('path');

const fs = require('fs');

let mainWindow;

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
