'use strict';

// E2E: Startseite „Läuft gerade“ (Design-Umbau Schritt 6) — Leiste bei frischem Profil ausgeblendet; mit gestelltem Zustand
// (zuletzt gehörter Radiosender über die Radio-Einstellungen, Verlaufseintrag über die Verlaufs-API) sichtbar, per Tastatur
// bedienbar. Kein Netz, Fenster im Hintergrund (launchApp). Screenshots (optional): RUNNING_NOW_SHOTS=<Verzeichnis>.
const { test, expect } = require('@playwright/test');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');
const { shotBoth } = require('./theme-audit');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Zuletzt gehörter Sender kommt aus radio-settings.json (nur das Abspielen schreibt ihn; kein IPC zum Setzen): Seed vor dem Start
const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'radiosources.json'), 'utf8'));
const radioSource = (Array.isArray(bundled) ? bundled : bundled.sources).find(src => Array.isArray(src.stations) && src.stations.length);
const radioStation = radioSource.stations[0];

const SHOTS = process.env.RUNNING_NOW_SHOTS || '';

const launch = seed => {
  const base = Math.floor(Date.now() / MIN) * MIN;
  const epgXml =
    '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>' +
    `<programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Laufende Sendung</title></programme></tv>`;
  return launchApp({ prefix: 'streaming-hub-e2e-runningnow-', epgXml, channels: [{ id: 'E2E.de', name: 'E2E Kanal' }], favorites: ['E2E.de'], seed });
};

test.describe('Startseite „Läuft gerade“: frisches Profil', () => {
  let ctx;
  test.beforeAll(async () => {
    ctx = await launch(null);
  });
  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test('Leiste ausgeblendet, kein Platzhaltertext', async () => {
    const { page } = ctx;
    await expect(page.locator('.dashboard-section-tile')).toHaveCount(6);
    await expect(page.locator('#runningNow')).toBeHidden();
    await expect(page.locator('.running-card')).toHaveCount(0);
    await expect(page.locator('#runningNowTitle')).toBeHidden();
    if (SHOTS) await shotBoth(page, SHOTS, 'start-leer');
  });
});

test.describe('Startseite „Läuft gerade“: mit Zustand', () => {
  let ctx;
  let page;
  test.beforeAll(async () => {
    ctx = await launch(({ userData }) =>
      fs.writeFileSync(path.join(userData, 'radio-settings.json'), JSON.stringify({ lastStation: { sourceId: radioSource.id, id: radioStation.id } })),
    );
    page = ctx.page;
  });
  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test('mit Zustand: Karten für Radio und Verlauf, Tastatur und Klick', async () => {
    const station = radioStation.name;
    await page.evaluate(() => window.electronAPI.saveHistoryEntry({ title: 'TV: E2E Kanal', serviceKey: '__tv__', serviceName: 'E2E Kanal' }));
    await page.reload();
    await page.locator('#dashboardView').waitFor();
    const strip = page.locator('#runningNow');
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('heading', { name: 'Läuft gerade' })).toBeVisible();
    const cards = strip.locator('.running-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute('data-kind', 'radio');
    await expect(cards.nth(0)).toContainText(station);
    await expect(cards.nth(0)).toContainText('LIVE');
    await expect(cards.nth(0)).toHaveAttribute('aria-label', new RegExp(`^${station.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, Zuletzt gehört, live$`));
    await expect(cards.nth(1)).toHaveAttribute('data-kind', 'history');
    await expect(cards.nth(1)).toContainText('E2E Kanal');
    // Tastatur: Tab bis zur Karte, Fokusring sichtbar
    await cards.nth(0).focus();
    await expect(cards.nth(0)).toBeFocused();
    const outline = await cards.nth(0).evaluate(el => getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth);
    expect(outline).toBe('solid 2px');
    if (SHOTS) await shotBoth(page, SHOTS, 'start-inhalt');
    // Zustandsupdate bei fokussierter Karte: Karte wird in place aktualisiert, Fokus bleibt (kein Neuaufbau der Liste)
    await cards.nth(0).focus();
    const station0 = { sourceId: radioSource.id, id: radioStation.id, name: radioStation.name };
    await ctx.electronApp.evaluate(({ BrowserWindow }, st) => {
      BrowserWindow.getAllWindows()[0].webContents.send('radio:state', { status: 'playing', station: st });
    }, station0);
    await expect(cards.nth(0)).toContainText('Läuft');
    await expect(cards.nth(0)).toBeFocused();
    expect(await page.evaluate(() => document.activeElement.dataset.kind)).toBe('radio');
    // Enter auf der Verlaufskarte (LiveTV-Sender) wechselt in die Wiedergabe: Startseite weg
    await cards.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#dashboardTitle')).not.toBeVisible();
  });
});

test.describe('Startseite „Läuft gerade“: Verlaufseintrag öffnet die gespeicherte Adresse', () => {
  let server;
  let ctx;
  let page;
  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>Seite ${req.url}</title><body>${req.url}</body>`);
    });
    await new Promise(resolve => server.listen(0, resolve));
    const base = `http://localhost:${server.address().port}`;
    ctx = await launch(({ userData }) =>
      fs.writeFileSync(path.join(userData, 'services.json'), JSON.stringify([{ id: 'e2esvc', name: 'E2E Dienst', url: `${base}/home`, icon: 'netflix.png', color: '#e50914', group: 'streaming' }])),
    );
    ctx.base = base;
    page = ctx.page;
  });
  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('Klick lädt die gespeicherte Video-Adresse, ein Klick auf Zurück führt zur Startseite', async () => {
    await page.evaluate(url => window.electronAPI.saveHistoryEntry({ title: 'Mein Video', serviceKey: 'e2esvc', serviceName: 'E2E Dienst', url }), `${ctx.base}/watch?v=abc`);
    await page.reload();
    await page.locator('#dashboardView').waitFor();
    const card = page.locator('#runningNow .running-card[data-kind="history"]');
    await expect(card).toContainText('Mein Video');
    await card.click();
    await expect(page.locator('#dashboardTitle')).not.toBeVisible();
    const contentUrl = () => page.evaluate(() => document.getElementById('contentView').getURL());
    await expect.poll(contentUrl).toBe(`${ctx.base}/watch?v=abc`);
    // Der Webview-Verlauf enthält keinen Eintrag vor der Zielseite (sonst führt Zurück auf about:blank)
    await expect.poll(() => page.evaluate(() => document.getElementById('contentView').canGoBack())).toBe(false);
    await expect(page.locator('#backBtn')).toBeVisible();
    await page.locator('#backBtn').dispatchEvent('click'); // Leiste ist im Vollbild-Inhalt eingeklappt, der Handler ist derselbe
    await expect(page.locator('#dashboardView.start-page')).toBeVisible();
    await expect(page.locator('#runningNow')).toBeVisible();
    await expect(page.locator('#dashboardView.start-page')).toBeVisible();
  });
});
