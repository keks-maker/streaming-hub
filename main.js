const { app, BrowserWindow, ipcMain, components, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

let mainWindow;
let pipWindow = null;

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
