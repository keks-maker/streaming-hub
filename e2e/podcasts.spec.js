'use strict';

// E2E: Podcast-Oberfläche (P3) — Navigation, Dashboard (Leerzustand mit Kurzliste), Suche (gestubbter Suchdienst per
// STREAMING_HUB_E2E_PODCAST_SEARCH_URL, lokaler Feed), Abo, Sendungsseite, Wiedergabe (stumm, kurze Testdatei) und Mini-Player.
// Kein Netz außer localhost. Screenshots (optional): PODCAST_E2E_SHOTS=<Verzeichnis>.
const { test, expect } = require('@playwright/test');
const { shotBoth } = require('./theme-audit');
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
  await shotBoth(page, SHOTS, name);
};

function feedXml(base, title, items) {
  const entries = items
    .map(
      (item, index) =>
        `<item><title>${item.title}</title><guid>${item.guid}</guid><pubDate>${new Date(Date.now() - (index + 1) * 3600 * 1000).toUTCString()}</pubDate><itunes:duration>00:00:03</itunes:duration><enclosure url="${base}/${item.file}" type="audio/aac" length="0"/>${item.extra || ''}</item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${title}</title><itunes:author>Test Autor</itunes:author><description>Beschreibung &lt;b&gt;nur Text&lt;/b&gt;</description><itunes:image href="${base}/cover.png"/>${entries}</channel></rss>`;
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
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(feedXml(base, 'Testsendung fett', [
          {
            title: 'Erste Folge',
            guid: 'g1',
            file: 'ep1.aac',
            extra: `<content:encoded><![CDATA[<h3>Kapitel\u00fcbersicht</h3><p>Absatz eins mit <a href="https://example.org/x">Link</a> und <a href="javascript:window.__pwned=3">b\u00f6ser Link</a></p><p>Absatz zwei <b>fett</b> <a href="mailto:test@example.org">Mail</a></p><ul><li>Punkt A</li><li>Punkt B</li></ul><table><tr><th>Name</th><th>Wert</th></tr><tr><td>x</td><td>1</td></tr></table><blockquote>Zitat</blockquote><pre>code zeile</pre><img src="${base}/shownote.png" alt="Testbild" width="1" height="1"><script>window.__pwned = 1</script><img src="x" onerror="window.__pwned = 2"><iframe src="https://example.org/"></iframe>]]></content:encoded><podcast:chapters url="${base}/chapters.json" type="application/json+chapters"/>`,
          },
          { title: 'Zweite Folge', guid: 'g2', file: 'ep2.aac' },
        ]));
    } else if (url.pathname === '/chapters.json') {
      res.writeHead(200, { 'Content-Type': 'application/json+chapters' }).end(JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Anfang' }, { startTime: 2, title: 'Ende-Kapitel' }] }));
    } else if (url.pathname === '/feed2.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(feedXml(base, 'Eigener Feed', [{ title: 'Eigene Folge', guid: 'h1', file: 'ep1.aac' }]));
    } else if (url.pathname === '/feed3.xml') {
      const items = Array.from({ length: 8 }, (_, i) => ({ title: `Viele ${i + 1}`, guid: `v${i + 1}`, file: 'ep2.aac' }));
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(feedXml(base, 'Viele Folgen', items));
    } else if (url.pathname === '/broken.xml') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>kein Feed</body></html>');
    } else if (url.pathname === '/cover.png' || url.pathname === '/shownote.png') {
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
    const colors = await page.locator('.dashboard-section-tile').evaluateAll(els => Object.fromEntries(els.map(e => [e.dataset.section, e.style.getPropertyValue('--tile-color').trim()])));
    expect(colors.podcasts).not.toBe(colors.livetv);
    expect(colors.podcasts).toBe('#5af2a6');
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
    await expect(page.locator('#podcastSplit')).toBeHidden();
    await expect(page.locator('#podcastRefresh')).toBeDisabled();
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(0); // kein Abo ohne Klick
    await shot(page, 'podcasts-leer');
  });

  test('Suche: Entprellung, Trefferzahl, Text ohne Markup, Abo; Leer- und Rate-Limit-Hinweis', async () => {
    await page.locator('#podcastSearchOpen').click();
    await expect(page.locator('#podcastSearchInput')).toBeFocused();
    // ohne Suchbegriff: Vorschläge aus dem mitgelieferten Katalog (nichts wird automatisch abonniert)
    await expect(page.locator('#podcastSuggestHeading')).toHaveText('Beliebte öffentlich-rechtliche Sendungen');
    const suggestions = page.locator('#podcastSuggestions .podcast-popular');
    await expect(suggestions.first()).toBeVisible();
    expect(await suggestions.count()).toBeLessThanOrEqual(8);
    expect(await suggestions.count()).toBeGreaterThan(0);
    await expect(suggestions.first().getByRole('button')).toHaveText('Abonnieren');
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(0);
    await shot(page, 'podcasts-suche-vorschlaege');
    await page.locator('#podcastSearchInput').fill('a');
    await expect(page.locator('#podcastSuggestSection')).toBeVisible(); // zu kurz: noch keine Suche
    await page.locator('#podcastSearchInput').fill('limit');
    await expect(page.locator('#podcastSuggestSection')).toBeHidden();
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
    await page.locator('#podcastSearchInput').fill('');
    await expect(page.locator('#podcastSuggestSection')).toBeVisible(); // Suchfeld leer: Vorschläge wieder da
  });

  test('Dashboard nach Abo: zweigeteilt, Abo-Liste mit „Alle neuen Episoden“ zuerst, Statuszeile, Badge', async () => {
    await page.locator('#podcastSearchBack').click();
    await expect(page.locator('#podcastSplit')).toBeVisible();
    await expect(page.locator('#podcastStatus')).toContainText('1 Abo · 2 neue Episoden · geprüft');
    const entries = page.locator('#podcastShowGrid .podcast-show');
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText('Alle neuen Episoden');
    await expect(entries.first().locator('.podcast-show-btn')).toHaveAttribute('aria-current', 'true');
    await expect(entries.nth(1).locator('.podcast-badge')).toHaveText('2');
    await expect(page.locator('#podcastNewHeading')).toHaveText('Alle neuen Episoden');
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(2);
    await expect(page.locator('#podcastOpenShow')).toBeHidden();
    await expect(page.locator('#podcastEmpty')).toBeHidden();
    await expect(page.locator('#podcastRefresh')).toBeEnabled();
    await shot(page, 'podcasts-dashboard');
  });

  test('Episoden-Overlay: Klick auf die Zeile öffnet Shownotes mit Elementen, spielt nicht; Kapitel; Fokusfalle, Esc, Fokus zurück', async () => {
    const row = page.locator('#podcastNewList .podcast-episode', { hasText: 'Erste Folge' });
    const main = row.locator('.podcast-episode-main');
    await main.click();
    const dialog = page.locator('#podcastOverlay [role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#podcastOverlayTitle')).toHaveText('Erste Folge');
    await expect(page.locator('#podcastOverlayShow')).toHaveText('Testsendung fett');
    await expect(page.locator('#podcastOverlayMeta')).toContainText('Neu');
    expect(await page.evaluate(() => window.podcasts.player.getState().then(s => s.status))).toBe('idle'); // bloßer Klick startet nichts
    const notes = page.locator('#podcastOverlayNotes');
    await expect(notes.locator('h3')).toHaveText('Kapitelübersicht');
    await expect(notes.locator('p').first()).toContainText('Absatz eins mit Link und böser Link');
    await expect(notes.locator('ul > li')).toHaveText(['Punkt A', 'Punkt B']);
    await expect(notes.locator('table th')).toHaveText(['Name', 'Wert']);
    await expect(notes.locator('blockquote')).toHaveText('Zitat');
    await expect(notes.locator('pre')).toHaveText('code zeile');
    await expect(notes.locator('strong')).toHaveText('fett');
    // bösartiges Material ist weg: kein Skript/Frame, kein javascript:-Link, keine Ereignis-Attribute
    expect(await notes.locator('script, iframe, form, style, object, [onerror], [onclick], a[href^="javascript" i]').count()).toBe(0);
    expect(await notes.locator('a').evaluateAll(els => els.map(e => e.getAttribute('href')))).toEqual(['https://example.org/x', 'mailto:test@example.org']);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    await expect(page.locator('#podcastOverlayChapters')).toBeVisible();
    await expect(page.locator('#podcastOverlayChapters .podcast-chapter-btn')).toHaveCount(2);
    await expect(page.locator('#podcastOverlayChapters .podcast-chapter-btn').nth(1)).toContainText('Ende-Kapitel');
    await expect(page.locator('#podcastOverlayPlay')).toBeFocused();
    await shot(page, 'podcasts-overlay');
    // Fokusfalle: Tab wandert nie aus dem Dialog heraus
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('#podcastOverlay')))).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('#podcastOverlay')))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#podcastOverlay')).toHaveCount(0);
    await expect(main).toBeFocused();
    // Episode ohne Shownotes/Kapitel: Hinweis, kein leerer Kapitelbereich
    await page.locator('#podcastNewList .podcast-episode', { hasText: 'Zweite Folge' }).locator('.podcast-episode-main').click();
    await expect(page.locator('#podcastOverlayTitle')).toHaveText('Zweite Folge');
    await expect(page.locator('#podcastOverlayNotes')).toHaveText('Zu dieser Episode gibt es keine Shownotes.');
    await expect(page.locator('#podcastOverlayChapters')).toBeHidden();
    await page.locator('#podcastOverlayClose').click();
    await expect(page.locator('#podcastOverlay')).toHaveCount(0);
  });

  test('Shownotes: Link-Klick geht über den Main (Stub), Tastatur, Bild über den Main mit Allowlist, Einstellung „Bilder laden“, Navigation unverändert', async () => {
    const urlBefore = page.url();
    await page.locator('#podcastNewList .podcast-episode', { hasText: 'Erste Folge' }).locator('.podcast-episode-main').click();
    const notes = page.locator('#podcastOverlayNotes');
    const link = notes.locator('a', { hasText: 'Link' }).first();
    await expect(link).toHaveAttribute('href', 'https://example.org/x');
    await expect(link).toHaveAttribute('title', 'https://example.org/x');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await link.getAttribute('target')).toBeNull();
    const opened = () => ctx.electronApp.evaluate(() => (globalThis.__streamingHubTest && globalThis.__streamingHubTest.openedLinks) || []);
    expect(await opened()).toEqual([]);
    await link.click();
    await expect.poll(opened).toEqual(['https://example.org/x']);
    expect(page.url()).toBe(urlBefore); // keine Navigation des Hauptfensters
    await link.focus();
    await page.keyboard.press('Enter');
    await expect.poll(opened).toEqual(['https://example.org/x', 'https://example.org/x']);
    await expect(page.locator('#podcastOverlay')).toHaveCount(1); // Overlay bleibt offen
    // Mailto öffnet erst nach Klick
    await notes.locator('a[href^="mailto:"]').click();
    await expect.poll(opened).toHaveLength(3);
    expect((await opened())[2]).toBe('mailto:test@example.org');
    // Bild lädt über den Main (data:-URL), Alt-Text bleibt
    const image = notes.locator('img');
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(image).toHaveAttribute('alt', 'Testbild');
    // Allowlist: nur Bilder aus den Shownotes der Episode; direkter Aufruf fremder Adressen bleibt ohne Abruf
    const check = await page.evaluate(async base => {
      const [sub] = await window.podcasts.list();
      const { episodes } = await window.podcasts.episodes(sub.id);
      const key = { podcastId: sub.id, episodeId: episodes.find(e => e.title === 'Erste Folge').id };
      return {
        inNotes: (await window.podcasts.getShownoteImage({ ...key, url: `${base}/shownote.png` })).ok,
        foreign: (await window.podcasts.getShownoteImage({ ...key, url: `${base}/cover.png` })).ok,
      };
    }, base);
    expect(check).toEqual({ inNotes: true, foreign: false }); // ungültige Adressen/Schemas prüfen die Unit-Tests (IPC-Fehler würden als Konsolenfehler zählen)
    expect(await opened()).toHaveLength(3);
    await shot(page, 'podcasts-shownotes');
    // Einstellung aus: kein Bild, Alt-Text als Platzhalter mit Hinweis
    await page.evaluate(() => window.podcasts.setSettings({ loadShownoteImages: false }));
    await page.keyboard.press('Escape');
    await expect(page.locator('#podcastOverlay')).toHaveCount(0);
    await page.locator('#podcastNewList .podcast-episode', { hasText: 'Erste Folge' }).locator('.podcast-episode-main').click();
    await expect(notes.locator('h3')).toBeVisible();
    await expect(notes.locator('img')).toHaveCount(0);
    await expect(notes.locator('.podcast-notes-img-alt')).toHaveText('Testbild');
    await expect(notes.locator('.podcast-notes-images-off')).toBeVisible();
    await page.evaluate(() => window.podcasts.setSettings({ loadShownoteImages: true }));
    await page.keyboard.press('Escape');
    await expect(page.locator('#podcastOverlay')).toHaveCount(0);
    expect(page.url()).toBe(urlBefore);
  });

  test('Wiedergabe: Play-Knopf der Zeile spielt, aktive Zeile markiert, Mini-Player zeigt den Podcast', async () => {
    const first = page.locator('#podcastNewList .podcast-episode-play').first();
    await first.click();
    await expect.poll(() => page.evaluate(() => window.podcasts.player.getState().then(s => s.status)), { timeout: 15_000 }).toMatch(/playing|loading|ended/);
    await expect(page.locator('#radioMiniPlayer')).toBeVisible();
    await expect(page.locator('#radioMiniPlayer')).toHaveAttribute('data-mode', 'podcast');
    await expect(page.locator('#radioMiniPlayer .radio-mini-name')).toHaveText('Testsendung fett');
    await expect(page.locator('#podcastNewList .podcast-episode.is-active, #podcastNewList .podcast-episode[data-state="played"]').first()).toBeVisible();
    await shot(page, 'podcasts-spielt');
  });

  test('Kapitel: Mini-Player zeigt das aktuelle Kapitel; Klick auf ein Kapitel im Overlay springt dorthin', async () => {
    const key = await page.evaluate(() => window.podcasts.player.getState().then(s => s.episode));
    expect(key.title).toBe('Erste Folge');
    await expect(page.locator('#radioMiniPlayer .radio-mini-chapter')).toContainText(/Kapitel \d\/2: /, { timeout: 10_000 });
    await page.locator('#podcastNewList .podcast-episode', { hasText: 'Erste Folge' }).locator('.podcast-episode-main').click();
    await page.locator('#podcastOverlayChapters .podcast-chapter-btn').nth(1).click();
    await expect(page.locator('#radioMiniPlayer .radio-mini-chapter')).toHaveText('Kapitel 2/2: Ende-Kapitel', { timeout: 10_000 });
    const state = await page.evaluate(() => window.podcasts.player.getState());
    expect(state.position).toBeGreaterThanOrEqual(1.9);
    await expect(page.locator('#podcastOverlayChapters .podcast-chapter.is-current')).toContainText('Ende-Kapitel');
    await page.keyboard.press('Escape');
    await expect(page.locator('#podcastOverlay')).toHaveCount(0);
    await shot(page, 'podcasts-kapitel');
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
    await page.locator('#podcastShowGrid .podcast-show-btn').nth(1).click();
    await page.locator('#podcastOpenShow').click();
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
  });

  test('Zweispaltig: Auswahl filtert rechts, Filter „ungehört“, Sortierung, Sitzung bleibt über die Sendungsseite erhalten, Tastatur', async () => {
    const viewOf = () => page.locator('#podcastDashboard').getAttribute('data-view');
    for (let i = 0; i < 3 && (await viewOf()) !== 'home'; i += 1) {
      const before = await viewOf();
      await page.evaluate(() => document.getElementById('backBtn').click()); // zurück durch Sendungsseite und Suche
      await expect.poll(viewOf).not.toBe(before);
    }
    await expect(page.locator('#podcastPanel-home')).toBeVisible();
    const entries = page.locator('#podcastShowGrid .podcast-show');
    await expect(entries).toHaveCount(3);
    const own = entries.filter({ hasText: 'Eigener Feed' });
    await own.locator('.podcast-show-btn').click();
    await expect(page.locator('#podcastNewHeading')).toHaveText('Eigener Feed');
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(1);
    await expect(page.locator('#podcastNewList')).toContainText('Eigene Folge');
    await expect(own.locator('.podcast-show-btn')).toHaveAttribute('aria-current', 'true');
    await expect(entries.first().locator('.podcast-show-btn')).not.toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.podcast-filter')).toBeVisible();
    await expect(page.locator('#podcastOpenShow')).toBeVisible();
    // „Alle neuen Episoden“: wieder die gemeinsame Liste (Testsendung ist komplett gehört, Eigener Feed hat eine neue Folge)
    await entries.first().locator('.podcast-show-btn').click();
    await expect(page.locator('#podcastNewHeading')).toHaveText('Alle neuen Episoden');
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(1);
    await expect(page.locator('.podcast-filter')).toBeHidden();
    // Testsendung: alle Episoden (auch gehörte), dann nur neue
    const show = entries.filter({ hasText: 'Testsendung fett' });
    await show.locator('.podcast-show-btn').click();
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(2);
    await page.locator('#podcastNewList .podcast-episode', { hasText: 'Erste Folge' }).locator('.podcast-episode-mark').click(); // → ungehört
    await page.getByRole('button', { name: 'Nur neue' }).click();
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(1);
    await expect(page.locator('#podcastNewList')).toContainText('Erste Folge');
    await page.getByRole('button', { name: 'Alle Episoden', exact: true }).click();
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(2);
    // Sortierung
    const titles = () => page.locator('#podcastNewList .podcast-episode-title').allTextContents();
    expect(await titles()).toEqual(['Erste Folge', 'Zweite Folge']);
    await page.locator('#podcastSort').selectOption('oldest');
    await expect.poll(titles).toEqual(['Zweite Folge', 'Erste Folge']);
    await shot(page, 'podcasts-zweispaltig');
    // Sitzung: Sendungsseite öffnen (Knopf), Sortierung gilt dort, zurück → Auswahl und Sortierung erhalten
    await page.locator('#podcastOpenShow').click();
    await expect(page.locator('#podcastPanel-show')).toBeVisible();
    await expect(page.locator('#podcastShowSort')).toHaveValue('oldest');
    await expect.poll(() => page.locator('#podcastEpisodeList .podcast-episode-title').allTextContents()).toEqual(['Zweite Folge', 'Erste Folge']);
    await page.evaluate(() => document.getElementById('backBtn').click());
    await expect(page.locator('#podcastPanel-home')).toBeVisible();
    await expect(page.locator('#podcastNewHeading')).toHaveText('Testsendung fett');
    await expect(page.locator('#podcastSort')).toHaveValue('oldest');
    // Doppelklick auf einen Abo-Eintrag öffnet die Sendungsseite
    await show.locator('.podcast-show-btn').dblclick();
    await expect(page.locator('#podcastPanel-show')).toBeVisible();
    await page.evaluate(() => document.getElementById('backBtn').click());
    // Tastatur: Pfeil runter in der Abo-Liste wählt den nächsten Eintrag, Pfeil hoch den vorigen
    await entries.first().locator('.podcast-show-btn').click();
    await entries.first().locator('.podcast-show-btn').focus();
    await page.keyboard.press('ArrowDown');
    await expect(entries.nth(1).locator('.podcast-show-btn')).toBeFocused();
    await expect(entries.nth(1).locator('.podcast-show-btn')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#podcastNewHeading')).toHaveText('Alle neuen Episoden');
    // Abbestellen der ausgewählten Sendung: Auswahl fällt auf „Alle neuen Episoden“ zurück
    await own.locator('.podcast-show-btn').click();
    await page.locator('#podcastOpenShow').click();
    await page.locator('#podcastSubscribe').click();
    await expect(page.locator('#podcastPanel-home')).toBeVisible();
    await expect(entries).toHaveCount(2);
    await expect(page.locator('#podcastNewHeading')).toHaveText('Alle neuen Episoden');
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.length))).toBe(1);
  });

  test('Zähler = Zeilen: 8 neue Episoden in einem Abo, Kopfzeile „x neue · y Episoden“, Statuszeile und Badges stimmen nach „gehört“ überein', async () => {
    await page.evaluate(url => window.podcasts.subscribe({ feedUrl: url, title: 'Viele Folgen', author: 'Test Autor' }), `${base}/feed3.xml`);
    const entries = page.locator('#podcastShowGrid .podcast-show');
    const many = entries.filter({ hasText: 'Viele Folgen' });
    await expect(many.locator('.podcast-badge')).toHaveText('8', { timeout: 15_000 });
    await expect(many.locator('.podcast-badge')).toHaveAttribute('title', '8 neue Episoden (ungehört, höchstens 30 Tage alt)');
    await many.locator('.podcast-show-btn').click();
    await expect(page.locator('#podcastNewHeading')).toHaveText('Viele Folgen');
    await expect(page.locator('#podcastColumnHint')).toHaveText('8 neue · 8 Episoden');
    await expect(page.getByRole('button', { name: 'Alle Episoden', exact: true })).toHaveAttribute('aria-pressed', 'true'); // Standard bei Abo-Auswahl
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(8);
    await expect(page.locator('#podcastNewList .podcast-episode-new:visible')).toHaveCount(8);
    await expect(page.locator('#podcastNewList .podcast-episode-new').first()).toHaveText('Neu');
    // 3 als gehört markieren → 5 neue von 8; Badge, Kopfzeile und „Nur neue“ ziehen sofort nach
    for (const title of ['Viele 6', 'Viele 7', 'Viele 8']) await page.locator('#podcastNewList .podcast-episode', { hasText: title }).locator('.podcast-episode-mark').click();
    await expect(page.locator('#podcastColumnHint')).toHaveText('5 neue · 8 Episoden');
    await expect(many.locator('.podcast-badge')).toHaveText('5');
    await expect(page.locator('#podcastNewList .podcast-episode-new:visible')).toHaveCount(5);
    await page.getByRole('button', { name: 'Nur neue' }).click();
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(5);
    // „Alle neuen Episoden“: Zähler = Zeilen = Statuszeile
    await entries.first().locator('.podcast-show-btn').click();
    const badge = Number(await entries.first().locator('.podcast-badge').textContent());
    expect(badge).toBeGreaterThanOrEqual(5);
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(badge);
    await expect(page.locator('#podcastColumnHint')).toHaveText(`${badge} neue Episoden`);
    await expect(page.locator('#podcastStatus')).toContainText(`· ${badge} neue Episoden ·`);
    await page.locator('#podcastNewList .podcast-episode', { hasText: 'Viele 1' }).locator('.podcast-episode-mark').click();
    await expect(entries.first().locator('.podcast-badge')).toHaveText(String(badge - 1));
    await expect(page.locator('#podcastNewList .podcast-episode')).toHaveCount(badge - 1);
    await expect(page.locator('#podcastStatus')).toContainText(`· ${badge - 1} neue Episoden ·`);
  });

  test('Wiedergabe-Markierung getrennt von der Auswahl: anderes Abo gewählt → nur Equalizer; gleiches Abo → Fläche und Equalizer', async () => {
    const entries = page.locator('#podcastShowGrid .podcast-show');
    const many = entries.filter({ hasText: 'Viele Folgen' });
    const other = entries.filter({ hasText: 'Testsendung fett' });
    await many.locator('.podcast-show-btn').click();
    await page.locator('#podcastNewList .podcast-episode', { hasText: 'Viele 2' }).locator('.podcast-episode-play').click();
    await expect.poll(() => page.evaluate(() => window.podcasts.player.getState().then(s => s.status)), { timeout: 15_000 }).toMatch(/playing|loading|ended/);
    await page.evaluate(() => window.podcasts.player.pause());
    await other.locator('.podcast-show-btn').click();
    await expect(many).toHaveClass(/is-active/);
    await expect(many).not.toHaveClass(/is-selected/);
    await expect(other).toHaveClass(/is-selected/);
    await expect(other).not.toHaveClass(/is-active/);
    await expect(many.locator('.podcast-eq')).toBeVisible();
    await expect(other.locator('.podcast-eq')).toBeHidden();
    await expect(many.locator('.podcast-show-btn')).toHaveAttribute('aria-label', /pausiert/);
    await expect(many.locator('.podcast-show-btn')).not.toHaveAttribute('aria-current', 'true');
    const eqColor = await many.locator('.podcast-eq span').first().evaluate(node => getComputedStyle(node).backgroundColor);
    expect(eqColor).toBe('rgb(255, 159, 28)'); // eigene Farbe, nicht der Akzent der Auswahl
    await many.locator('.podcast-show-btn').click();
    await expect(many).toHaveClass(/is-active/);
    await expect(many).toHaveClass(/is-selected/);
    const row = page.locator('#podcastNewList .podcast-episode.is-active');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Viele 2');
    await expect(row.locator('.podcast-eq')).toBeVisible();
    await expect(row.locator('.podcast-episode-main')).toHaveAttribute('aria-label', /pausiert/);
    await shot(page, 'podcasts-wiedergabe-auswahl');
  });

  test('Sendungsseite: Wiedergabe-Indikator im Kopf bei laufender Episode, live bei Pause, weg bei Stopp', async () => {
    await page.locator('#podcastShowGrid .podcast-show', { hasText: 'Viele Folgen' }).locator('.podcast-show-btn').dblclick();
    await expect(page.locator('#podcastPanel-show')).toBeVisible();
    const row = page.locator('.podcast-show-title-row');
    await expect(page.locator('.podcast-show-now-state')).toHaveText('Pausiert'); // Episode aus dem Vortest, pausiert
    await expect(row.locator('.podcast-eq')).toBeVisible();
    await page.locator('#podcastEpisodeList .podcast-episode', { hasText: 'Viele 2' }).locator('.podcast-episode-play').click();
    await expect.poll(() => page.evaluate(() => window.podcasts.player.getState().then(s => s.status)), { timeout: 15_000 }).toMatch(/playing|loading|ended/);
    await page.locator('#podcastSubscribe').focus();
    await expect(row).toHaveClass(/is-active/);
    await expect(row.locator('.podcast-eq')).toBeVisible();
    await expect(row.locator('.podcast-eq')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.podcast-show-now-state')).toHaveText(/Spielt gerade|Pausiert/);
    await expect(page.locator('.podcast-show-now-episode')).toHaveText('Viele 2');
    expect(await row.locator('.podcast-eq span').first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(255, 159, 28)');
    await page.evaluate(() => window.podcasts.player.pause());
    await expect.poll(() => page.evaluate(() => window.podcasts.player.getState().then(s => s.status)), { timeout: 15_000 }).toBe('paused');
    await expect(page.locator('.podcast-show-now-state')).toHaveText('Pausiert');
    await expect(row).not.toHaveClass(/is-playing/);
    await expect(page.locator('#podcastSubscribe')).toBeFocused(); // kein Neuaufbau, kein Fokusverlust
    await page.evaluate(() => window.podcasts.player.stop());
    await expect.poll(() => page.evaluate(() => window.podcasts.player.getState().then(s => s.status))).toBe('idle');
    await expect(row).not.toHaveClass(/is-active/);
    await expect(row.locator('.podcast-eq')).toBeHidden();
    await expect(page.locator('.podcast-show-now-state')).toBeHidden();
    await expect(page.locator('.podcast-show-now-episode')).toBeHidden();
  });

  test('Keine Konsolenfehler', async () => {
    expect(ctx.problems).toEqual([]);
  });
});
