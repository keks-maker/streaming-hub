'use strict';

// E2E: Podcast-Oberfläche (P3) — Navigation, Dashboard (Leerzustand mit Kurzliste), Suche (gestubbter Suchdienst per
// STREAMING_HUB_E2E_PODCAST_SEARCH_URL, lokaler Feed), Abo, Sendungsseite, Wiedergabe (stumm, kurze Testdatei) und Mini-Player.
// Kein Netz außer localhost. Screenshots (optional): PODCAST_E2E_SHOTS=<Verzeichnis>.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');

const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg');
const SHOTS = process.env.PODCAST_E2E_SHOTS || '';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

function feedXml(base, title, items) {
  const entries = items
    .map(
      (item, index) =>
        `<item><title>${item.title}</title><guid>${item.guid}</guid><pubDate>${new Date(Date.now() - (index + 1) * 3600 * 1000).toUTCString()}</pubDate><itunes:duration>00:00:03</itunes:duration><enclosure url="${base}/${item.file}" type="audio/aac" length="0"/></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${title}</title><itunes:author>Test Autor</itunes:author><description>Beschreibung &lt;b&gt;nur Text&lt;/b&gt;</description><itunes:image href="${base}/cover.png"/>${entries}</channel></rss>`;
}

function startServer(tone) {
  const server = http.createServer((req, res) => {
    const base = `http://localhost:${server.address().port}`;
    const url = new URL(req.url, base);
    if (url.pathname === '/search') {
      if (url.searchParams.get('term') === 'limit') {
        res.writeHead(429).end('Too Many Requests');
        return;
      }
      const results =
        url.searchParams.get('term') === 'nichts'
          ? []
          : [{ collectionName: 'Testsendung fett', artistName: 'Test Autor', feedUrl: `${base}/feed.xml`, artworkUrl600: `${base}/cover.png`, primaryGenreName: 'Test' }];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ resultCount: results.length, results }));
    } else if (url.pathname === '/feed.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(feedXml(base, 'Testsendung fett', [{ title: 'Erste Folge', guid: 'g1', file: 'ep1.aac' }, { title: 'Zweite Folge', guid: 'g2', file: 'ep2.aac' }]));
    } else if (url.pathname === '/feed2.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(feedXml(base, 'Eigener Feed', [{ title: 'Eigene Folge', guid: 'h1', file: 'ep1.aac' }]));
    } else if (url.pathname === '/broken.xml') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>kein Feed</body></html>');
    } else if (url.pathname === '/cover.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
    } else if (url.pathname.endsWith('.aac')) {
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1] || 0);
        const end = Math.min(tone.length - 1, range[2] ? Number(range[2]) : tone.length - 1);
        res.writeHead(206, { 'Content-Type': 'audio/aac', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${tone.length}`, 'Content-Length': end - start + 1 }).end(tone.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Type': 'audio/aac', 'Accept-Ranges': 'bytes', 'Content-Length': tone.length }).end(tone);
      }
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function openPodcasts(page) {
  await page.evaluate(() => window.document.getElementById('overlayLocation').click());
  await page.locator('.dashboard-section-tile[data-section="podcasts"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Podcasts');
  await expect(page.locator('#podcastDashboard')).toBeVisible();
}

test.describe('Podcast-Oberfläche', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let server;
  let base;
  let tmpDir;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-podcast-'));
    const file = path.join(tmpDir, 'tone.aac');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', file], { timeout: 30_000 });
    server = await startServer(fs.readFileSync(file));
    base = `http://localhost:${server.address().port}`;
    const now = Math.floor(Date.now() / MIN) * MIN;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-podcast-',
      epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(now - 30 * MIN)}" stop="${xmltvTime(now + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
      channels: [{ id: 'E2E.de', name: 'E2E Kanal', group: 'Test' }],
      favorites: ['E2E.de'],
      env: { STREAMING_HUB_E2E_PODCAST_SEARCH_URL: `http://localhost:${server.address().port}/search` },
    });
    page = ctx.page;
    await page.evaluate(() => window.podcasts.player.setVolume(0));
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (server) await new Promise(resolve => server.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Navigation: Kachel und Nav-Eintrag direkt nach Radio; Leerzustand mit Suchfeld und Kurzliste', async () => {
    const order = await page.locator('.dashboard-section-tile').evaluateAll(els => els.map(e => e.dataset.section));
    expect(order.slice(0, 3)).toEqual(['livetv', 'radio', 'podcasts']);
    await shot(page, 'startseite');
    await openPodcasts(page);
    await expect(page.locator('#overlayLocation')).toHaveText('Podcasts');
    await expect(page.locator('#dashboardEyebrow')).toHaveText('Deine Podcasts');
    const navOrder = await page.locator('#overlayNav .nav-section-item').evaluateAll(els => els.map(e => e.dataset.section));
    expect(navOrder.slice(0, 3)).toEqual(['livetv', 'radio', 'podcasts']);
    await expect(page.locator('#overlayNav .nav-section-item[data-section="podcasts"]')).toHaveClass(/active/);
    await expect(page.locator('#podcastEmpty')).toBeVisible();
    await expect(page.locator('#podcastEmptySearch')).toBeVisible();
    await expect(page.locator('#podcastPopular .podcast-popular').first()).toBeVisible();
    expect(await page.locator('#podcastPopular .podcast-popular').count()).toBeLessThanOrEqual(8);
    await expect(page.locator('#podcastNewSection')).toBeHidden();
    await expect(page.locator('#podcastRefresh')).toBeDisabled();
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(0); // kein Abo ohne Klick
    await shot(page, 'podcasts-leer');
  });

  test('Suche: Entprellung, Trefferzahl, Text ohne Markup, Abo; Leer- und Rate-Limit-Hinweis', async () => {
    await page.locator('#podcastSearchOpen').click();
    await expect(page.locator('#podcastSearchInput')).toBeFocused();
    await page.locator('#podcastSearchInput').fill('limit');
    await expect(page.locator('#podcastSearchCount')).toContainText('später erneut', { timeout: 10_000 });
    await page.locator('#podcastSearchInput').fill('nichts');
    await expect(page.locator('#podcastSearchCount')).toContainText('Keine Treffer', { timeout: 10_000 });
    await page.locator('#podcastSearchInput').fill('Testsendung');
    await expect(page.locator('#podcastSearchCount')).toHaveText('1 Treffer', { timeout: 10_000 });
    const row = page.locator('#podcastSearchResults .podcast-result').first();
    await expect(row.locator('.podcast-show-title')).toHaveText('Testsendung fett');
    expect(await row.locator('b').count()).toBe(0);
    await shot(page, 'podcasts-suche');
    await row.getByRole('button', { name: /abonnieren/ }).click();
    await expect(row.locator('.podcast-btn')).toHaveText('Abonniert');
    await expect.poll(() => page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(1);
    // Cover (http) kommt über den Main als data:-URL
    await expect(row.locator('.podcast-cover img')).toHaveAttribute('src', /^data:image\/png/);
  });

  test('Dashboard nach Abo: Statuszeile, Neue Episoden, Meine Abos mit Badge', async () => {
    await page.locator('#podcastSearchBack').click();
    await expect(page.locator('#podcastNewSection')).toBeVisible();
    await expect(page.locator('#podcastStatus')).toContainText('1 Abo · 2 neue Episoden · geprüft');
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(2);
    await expect(page.locator('#podcastShowGrid .podcast-show')).toHaveCount(1);
    await expect(page.locator('#podcastShowGrid .podcast-badge')).toHaveText('2');
    await expect(page.locator('#podcastEmpty')).toBeHidden();
    await expect(page.locator('#podcastRefresh')).toBeEnabled();
    await shot(page, 'podcasts-dashboard');
  });

  test('Wiedergabe: Klick auf eine neue Episode spielt, aktive Zeile markiert, Mini-Player zeigt den Podcast', async () => {
    const first = page.locator('#podcastNewList .podcast-episode-main').first();
    await first.click();
    await expect.poll(() => page.evaluate(() => window.podcasts.player.getState().then(s => s.status)), { timeout: 15_000 }).toMatch(/playing|loading|ended/);
    await expect(page.locator('#radioMiniPlayer')).toBeVisible();
    await expect(page.locator('#radioMiniPlayer')).toHaveAttribute('data-mode', 'podcast');
    await expect(page.locator('#radioMiniPlayer .radio-mini-name')).toHaveText('Testsendung fett');
    await expect(page.locator('#podcastNewList .podcast-episode.is-active, #podcastNewList .podcast-episode[data-state="played"]').first()).toBeVisible();
    await shot(page, 'podcasts-spielt');
  });

  test('Mini-Player: Klick auf den Titel öffnet die Sendungsseite; Episodenliste, Markieren, Abo-Knopf', async () => {
    await page.locator('#radioMiniInfo').click();
    await expect(page.locator('#podcastPanel-show')).toBeVisible();
    await expect(page.locator('#podcastShowTitle')).toHaveText('Testsendung fett');
    await expect(page.locator('.podcast-show-description')).toHaveText('Beschreibung nur Text');
    await expect(page.locator('#podcastEpisodeList .podcast-episode')).toHaveCount(2);
    await expect(page.locator('#podcastSubscribe')).toHaveText('Abbestellen');
    await shot(page, 'podcasts-sendung');
    const second = page.locator('#podcastEpisodeList .podcast-episode', { hasText: 'Zweite Folge' });
    await second.locator('.podcast-episode-mark').click();
    await expect(second).toHaveAttribute('data-state', 'played');
    await second.locator('.podcast-episode-mark').click();
    await expect(second).not.toHaveAttribute('data-state', 'played');
    await page.locator('#podcastMarkAll').click();
    await expect(page.locator('#podcastEpisodeList .podcast-episode[data-state="played"]')).toHaveCount(2);
    await expect(page.locator('#podcastMarkAll')).toBeDisabled();
  });

  test('Zurück: Sendungsseite → Dashboard; Podcast-Navigation bleibt im Verlauf', async () => {
    await page.locator('#podcastShowBack').click();
    await expect(page.locator('#podcastPanel-home')).toBeVisible();
    await expect(page.locator('#podcastPanel-show')).toBeHidden();
    await expect(page.locator('#podcastNewEmpty')).toBeVisible(); // alles gehört
    await page.locator('#podcastShowGrid .podcast-show-btn').first().click();
    await expect(page.locator('#podcastPanel-show')).toBeVisible();
    await page.evaluate(() => document.getElementById('backBtn').click()); // Navigationsleiste fängt Mausklicks ab, solange sie eingeblendet ist
    await expect(page.locator('#podcastPanel-home')).toBeVisible();
  });

  test('Eigener Feed: Fehler beim Prüfen ohne Abo; gültiger Feed erst nach Bestätigung abonniert', async () => {
    await page.locator('#podcastSearchOpen').click();
    await page.locator('#podcastFeedUrl').fill(`${base}/broken.xml`);
    await page.locator('#podcastFeedCheck').click();
    await expect(page.locator('#podcastFeedMessage')).toContainText('Kein gültiger Podcast-Feed');
    await expect(page.locator('#podcastFeedPreview')).toBeHidden();
    await page.locator('#podcastFeedUrl').fill(`${base}/feed2.xml`);
    await page.locator('#podcastFeedCheck').click();
    await expect(page.locator('#podcastFeedPreview')).toBeVisible();
    await expect(page.locator('#podcastFeedPreview')).toContainText('Eigener Feed');
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(1); // geprüft, nicht abonniert
    await shot(page, 'podcasts-eigener-feed');
    await page.locator('#podcastFeedConfirm').click();
    await expect(page.locator('#podcastPanel-show')).toBeVisible();
    await expect(page.locator('#podcastShowTitle')).toHaveText('Eigener Feed');
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(2);
    await page.locator('#podcastSubscribe').click(); // abbestellen → zurück zur Übersicht
    await expect(page.locator('#podcastPanel-home')).toBeVisible();
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(1);
  });

  test('Keine Konsolenfehler', async () => {
    expect(ctx.problems).toEqual([]);
  });
});
