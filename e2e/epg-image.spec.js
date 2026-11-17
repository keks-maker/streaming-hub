'use strict';

// E2E: Senderkachel mit EPG-Vorschaubild (S2). Kein Netz: Bilder und Live-Stream kommen von einem lokalen Server
// (127.0.0.1); der Main lädt das Bild (STREAMING_HUB_EPG_IMAGE_LOCAL=1 erlaubt dort lokale Ziele), verkleinert und
// legt es unter <temp-userData>/cache/epg-images ab. Muster: livetv-hub.spec.js.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp, waitForEpgChannels } = require('./epg-helpers');

const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg');

test.describe('Senderkachel mit EPG-Bild', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let server;
  let port;
  let workDir;
  const hits = [];

  test.beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-epgimg-'));
    const seg = path.join(workDir, 'seg.ts');
    const jpg = path.join(workDir, 'big.jpg');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=1', '-frames:v', '1', '-y', jpg], { timeout: 30_000 });
    execFileSync(
      FFMPEG,
      ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', seg],
      { timeout: 30_000 },
    );
    const t0 = Date.now();
    server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url.startsWith('/img/ok.jpg')) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        fs.createReadStream(jpg).pipe(res);
      } else if (req.url.startsWith('/img/html.jpg')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
      } else if (req.url.startsWith('/live.m3u8')) {
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
    port = server.address().port;
    const base = Math.floor(Date.now() / MIN) * MIN;
    const prog = (ch, title, icon) =>
      `<programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="${ch}"><title>${title}</title>${icon ? `<icon src="${icon}"/>` : ''}</programme>`;
    const origin = `http://127.0.0.1:${port}`;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgimg-',
      epgXml:
        '<?xml version="1.0" encoding="UTF-8"?><tv>' +
        ['A', 'B', 'C', 'D'].map(k => `<channel id="${k}.de"><display-name>Kanal ${k}</display-name></channel>`).join('') +
        prog('A.de', 'Mit Bild', `${origin}/img/ok.jpg`) +
        prog('B.de', 'Bild fehlt', `${origin}/img/missing.jpg`) +
        prog('C.de', 'Ohne Bild', '') +
        prog('D.de', 'Falscher Typ', `${origin}/img/html.jpg`) +
        '</tv>',
      channels: [
        { id: 'A.de', name: 'Kanal A', logo: '@file' },
        { id: 'B.de', name: 'Kanal B', logo: '@file' },
        { id: 'C.de', name: 'Sender ohne Logo' },
        { id: 'D.de', name: 'Kanal D', logo: '@file' },
      ],
      favorites: ['A.de', 'B.de', 'C.de', 'D.de'],
      env: { STREAMING_HUB_EPG_IMAGE_LOCAL: '1' },
    });
    page = ctx.page;
    await waitForEpgChannels(page, 4);
  });

  test('Bild erscheint, Fehler und falscher Typ fallen auf den Verlauf zurück, ohne Logo Anfangsbuchstabe, Cache verkleinert', async () => {
    await page.evaluate(() => window.document.getElementById('overlayLocation').click());
    await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
    await expect(page.locator('#dashboardHub')).toBeVisible();
    const tile = name => page.locator('#dashboardGrid .dashboard-tv-tile').filter({ has: page.locator('.tv-tile-title, .tv-tile-meta', { hasText: new RegExp(`^${name}`) }) });
    // Kachel steht sofort da, Bild kommt asynchron
    await expect(tile('Mit Bild').locator('.tv-tile-still.has-image .tv-tile-image')).toHaveCount(1, { timeout: 15_000 });
    const img = tile('Mit Bild').locator('.tv-tile-image');
    expect(await img.evaluate(el => el.decoding)).toBe('async');
    expect(await img.evaluate(el => el.src.startsWith('data:image/jpeg;base64,'))).toBe(true);
    const natural = await img.evaluate(el => el.naturalWidth);
    expect(natural).toBeGreaterThan(0);
    expect(natural).toBeLessThanOrEqual(560);
    // Fallbacks: Verlauf mit Platzhalter, kein <img>
    for (const name of ['Bild fehlt', 'Falscher Typ', 'Ohne Bild']) {
      await expect(tile(name).locator('.tv-tile-image')).toHaveCount(0);
      await expect(tile(name).locator('.tv-tile-still .ic')).toHaveCount(1);
    }
    // Sender ohne Logo: Anfangsbuchstabe sichtbar, kein leeres <img>
    const noLogo = tile('Sender ohne Logo').locator('.tv-tile-logo');
    await expect(noLogo.locator('img')).toHaveCount(0);
    await expect(noLogo.locator('.dashboard-tile-fallback')).toBeVisible();
    await expect(noLogo.locator('.dashboard-tile-fallback')).toHaveText('S');
    // Cache: genau eine Datei <hash>.jpg, im Temp-userData, JPEG
    const dir = path.join(ctx.userData, 'cache', 'epg-images');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.jpg$/);
    expect(fs.readFileSync(path.join(dir, files[0])).subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(fs.statSync(path.join(dir, files[0])).size).toBeLessThan(fs.statSync(path.join(workDir, 'big.jpg')).size);
    // Zweites Rendern lädt nicht erneut aus dem Netz
    const before = hits.filter(u => u.startsWith('/img/ok.jpg')).length;
    await page.evaluate(() => window.document.getElementById('overlayLocation').click());
    await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
    await expect(tile('Mit Bild').locator('.tv-tile-still.has-image')).toHaveCount(1, { timeout: 10_000 });
    expect(hits.filter(u => u.startsWith('/img/ok.jpg')).length).toBe(before);
  });

  test('Hover: Bild bleibt bis zum ersten Videobild, dann Überblendung; beim Verlassen zurück zum Bild', async () => {
    const tile = page.locator('#dashboardGrid .dashboard-tv-tile', { hasText: 'Mit Bild' });
    const streamUrl = `http://127.0.0.1:${port}/live.m3u8`;
    await page.route('http://streams.invalid/**', async route => {
      const url = route.request().url();
      const target = url.includes('.m3u8') ? streamUrl : `${streamUrl.replace('/live.m3u8', '')}${new URL(url).pathname}`;
      const res = await fetch(target);
      let body = Buffer.from(await res.arrayBuffer());
      if (url.includes('.m3u8')) body = Buffer.from(body.toString().replace(/\/seg\//g, 'http://streams.invalid/seg/'));
      await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': res.headers.get('content-type') }, body });
    });
    await tile.hover();
    await expect(tile).toHaveClass(/is-previewing/, { timeout: 20_000 });
    const video = tile.locator('.tv-tile-media > video.dashboard-tv-preview');
    await expect.poll(() => video.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
    // Das Bild liegt unter dem Video und bleibt im DOM
    await expect(tile.locator('.tv-tile-still.has-image .tv-tile-image')).toHaveCount(1);
    await page.mouse.move(2, 400);
    await expect(tile).not.toHaveClass(/is-previewing/);
    await expect(tile.locator('video')).toHaveCount(0, { timeout: 3000 });
    await expect(tile.locator('.tv-tile-still.has-image')).toHaveCount(1);
  });

  test('Jetzt & Gleich: dieselbe Kachel mit Bild; Hover und Tastaturfokus starten die Vorschau, nur eine gleichzeitig', async () => {
    await page.locator('#dashboardEpgOpen').evaluate(el => el.click());
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await page.locator('#epgModeJng').click();
    const tile = name => page.locator('#epgJngItems .epg-jtile', { has: page.locator('.tv-tile-title', { hasText: name }) });
    // Bild der laufenden Sendung (EPG-Bild-Cache), Verlauf bei fehlendem/falschem Bild
    await expect(tile('Mit Bild').locator('.tv-tile-still.has-image .tv-tile-image')).toHaveCount(1, { timeout: 15_000 });
    expect(await tile('Mit Bild').locator('.tv-tile-image').evaluate(el => el.src.startsWith('data:image/jpeg;base64,'))).toBe(true);
    await expect(tile('Bild fehlt').locator('.tv-tile-image')).toHaveCount(0);
    await expect(tile('Bild fehlt').locator('.tv-tile-still .ic')).toHaveCount(1);
    // Hover: Bild bleibt bis zum ersten Videobild, dann Überblendung
    await tile('Mit Bild').hover();
    await expect(tile('Mit Bild')).toHaveClass(/is-previewing/, { timeout: 20_000 });
    const video = tile('Mit Bild').locator('.tv-tile-media > video.dashboard-tv-preview');
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
    await expect(tile('Mit Bild').locator('.tv-tile-still.has-image')).toHaveCount(1);
    // andere Kachel per Tastaturfokus: die erste Vorschau endet, es läuft nur eine
    await page.mouse.move(2, 400);
    await expect(tile('Mit Bild')).not.toHaveClass(/is-previewing/);
    await tile('Bild fehlt').locator('.tv-tile-title.epg-row-open').focus();
    await expect(tile('Bild fehlt')).toHaveClass(/is-previewing/, { timeout: 20_000 });
    await expect(page.locator('#epgJngItems video.dashboard-tv-preview')).toHaveCount(1);
    await tile('Ohne Bild').hover();
    await expect(tile('Ohne Bild')).toHaveClass(/is-previewing/, { timeout: 20_000 });
    await expect(tile('Bild fehlt')).not.toHaveClass(/is-previewing/);
    await expect(page.locator('#epgJngItems video.dashboard-tv-preview')).toHaveCount(1, { timeout: 3000 });
    await page.mouse.move(2, 400);
    await page.locator('#epgCloseBtn').click();
    await expect(page.locator('#epgOverlay')).toBeHidden();
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (server) await new Promise(resolve => server.close(resolve));
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });
});
