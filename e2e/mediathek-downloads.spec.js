'use strict';

// E2E: Mediathek-Downloads — Bereich Downloads (Warteschlange/Bibliothek), Optionen-Dialog, Serien-Auswahl, Offline-Wiedergabe über dl://,
// Löschen mit Rückfrage, Navbar-Indikator und Einstellungen. Kein Netz und kein echter Download: die Liste wird aus einer vorbereiteten
// downloads.json geladen (Zustände paused/scheduled/failed/done mit einer kleinen echten MP4), der Fortschritt kommt als Ereignis
// downloads:changed aus dem Main, die Quellen-Antworten aus festen Fixtures (STREAMING_HUB_E2E_MEDIATHEK_ROUTES).
// Screenshots (optional): MEDIATHEK_E2E_SHOTS=<Verzeichnis> (je Hell/Dunkel).
const { test, expect } = require('@playwright/test');
const { shotBoth } = require('./theme-audit');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');
const { fixture } = require('../tests/fixtures/mediathek/index.js');
const parser = require('../lib/mediathek/parser.js');

const SHOTS = process.env.MEDIATHEK_E2E_SHOTS || '';
const shot = async (page, name) => {
  if (!SHOTS) return;
  await shotBoth(page, SHOTS, name);
};

const NO_STREAM = 'https://127.0.0.1:9/e2e.mp4'; // Verbindung wird sofort abgelehnt: kein Netzzugriff
const episodes = parser.parseArdGrouping(fixture('ardGroupingMurdoch'));
const series = parser.parseSections(fixture('ardHomeSections'), 'ard').flatMap(section => section.series).find(item => /House of Yang/.test(item.title));
const FFMPEG = path.resolve(__dirname, '..', 'bin', 'ffmpeg');

function buildRoutes() {
  const noNet = body => body.replace(/https:\/\/[^"]*\.(mp4|m3u8)[^"]*/g, NO_STREAM);
  return {
    'pages/ard/home': fixture('ardHomeSections'),
    'pages/HOME/': fixture('arteHomeGenres'),
    '/grouping/': fixture('ardGroupingMurdoch').replaceAll('S10/E01', 'S9/E01'),
    [`/item/${episodes[0].id}`]: noNet(fixture('ardItem')),
    [`/item/${episodes[1].id}`]: fixture('ardItemInstitutFskBlocked'),
    [`/item/${episodes[2].id}`]: noNet(fixture('ardItemGeoBlocked')),
  };
}

let ctx;
let page;
let tmp;
let dlRoot;
let doneFile;
let hasVideo = false;

const record = (id, seq, over) => ({
  id,
  seq,
  entry: { id: `E-${id}`, title: `Folge ${seq}`, sourceId: 'ard', imageUrl: null, duration: 1800, airedAt: '2026-10-01T19:00:00Z', availableUntil: '2027-03-01T00:00:00Z' },
  series: { id: series.id, title: series.title, sourceId: 'ard', groupingURL: series.groupingURL, imageUrl: null, description: null },
  options: {},
  status: 'queued',
  title: `Folge ${seq}`,
  seriesTitle: 'House of Yang',
  season: 10,
  episode: seq,
  durationSec: 1800,
  availableUntil: '2027-03-01T00:00:00Z',
  createdAt: `2026-10-20T10:0${seq}:00.000Z`,
  progress: {},
  ...over,
});

