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
// Ziel: E2E_APP_PATH (optional) = gepackte .app (macOS), AppImage/linux-unpacked (Linux) oder
// ausführbare Datei; Default: `electron .` aus node_modules. Plattformlogik: e2e/platform.js.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLaunchTarget, launchArgs, realUpdaterLogPath } = require('./platform');

const PKG_VERSION = require('../package.json').version;

// Bekannte, harmlose Konsolen-/Log-Meldungen (Teilstring-Match, jeweils begründet).
// Hermetischer Lauf ohne Netz + ohne Widevine-Signatur erzeugt zwangsläufig:
const KNOWN_HARMLESS = [
  // Netz absichtlich gesperrt: Playlist-/EPG-/Favicon-Fetches des Renderers scheitern.
  'ERR_NAME_NOT_RESOLVED',
  'Failed to fetch',
  'net::ERR_',
  // Einstellungen-Test weist bewusst eine lokale URL ab; main.js loggt die Validierungsabweisung.
  "Error occurred in handler for 'update-tv-source': Error: M3U-URL darf kein lokales oder privates Ziel verwenden",
  // Einstellungen-Test legt eine Quelle auf *.invalid an; deren EPG-Abruf scheitert erwartungsgemäß.
  "Error occurred in handler for 'fetch-epg': Error: Fehler beim Laden des EPG (https://e2e-quelle.invalid/",
  "Error occurred in handler for 'update-tv-source': TypeError: Invalid URL",
  // Component-Updater (Widevine) braucht Netz/EVS-Sandbox; die App loggt dazu selbst eine Warnung.
  'Component updater failed',
  // Chromium/Electron-Rauschen ohne Bezug zur App.
  'Electron Security Warning',
  'Autofill.enable',
  'Autofill.setAddresses',
];

function isKnownHarmless(text) {
  return KNOWN_HARMLESS.some(k => text.includes(k));
}

