'use strict';

// E2E: Radio-Oberfläche (R2) — Navigation, Dashboard (Leerzustand, Favoriten-Kacheln), Mini-Player und Ton-Konflikt
// mit LiveTV. Kein Netz: lokale Test-Streams (gültiges AAC (ADTS) aus dem mitgelieferten ffmpeg, 404 aus tests/helpers/radio-server.js),
// Lautstärke 0 (stumm) und Fenster im Hintergrund (STREAMING_HUB_E2E_BACKGROUND über launchApp, kein Fokusklau).
// Screenshots (optional): RADIO_E2E_SHOTS=<Verzeichnis>.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp, waitForEpgChannels } = require('./epg-helpers');
const { startRadioServer } = require('../tests/helpers/radio-server');

const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg');
const CUSTOM = 'eigene-radiosender';
const SHOTS = process.env.RADIO_E2E_SHOTS || '';

function buildEpg(base) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>' +
    `<programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Laufende Sendung</title></programme></tv>`
  );
}

const radioState = page => page.evaluate(() => window.radio.getState());
const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

async function openRadio(page) {
  await page.evaluate(() => window.document.getElementById('overlayLocation').click());
  await page.locator('.dashboard-section-tile[data-section="radio"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Radio');
  await expect(page.locator('#radioDashboard')).toBeVisible();
}