function seedUserData({ userData, tmpRoot }) {
  dlRoot = path.join(tmpRoot, 'downloads');
  const dir = path.join(dlRoot, 'ARD', 'House of Yang');
  fs.mkdirSync(dir, { recursive: true });
  doneFile = path.join(dir, 'S10E08 - Das Geschenk des Lebens.mp4');
  try {
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', doneFile]);
    hasVideo = true;
  } catch {
    fs.writeFileSync(doneFile, 'kein Video');
  }
  const items = [
    record('dl_done_0001', 1, {
      status: 'done',
      entry: { id: episodes[2].id, title: episodes[2].title, sourceId: 'ard', imageUrl: null, duration: 2656, airedAt: '2026-09-23T19:00:00Z', availableUntil: '2027-03-01T00:00:00Z' },
      title: 'Mitten im Feuer - Teil 1',
      episode: 1,
      root: dlRoot,
      file: doneFile,
      fileSize: fs.statSync(doneFile).size,
      finishedAt: '2026-10-20T11:00:00.000Z',
      options: { container: 'mp4' },
    }),
    record('dl_paused_001', 2, { status: 'paused', title: 'Pausierte Folge', progress: { percent: 30 }, root: dlRoot }),
    record('dl_sched_0001', 3, { status: 'scheduled', title: 'Zurückgestellte Folge', retryAt: '2027-01-01T20:00:00.000Z', error: 'Die Folge ist erst ab 22 Uhr freigegeben.', root: dlRoot }),
    record('dl_failed_001', 4, { status: 'failed', title: 'Fehlgeschlagene Folge', error: 'Die Quelle ist nicht erreichbar.', root: dlRoot }),
  ];
  fs.writeFileSync(path.join(userData, 'downloads.json'), JSON.stringify({ version: 1, items }));
  fs.writeFileSync(path.join(userData, 'download-settings.json'), JSON.stringify({ storageRoot: dlRoot }));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediathek-dl-routes-'));
  const routes = path.join(tmp, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify(buildRoutes()));
  const base = Date.now();
  ctx = await launchApp({
    prefix: 'mediathek-dl-e2e-',
    epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
    channels: [{ id: 'E2E.de', name: 'E2E Kanal' }],
    favorites: [],
    env: { STREAMING_HUB_E2E_MEDIATHEK_ROUTES: routes },
    seed: seedUserData,
  });
  page = ctx.page;
  await page.setViewportSize({ width: 1280, height: 860 });
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const chip = label => page.locator('#mediathekPanel-home .mediathek-chip', { hasText: label });
const items = () => page.locator('#mediathekDownloads .mediathek-dl-item');
const sendChange = payload => ctx.electronApp.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send('downloads:changed', data), payload);

