'use strict';

// E2E: LiveTV-Hub (Etappe 3.6b, Variante A) — zwei Einstiegskarten im LiveTV-Dashboard, Werkzeugleiste,
// NavBar-Indikator (P21), keine Dashboard-Vorschau „Jetzt im TV“ und keine linke TV-Sidebar mehr.
// Kein Netz: lokale M3U-Quelle + XMLTV-Fixture (Muster epg-helpers.js). Die laufende Aufnahme kommt von einem
// lokalen HLS-Live-Stream (127.0.0.1, Segment mit dem mitgelieferten ffmpeg erzeugt).
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp, waitForEpgChannels } = require('./epg-helpers');

const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg');
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const programme = (channel, title, start, stop) =>
  `<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="${channel}"><title>${title}</title><desc>Beschreibung zu ${title}</desc></programme>`;

function buildEpg(base) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>' +
    programme('E2E.de', 'Laufende Sendung', base - 30 * MIN, base + 30 * MIN) +
    programme('E2E.de', 'Kommende Sendung', base + 45 * MIN, base + 90 * MIN) +
    '</tv>'
  );
}

async function setWindowWidth(ctx, width) {
  await ctx.electronApp.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(300, 400);
    win.setSize(w, 800);
  }, width);
  await expect.poll(() => ctx.page.evaluate(() => window.innerWidth)).toBe(width);
}

async function openLiveTv(page) {
  await page.evaluate(() => window.document.getElementById('overlayLocation').click());
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  await expect(page.locator('#dashboardHub')).toBeVisible();
}

// ───────────────────────── Mit Favoriten, laufende Aufnahme per lokalem HLS-Live-Stream ─────────────────────────

