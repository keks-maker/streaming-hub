'use strict';

// E2E: Navigationseintrag „Start“ (springt zur Startseite). Auf der Startseite ist die Leiste ausgeblendet, „Start“ hat keinen
// aktiven Zustand. Kein Netz, Fenster im Hintergrund (launchApp). Screenshots (optional): NAV_START_SHOTS=<Verzeichnis>.
const { test, expect } = require('@playwright/test');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');
const path = require('path');

const SHOTS = process.env.NAV_START_SHOTS || '';
const startItem = page => page.locator('#overlayNav [data-section="start"]');
const barShown = page => page.evaluate(() => getComputedStyle(document.getElementById('overlayBar')).display !== 'none');

let ctx;
let page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const base = Math.floor(Date.now() / MIN) * MIN;
  const epgXml =
    '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>' +
    `<programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Laufende Sendung</title></programme></tv>`;
  ctx = await launchApp({ prefix: 'streaming-hub-e2e-navstart-', epgXml, channels: [{ id: 'E2E.de', name: 'E2E Kanal' }], favorites: ['E2E.de'] });
  page = ctx.page;
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

async function shots(name) {
  if (!SHOTS) return;
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(450);
    await page.locator('#overlayBar').screenshot({ path: path.join(SHOTS, `leiste-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

test('Start ist erster Eintrag mit Icon und Beschriftung; Startseite ohne Leiste und ohne aktiven Eintrag', async () => {
  await expect(page.locator('.dashboard-view.start-page')).toBeVisible();
  expect(await barShown(page)).toBe(false);
  const order = await page.locator('#overlayNav .nav-section-item').evaluateAll(els => els.map(e => e.dataset.section));
  expect(order[0]).toBe('start');
  await expect(startItem(page).locator('svg')).toHaveCount(1);
  await expect(startItem(page).locator('.nav-section-label')).toHaveText('Start');
  await expect(page.locator('#overlayNav .nav-item.active')).toHaveCount(0);
});

test('Klick auf Start führt aus Bereich und Einstellungen zur Startseite; Leiste verschwindet und kehrt zurück', async () => {
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  expect(await barShown(page)).toBe(true);
  await expect(startItem(page)).toBeVisible();
  await expect(startItem(page)).not.toHaveClass(/active/);
  await expect(startItem(page)).not.toHaveAttribute('aria-current', /.*/);
  await expect(page.locator('#overlayNav [data-section="livetv"]')).toHaveClass(/active/);
  await shots('livetv');
  await startItem(page).click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Was möchtest du sehen?');
  expect(await barShown(page)).toBe(false);
  await expect(page.locator('#overlayNav .nav-item.active')).toHaveCount(0);

  await page.locator('.dashboard-section-tile[data-section="settings"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  expect(await barShown(page)).toBe(true);
  await expect(page.locator('#overlayNav [data-section="settings"]')).toHaveClass(/active/);
  await startItem(page).click();
  await expect(page.locator('.dashboard-view.start-page')).toBeVisible();
  await expect(page.locator('#overlayNav .nav-item.active')).toHaveCount(0);
});

test('Strg+Umsch+H führt zur Startseite, Strg+H öffnet weiter den Verlauf', async () => {
  await page.locator('.dashboard-section-tile[data-section="radio"]').click();
  await expect(page.locator('#overlayNav [data-section="radio"]')).toHaveClass(/active/);
  await page.keyboard.press('Control+Shift+H');
  await expect(page.locator('.dashboard-view.start-page')).toBeVisible();
  expect(await barShown(page)).toBe(false);
  await expect(page.locator('#historyOverlay')).not.toHaveClass(/open/);
  await page.keyboard.press('Control+H');
  await expect(page.locator('#historyOverlay')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#historyOverlay')).not.toHaveClass(/open/);
});

test('Start bleibt im eingeklappten Zustand vorhanden und passt in jeder Breite in die Leiste', async () => {
  await page.locator('.dashboard-section-tile[data-section="radio"]').click();
  await page.evaluate(() => document.getElementById('overlayBar').classList.add('nav-collapsed'));
  await expect(startItem(page)).toHaveCount(1);
  await page.evaluate(() => document.getElementById('overlayBar').classList.remove('nav-collapsed'));
  for (const width of [1280, 900, 700, 520]) {
    await ctx.electronApp.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(300, 400);
      win.setSize(w, 800);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const fits = await page.evaluate(() => {
      const bar = document.getElementById('overlayBar').getBoundingClientRect();
      const items = [...document.querySelectorAll('#overlayNav .nav-item')].map(n => n.getBoundingClientRect());
      const left = Math.min(...items.map(r => r.left));
      const right = Math.max(...items.map(r => r.right));
      return { inBar: left >= bar.left && right <= bar.right, width: Math.round(right - left), bar: Math.round(bar.width) };
    });
    expect(fits.inBar, `Breite ${width}: ${JSON.stringify(fits)}`).toBe(true);
  }
});

test('In einem Dienst erscheint Start beim Überfahren der Leiste und führt zur Startseite', async () => {
  await page.locator('#overlayNav [data-section="start"]').evaluate(el => el.click());
  await page.locator('.dashboard-section-tile[data-section="streaming"]').click();
  await page.locator('.dashboard-grid .dashboard-tile').first().click();
  await expect(page.locator('#overlayBar')).toHaveClass(/nav-collapsed/);
  await page.locator('#overlayBar').hover();
  await expect(startItem(page)).toBeVisible();
  await shots('dienst');
  await startItem(page).click();
  await expect(page.locator('.dashboard-view.start-page')).toBeVisible();
  expect(await barShown(page)).toBe(false);
  await expect(page.locator('#overlayNav .nav-item.active')).toHaveCount(0);
});
