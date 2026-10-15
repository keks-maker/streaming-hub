'use strict';

// E2E: Radio-Einstellungen (R3) — Seiten „Sender“, „Eigene Sender“ und „Wiedergabe“: Öffnen aus dem Dashboard,
// Suche, Favoriten und Reihenfolge (Dashboard folgt), eigener Sender mit Ablehnung ungültiger URLs, „Stream prüfen“ und
// Abspielen. Kein Netz: lokale Teststreams (gültiges AAC (ADTS) aus dem mitgelieferten ffmpeg, 404 aus
// tests/helpers/radio-server.js), Lautstärke 0 (stumm), Fenster im Hintergrund (launchApp, kein Fokusklau).
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

async function gotoStart(page) {
  await page.evaluate(() => window.document.getElementById('overlayLocation').click());
}

async function openRadioDashboard(page) {
  await gotoStart(page);
  await page.locator('.dashboard-section-tile[data-section="radio"]').click();
  await expect(page.locator('#radioDashboard')).toBeVisible();
}

// Radio-Seite der Einstellungen über die Seitenleiste öffnen (Gruppe „Radio“ aufklappen, Tab wählen)
async function openRadioSettingsTab(page, tab) {
  const radioGroup = page.locator('#settingsNav .settings-nav-group').nth(1);
  if ((await radioGroup.getAttribute('aria-expanded')) !== 'true') await radioGroup.click();
  await page.locator(`#settingsTab-${tab}`).click();
  await expect(page.locator(`[data-settings-page="${tab}"]`)).toBeVisible();
}

const dashboardNames = page => page.locator('#radioGrid .radio-tile .dashboard-tile-name').allTextContents();

