'use strict';

// E2E: YouTube-Mini-Player (ohne Netz, Fenster im Hintergrund, eigenes userData): zweite Webview unsichtbar bis zum Start,
// Leiste verborgen, Einstellungen (Schalter, Klick-Verhalten) mit Speichern, Playlist mit Validierung und Persistenz über Neustart,
// Radio/Podcast-Leiste unverändert zugänglich. Der Echtbetrieb auf YouTube braucht Netz und läuft nicht in dieser Suite.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backgroundEnv, resolveLaunchTarget, launchArgs } = require('./platform');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';

let tmpRoot;
let userData;
let electronApp;
let page;

async function start() {
  const target = resolveLaunchTarget();
  electronApp = await electron.launch({
    executablePath: target.executablePath,
    args: launchArgs(target),
    env: { ...process.env, HOME: path.join(tmpRoot, 'home'), STREAMING_HUB_USER_DATA: userData, ...backgroundEnv(), STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9' },
    timeout: 45_000,
  });
  const actual = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  if (fs.realpathSync(actual) !== userData) {
    await electronApp.close().catch(() => {});
    throw new Error(`userData nicht isoliert: ${actual}`);
  }
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
}

async function stop() {
  if (!electronApp) return;
  const proc = electronApp.process();
  await Promise.race([electronApp.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  electronApp = null;
}

test.beforeAll(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-ytmini-')));
  userData = path.join(tmpRoot, 'userData');
  fs.mkdirSync(userData);
  fs.mkdirSync(path.join(tmpRoot, 'home'));
});

test.afterAll(async () => {
  await stop();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Start: Player-Webview ist unsichtbar und nicht klickbar, die Leiste verborgen, nichts läuft', async () => {
  await start();
  const state = await page.evaluate(() => {
    const view = document.getElementById('ytPlayerView');
    const style = getComputedStyle(view);
    return { cls: view.className, opacity: style.opacity, pointer: style.pointerEvents, bar: document.getElementById('radioMiniPlayer').hidden };
  });
  expect(state.cls).toContain('yt-place-hidden');
  expect(state.opacity).toBe('0');
  expect(state.pointer).toBe('none');
  expect(state.bar).toBe(true);
  // Standard: Mini-Player an, ersetzen
  expect(await page.evaluate(() => window.electronAPI.getYoutubeMiniSettings())).toEqual({ enabled: true, clickBehavior: 'replace' });
});

test('Einstellungen: Schalter und Klick-Verhalten (Streaming → YouTube), Speichern, Sperre der Auswahl bei „aus“', async () => {
  await page.locator('.dashboard-section-tile[data-section="settings"]').click();
  await page.locator('#settingsTab-streaming').click();
  const toggle = page.locator('#settingsYoutubeMini');
  const click = page.locator('#settingsYoutubeClick');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(click).toHaveValue('replace');
  await expect(click.locator('option')).toHaveText(['Laufendes Video ersetzen', 'Zur Playlist hinzufügen']);
  await click.selectOption('playlist');
  await expect(page.locator('#settingsYoutubeMiniStatus')).toHaveText('Gespeichert.');
  expect((await page.evaluate(() => window.electronAPI.getYoutubeMiniSettings())).clickBehavior).toBe('playlist');
  await toggle.uncheck();
  await expect(click).toBeDisabled();
  expect(await page.evaluate(() => window.electronAPI.getYoutubeMiniSettings())).toEqual({ enabled: false, clickBehavior: 'playlist' });
  await toggle.check();
  await expect(click).toBeEnabled();
  // Ungültige Werte lehnt der Main ab
  for (const patch of [{ enabled: 'ja' }, { clickBehavior: 'x' }, { extra: 1 }, {}]) {
    const error = await page.evaluate(p => window.electronAPI.setYoutubeMiniSettings(p).then(() => '', e => e.message), patch);
    expect(error).toContain('Ungültige Mini-Player-Einstellungen');
  }
});

test('Playlist: wird validiert gespeichert; ungültige Einträge werden abgelehnt', async () => {
  const saved = await page.evaluate(([a, b]) => window.electronAPI.setYoutubePlaylist([{ id: a, title: 'Eins\n' }, { id: b, title: 'Zwei' }, { id: a, title: 'doppelt' }]), [A, B]);
  expect(saved).toEqual([{ id: A, title: 'Eins' }, { id: B, title: 'Zwei' }]);
  for (const bad of [[{ id: 'kaputt' }], 'x', [{ id: A, title: 5 }]]) {
    const error = await page.evaluate(list => window.electronAPI.setYoutubePlaylist(list).then(() => '', e => e.message), bad);
    expect(error).toContain('Ungültige Playlist');
  }
  expect(await page.evaluate(() => window.electronAPI.getYoutubePlaylist())).toEqual(saved);
});

test('Neustart: Einstellungen und Playlist bleiben; wartende Einträge zeigen die Leiste mit Abspielen und Playlist-Knopf', async () => {
  await stop();
  await start();
  expect(await page.evaluate(() => window.electronAPI.getYoutubeMiniSettings())).toEqual({ enabled: true, clickBehavior: 'playlist' });
  expect(await page.evaluate(() => window.electronAPI.getYoutubePlaylist())).toEqual([{ id: A, title: 'Eins' }, { id: B, title: 'Zwei' }]);
  const bar = page.locator('#radioMiniPlayer');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-mode', 'video');
  await expect(page.locator('#radioMiniPlayPause')).toHaveAttribute('title', 'Abspielen');
  await expect(page.locator('#youtubeMiniList')).toHaveAttribute('title', 'Playlist anzeigen');
  await expect(page.locator('#youtubeMiniBack')).toBeHidden();
  await page.locator('#youtubeMiniList').click();
  await expect(page.locator('#youtubeMiniList')).toHaveAttribute('title', 'Playlist ausblenden');
  const rows = page.locator('.radio-mini-playlist-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.radio-mini-playlist-title')).toHaveText('Eins');
  // Entfernen und ▲▼ wirken und werden gespeichert
  await rows.nth(1).locator('[data-action="up"]').click();
  await expect(rows.nth(0).locator('.radio-mini-playlist-title')).toHaveText('Zwei');
  await rows.nth(0).locator('.radio-mini-playlist-remove').click();
  await expect(rows).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.electronAPI.getYoutubePlaylist())).toEqual([{ id: A, title: 'Eins' }]);
  // alle Knöpfe der Leiste haben einen Tooltip
  const missing = await page.evaluate(() => [...document.querySelectorAll('#radioMiniPlayer button')].filter(b => !b.title).map(b => b.id || b.className));
  expect(missing).toEqual([]);
});
