'use strict';

// E2E: Beenden-Dialog bei anstehender Planung (Etappe 2b; Konzept §3.5/§5, E2).
// Kein Netz: lokale M3U + lokale XMLTV-Fixture (Muster e2e/schedule.spec.js). Der native
// Dialog ist per Test-Hook ersetzt (STREAMING_HUB_TEST_QUIT_DIALOG=mock, gilt nur zusammen
// mit STREAMING_HUB_USER_DATA): die Attrappe zeichnet die Dialog-Optionen auf und liefert
// die in globalThis.__streamingHubTest gesetzte Antwort (0 = „Im Hintergrund behalten“,
// 1 = „Trotzdem beenden“).
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLaunchTarget, launchArgs } = require('./platform');

const MIN = 60 * 1000;
const MESSAGE = /^Es ist eine Aufnahme geplant: E2E Kanal — Kommende Sendung, (heute|morgen) \d{2}:\d{2}\. Streaming Hub muss dafür laufen\.$/;

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

let tmpRoot;
const apps = [];

async function launch(name) {
  const dir = path.join(tmpRoot, name);
  const userData = path.join(dir, 'userData');
  const home = path.join(dir, 'home');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const base = Math.floor(Date.now() / MIN) * MIN;
  const slot = { start: base + 45 * MIN, stop: base + 90 * MIN };
  const fixture = path.join(dir, 'epg.xml');
  fs.writeFileSync(
    fixture,
    `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>` +
      `<programme start="${xmltvTime(slot.start)}" stop="${xmltvTime(slot.stop)}" channel="E2E.de"><title>Kommende Sendung</title><desc>Beschreibung</desc></programme></tv>`,
  );
  const m3u = path.join(dir, 'e2e.m3u');
  fs.writeFileSync(m3u, '#EXTM3U\n#EXTINF:-1 tvg-id="E2E.de" group-title="Test",E2E Kanal\nhttp://streams.invalid/e2e.m3u8\n');
  fs.writeFileSync(
    path.join(userData, 'tvsources.json'),
    JSON.stringify([
      { id: 'e2e', name: 'E2E Quelle', url: m3u, type: 'file', color: '#a78bfa', epgUrl: 'https://e2e-epg.example/epg.xml', sortOrder: [], favorites: ['E2E.de'] },
    ]),
  );
  const target = resolveLaunchTarget();
  const electronApp = await electron.launch({
    executablePath: target.executablePath,
    args: launchArgs(target),
    env: {
      ...process.env,
      HOME: home,
      STREAMING_HUB_USER_DATA: userData,
      STREAMING_HUB_EPG_FIXTURE: fixture,
      STREAMING_HUB_TEST_QUIT_DIALOG: 'mock',
      STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9',
    },
    timeout: 45_000,
  });
  apps.push({ app: electronApp, proc: electronApp.process() });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
  return { electronApp, page, slot };
}

const exited = electronApp => {
  const proc = electronApp.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return Promise.race([new Promise(resolve => proc.once('exit', () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 15_000))]);
};

const dialogCalls = electronApp => electronApp.evaluate(() => globalThis.__streamingHubTest.quitDialogCalls);
const setAnswer = (electronApp, response) => electronApp.evaluate((_e, r) => { globalThis.__streamingHubTest.quitDialogResponse = r; }, response);
const windowCount = electronApp => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test.beforeAll(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-quit-')));
});