test.describe('LiveTV-Hub (mit Favorit)', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let server;
  let streamUrl;
  let segDir;

  test.beforeAll(async () => {
    const base = Math.floor(Date.now() / MIN) * MIN;
    segDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-hls-'));
    const seg = path.join(segDir, 'seg.ts');
    execFileSync(
      FFMPEG,
      ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', seg],
      { timeout: 30_000 },
    );
    const t0 = Date.now();
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/live.m3u8')) {
        const n = Math.floor((Date.now() - t0) / 2000);
        const body = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${n}\n` + [0, 1, 2].map(i => `#EXTINF:2.0,\n/seg/${n + i}.ts\n`).join('');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        res.end(body);
      } else if (req.url.startsWith('/seg/')) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        fs.createReadStream(seg).pipe(res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    streamUrl = `http://127.0.0.1:${server.address().port}/live.m3u8`;

    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-hub-',
      epgXml: buildEpg(base),
      channels: [{ id: 'E2E.de', name: 'E2E Kanal', group: 'Test' }],
      favorites: ['E2E.de'],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 1);
    ctx.base = base;
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (server) await new Promise(resolve => server.close(resolve));
    if (segDir) fs.rmSync(segDir, { recursive: true, force: true });
  });

  test('Dashboard: zwei gleich große Karten (links Programmübersicht, rechts Aufnahmen), keine Vorschau, keine Sidebar', async () => {
    await openLiveTv(page);
    const epg = page.locator('#dashboardEpgOpen');
    const rec = page.locator('#dashboardRecordingsOpen');
    await expect(epg).toBeVisible();
    await expect(epg).toHaveText('Programmübersicht');
    await expect(rec).toBeVisible();
    await expect(rec).toHaveText('Aufnahmen');
    const cards = page.locator('.hub-card');
    await expect(cards).toHaveCount(2);
    // offset*-Maße: unabhängig von der Hover-Transformation der Karten
    const [a, b] = await cards.evaluateAll(els => els.map(e => ({ left: e.offsetLeft, top: e.offsetTop, width: e.offsetWidth })));
    expect(a.left).toBeLessThan(b.left);
    expect(Math.abs(a.width - b.width)).toBeLessThan(2);
    expect(a.top).toBe(b.top);
    // Statuszeilen
    await expect(page.locator('.hub-card-epg .hub-card-status')).toHaveText('EPG aktuell · 1 Favorit', { timeout: 20_000 });
    await expect(page.locator('.hub-card-recordings .hub-card-status')).toHaveText('Noch keine Aufnahmen');
    // Werkzeugleiste (ruhig, Labels sichtbar): drei Werkzeuge, kein „Alle Sender“-Button mehr
    await expect(page.locator('#dashboardTvActions .dashboard-hub-tool')).toHaveCount(3);
    for (const id of ['dashboardTvSettings', 'dashboardTvStatusBtn', 'dashboardTvRefresh']) await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator('#dashboardTvManage, #tvChannelManagerOverlay')).toHaveCount(0);
    await expect(page.locator('#dashboardTvRefresh .dashboard-hub-tool-label')).toHaveText('EPG aktualisieren');
    // Vorschau „Jetzt im TV“ und linke Sidebar sind weg
    await expect(page.locator('#dashboardEpg, .dashboard-epg-row, #tvSidebar, #tvSidebarTrigger, .tv-sidebar')).toHaveCount(0);
    // Senderraster bleibt
    await expect(page.locator('#dashboardGrid .dashboard-tv-tile')).toHaveCount(1);
  });

  test('Kein linker Rand-Trigger: Maus am linken Rand öffnet nichts', async () => {
    await page.mouse.move(2, 400);
    await page.waitForTimeout(500);
    await page.mouse.move(150, 400);
    await page.waitForTimeout(300);
    await expect(page.locator('.tv-sidebar, #tvSidebar')).toHaveCount(0);
    const hit = await page.evaluate(() => window.document.elementFromPoint(2, 400)?.className || '');
    expect(String(hit)).not.toContain('sidebar');
  });

  test('Klick auf „Programmübersicht“ öffnet den Programmführer; Esc schließt; Navigation bleibt intakt', async () => {
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(page.locator('.epg-program', { hasText: 'Kommende Sendung' })).toHaveCount(1, { timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgOverlay')).toBeHidden();
    await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  });

  test('Karte „Aufnahmen“ führt in den Aufnahmen-Bereich; die NavBar hat keinen Aufnahmen-Eintrag mehr', async () => {
    await expect(page.locator('#overlayNav [data-section="recording"]')).toHaveCount(0);
    await expect(page.locator('#overlayNav .nav-section-item')).toHaveCount(3); // LiveTV, Streaming, Mediatheken
    await page.locator('#dashboardRecordingsOpen').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Aufnahmen');
    await expect(page.locator('#dashboardView')).toHaveClass(/recordings-dashboard/);
    await page.locator('#overlayNav [data-section="livetv"]').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  });

  test('Planung erscheint live in der Statuszeile (geplant, rot statisch) und verschwindet beim Absagen', async () => {
    const status = page.locator('.hub-card-recordings .hub-card-status');
    const added = await page.evaluate(
      r => window.electronAPI.addSchedule(r),
      { channelId: 'E2E.de', channelName: 'E2E Kanal', tvgId: 'E2E.de', sourceId: 'e2e', title: 'Kommende Sendung', epgStart: iso(ctx.base + 45 * MIN), epgStop: iso(ctx.base + 90 * MIN) },
    );
    expect(added.ok).toBe(true);
    await expect(status).toHaveText('1 geplant');
    await expect(status.locator('.hub-dot-planned')).toHaveCount(1);
    await expect(status.locator('.hub-dot-live')).toHaveCount(0);
    const animation = await status.locator('.hub-dot-planned').evaluate(el => window.getComputedStyle(el).animationName);
    expect(animation).toBe('none');
    const [entry] = await page.evaluate(() => window.electronAPI.listSchedules());
    await page.evaluate(id => window.electronAPI.removeSchedule(id), entry.id);
    await expect(status).toHaveText('Noch keine Aufnahmen');
  });

  test('Laufende Aufnahme: NavBar-Punkt (pulsierend, mit Screenreader-Text), Karte „1 läuft“, Punkt auch in anderen Bereichen', async () => {
    const dot = page.locator('#overlayNav [data-section="livetv"] .nav-live-dot');
    await expect(dot).toBeHidden();
    const started = await page.evaluate(
      url => window.electronAPI.startRecording({ sourceUrl: url, channelId: 'E2E.de', channelName: 'E2E Kanal', epgTitle: 'Laufende Sendung', startOffsetSec: 0 }),
      streamUrl,
    );
    expect(started && started.recId).toBeTruthy();
    const status = page.locator('.hub-card-recordings .hub-card-status');
    await expect(status).toHaveText('1 läuft', { timeout: 20_000 });
    await expect(status.locator('.hub-dot-live')).toHaveCount(1);
    await expect(dot).toBeVisible();
    await expect(page.locator('#overlayNav [data-section="livetv"] .nav-live-sr')).toHaveText('Aufnahme läuft');
    await expect(page.locator('#overlayNav [data-section="livetv"] .nav-live-sr')).toBeAttached();
    // keine Zahl am Indikator
    expect((await dot.textContent()) || '').toBe('');
    expect(await dot.evaluate(el => window.getComputedStyle(el).animationName)).toBe('hubPulse');
    // bei „Bewegung reduzieren“ statisch
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await dot.evaluate(el => window.getComputedStyle(el).animationName)).toBe('none');
    expect(await status.locator('.hub-dot-live').evaluate(el => window.getComputedStyle(el).animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // anderer Bereich: Indikator bleibt sichtbar (Mediatheken)
    await page.locator('#overlayNav [data-section="mediathek"]').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Mediatheken');
    await expect(dot).toBeVisible();
    // Karte führt in den Aufnahmen-Bereich, dort ist die laufende Aufnahme erreichbar
    await page.locator('#overlayNav [data-section="livetv"]').click();
    await page.locator('#dashboardRecordingsOpen').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Aufnahmen');
    await expect(page.locator('#dashboardView')).toHaveClass(/recordings-dashboard/);
    await expect(page.locator('.recording-entry', { hasText: 'Laufende Aufnahme' }).first()).toBeVisible();
    // Beenden → Indikator weg, Karte zählt „1 fertig“ bzw. nicht mehr „läuft“
    await page.evaluate(id => window.electronAPI.stopRecording(id), started.recId);
    await expect(dot).toBeHidden({ timeout: 30_000 });
    await page.locator('#overlayNav [data-section="livetv"]').click();
    await expect(status).not.toContainText('läuft', { timeout: 30_000 });
  });

  test('Breiten: ≥ 900 nebeneinander mit Beschreibung; < 900 kompakt; < 640 gestapelt, Werkzeuge nur Icons', async () => {
    await openLiveTv(page);
    const geometry = () =>
      page.evaluate(() => {
        const [a, b] = [...window.document.querySelectorAll('.hub-card')].map(e => ({ top: e.offsetTop, bottom: e.offsetTop + e.offsetHeight }));
        const vis = sel => {
          const el = window.document.querySelector(sel);
          return !!el && window.getComputedStyle(el).display !== 'none';
        };
        return { sameRow: Math.abs(a.top - b.top) < 2, stacked: b.top >= a.bottom - 1, hint: vis('.hub-card-hint'), chevron: vis('.hub-card-chevron'), label: vis('.dashboard-hub-tool-label') };
      });
    await setWindowWidth(ctx, 1200);
    expect(await geometry()).toEqual({ sameRow: true, stacked: false, hint: true, chevron: true, label: true });
    await setWindowWidth(ctx, 800);
    expect(await geometry()).toEqual({ sameRow: true, stacked: false, hint: false, chevron: false, label: true });
    await setWindowWidth(ctx, 600);
    expect(await geometry()).toEqual({ sameRow: false, stacked: true, hint: false, chevron: false, label: false });
    // Werkzeuge bleiben als Icons bedienbar (Name über title)
    await expect(page.locator('#dashboardTvSettings')).toHaveAttribute('title', 'Senderverwaltung');
    await expect(page.locator('#dashboardTvRefresh')).toHaveAttribute('title', 'EPG aktualisieren');
    await setWindowWidth(ctx, 1200);
  });

  test('Verlaufsklick auf TV führt ins LiveTV-Dashboard (keine Sidebar)', async () => {
    await page.evaluate(() => window.electronAPI.saveHistoryEntry({ title: 'TV: E2E Kanal', serviceKey: '__tv__', serviceName: 'E2E Kanal' }));
    await page.locator('#overlayNav [data-section="mediathek"]').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('Mediatheken');
    await page.keyboard.press('Control+h');
    const entry = page.locator('.history-entry', { hasText: 'TV: E2E Kanal' }).first();
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
    await expect(page.locator('#dashboardHub')).toBeVisible();
    await expect(page.locator('#historyOverlay')).not.toHaveClass(/open/);
    await expect(page.locator('.tv-sidebar, #tvSidebar')).toHaveCount(0);
  });

  test('„Sender öffnen“ aus dem Programmführer wählt nur den Sender (Player), ohne Sidebar', async () => {
    await openLiveTv(page);
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await page.locator('.epg-program', { hasText: 'Kommende Sendung' }).first().click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await page.locator('#epgDetailWatchBtn').click();
    await expect(page.locator('#epgOverlay')).toBeHidden();
    await expect(page.locator('#dashboardView')).toBeHidden();
    await expect(page.locator('#tvView')).toBeVisible();
    await expect(page.locator('.tv-sidebar, #tvSidebar, #tvSidebarTrigger')).toHaveCount(0);
  });

  test('Keine uncaught Exceptions / unerwarteten Konsolen-Errors', async () => {
    expect(ctx.problems).toEqual([]);
  });
});

// ───────────────────────── Ohne Favoriten ─────────────────────────

test.describe('LiveTV-Hub (keine Favoriten)', () => {
  let ctx;
  let page;

  test.beforeAll(async () => {
    const base = Math.floor(Date.now() / MIN) * MIN;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-hubnofav-',
      epgXml: buildEpg(base),
      channels: [{ id: 'E2E.de', name: 'E2E Kanal', group: 'Test' }],
      favorites: [],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 1);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test('Programmübersicht-Karte zeigt den Hinweis, bleibt klickbar und öffnet den Programmführer', async () => {
    await openLiveTv(page);
    await expect(page.locator('.hub-card-epg .hub-card-status')).toHaveText('Favorisiere Sender, um die Programmübersicht zu sehen');
    await expect(page.locator('.hub-card-epg .hub-card-status')).toHaveClass(/is-warn/);
    await expect(page.locator('#dashboardEpgOpen')).toBeEnabled();
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', /./);
  });
});
