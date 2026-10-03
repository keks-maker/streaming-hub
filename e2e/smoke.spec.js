'use strict';

// E2E-Smoke-Test der Desktop-App (Playwright _electron, Castlabs-Electron aus node_modules).
//
// Isolation:
//  - userData  -> temporäres Verzeichnis (Env STREAMING_HUB_USER_DATA, siehe main.js)
//  - HOME      -> temporäres Verzeichnis (Aufnahme-Default ~/Videos/Streaming Hub landet im Temp)
//  - Netz      -> per --host-resolver-rules komplett gesperrt (kein api.github.com,
//                 keine EPG-/Playlist-Downloads). Der Updater prüft ohnehin nur auf
//                 Nutzeraktion (Hover/Klick auf den Update-Button), nie beim Start;
//                 dieser Test löst sie nie aus.
//
// Ziel: E2E_APP_PATH (optional) = gepackte .app (macOS) oder ausführbare Datei;
// Default: `electron .` aus node_modules.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_VERSION = require('../package.json').version;

// Bekannte, harmlose Konsolen-/Log-Meldungen (Teilstring-Match, jeweils begründet).
// Hermetischer Lauf ohne Netz + ohne Widevine-Signatur erzeugt zwangsläufig:
const KNOWN_HARMLESS = [
  // Netz absichtlich gesperrt: Playlist-/EPG-/Favicon-Fetches des Renderers scheitern.
  'ERR_NAME_NOT_RESOLVED',
  'Failed to fetch',
  'net::ERR_',
  // Component-Updater (Widevine) braucht Netz/EVS-Sandbox; die App loggt dazu selbst eine Warnung.
  'Component updater failed',
  // Chromium/Electron-Rauschen ohne Bezug zur App.
  'Electron Security Warning',
  'Autofill.enable',
  'Autofill.setAddresses',
];

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
  }
  if (!fs.existsSync(exe)) throw new Error(`E2E_APP_PATH existiert nicht: ${exe}`);
  // Vorab-Schutz (vor dem Start!): Ein Build ohne userData-Hook würde sonst die ECHTEN
  // Nutzerdaten öffnen. Bei .app-Bundles (asar: false) prüfen wir main.js im Bundle.
  if (custom.endsWith('.app')) {
    const bundledMain = path.join(path.resolve(custom), 'Contents', 'Resources', 'app', 'main.js');
    if (!fs.existsSync(bundledMain) || !fs.readFileSync(bundledMain, 'utf8').includes('STREAMING_HUB_USER_DATA')) {
      throw new Error(`E2E_APP_PATH: ${custom} enthält den Test-Hook STREAMING_HUB_USER_DATA nicht (zu alter Build?) — Abbruch zum Schutz echter Nutzerdaten`);
    }
  }
  return { executablePath: exe, args: [], packaged: true };
}

function isKnownHarmless(text) {
  return KNOWN_HARMLESS.some(k => text.includes(k));
}

let tmpRoot;
let electronApp;
let page;
const problems = [];