test('Downloads-Chip: Warteschlange mit Zuständen, Meldungen und Summenzeile', async () => {
  await page.locator('.dashboard-section-tile[data-section="mediathek"]').click();
  await expect(page.locator('#mediathekDashboard')).toBeVisible();
  await expect(chip('Downloads')).toBeVisible();
  await chip('Downloads').click();
  await expect(chip('Downloads')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mediathekDownloads .mediathek-seg.is-on')).toHaveText('Warteschlange (3)');
  await expect(items()).toHaveCount(3);
  const paused = items().filter({ hasText: 'Pausierte Folge' });
  await expect(paused.locator('.mediathek-dl-bar')).toHaveAttribute('aria-valuenow', '30');
  await expect(paused.locator('[data-action="resume"]')).toHaveAccessibleName('Fortsetzen: Pausierte Folge');
  await expect(paused.locator('[data-action="cancel"]')).toBeVisible();
  const scheduled = items().filter({ hasText: 'Zurückgestellte Folge' });
  await expect(scheduled.locator('.mediathek-dl-msg')).toContainText('Start automatisch ab 01.01.2027, 21:00 Uhr');
  const failed = items().filter({ hasText: 'Fehlgeschlagene Folge' });
  await expect(failed.locator('.mediathek-dl-msg')).toHaveText('Die Quelle ist nicht erreichbar.');
  await expect(failed.locator('.mediathek-dl-msg')).toHaveAttribute('role', 'alert');
  await expect(failed.locator('[data-action="retry"]')).toBeVisible();
  await expect(page.locator('#mediathekDownloads .mediathek-dl-summary')).toContainText('1 fertig');
  await expect(page.locator('#mediathekDownloads .mediathek-dl-summary')).toContainText('Frei:');
  await shot(page, 'dl-queue');
});

test('Fortschritt aus dem Main: Balken, Tempo, Restzeit; Navbar-Indikator mit aria-label', async () => {
  const mediathekNav = page.locator('#overlayNav .nav-section-item[data-section="mediathek"]');
  await expect(mediathekNav).not.toHaveAttribute('aria-label', /Download/);
  const running = {
    id: 'dl_run_00001', key: 'ard:RUN', sourceId: 'ard', entryId: 'RUN', title: 'Laufende Folge', seriesTitle: 'House of Yang', seriesId: null, season: 10, episode: 5, imageUrl: null,
    status: 'downloading', error: null, errorCode: null, progress: { percent: 42, bytes: 420e6, totalBytes: 1e9, speed: 3.2e6, etaSec: 240 }, estimatedBytes: 1e9, fileSize: null,
    durationSec: 1800, availableUntil: null, sourceExpired: false, retryAt: null, container: 'mp4', createdAt: '2026-10-20T09:00:00.000Z', finishedAt: null, watchedAt: null, fileMissing: false, warnings: [],
  };
  await sendChange({ items: [running], removed: [], summary: { active: 1, paused: 1, scheduled: 1, failed: 1, done: 1 } });
  const row = items().filter({ hasText: 'Laufende Folge' });
  await expect(row).toBeVisible();
  await expect(row.locator('.mediathek-dl-bar')).toHaveAttribute('aria-valuenow', '42');
  await expect(row.locator('.mediathek-dl-state')).toContainText('3,2 MB/s');
  await expect(row.locator('.mediathek-dl-state')).toContainText('noch 4 Min.');
  await expect(items().first()).toContainText('Laufende Folge'); // laufende zuerst
  await expect(mediathekNav).toHaveAttribute('aria-label', 'Mediatheken, Ein Download läuft');
  await expect(mediathekNav.locator('.nav-dl-ring')).not.toHaveAttribute('hidden', '');
  await expect(chip('Downloads (1)')).toBeVisible();
  await shot(page, 'dl-queue-running');
  await sendChange({ items: [], removed: ['dl_run_00001'], summary: { paused: 1, scheduled: 1, failed: 1, done: 1 } });
  await expect(row).toHaveCount(0);
  await expect(mediathekNav).not.toHaveAttribute('aria-label', /Download/);
  await expect(mediathekNav.locator('.nav-dl-ring')).toHaveAttribute('hidden', '');
});

test('Bibliothek: Größe, Datum, „Quelle läuft ab am“; Abspielen über dl:// mit Verlaufseintrag', async () => {
  await page.locator('#mediathekDownloads .mediathek-seg', { hasText: 'Bibliothek' }).click();
  await expect(items()).toHaveCount(1);
  const row = items().first();
  await expect(row).toContainText('Mitten im Feuer - Teil 1');
  await expect(row.locator('.mediathek-dl-state')).toContainText('geladen am 20.10.2026');
  await expect(row.locator('.mediathek-dl-state')).toContainText('Quelle läuft ab am 01.03.2027');
  await expect(row.locator('[data-action="play"]')).toBeVisible();
  await expect(row.locator('[data-action="reveal"]')).toBeVisible();
  await expect(row.locator('[data-action="remove"]')).toBeVisible();
  await shot(page, 'dl-library');
  await row.locator('[data-action="play"]').click();
  const player = page.locator('.mediathek-player');
  await expect(player).toBeVisible();
  const video = player.locator('video');
  await expect(video).toHaveAttribute('src', /^dl:\/\/local\/dl_done_0001\.mp4$/);
  if (hasVideo) {
    await expect.poll(() => video.evaluate(node => (node.error ? `Fehler ${node.error.code}` : node.readyState >= 2 && node.duration > 3 ? 'ok' : 'lädt')), { timeout: 20000 }).toBe('ok');
    // Spulen setzt Range-Anfragen voraus
    await video.evaluate(node => {
      node.currentTime = 2;
    });
    await expect.poll(() => video.evaluate(node => Math.round(node.currentTime))).toBeGreaterThanOrEqual(2);
  }
  await page.keyboard.press('Escape');
  await expect(player).toHaveCount(0);
  const history = await page.evaluate(() => window.electronAPI.getHistory());
  expect(history.some(entry => entry.serviceKey === 'mediathek:ard' && entry.title === episodes[2].title)).toBe(true);
});

test('Serie: Symbol je Folge mit Zustand, Anzahl geladener Folgen, Laden-Menü', async () => {
  await chip('Alle').click();
  await page.locator('#mediathekDashboard .mediathek-series-card', { hasText: 'House of Yang' }).first().locator('.mediathek-card-main').click();
  const rows = page.locator('#mediathekDashboard .mediathek-episode');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#mediathekDashboard .mediathek-dl-count')).toHaveText('1 Folge geladen');
  const doneBtn = rows.filter({ hasText: 'Folge 1' }).locator('[data-action="download"]');
  await expect(doneBtn).toHaveAttribute('data-dl-state', 'done');
  await expect(doneBtn).toHaveAccessibleName(/Heruntergeladen/);
  const freshBtn = rows.filter({ hasText: 'Folge 8' }).locator('[data-action="download"]');
  await expect(freshBtn).toHaveAttribute('data-dl-state', 'none');
  await expect(freshBtn).toHaveAccessibleName(/Herunterladen: Folge 8/);
  const toggle = page.locator('#mediathekSeriesLoad');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#mediathekDashboard .mediathek-menu-item')).toHaveText(['Alle Folgen', 'Staffel 9', 'Staffel 10', 'Auswahl …', 'Nur neue']);
  await expect(page.locator('#mediathekDashboard .mediathek-menu-item').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});

test('Optionen-Dialog: Vorbelegung 1080p, Vorschau, Duplikat-Hinweis, Esc gibt den Fokus zurück', async () => {
  const rows = page.locator('#mediathekDashboard .mediathek-episode');
  const btn = rows.filter({ hasText: 'Folge 8' }).locator('[data-action="download"]');
  await btn.click();
  const dialog = page.locator('.mediathek-dialog-options');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog.locator('.mediathek-dialog-title')).toHaveText('Download-Optionen');
  await expect(page.locator('#mediathekDlOptHeight')).toHaveValue('1080');
  await expect(page.locator('#mediathekDlOptContainer')).toHaveValue('mp4');
  await expect(page.locator('#mediathekDlPreview')).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  await expect(page.locator('#mediathekDlPreview')).toContainText('Geschätzte Größe');
  await expect(page.locator('#mediathekDlPreview')).toContainText('Freier Platz');
  await expect(page.locator('#mediathekDlOptionsGo')).toBeEnabled();
  await shot(page, 'dl-options');
  await page.locator('#mediathekDlOptHeight').selectOption('720');
  await expect(page.locator('#mediathekDlPreview')).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(btn).toBeFocused();
});

test('Serien-Auswahl: geladene ausgegraut, Summe und freier Platz, „n Folgen laden“ reiht ein', async () => {
  await page.locator('#mediathekSeriesLoad').click();
  await page.locator('#mediathekDashboard .mediathek-menu-item', { hasText: 'Auswahl' }).click();
  const dialog = page.locator('.mediathek-dialog-select');
  await expect(dialog).toBeVisible();
  const rows = dialog.locator('.mediathek-select-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'Folge 1' }).locator('input')).toBeDisabled();
  await expect(rows.filter({ hasText: 'Folge 1' })).toContainText('Bereits geladen');
  await expect(rows.filter({ hasText: 'Folge 8' }).locator('input')).toBeChecked();
  await expect(rows.filter({ hasText: 'Folge 7' }).locator('input')).toBeChecked();
  await expect(page.locator('#mediathekDlSelTotals')).toContainText('2 Folgen');
  await expect(page.locator('#mediathekDlSelTotals')).toContainText('Frei:');
  await expect(page.locator('#mediathekDlSelGo')).toHaveText('2 Folgen laden');
  await shot(page, 'dl-select');
  await rows.filter({ hasText: 'Folge 7' }).locator('input').uncheck();
  await expect(page.locator('#mediathekDlSelGo')).toHaveText('1 Folge laden');
  await page.locator('#mediathekDlSelNone').click();
  await expect(page.locator('#mediathekDlSelGo')).toBeDisabled();
  await page.locator('#mediathekDlSelAll').click();
  await rows.filter({ hasText: 'Folge 7' }).locator('input').uncheck();
  await page.locator('#mediathekDlSelGo').click();
  await expect(dialog).toHaveCount(0);
  const btn = page.locator('#mediathekDashboard .mediathek-episode', { hasText: 'Folge 8' }).locator('[data-action="download"]');
  await expect(btn).not.toHaveAttribute('data-dl-state', 'none'); // eingereiht (Warteschlange, läuft oder – ohne Netz – fehlgeschlagen)
  await expect(page.locator('#mediathekDashboard .mediathek-dl-count')).toHaveText('1 Folge geladen');
});

test('Ein-Klick-Download: mit „Dialog überspringen“ kein Dialog; Zurückstellung bei Altersfreigabe', async () => {
  await page.evaluate(() => window.downloads.setSettings({ skipOptionsDialog: true }));
  await page.locator('#mediathekSeriesBack').click();
  await page.locator('#mediathekDashboard .mediathek-series-card', { hasText: 'House of Yang' }).first().locator('.mediathek-card-main').click();
  const btn = page.locator('#mediathekDashboard .mediathek-episode', { hasText: 'Folge 7' }).locator('[data-action="download"]');
  await expect(btn).toHaveAttribute('data-dl-state', 'none');
  await btn.click();
  await expect(page.locator('.mediathek-dialog-options')).toHaveCount(0);
  await expect(btn).not.toHaveAttribute('data-dl-state', 'none', { timeout: 15000 });
  await page.evaluate(() => window.downloads.setSettings({ skipOptionsDialog: false }));
});

test('Detail-Fenster: Herunterladen-Knopf; Folge in der Warteschlange ist deaktiviert', async () => {
  const row = page.locator('#mediathekDashboard .mediathek-episode', { hasText: 'Folge 1' });
  await row.locator('.mediathek-info-btn').click();
  const dl = page.locator('#mediathekDetailDownload');
  await expect(dl).toBeVisible();
  await expect(dl).toContainText('Heruntergeladen');
  await expect(dl).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.locator('#mediathekSeriesBack').click();
});

test('Löschen mit Rückfrage: Abbrechen behält, „Datei auch löschen“ entfernt die Datei', async () => {
  await chip('Downloads').click();
  await page.locator('#mediathekDownloads .mediathek-seg', { hasText: 'Bibliothek' }).click();
  const row = items().first();
  await row.locator('[data-action="remove"]').click();
  const dialog = page.locator('.mediathek-dialog-small');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.mediathek-dialog-title')).toHaveText('Download löschen?');
  await expect(page.locator('#mediathekDlConfirmFile')).toBeChecked();
  await expect(page.locator('#mediathekDlConfirmCancel')).toBeFocused();
  await shot(page, 'dl-confirm');
  await page.locator('#mediathekDlConfirmCancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(items()).toHaveCount(1);
  expect(fs.existsSync(doneFile)).toBe(true);
  await row.locator('[data-action="remove"]').click();
  await page.locator('#mediathekDlConfirmOk').click();
  await expect(items()).toHaveCount(0);
  await expect(page.locator('#mediathekDownloads .mediathek-empty')).toContainText('Noch keine fertigen Downloads');
  await expect.poll(() => fs.existsSync(doneFile)).toBe(false);
});

test('Einstellungen: Seiten, Begrenzung, Speicherort prüfen, Hinweise, „Download-Funktion anzeigen“', async () => {
  await page.locator('#overlayNav [data-section="settings"]').click();
  const group = page.locator('#settingsNav .settings-nav-group', { hasText: 'Mediatheken' });
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  for (const label of ['Downloads: Ablage', 'Downloads: Qualität', 'Downloads: Ton & Untertitel', 'Downloads: Steuerung', 'Downloads: Hinweise']) {
    await expect(page.locator('#settingsNav .settings-nav-item', { hasText: label })).toBeVisible();
  }
  // Ablage
  await page.locator('#settingsTab-mediathek-dl-storage').click();
  await expect(page.locator('#settingsDl-storageRoot')).toHaveValue(dlRoot);
  const blocker = path.join(tmp, 'datei.txt');
  fs.writeFileSync(blocker, 'x');
  await page.locator('#settingsDl-storageRoot').fill(path.join(blocker, 'unterordner')); // unter einer Datei: nicht nutzbar
  await page.locator('#settingsDlApplyRoot').click();
  await expect(page.locator('#settingsDl-storageRoot-note')).toHaveClass(/error/);
  const newRoot = path.join(tmp, 'neuer-ordner');
  fs.mkdirSync(newRoot);
  await page.locator('#settingsDl-storageRoot').fill(newRoot);
  await page.locator('#settingsDlApplyRoot').click();
  await expect(page.locator('#settingsDl-storageRoot-note')).toHaveText('Speicherort geändert.');
  await expect.poll(() => page.evaluate(async () => (await window.downloads.getSettings()).storageRoot)).toBe(path.resolve(newRoot));
  await page.locator('#settingsDl-fileNameScheme').fill('{series} - {title}');
  await page.locator('#settingsDl-fileNameScheme').blur();
  await expect(page.locator('#settingsMediathekDl-storage-status')).toContainText('Gespeichert');
  await page.locator('#settingsDl-fileNameScheme').fill('{kaputt}');
  await page.locator('#settingsDl-fileNameScheme').blur();
  await expect(page.locator('#settingsDl-fileNameScheme-note')).toContainText('Ungültiges Schema');
  await page.locator('#settingsDl-fileNameScheme').fill('S{season2}E{episode2} - {title}');
  await page.locator('#settingsDl-fileNameScheme').blur();
  await page.locator('#settingsDl-writeNfoCover').check();
  await expect(page.locator('#settingsMediathekDl-storage-status')).toContainText('Gespeichert');
  await page.locator('#settingsDlResetRoot').click();
  await expect(page.locator('#settingsDl-storageRoot-note')).toHaveText('Standard-Speicherort wird verwendet.');
  await shot(page, 'settings-dl-storage');
  // Qualität, Ton & Untertitel
  await page.locator('#settingsTab-mediathek-dl-quality').click();
  await page.locator('#settingsDl-maxHeight').selectOption('720');
  await page.locator('#settingsDl-container').selectOption('mkv');
  await expect(page.locator('#settingsMediathekDl-quality-status')).toContainText('Gespeichert');
  await page.locator('#settingsTab-mediathek-dl-audio').click();
  await page.locator('#settingsDl-audioMode').selectOption('all');
  await page.locator('#settingsDl-audioLanguages-1').selectOption('eng');
  await page.locator('#settingsDl-subtitleDelivery').selectOption('external');
  await expect.poll(() => page.evaluate(async () => (await window.downloads.getSettings()))).toMatchObject({ maxHeight: '720', container: 'mkv', audioMode: 'all', audioLanguages: ['deu', 'eng'], subtitleDelivery: 'external', writeNfoCover: true });
  await shot(page, 'settings-dl-audio');
  // Steuerung: Begrenzung wird sichtbar
  await page.locator('#settingsTab-mediathek-dl-control').click();
  await page.locator('#settingsDl-maxParallel').fill('9');
  await page.locator('#settingsDl-maxParallel').blur();
  await expect(page.locator('#settingsDl-maxParallel-note')).toHaveText('Auf 5 begrenzt (erlaubt: 1 bis 5).');
  await expect(page.locator('#settingsDl-maxParallel')).toHaveValue('5');
  await page.locator('#settingsDl-maxParallel').fill('abc');
  await page.locator('#settingsDl-maxParallel').blur();
  await expect(page.locator('#settingsDl-maxParallel-note')).toHaveText('Bitte eine Zahl eingeben.');
  await expect(page.locator('#settingsDl-maxParallel')).toHaveValue('5');
  await page.locator('#settingsDl-bandwidthKBps').fill('2000');
  await page.locator('#settingsDl-bandwidthKBps').blur();
  await page.locator('#settingsDl-cleanupWatchedDays').fill('99999');
  await page.locator('#settingsDl-cleanupWatchedDays').blur();
  await expect(page.locator('#settingsDl-cleanupWatchedDays-note')).toContainText('3650');
  await page.locator('#settingsDl-cleanupWatchedDays').fill('0');
  await page.locator('#settingsDl-cleanupWatchedDays').blur();
  await expect.poll(() => page.evaluate(async () => (await window.downloads.getSettings()))).toMatchObject({ maxParallel: 5, bandwidthKBps: 2000, cleanupWatchedDays: 0 });
  await shot(page, 'settings-dl-control');
  // Hinweise: Nutzungshinweis, Funktion ausblenden
  await page.locator('#settingsTab-mediathek-dl-notes').click();
  await expect(page.locator('.settings-notice')).toContainText('privaten Gebrauch');
  await shot(page, 'settings-dl-notes');
  await page.locator('#settingsDl-showDownloads').uncheck();
  await expect(page.locator('#settingsMediathekDl-notes-status')).toContainText('Gespeichert');
  await page.locator('.dashboard-section-tile[data-section="mediathek"], #overlayNav [data-section="mediathek"]').first().click();
  await expect(page.locator('#mediathekDashboard')).toBeVisible();
  await expect(chip('Downloads')).toHaveCount(0);
  await page.locator('#mediathekDashboard .mediathek-series-card').first().locator('.mediathek-card-main').click();
  await expect(page.locator('#mediathekDashboard .mediathek-episode')).not.toHaveCount(0);
  await expect(page.locator('#mediathekDashboard [data-action="download"]')).toHaveCount(0);
  await expect(page.locator('#mediathekSeriesLoad')).toHaveCount(0);
  await page.locator('#mediathekSeriesBack').click();
  await page.evaluate(() => window.downloads.setSettings({ showDownloads: true }));
});

test('Navigationsleiste folgt dem Systemdesign auf jeder Seite (Mediathek, LiveTV, Einstellungen)', async () => {
  const barBg = () => page.locator('#overlayNav').evaluate(node => getComputedStyle(node.closest('.overlay-bar') || node).backgroundColor);
  const dark = 'rgb(23, 23, 23)';
  const white = 'rgb(255, 255, 255)';
  for (const [scheme, section, expected] of [
    ['dark', 'mediathek', dark], ['light', 'mediathek', white],
    ['dark', 'livetv', dark], ['light', 'livetv', white], ['light', 'settings', white], ['dark', 'settings', dark],
  ]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(`#overlayNav [data-section="${section}"]`).click();
    await expect.poll(barBg, { message: `${section}/${scheme}` }).toBe(expected);
  }
  // Unterstrich des aktiven Eintrags bleibt auf den Eintrag begrenzt (nicht über die ganze Leiste)
  const widths = await page.locator('#overlayNav .nav-settings-item.active').evaluate(node => ({ after: parseFloat(getComputedStyle(node, '::after').width), item: node.getBoundingClientRect().width }));
  expect(widths.after).toBeLessThan(widths.item);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#overlayNav [data-section="mediathek"]').click();
});