test.afterAll(async () => {
  for (const { app, proc } of apps) {
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('mit Planung < 24 h: Fenster-X und Quit fragen; „behalten“ lässt die App im Tray, „Trotzdem beenden“ beendet', async () => {
  const { electronApp, page, slot } = await launch('with-plan');
  await expect
    .poll(async () => (await page.evaluate(() => window.electronAPI.getEpgStatus())).sources.reduce((n, s) => n + s.channelCount, 0), { timeout: 20_000 })
    .toBe(1);
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const added = await page.evaluate(
    r => window.electronAPI.addSchedule(r),
    { channelId: 'E2E.de', channelName: 'E2E Kanal', tvgId: 'E2E.de', sourceId: 'e2e', title: 'Kommende Sendung', epgStart: iso(slot.start), epgStop: iso(slot.stop) },
  );
  expect(added.ok).toBe(true);

  // Fenster-X + „Im Hintergrund behalten“: Dialog, Fenster zu, App läuft weiter
  await setAnswer(electronApp, 0);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => dialogCalls(electronApp).then(c => c.length)).toBe(1);
  const first = (await dialogCalls(electronApp))[0];
  expect(first.message).toMatch(MESSAGE);
  expect(first.buttons).toEqual(['Im Hintergrund behalten', 'Trotzdem beenden']);
  await expect.poll(() => windowCount(electronApp)).toBe(0);
  expect(await electronApp.evaluate(() => true)).toBe(true); // Main-Prozess lebt (Tray-Betrieb)

  // Dock-/Tray-„App öffnen“ bringt das Fenster zurück; IPC funktioniert am neuen Fenster
  const reopened = electronApp.waitForEvent('window');
  await electronApp.evaluate(({ app }) => app.emit('activate'));
  const page2 = await reopened;
  await page2.waitForLoadState('domcontentloaded');
  await page2.locator('#dashboardView').waitFor();
  const list = await page2.evaluate(() => window.electronAPI.listSchedules());
  expect(list).toHaveLength(1);
  expect(await page2.evaluate(() => window.electronAPI.getRecordingSettings().then(() => 'ok', e => e.message))).toBe('ok');

  // Quit (Cmd+Q/Tray): fragt ebenfalls; „behalten“ bricht ab und schließt das Fenster
  await electronApp.evaluate(({ app }) => app.quit());
  await expect.poll(() => dialogCalls(electronApp).then(c => c.length)).toBe(2);
  await expect.poll(() => windowCount(electronApp)).toBe(0);
  expect(await electronApp.evaluate(() => true)).toBe(true);

  // Fenster-X + „Trotzdem beenden“: App beendet sich (normales Cleanup), ohne zweiten Dialog
  const reopened2 = electronApp.waitForEvent('window');
  await electronApp.evaluate(({ app }) => app.emit('activate'));
  await reopened2;
  await setAnswer(electronApp, 1);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(await exited(electronApp)).toBe(true);
});

test('ohne Planung: Beenden ist still (kein Dialog)', async () => {
  const { electronApp } = await launch('no-plan');
  await setAnswer(electronApp, 0);
  // before-quit läuft synchron in app.quit(): die Zahl der Dialoge direkt danach auslesen
  const calls = await electronApp
    .evaluate(({ app }) => {
      app.quit();
      return globalThis.__streamingHubTest.quitDialogCalls.length;
    })
    .catch(() => 0); // Prozess kann vor der Antwort enden — dann gab es ebenfalls keinen Dialog
  expect(calls).toBe(0);
  expect(await exited(electronApp)).toBe(true);
});

test('Tray „Planung öffnen“: Main → Renderer öffnet Dashboard Aufnahmen im Tab „Geplant“ (Whitelist)', async () => {
  const { electronApp, page } = await launch('open-planning');
  const send = payload => electronApp.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('recordings:open', p), payload);
  await send({ tab: 'planned' });
  await expect(page.locator('#recordingsTab-planned')).toHaveAttribute('aria-selected', 'true');
  await send({ tab: 'library' });
  await expect(page.locator('#recordingsTab-library')).toHaveAttribute('aria-selected', 'true');
  // unbekannter Wert wird ignoriert (bleibt im zuletzt gewählten Tab)
  await send({ tab: '<img src=x onerror=alert(1)>' });
  await expect(page.locator('#recordingsTab-library')).toHaveAttribute('aria-selected', 'true');
});
