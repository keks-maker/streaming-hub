'use strict';

// Gemeinsame Helfer der EPG-E2E-Specs (Programmführer 3.3–3.5): App mit lokaler M3U-Quelle und
// XMLTV-Fixture starten (kein Netz), auf den EPG-Cache warten, Overlay aus dem Dashboard öffnen.
const { expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLaunchTarget, launchArgs } = require('./platform');

const KNOWN_HARMLESS = [
  'ERR_NAME_NOT_RESOLVED',
  'Failed to fetch',
  'net::ERR_',
  'Component updater failed',
  'Electron Security Warning',
  'Autofill.enable',
  'Autofill.setAddresses',
];
const isHarmless = text => KNOWN_HARMLESS.some(k => text.includes(k));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MSG_RUNNING =
  'Diese Sendung läuft bereits und kann nicht mehr geplant werden. Zum Aufnehmen der laufenden Sendung nutze den Aufnahme-Button im Player.';

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

/** Startet die App mit lokaler Quelle (M3U), EPG-Fixture und Favoriten. */
async function launchApp({ prefix, epgXml, channels, favorites }) {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const userData = path.join(tmpRoot, 'userData');
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(userData);
  fs.mkdirSync(home);
  const fixture = path.join(tmpRoot, 'epg.xml');
  fs.writeFileSync(fixture, epgXml);
  const m3u = path.join(tmpRoot, 'e2e.m3u');
  // Logo '@file': winzige lokale PNG-Datei (file:-URL); sonst die URL unverändert (tvg-logo der Playlist)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const logoOf = c => {
    if (c.logo !== '@file') return c.logo || '';
    const file = path.join(tmpRoot, `${c.id}.png`);
    fs.writeFileSync(file, png);
    return `file://${file}`;
  };
  fs.writeFileSync(
    m3u,
    '#EXTM3U\n' +
      channels
        .map(c => {
          const logo = logoOf(c);
          return `#EXTINF:-1 tvg-id="${c.id}"${logo ? ` tvg-logo="${logo}"` : ''} group-title="${c.group || 'Test'}",${c.name}\nhttp://streams.invalid/${c.id}.m3u8\n`;
        })
        .join(''),
  );
  fs.writeFileSync(
    path.join(userData, 'tvsources.json'),
    JSON.stringify([
      {
        id: 'e2e',
        name: 'E2E Quelle',
        url: m3u,
        type: 'file',
        color: '#a78bfa',
        epgUrl: 'https://e2e-epg.example/epg.xml',
        sortOrder: [],
        favorites,
      },
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
      STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9',
    },
    timeout: 45_000,
  });
  const problems = [];
  electronApp.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[main console] ${msg.text()}`);
  });
  const page = await electronApp.firstWindow();
  page.on('pageerror', err => problems.push(`[pageerror] ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[renderer console] ${msg.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
  const cleanup = async () => {
    const proc = electronApp.process();
    await Promise.race([electronApp.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };
  return { electronApp, page, problems, cleanup };
}

async function waitForEpgChannels(page, count) {
  await expect
    .poll(async () => (await page.evaluate(() => window.electronAPI.getEpgStatus())).sources.reduce((n, s) => n + s.channelCount, 0), {
      timeout: 60_000,
    })
    .toBe(count);
}

async function openOverlayFromDashboard(page) {
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  await page.locator('#dashboardEpgOpen').click();
  await expect(page.locator('#epgOverlay')).toBeVisible();
}

module.exports = { MIN, HOUR, MSG_RUNNING, isHarmless, xmltvTime, launchApp, waitForEpgChannels, openOverlayFromDashboard };