// Zustand einer Datei (oder null) — für Unverändert-Prüfung echter Nutzer-Logs.
function fileState(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

// macOS: app.getPath('logs') zeigt trotz HOME-Umbiegung auf das ECHTE ~/Library/Logs/Streaming Hub
// (dort kann der updater.log eines echten Nutzers liegen). Zustand vor App-Start erfassen;
// der Test prüft später nur "unverändert", nie "nicht vorhanden". Das echte Log wird nie angefasst.
// Linux/Windows: dort liegt logs unter userData (im Test umgebogen), der echte Pfad dient nur dem Vergleich.
const REAL_UPDATER_LOG = realUpdaterLogPath();
let realUpdaterLogBefore = null;

let tmpRoot;
let electronApp;
let page;
const problems = [];

test.beforeAll(async () => {
  // realpath: macOS: tmp liegt unter /var -> /private/var; Linux: /tmp kann ein Symlink/Mount sein. app.getPath liefert die aufgelöste Form.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-')));
  const userData = path.join(tmpRoot, 'userData');
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(userData);
  fs.mkdirSync(home);

  realUpdaterLogBefore = fileState(REAL_UPDATER_LOG);
  const target = resolveLaunchTarget();
  electronApp = await electron.launch({
    executablePath: target.executablePath,
    args: launchArgs(target),
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
  // Zeigt logs auf das echte Verzeichnis, muss das Log unverändert sein (Zustand vor Start);
  // liegt es im Temp, darf es nicht existieren.
  const updaterLog = path.join(logsDir, 'updater.log');
  if (updaterLog === REAL_UPDATER_LOG) {
    expect(fileState(updaterLog)).toBe(realUpdaterLogBefore);
  } else {
    expect(fs.existsSync(updaterLog)).toBe(false);
  }
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

// LiveTV-Gruppe der Einstellungs-Seitenleiste aufklappen (falls zugeklappt).
async function expandSettingsLiveTv() {
  const group = page.locator('#settingsNav .settings-nav-group');
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
}

test('Aufnahmen: Dashboard-Einstieg und Speicherort-Einstellung erreichbar', async () => {
  // Navigation über die Navbar (nach dem Betreten eines Bereichs ist sie sichtbar).
  const nav = page.locator('#overlayNav');
  // 3.6b (P21): kein NavBar-Eintrag mehr; Einstieg über die Karte „Aufnahmen“ im LiveTV-Dashboard
  await expect(nav.locator('[data-section="recording"]')).toHaveCount(0);
  await nav.locator('[data-section="livetv"]').click();
  await page.locator('#dashboardRecordingsOpen').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Aufnahmen');
  await expect(page.locator('#dashboardView')).toHaveClass(/recordings-dashboard/);
  await expect(page.locator('.recordings-dashboard-title')).toHaveText('Aufnahmen');
  await expect(page.locator('#recordingsRefresh')).toBeVisible();

  // Einstellungen -> Aufnahme-Speicherort (Recorder-Konfiguration).
  await nav.locator('[data-section="settings"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  // Seitenleiste: Aufnahmen liegt unter LiveTV und ist erst nach Seitenwahl sichtbar.
  await expandSettingsLiveTv();
  await page.locator('#settingsTab-livetv-recordings').click();
  await expect(page.locator('#recPathInput')).toBeVisible();
  await expect(page.locator('#recPathSaveBtn')).toBeVisible();
});

test('Einstellungen: Seitenwechsel per Seitenleiste und Tastatur', async () => {
  await page.locator('#overlayNav [data-section="settings"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');

  await page.locator('#settingsTab-general').click();
  await expect(page.locator('[data-settings-page="general"]')).toBeVisible();
  await expect(page.locator('#backupBtn')).toBeVisible();
  await expect(page.locator('[data-settings-page="streaming"]')).toBeHidden();
  await expect(page.locator('#recPathInput')).toBeHidden();

  await page.locator('#settingsTab-streaming').click();
  await expect(page.locator('#settingsServiceListStreaming')).toBeVisible();
  await expect(page.locator('#settingsTab-streaming')).toHaveAttribute('aria-selected', 'true');

  await page.locator('#settingsTab-mediathek').click();
  await expect(page.locator('#settingsServiceListMediathek')).toBeVisible();
  await page.locator('#settingsAddMediathekBtn').click();
  await expect(page.locator('#settingsAddForm')).toBeVisible();
  await expect(page.locator('#settingsInputGroup')).toHaveValue('mediathek');

  // Formular wird beim Seitenwechsel zurückgesetzt und geschlossen (ohne erneuten +-Klick prüfen).
  await page.locator('#settingsTab-streaming').click();
  await page.locator('#settingsAddDienstBtn').click();
  await expect(page.locator('#settingsAddForm')).toBeVisible();
  await page.locator('#settingsInputName').fill('Testdienst');
  await page.locator('#settingsTab-general').click();
  await page.locator('#settingsTab-streaming').click();
  await expect(page.locator('#settingsAddForm')).toBeHidden();
  await expect(page.locator('#settingsInputName')).toHaveValue('');

  // Pfeiltasten wechseln die Seite (Mediatheken -> Allgemein per Home).
  await page.locator('#settingsTab-mediathek').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-settings-page="general"]')).toBeVisible();

  // LiveTV-Unterseiten
  await expandSettingsLiveTv();
  await page.locator('#settingsTab-livetv-playback').click();
  await expect(page.locator('input[name="tvMode"][value="free"]')).toBeVisible();
  await page.locator('#settingsTab-livetv-sources').click();
  await expect(page.locator('#settingsTvSourceList')).toBeVisible();
  await expect(page.locator('#settingsTvSourceAdd form')).toBeVisible();
});

test('Einstellungen: Pfeiltasten im schmalen Layout erreichen LiveTV-Tabs', async () => {
  await page.setViewportSize({ width: 700, height: 800 });
  try {
    await page.locator('#overlayNav [data-section="settings"]').click();
    await page.locator('#settingsTab-general').click();
    const group = page.locator('#settingsNav .settings-nav-group');
    if ((await group.getAttribute('aria-expanded')) === 'true') {
      await group.evaluate(el => el.click());
    }
    await page.locator('#settingsTab-general').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#settingsTab-livetv-sources')).toHaveAttribute('aria-selected', 'true');
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test('Einstellungen: LiveTV-Quelle hinzufügen, bearbeiten, EPG-URL ändern, entfernen', async () => {
  await page.locator('#overlayNav [data-section="settings"]').click();
  await expandSettingsLiveTv();
  await page.locator('#settingsTab-livetv-sources').click();

  const row = name => page.locator('#settingsTvSourceList .settings-source-row', { hasText: name });
  const sourceByName = name =>
    page.evaluate(async n => (await window.electronAPI.getTvSources()).find(s => s.name === n) || null, name);

  // Hinzufügen (isoliertes Profil, kein Netz: .invalid wird nie aufgelöst)
  const add = page.locator('#settingsTvSourceAdd form');
  await add.locator('input[name="name"]').fill('E2E Quelle');
  await add.locator('input[name="url"]').fill('https://e2e-quelle.invalid/liste.m3u');
  await add.locator('input[name="epgUrl"]').fill('https://e2e-quelle.invalid/epg.xml');
  await add.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(row('E2E Quelle')).toBeVisible();
  await expect(row('E2E Quelle')).toContainText('https://e2e-quelle.invalid/liste.m3u');
  await expect(row('E2E Quelle')).toContainText('EPG: https://e2e-quelle.invalid/epg.xml');
  const created = await sourceByName('E2E Quelle');
  expect(created).not.toBeNull();

  // Favoriten/Overrides setzen, damit das Bearbeiten sie nachweislich nicht löscht.
  await page.evaluate(
    id =>
      window.electronAPI.updateTvSource(id, {
        favorites: ['fav-1'],
        sortOrder: ['fav-1'],
        channelOverrides: { 'fav-1': { url: 'https://e2e-quelle.invalid/x' } },
      }),
    created.id,
  );

  // Bearbeiten
  await row('E2E Quelle').getByRole('button', { name: 'Bearbeiten' }).click();
  const edit = page.locator('#settingsTvSourceList form');
  await edit.locator('input[name="name"]').fill('E2E Quelle 2');
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect(row('E2E Quelle 2')).toBeVisible();
  const edited = await sourceByName('E2E Quelle 2');
  expect(edited.id).toBe(created.id);
  expect(edited.favorites).toEqual(['fav-1']);
  expect(edited.sortOrder).toEqual(['fav-1']);
  expect(edited.channelOverrides).toEqual({ 'fav-1': { url: 'https://e2e-quelle.invalid/x' } });
  expect(edited.epgUrl).toBe('https://e2e-quelle.invalid/epg.xml');

  // Ungültige Eingabe wird abgewiesen und nicht gespeichert (keine Datei-/Localhost-URL).
  await row('E2E Quelle 2').getByRole('button', { name: 'Bearbeiten' }).click();
  await edit.locator('input[name="url"]').fill('http://127.0.0.1/privat.m3u');
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#settingsTvSourcesStatus')).toHaveClass(/error/);
  expect((await sourceByName('E2E Quelle 2')).url).toBe('https://e2e-quelle.invalid/liste.m3u');
  // Ungültige URL: verständlicher deutscher Text statt rohem "TypeError: Invalid URL".
  await edit.locator('input[name="url"]').fill('keine url');
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#settingsTvSourcesStatus')).toContainText('Ungültige URL');
  await expect(page.locator('#settingsTvSourcesStatus')).not.toContainText('TypeError');
  // Abbrechen räumt den Fehlerstatus weg.
  await edit.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.locator('#settingsTvSourcesStatus')).toHaveText('');

  // EPG-Seite: URL pro Quelle ändern, Aktualisieren-Button + Status sichtbar
  await page.locator('#settingsTab-livetv-epg').click();
  await expect(page.locator('#settingsEpgRefreshBtn')).toBeVisible();
  await expect(page.locator('#settingsEpgStatus')).toBeVisible();
  const epgRow = page.locator('#settingsEpgSourceList .settings-epg-row', { hasText: 'E2E Quelle 2' });
  await epgRow.locator('input').fill('https://e2e-quelle.invalid/epg2.xml');
  await epgRow.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#settingsEpgStatus')).toContainText('EPG-URL gespeichert');
  expect((await sourceByName('E2E Quelle 2')).epgUrl).toBe('https://e2e-quelle.invalid/epg2.xml');

  // Entfernen mit Bestätigung: Abbrechen behält, Bestätigen entfernt.
  await page.locator('#settingsTab-livetv-sources').click();
  page.once('dialog', d => d.dismiss());
  await row('E2E Quelle 2').getByRole('button', { name: 'Entfernen' }).click();
  await expect(row('E2E Quelle 2')).toBeVisible();
  page.once('dialog', d => d.accept());
  await row('E2E Quelle 2').getByRole('button', { name: 'Entfernen' }).click();
  await expect(row('E2E Quelle 2')).toHaveCount(0);
  expect(await sourceByName('E2E Quelle 2')).toBeNull();
});

test('M3U-Ladefehler: verständliches Ergebnisobjekt statt geworfener IPC-Fehler, ohne URL', async () => {
  const result = await page.evaluate(() =>
    window.electronAPI
      .fetchAndParseM3U('https://m3u-unerreichbar.invalid/liste.m3u?token=abc123')
      .then(value => ({ resolved: true, value }))
      .catch(err => ({ resolved: false, message: String(err && err.message) })),
  );
  expect(result.resolved, `IPC darf nicht werfen: ${result.message}`).toBe(true);
  expect(result.value.channels).toBeUndefined();
  expect(result.value.error).toContain('Fehler beim Laden der M3U: ');
  expect(result.value.error).toMatch(/Host nicht gefunden|Verbindung|Zeitüberschreitung|Server nicht erreichbar/);
  expect(result.value.error).not.toContain('fetch failed');
  for (const secret of ['abc123', 'm3u-unerreichbar', 'liste.m3u']) {
    expect(result.value.error).not.toContain(secret);
  }
  // Validierungsfehler kommen ebenfalls als Ergebnisobjekt, ohne die Zugangsdaten zu nennen.
  const creds = await page.evaluate(() =>
    window.electronAPI.fetchAndParseM3U('https://nutzer:geheim@m3u-unerreichbar.invalid/x.m3u'),
  );
  expect(creds.error).toContain('Zugangsdaten');
  expect(creds.error).not.toContain('geheim');
  // Renderer/Dashboard bleiben intakt.
  await expect(page.locator('#dashboardView')).toBeAttached();
});

test('Keine uncaught Exceptions / unerwarteten Konsolen-Errors seit Start', async () => {
  expect(problems, `Unerwartete Fehler:\n${problems.join('\n')}`).toEqual([]);
});
