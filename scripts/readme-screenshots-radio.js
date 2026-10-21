'use strict';

// Erzeugt die Radio-Screenshots für die README (assets/screenshots/radio-dashboard.png, radio-senderverwaltung.png)
// aus einem isolierten Profil: mitgelieferte Senderliste (öffentliche Sender), einige Favoriten, ein Sender spielt stumm
// aus einem lokalen Testton (Stream-URL per Override auf localhost), keine privaten Daten. Logos laden im Testlauf nicht
// (kein Netz), die Kacheln zeigen daher den Platzhalter. Danach mit `sips -Z 1280 <Datei>` verkleinern.
//
// Aufruf (vorher `npm run build:renderer`): node scripts/readme-screenshots-radio.js [Zielordner]
// Voraussetzung: bin/ffmpeg (Testton). Nur für Doku-Zwecke, scripts/ wird nicht ausgeliefert.

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('@playwright/test');
const { resolveLaunchTarget, launchArgs, backgroundEnv } = require('../e2e/platform');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'assets', 'screenshots'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SOURCE = 'deutsche-radiosender';
const FAVORITES = ['swr3', '1live', 'wdr5', 'deutschlandfunk', 'ndr-2', 'bayern-3', 'radioeins', 'dlf-nova'];
const PLAYING = 'swr3';

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shsh-radio-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'ud');
  fs.mkdirSync(home);
  fs.mkdirSync(userData);
  const tone = path.join(root, 'tone.aac');
  execFileSync(path.join(__dirname, '..', 'bin', 'ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', tone], { timeout: 30_000 });
  const data = fs.readFileSync(tone);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/aac', 'Cache-Control': 'no-store', Connection: 'close' });
    let offset = 0;
    const push = () => {
      const end = Math.min(data.length, offset + 2048);
      res.write(data.subarray(offset, end));
      offset = end >= data.length ? 0 : end;
    };
    for (let i = 0; i < 8; i += 1) push();
    const timer = setInterval(push, 400);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const streamUrl = `http://localhost:${server.address().port}/tone.aac`;

  fs.mkdirSync(OUT, { recursive: true });
  const target = resolveLaunchTarget();
  const app = await electron.launch({
    executablePath: target.executablePath,
    args: [...launchArgs(target), '--force-device-scale-factor=2'],
    env: { ...process.env, HOME: home, STREAMING_HUB_USER_DATA: userData, STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9', ...backgroundEnv() },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await sleep(800);

  await page.evaluate(
    async ({ favorites, playing, streamUrl, source }) => {
      await window.radio.setVolume(0);
      await window.radio.setOverride({ sourceId: source, stationId: playing }, { streamUrl });
      for (const id of favorites) await window.radio.setFavorite({ sourceId: source, stationId: id }, true);
    },
    { favorites: FAVORITES, playing: PLAYING, streamUrl, source: SOURCE },
  );
  const shot = async name => {
    await page.mouse.move(640, 780);
    await sleep(900);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('ok', name);
  };

  await page.locator('.dashboard-section-tile[data-section="radio"]').click();
  await page.locator('#radioGrid .radio-tile').first().waitFor();
  await page.locator('#radioGrid .radio-tile .dashboard-tile-name', { hasText: /^SWR3$/ }).click();
  for (let i = 0; i < 40; i += 1) {
    if ((await page.evaluate(() => window.radio.getState())).status === 'playing') break;
    await sleep(500);
  }
  await shot('radio-dashboard.png');

  await page.locator('#radioManage').click();
  await page.locator('[data-settings-page="radio-stations"]').waitFor({ state: 'visible' });
  await sleep(800);
  await shot('radio-senderverwaltung.png');

  await app.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