test.describe('Radio-Oberfläche', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let audioServer;
  let streamUrl;
  let testServer;
  let tmpDir;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-radio-'));
    const tone = path.join(tmpDir, 'tone.aac');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', tone], { timeout: 30_000 });
    const data = fs.readFileSync(tone);
    // Endlos-Stream: das gültige AAC in Schleife, in kleinen Stücken ungefähr in Echtzeit (32 kbit/s ≈ 4 KB/s)
    audioServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/aac', 'Cache-Control': 'no-store', Connection: 'close' });
      let offset = 0;
      const push = () => {
        const end = Math.min(data.length, offset + 2048);
        res.write(data.subarray(offset, end));
        offset = end >= data.length ? 0 : end;
      };
      for (let i = 0; i < 8; i += 1) push(); // Vorlauf, damit der Player das Format sicher erkennt
      const timer = setInterval(push, 400);
      req.on('close', () => clearInterval(timer));
    });
    await new Promise(resolve => audioServer.listen(0, '127.0.0.1', resolve));
    // „localhost“ statt IP-Literal: die E2E-Startargumente sperren per Host-Resolver alles außer localhost (auch für <audio>)
    streamUrl = `http://localhost:${audioServer.address().port}/tone.aac`;
    testServer = await startRadioServer();
    const base = Math.floor(Date.now() / MIN) * MIN;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-radio-',
      epgXml: buildEpg(base),
      channels: [{ id: 'E2E.de', name: 'E2E Kanal', group: 'Test' }],
      favorites: ['E2E.de'],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 1);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (audioServer) await new Promise(resolve => audioServer.close(resolve));
    if (testServer) await testServer.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Startseite: Kachel „Radio“ nach LiveTV; Navigation und Ort; Leerzustand mit Hinweis', async () => {
    const order = await page.locator('.dashboard-section-tile').evaluateAll(els => els.map(e => e.dataset.section));
    expect(order).toEqual(['livetv', 'radio', 'streaming', 'mediathek', 'settings']);
    await expect(page.locator('.dashboard-section-tile[data-section="radio"] .dashboard-tile-name')).toHaveText('Radio');
    await shot(page, 'startseite');
    await openRadio(page);
    await expect(page.locator('#overlayLocation')).toHaveText('Radio');
    await expect(page.locator('#dashboardEyebrow')).toHaveText('Deine Radiosender');
    // Nav-Eintrag direkt nach LiveTV
    const navOrder = await page.locator('#overlayNav .nav-section-item').evaluateAll(els => els.map(e => e.dataset.section));
    expect(navOrder.slice(0, 2)).toEqual(['livetv', 'radio']);
    await expect(page.locator('#overlayNav .nav-section-item[data-section="radio"]')).toHaveClass(/active/);
    // Leerzustand: Hinweis, Button, Senderverwaltung; keine LiveTV-Karten
    await expect(page.locator('#radioStatus')).toHaveText('0 Favoriten');
    await expect(page.locator('#radioEmpty')).toBeVisible();
    await expect(page.locator('#radioEmpty')).toContainText('Senderverwaltung');
    await expect(page.locator('#radioAddPopular')).toBeVisible();
    await expect(page.locator('#radioManage')).toBeVisible();
    await expect(page.locator('#dashboardHub')).toBeHidden();
    await expect(page.locator('#radioMiniPlayer')).toBeHidden();
    await shot(page, 'radio-leer');
  });

  test('„Beliebte Sender hinzufügen“ setzt 5–8 Favoriten erst auf Klick', async () => {
    await page.locator('#radioAddPopular').click();
    await expect.poll(() => page.locator('#radioGrid .radio-tile').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
    expect(await page.locator('#radioGrid .radio-tile').count()).toBeLessThanOrEqual(8);
    await expect(page.locator('#radioEmpty')).toBeHidden();
    // zurücksetzen, ohne etwas abzuspielen
    await page.evaluate(() => window.radio.setFavoriteOrder([]));
    await expect(page.locator('#radioEmpty')).toBeVisible();
  });

  test('Senderverwaltung: ohne Seite (R3) öffnet die allgemeinen Einstellungen', async () => {
    await page.locator('#radioManage').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
    await openRadio(page);
  });

  test('Favoriten-Kacheln in Reihenfolge; Klick = Play, Mini-Player erscheint; erneut = Pause', async () => {
    await page.evaluate(
      async ({ streamUrl, broken }) => {
        await window.radio.setVolume(0);
        const a = await window.radio.addCustom({ name: 'Teststation', streamUrl, genre: 'Test' });
        const b = await window.radio.addCustom({ name: 'Defekt <b>X</b>', streamUrl: broken, genre: 'Test' });
        await window.radio.setFavorite({ sourceId: 'eigene-radiosender', stationId: a.station.id }, true);
        await window.radio.setFavorite({ sourceId: 'eigene-radiosender', stationId: b.station.id }, true);
      },
      { streamUrl, broken: `${testServer.base.replace('127.0.0.1', 'localhost')}/missing` },
    );
    const tiles = page.locator('#radioGrid .radio-tile');
    await expect(tiles).toHaveCount(2);
    await expect(page.locator('#radioStatus')).toHaveText('2 Favoriten');
    await expect(tiles.nth(0).locator('.dashboard-tile-name')).toHaveText('Teststation');
    await expect(tiles.nth(1).locator('.dashboard-tile-name')).toHaveText('Defekt <b>X</b>');
    await expect(tiles.nth(0).locator('.dashboard-tile-fallback')).toHaveText('T');
    await expect(page.locator('#radioMiniPlayer')).toBeHidden();

    await tiles.nth(0).click();
    await expect.poll(async () => (await radioState(page)).status, { timeout: 20_000 }).toBe('playing');
    await expect(tiles.nth(0)).toHaveAttribute('data-state', 'playing');
    await expect(tiles.nth(0).locator('.radio-eq')).toBeVisible();
    const mini = page.locator('#radioMiniPlayer');
    await expect(mini).toBeVisible();
    await expect(mini.locator('.radio-mini-name')).toHaveText('Teststation');
    await expect(page.locator('#radioMiniLive')).toHaveText('Teststation: spielt');
    await shot(page, 'radio-dashboard-spielt');

    await tiles.nth(0).click();
    await expect.poll(async () => (await radioState(page)).status).toBe('paused');
    await expect(tiles.nth(0)).toHaveAttribute('data-state', 'paused');
    await expect(mini.locator('.radio-mini-subtitle')).toHaveText('Pausiert');
    // Fortsetzen über den Mini-Player
    await page.locator('#radioMiniPlayPause').click();
    await expect.poll(async () => (await radioState(page)).status, { timeout: 20_000 }).toBe('playing');
  });

  test('Mini-Player bleibt auf anderen Seiten; Navigation und Zurück-Historie funktionieren', async () => {
    await page.evaluate(() => window.document.getElementById('overlayLocation').click());
    await expect(page.locator('#radioMiniPlayer')).toBeVisible();
    await page.locator('.dashboard-section-tile[data-section="settings"]').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
    await expect(page.locator('#radioMiniPlayer')).toBeVisible();
    await page.locator('#backBtn').click();
    await expect(page.locator('#radioMiniPlayer')).toBeVisible();
    // Klick auf den Sendernamen öffnet das Radio-Dashboard
    await page.evaluate(() => window.document.getElementById('overlayLocation').click());
    await page.locator('#radioMiniInfo').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Radio');
    // Der Mini-Player füllt die Breite unten, ohne das Dashboard zu überdecken
    const box = await page.locator('#radioMiniPlayer').boundingBox();
    const area = await page.locator('#contentArea').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(area.y + area.height - 1);
    // Die Leiste liegt vollständig im Fenster (kein Überlauf durch min-height des Inhaltsbereichs)
    const innerHeight = await page.evaluate(() => window.innerHeight);
    expect(box.y + box.height).toBeLessThanOrEqual(innerHeight + 1);
    expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
    await shot(page, 'radio-miniplayer');
  });

  test('Mini-Player: Lautstärke, Favorit vor/zurück, Vollbild blendet aus', async () => {
    await page.locator('#radioMiniVolume').fill('35');
    await expect.poll(async () => (await radioState(page)).volume).toBeCloseTo(0.35, 2);
    await page.locator('#radioMiniNext').click();
    await expect.poll(async () => (await radioState(page)).station.name).toBe('Defekt <b>X</b>');
    // 404 → Fehlerkachel und Fehlertext im Mini-Player (nach den Wiederverbindungsversuchen)
    await expect.poll(async () => (await radioState(page)).status, { timeout: 45_000 }).toBe('error');
    await expect(page.locator('#radioGrid .radio-tile').nth(1)).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#radioMiniPlayer')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#radioMiniPlayPause')).toHaveAttribute('aria-label', 'Erneut versuchen');
    // der Name erscheint als Text, nicht als HTML
    await expect(page.locator('#radioMiniPlayer .radio-mini-name')).toHaveText('Defekt <b>X</b>');
    await expect(page.locator('#radioMiniPlayer .radio-mini-name b')).toHaveCount(0);
    // Vollbild (Webview-Event) blendet die Leiste aus, Ende zeigt sie wieder
    await page.evaluate(() => document.getElementById('tvView').dispatchEvent(new Event('enter-html-full-screen')));
    await expect(page.locator('#radioMiniPlayer')).toBeHidden();
    await page.evaluate(() => document.getElementById('tvView').dispatchEvent(new Event('leave-html-full-screen')));
    await expect(page.locator('#radioMiniPlayer')).toBeVisible();
    await shot(page, 'radio-dashboard-fehler');
    // zurück zum funktionierenden Sender
    await page.locator('#radioMiniPrev').click();
    await expect.poll(async () => (await radioState(page)).status, { timeout: 20_000 }).toBe('playing');
  });

  test('Ton-Konflikt: LiveTV-Start pausiert das Radio, kein automatisches Fortsetzen', async () => {
    await page.evaluate(() => window.document.getElementById('overlayLocation').click());
    await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
    await page.locator('#dashboardGrid .dashboard-tv-tile').first().click();
    await expect.poll(async () => (await radioState(page)).status, { timeout: 10_000 }).toBe('paused');
    await page.waitForTimeout(2_000);
    expect((await radioState(page)).status).toBe('paused');
    await expect(page.locator('#radioMiniPlayer .radio-mini-subtitle')).toHaveText('Pausiert');
  });

  test('Radio-Start berührt die TV-Ansicht nicht (nur Richtung TV → Radio pausiert)', async () => {
    await page.evaluate(() => window.radio.play());
    await expect.poll(async () => (await radioState(page)).status, { timeout: 20_000 }).toBe('playing');
    // tvView bleibt aktiv sichtbar, es wird weder pausiert noch gewechselt
    const opacity = await page.evaluate(() => getComputedStyle(document.getElementById('tvView')).opacity);
    expect(opacity).toBe('1');
    expect(await page.evaluate(() => document.getElementById('overlayLocation').textContent)).not.toBe('Radio');
  });

  test('Stopp blendet den Mini-Player aus; keine Konsolenfehler', async () => {
    await page.locator('#radioMiniStop').click();
    await expect.poll(async () => (await radioState(page)).status).toBe('idle');
    await expect(page.locator('#radioMiniPlayer')).toBeHidden();
    expect(ctx.problems).toEqual([]);
  });
});