test.describe('Radio-Einstellungen', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let audioServer;
  let streamUrl;
  let testServer;
  let pageServer;
  let pageUrl;
  let tmpDir;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-radio-settings-'));
    const tone = path.join(tmpDir, 'tone.aac');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', tone], { timeout: 30_000 });
    const data = fs.readFileSync(tone);
    // Webseite des Senders mit apple-touch-icon (lokal über http: der Test-Hook STREAMING_HUB_TEST_LOGO_ALLOW_HTTP erlaubt das nur im Testlauf)
    const icon = path.join(tmpDir, 'icon.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xf59e0b:s=96x96', '-frames:v', '1', icon], { timeout: 30_000 });
    const iconData = fs.readFileSync(icon);
    pageServer = http.createServer((req, res) => {
      if (req.url === '/icon.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(iconData);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><link rel="apple-touch-icon" sizes="96x96" href="/icon.png"></head><body>Testsender</body></html>');
      }
    });
    await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
    pageUrl = `http://localhost:${pageServer.address().port}/`;
    audioServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/aac', 'Cache-Control': 'no-store', Connection: 'close', 'icy-url': pageUrl });
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
    await new Promise(resolve => audioServer.listen(0, '127.0.0.1', resolve));
    // „localhost“ statt IP-Literal: die E2E-Startargumente sperren per Host-Resolver alles außer localhost
    streamUrl = `http://localhost:${audioServer.address().port}/tone.aac`;
    testServer = await startRadioServer();
    const base = Math.floor(Date.now() / MIN) * MIN;
    process.env.STREAMING_HUB_TEST_LOGO_ALLOW_HTTP = '1';
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-radio-settings-',
      epgXml: buildEpg(base),
      channels: [{ id: 'E2E.de', name: 'E2E Kanal', group: 'Test' }],
      favorites: ['E2E.de'],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 1);
    await page.evaluate(() => window.radio.setVolume(0));
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (audioServer) await new Promise(resolve => audioServer.close(resolve));
    if (pageServer) await new Promise(resolve => pageServer.close(resolve));
    if (testServer) await testServer.close();
    delete process.env.STREAMING_HUB_TEST_LOGO_ALLOW_HTTP;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Senderverwaltung im Dashboard öffnet „Radio: Sender“; Gruppe „Radio“ in der Seitenleiste', async () => {
    await openRadioDashboard(page);
    await page.locator('#radioManage').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
    await expect(page.locator('#settingsTab-radio-stations')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-settings-page="radio-stations"]')).toBeVisible();
    const groups = await page.locator('#settingsNav .settings-nav-group').allTextContents();
    expect(groups.map(t => t.replace('▸', '').trim())).toEqual(['LiveTV', 'Radio', 'Podcasts']);
    const tabs = await page.locator('#settingsNav .settings-nav-children').nth(1).locator('[role="tab"]').allTextContents();
    expect(tabs).toEqual(['Sender', 'Eigene Sender', 'Wiedergabe']);
    await expect(page.locator('#settingsRadioList .settings-chan-row').first()).toBeVisible();
    await shot(page, 'radio-einstellungen-sender');
  });

  test('Suche, Zähler und Filter (Umlaut-/Groß-Kleinschreibung egal)', async () => {
    const total = await page.evaluate(async () => (await window.radio.getSources()).reduce((n, s) => n + s.stations.length, 0));
    await expect(page.locator('#settingsRadioCount')).toHaveText(`${total} Sender`);
    const rows = page.locator('#settingsRadioList .settings-chan-row');
    // „1live“ trifft auch die WDR-1Live-Webkanäle der großen Liste; der Sender „1LIVE“ steht (Votes) zuerst
    await page.locator('#settingsRadioSearch').fill('1LIVE');
    await expect(rows).toHaveCount(3);
    await expect(rows.first().locator('.settings-chan-name')).toHaveText('1LIVE');
    await expect(page.locator('#settingsRadioCount')).toHaveText(`3 von ${total} Sendern`);
    await page.locator('#settingsRadioSearch').fill('1live');
    await expect(rows).toHaveCount(3);
    await page.locator('#settingsRadioSearch').fill('zzzzzz');
    await expect(page.locator('#settingsRadioList')).toContainText('Keine Sender gefunden');
    await page.locator('#settingsRadioSearch').fill('');
    await expect(page.locator('#settingsRadioCount')).toHaveText(`${total} Sender`);
    const genre = page.locator('#settingsRadioFilter-genre');
    const options = await genre.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(2);
    await genre.selectOption({ index: 1 });
    expect(await rows.count()).toBeLessThan(total);
    await genre.selectOption('');
    await expect(rows).not.toHaveCount(0);
  });

  test('Favoriten setzen erscheint im Dashboard; Reihenfolge ändern, Dashboard folgt', async () => {
    const rows = page.locator('#settingsRadioList .settings-chan-row');
    await page.locator('#settingsRadioSearch').fill('1live');
    await rows.first().locator('[data-action="fav"]').click();
    await expect(rows.first().locator('[data-action="fav"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#settingsRadioSearch').fill('wdr 4');
    await expect(rows).toHaveCount(1);
    await rows.first().locator('[data-action="fav"]').click();
    await page.locator('#settingsRadioSearch').fill('');
    await page.locator('#settingsRadioViewFav').click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#settingsRadioCount')).toHaveText('2 Sender');
    await expect(rows.nth(0).locator('.settings-chan-name')).toHaveText('1LIVE');
    // Reihenfolge nur nach „Reihenfolge bearbeiten“
    await expect(rows.first().locator('[data-action="down"]')).toHaveCount(0);
    await page.locator('#settingsRadioReorder').click();
    await expect(page.locator('#settingsRadioReorder')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'radio-einstellungen-reihenfolge');
    await rows.first().locator('[data-action="down"]').click();
    await expect(rows.nth(0).locator('.settings-chan-name')).toHaveText('WDR 4');
    await expect(rows.nth(1).locator('.settings-chan-name')).toHaveText('1LIVE');
    // Fokus bleibt auf dem verschobenen Eintrag (am Listenende beim Gegenstück „nach oben“)
    await expect(rows.nth(1).locator('[data-action="up"]')).toBeFocused();
    await openRadioDashboard(page);
    await expect(page.locator('#radioStatus')).toHaveText('2 Favoriten');
    await expect.poll(() => dashboardNames(page)).toEqual(['WDR 4', '1LIVE']);
    // zurück in die Einstellungen, anders herum
    await page.locator('#radioManage').click();
    await page.locator('#settingsRadioViewFav').click();
    await page.locator('#settingsRadioReorder').click();
    await page.locator('#settingsRadioList .settings-chan-row').first().locator('[data-action="down"]').click();
    await openRadioDashboard(page);
    await expect.poll(() => dashboardNames(page)).toEqual(['1LIVE', 'WDR 4']);
    await shot(page, 'radio-dashboard-favoriten');
  });

  test('Sender anpassen: Name per stationOverrides, Dashboard zeigt ihn, Zurücksetzen stellt das Original her', async () => {
    await page.locator('#radioManage').click();
    const rows = page.locator('#settingsRadioList .settings-chan-row');
    await page.locator('#settingsRadioViewAll').click();
    await page.locator('#settingsRadioSearch').fill('1live');
    await rows.first().locator('[data-action="edit"]').click();
    const name = page.locator('#settingsRadioList [data-field="name"]');
    await expect(name).toBeFocused();
    await name.fill('Mein Eins');
    await page.locator('#settingsRadioList [data-field="streamUrl"]').fill('ftp://x');
    await page.locator('#settingsRadioList button[type="submit"]').click();
    await expect(page.locator('#settingsRadioList .settings-chan-error')).toContainText('http://');
    await page.locator('#settingsRadioList [data-field="streamUrl"]').fill('http://wdr-1live-live.icecast.wdr.de/wdr/1live/live/mp3/128/stream.mp3');
    await page.locator('#settingsRadioList button[type="submit"]').click();
    await expect(rows.first().locator('.settings-chan-name')).toHaveText('Mein Eins');
    await expect(rows.first()).toContainText('angepasst');
    await openRadioDashboard(page);
    await expect.poll(() => dashboardNames(page)).toEqual(['Mein Eins', 'WDR 4']);
    await page.locator('#radioManage').click();
    await page.locator('#settingsRadioSearch').fill('mein eins');
    await rows.first().locator('[data-action="edit"]').click();
    await page.locator('#settingsRadioList [data-action="reset"]').click();
    await expect(page.locator('#settingsRadioStatus')).toContainText('Original');
    // die Suche kennt den Namen „Mein Eins“ nicht mehr; unter dem Originalnamen ist der Sender wieder ohne Anpassung da
    await page.locator('#settingsRadioSearch').fill('1live');
    await expect(rows.first().locator('.settings-chan-name')).toHaveText('1LIVE');
    await expect(rows.first()).not.toContainText('angepasst');
    await page.locator('#settingsRadioSearch').fill('');
  });

  test('Eigene Sender: ungültige URL wird abgelehnt, „Stream prüfen“, speichern, abspielen', async () => {
    await openRadioSettingsTab(page, 'radio-custom');
    await expect(page.locator('#settingsRadioCustomList')).toContainText('Noch keine eigenen Sender');
    await shot(page, 'radio-einstellungen-eigene-leer');
    await page.locator('#settingsRadioCustomAdd').click();
    await expect(page.locator('[data-settings-page="radio-custom"] [data-field="name"]')).toBeFocused();
    const custom = page.locator('[data-settings-page="radio-custom"]');
    // Pflichtfelder
    await custom.locator('button[type="submit"]').click();
    await expect(custom.locator('.settings-chan-error').first()).toHaveText('Bitte einen Namen eingeben');
    // ungültige URL
    await custom.locator('[data-field="name"]').fill('E2E Teststation');
    await custom.locator('[data-field="streamUrl"]').fill('ftp://localhost/x');
    await custom.locator('button[type="submit"]').click();
    await expect(custom.locator('.settings-chan-error')).toContainText('http:// oder https://');
    await expect(custom.locator('[data-field="streamUrl"]')).toHaveAttribute('aria-invalid', 'true');
    expect(await page.evaluate(async () => (await window.radio.getSources()).find(s => s.id === 'eigene-radiosender').stations.length)).toBe(0);
    // Prüfen: nicht erreichbar (404), dann erreichbar
    await custom.locator('[data-field="streamUrl"]').fill(`${testServer.base.replace('127.0.0.1', 'localhost')}/missing`);
    await custom.locator('[data-action="probe"]').click();
    await expect(page.locator('#settingsRadioProbeResult')).toContainText('Nicht erreichbar');
    await expect(page.locator('#settingsRadioProbeResult')).toContainText('404');
    await custom.locator('[data-field="streamUrl"]').fill(streamUrl);
    await expect(page.locator('#settingsRadioProbeResult')).toHaveText('');
    await custom.locator('[data-action="probe"]').click();
    await expect(page.locator('#settingsRadioProbeResult')).toContainText('Erreichbar');
    await expect(page.locator('#settingsRadioProbeResult')).toContainText('AAC');
    await custom.locator('[data-field="genre"]').fill('Test');
    await shot(page, 'radio-einstellungen-eigene-formular');
    await custom.locator('button[type="submit"]').click();
    await expect(custom.locator('#settingsRadioCustomList .settings-chan-row')).toHaveCount(1);
    await expect(custom.locator('#settingsRadioCustomList .settings-chan-name')).toHaveText('E2E Teststation');
    await expect(page.locator('#settingsRadioCustomStatus')).toContainText('hinzugefügt');
    await shot(page, 'radio-einstellungen-eigene');
    // Vorhören auf der Seite „Sender“ (stumm)
    await openRadioSettingsTab(page, 'radio-stations');
    await page.locator('#settingsRadioSearch').fill('E2E Teststation');
    const row = page.locator('#settingsRadioList .settings-chan-row');
    await expect(row).toHaveCount(1);
    await row.locator('[data-action="preview"]').click();
    await expect.poll(async () => (await radioState(page)).status, { timeout: 20_000 }).toBe('playing');
    await expect(row.locator('[data-action="preview"]')).toHaveAttribute('aria-pressed', 'true');
    await row.locator('[data-action="preview"]').click();
    await expect.poll(async () => (await radioState(page)).status).toBe('idle');
    // Bearbeiten eines eigenen Senders springt zur Seite „Eigene Sender“
    await row.locator('[data-action="edit"]').click();
    await expect(page.locator('[data-settings-page="radio-custom"]')).toBeVisible();
    await expect(page.locator('[data-settings-page="radio-custom"] [data-field="name"]')).toHaveValue('E2E Teststation');
    await page.locator('[data-settings-page="radio-custom"] [data-action="cancel"]').click();
    // Löschen mit Bestätigung
    await custom.locator('[data-action="remove"]').click();
    await expect(custom.locator('#settingsRadioCustomList .settings-chan-row')).toHaveCount(1);
    await custom.locator('[data-action="confirm-remove"]').click();
    await expect(custom.locator('#settingsRadioCustomList')).toContainText('Noch keine eigenen Sender');
  });

  test('Eigene Sender: Prüfen übernimmt Webseite (icy-url) und schlägt ein Logo vor; eingetragenes Logo bleibt', async () => {
    await openRadioSettingsTab(page, 'radio-custom');
    const custom = page.locator('[data-settings-page="radio-custom"]');
    await page.locator('#settingsRadioCustomAdd').click();
    await custom.locator('[data-field="name"]').fill('E2E Logo-Sender');
    await custom.locator('[data-field="streamUrl"]').fill(streamUrl);
    await custom.locator('[data-action="probe"]').click();
    await expect(custom.locator('[data-field="homepage"]')).toHaveValue(pageUrl);
    await expect(page.locator('#settingsRadioLogoStatus')).toHaveText('Logo gefunden (Quelle: Webseite)');
    await expect(custom.locator('[data-field="logo"]')).toHaveValue(`${pageUrl}icon.png`);
    // Die CSP erlaubt Bilder nur über https; das lokale http-Testlogo scheitert daher und zeigt den Platzhalter mit Anfangsbuchstaben
    await expect(custom.locator('.settings-radio-logo-preview img.settings-chan-logo')).toHaveClass(/empty/);
    await expect(custom.locator('.settings-radio-logo-preview .settings-chan-logo-fallback')).toHaveText('E');
    await expect(custom.locator('.settings-radio-logo-preview .settings-chan-logo-fallback')).toBeVisible();
    await shot(page, 'radio-einstellungen-logo-vorschlag');
    // erneutes Prüfen überschreibt ein vom Nutzer geändertes Logo nicht
    await custom.locator('[data-field="logo"]').fill('https://meins.example/logo.png');
    await custom.locator('[data-action="probe"]').click();
    await expect(page.locator('#settingsRadioProbeResult')).toContainText('Erreichbar');
    await expect(custom.locator('[data-field="logo"]')).toHaveValue('https://meins.example/logo.png');
    // leer lassen: „Logo suchen“ findet es wieder
    await custom.locator('[data-field="logo"]').fill('');
    await custom.locator('[data-action="find-logo"]').click();
    await expect(custom.locator('[data-field="logo"]')).toHaveValue(`${pageUrl}icon.png`);
    await custom.locator('button[type="submit"]').click();
    const savedRow = custom.locator('#settingsRadioCustomList .settings-chan-row');
    await expect(savedRow).toHaveCount(1);
    await expect(savedRow.locator('.settings-chan-logo-fallback')).toHaveText('E');
    const saved = await page.evaluate(async () => (await window.radio.getSources()).find(s => s.id === 'eigene-radiosender').stations[0]);
    expect(saved.homepage).toBe(pageUrl);
    expect(saved.logo).toBe(`${pageUrl}icon.png`);
    // Löschen
    await savedRow.locator('[data-action="remove"]').click();
    await custom.locator('[data-action="confirm-remove"]').click();
    await expect(custom.locator('#settingsRadioCustomList')).toContainText('Noch keine eigenen Sender');
  });

  test('Wiedergabe: Schalter und Lautstärke werden gespeichert', async () => {
    await openRadioSettingsTab(page, 'radio-playback');
    await expect(page.locator('#settingsRadio-resumeOnStart')).not.toBeChecked();
    await expect(page.locator('#settingsRadio-pauseOnTv')).toBeChecked();
    await expect(page.locator('#settingsRadio-keepPlayingWhenClosed')).toBeChecked();
    await expect(page.locator('#settingsRadio-keepPlayingWhenClosed-hint')).toContainText('Tray');
    await expect(page.locator('#settingsRadioVolume')).toHaveValue('0');
    await expect(page.locator('#settingsRadio-trayDisplay-station-title')).toBeChecked();
    await page.locator('#settingsRadio-trayDisplay-station').check();
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).trayDisplay).toBe('station');
    await page.locator('#settingsRadio-trayDisplay-station-title').check();
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).trayDisplay).toBe('station-title');
    await expect(page.locator('#settingsRadio-trayScroll')).toBeChecked();
    await page.locator('#settingsRadio-trayScroll').uncheck();
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).trayScroll).toBe(false);
    await page.locator('#settingsRadio-trayScroll').check();
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).trayScroll).toBe(true);
    await expect(page.locator('#settingsRadio-trayScrollMode')).toHaveValue('smooth');
    await page.locator('#settingsRadio-trayScrollMode').selectOption('steps');
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).trayScrollMode).toBe('steps');
    await page.locator('#settingsRadio-trayScrollMode').selectOption('smooth');
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).trayScrollMode).toBe('smooth');
    await page.locator('#settingsRadio-resumeOnStart').check();
    await expect(page.locator('#settingsRadioPlaybackStatus')).toContainText('Gespeichert');
    expect((await page.evaluate(() => window.radio.getSettings())).resumeOnStart).toBe(true);
    await page.locator('#settingsRadio-pauseOnTv').uncheck();
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).pauseOnTv).toBe(false);
    await shot(page, 'radio-einstellungen-wiedergabe');
    await page.locator('#settingsRadio-resumeOnStart').uncheck();
    await page.locator('#settingsRadio-pauseOnTv').check();
    await expect.poll(async () => (await page.evaluate(() => window.radio.getSettings())).pauseOnTv).toBe(true);
    expect((await page.evaluate(() => window.radio.getSettings())).resumeOnStart).toBe(false);
    // die Lautstärke bleibt stumm (0), damit der Lauf nichts ausgibt
    expect((await radioState(page)).volume).toBe(0);
  });

  test('keine Konsolen- oder Seitenfehler im gesamten Ablauf', async () => {
    expect(ctx.problems).toEqual([]);
  });
});