test.beforeAll(async () => {
  // realpath: macOS-tmp liegt unter /var -> /private/var; app.getPath liefert die aufgelöste Form.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-')));
  const userData = path.join(tmpRoot, 'userData');
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(userData);
  fs.mkdirSync(home);

  const target = resolveLaunchTarget();
  electronApp = await electron.launch({
    executablePath: target.executablePath,
    args: [...target.args, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    env: {
      ...process.env,
      HOME: home,
      STREAMING_HUB_USER_DATA: userData,
      STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9',
    },
    timeout: 45_000,
  });

  // Fail-fast: niemals gegen echte Nutzerdaten laufen (z.B. gepackte Alt-Version ohne Env-Hook).
  const actualUserData = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  if (fs.realpathSync(actualUserData) !== userData) {
    await electronApp.close().catch(() => {});
    throw new Error(`userData nicht isoliert: ${actualUserData} (erwartet ${userData}) — Abbruch zum Schutz echter Nutzerdaten`);
  }

  electronApp.on('console', msg => {
    if (msg.type() === 'error' && !isKnownHarmless(msg.text())) problems.push(`[main console] ${msg.text()}`);
  });

  page = await electronApp.firstWindow();
  page.on('pageerror', err => problems.push(`[pageerror] ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error' && !isKnownHarmless(msg.text())) problems.push(`[renderer console] ${msg.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  // Kern-DOM abwarten; damit sind auch die Start-Listener der Konsole gesetzt.
  await page.locator('#dashboardView').waitFor();
});

test.afterAll(async () => {
  if (electronApp) {
    // Playwright hängt `--inspect`; beim Quit wartet Node mitunter ewig auf den Debugger
    // ("Waiting for the debugger to disconnect...", nur unter Playwright, nicht im Normalbetrieb).
    // Deshalb: sauberes close() mit Frist, danach hartes Beenden der Testinstanz.
    const proc = electronApp.process();
    await Promise.race([electronApp.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Hauptfenster rendert Titel und Kern-DOM', async () => {
  await expect(page).toHaveTitle('Streaming Hub');
  // Auf der Startseite ist die Navbar by design ausgeblendet (display:none) — nur im DOM prüfen.
  await expect(page.locator('#overlayBar')).toBeAttached();
  await expect(page.locator('#contentArea')).toBeAttached();
  // Startdashboard mit allen fünf Bereichs-Kacheln (renderStartDashboard).
  await expect(page.locator('#dashboardView')).toBeVisible();
  await expect(page.locator('#dashboardTitle')).toHaveText('Was möchtest du sehen?');
  for (const key of ['livetv', 'streaming', 'mediathek', 'recording', 'settings']) {
    await expect(page.locator(`.dashboard-section-tile[data-section="${key}"]`)).toBeVisible();
  }
  await expect(page.locator('#versionTag')).toHaveText(`v${PKG_VERSION}`);
});

test('Isolation: userData im Temp-Verzeichnis, kein Updater-Lauf', async () => {
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  expect(fs.realpathSync(userData).startsWith(tmpRoot)).toBe(true);
  // Updater läuft nur auf Nutzeraktion: Button darf weder "Suche…" noch "verfügbar" zeigen.
  const btn = page.locator('#updateBtn');
  await expect(btn).not.toHaveClass(/update-available/);
  await expect(btn).not.toHaveAttribute('title', 'Suche…');
  // Kein Updater-Apply: updater.log entsteht erst beim Apply.
  const logsDir = await electronApp.evaluate(({ app }) => app.getPath('logs'));
  expect(fs.existsSync(path.join(logsDir, 'updater.log'))).toBe(false);
});

test('LiveTV: Favoriten-UI (Senderliste, Favoriten-Tab, Reihenfolge) erreichbar', async () => {
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  const manage = page.locator('#dashboardTvManage');
  await expect(manage).toBeVisible();
  await manage.click();

  const overlay = page.locator('#tvChannelManagerOverlay');
  await expect(overlay).toHaveClass(/open/);
  await expect(page.locator('#tvChannelViewAll')).toHaveAttribute('aria-selected', 'true');

  await page.locator('#tvChannelViewFavorites').click();
  await expect(page.locator('#tvChannelViewFavorites')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tvChannelViewAll')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#tvFavoriteSortToggle')).toBeVisible();
  await expect(page.locator('#tvChannelManagerList')).toBeAttached();

  await page.locator('#tvChannelManagerClose').click();
  await expect(overlay).not.toHaveClass(/open/);
});

test('Aufnahmen: Dashboard-Einstieg und Speicherort-Einstellung erreichbar', async () => {
  // Navigation über die Navbar (nach dem Betreten eines Bereichs ist sie sichtbar).
  const nav = page.locator('#overlayNav');
  await nav.locator('[data-section="recording"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Aufnahmen');
  await expect(page.locator('#dashboardView')).toHaveClass(/recordings-dashboard/);
  await expect(page.locator('.recordings-dashboard-title')).toHaveText('Aufnahmen');
  await expect(page.locator('#recordingsRefresh')).toBeVisible();

  // Einstellungen -> Aufnahme-Speicherort (Recorder-Konfiguration).
  await nav.locator('[data-section="settings"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  await expect(page.locator('#recPathInput')).toBeVisible();
  await expect(page.locator('#recPathSaveBtn')).toBeVisible();
});

test('Keine uncaught Exceptions / unerwarteten Konsolen-Errors seit Start', async () => {
  expect(problems, `Unerwartete Fehler:\n${problems.join('\n')}`).toEqual([]);
});
