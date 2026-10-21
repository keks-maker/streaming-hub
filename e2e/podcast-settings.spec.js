'use strict';

// E2E: Einstellungen → Podcasts (P4) — „Podcasts verwalten“ springt in die Einstellungen, Eigener Feed prüfen/abonnieren,
// Reihenfolge ändern (▲▼ und Drag & Drop), Anpassung (Name, Cover mit Prüfung im Main), Abbestellen mit Bestätigung,
// Wiedergabeeinstellungen (Sprungweiten wirken im Mini-Player) und Erhalt nach Neustart. Kein Netz außer localhost.
// Screenshots (optional): PODCAST_E2E_SHOTS=<Verzeichnis>.
const { test, expect } = require('@playwright/test');
const { shotBoth } = require('./theme-audit');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp, relaunchApp } = require('./epg-helpers');

const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg');
const SHOTS = process.env.PODCAST_E2E_SHOTS || '';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const shot = async (page, name) => {
  if (!SHOTS) return;
  await shotBoth(page, SHOTS, name);
};

function feedXml(base, title, items) {
  const entries = items
    .map((item, index) => `<item><title>${item.title}</title><guid>${item.guid}</guid><pubDate>${new Date(Date.now() - (index + 1) * 3600 * 1000).toUTCString()}</pubDate><itunes:duration>00:00:03</itunes:duration><enclosure url="${base}/${item.file}" type="audio/aac" length="0"/></item>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${title}</title><itunes:author>Test Autor</itunes:author><itunes:image href="${base}/cover.png"/>${entries}</channel></rss>`;
}

function startServer(tone) {
  const server = http.createServer((req, res) => {
    const base = `http://localhost:${server.address().port}`;
    const url = new URL(req.url, base);
    const feeds = {
      '/feed1.xml': ['Erste Sendung', [{ title: 'Folge A', guid: 'a1', file: 'ep.aac' }, { title: 'Folge B', guid: 'a2', file: 'ep.aac' }]],
      '/feed2.xml': ['Zweite Sendung', [{ title: 'Folge C', guid: 'b1', file: 'ep.aac' }]],
      '/feed3.xml': ['Dritte Sendung', [{ title: 'Folge D', guid: 'c1', file: 'ep.aac' }]],
    };
    if (feeds[url.pathname]) {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(feedXml(base, feeds[url.pathname][0], feeds[url.pathname][1]));
    } else if (url.pathname === '/broken.xml') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>kein Feed</body></html>');
    } else if (url.pathname === '/cover.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
    } else if (url.pathname === '/notimage.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end('kein Bild');
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

const titles = page => page.evaluate(() => window.podcasts.list().then(list => list.map(sub => sub.title)));
const rowNames = page => page.locator('#settingsPodcastSubsList .settings-podcast-name').allTextContents();

async function openManagement(page) {
  await page.evaluate(() => window.document.getElementById('overlayLocation').click());
  await page.locator('.dashboard-section-tile[data-section="podcasts"]').click();
  await expect(page.locator('#podcastDashboard')).toBeVisible();
  await page.locator('#podcastManage').click();
  await expect(page.locator('[data-settings-page="podcast-subs"]')).toBeVisible();
}

async function openTab(page, tab) {
  const group = page.locator('#settingsNav .settings-nav-group', { hasText: 'Podcasts' });
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await page.locator(`#settingsTab-${tab}`).click();
  await expect(page.locator(`[data-settings-page="${tab}"]`)).toBeVisible();
}

test.describe('Einstellungen: Podcasts', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let server;
  let base;
  let tmpDir;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-podcast-settings-'));
    const file = path.join(tmpDir, 'tone.aac');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', file], { timeout: 30_000 });
    server = await startServer(fs.readFileSync(file));
    base = `http://localhost:${server.address().port}`;
    const now = Math.floor(Date.now() / MIN) * MIN;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-podcast-settings-',
      epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(now - 30 * MIN)}" stop="${xmltvTime(now + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
      channels: [{ id: 'E2E.de', name: 'E2E Kanal', group: 'Test' }],
      favorites: ['E2E.de'],
      env: { STREAMING_HUB_E2E_PODCAST_SEARCH_URL: `${base}/search` },
    });
    page = ctx.page;
    await page.evaluate(() => window.podcasts.player.setVolume(0));
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (server) await new Promise(resolve => server.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('„Podcasts verwalten“ im Dashboard öffnet Einstellungen → Podcasts → Abos (leer)', async () => {
    await openManagement(page);
    await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
    await expect(page.locator('#settingsTab-podcast-subs')).toHaveAttribute('aria-selected', 'true');
    const group = page.locator('#settingsNav .settings-nav-group', { hasText: 'Podcasts' });
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#settingsPodcastSubsEmpty')).toBeVisible();
    await expect(page.locator('#settingsPodcastSubsRefresh')).toBeDisabled();
    const navOrder = await page.locator('#settingsNav .settings-nav-group').allTextContents();
    expect(navOrder.map(text => text.replace('▸', '').trim()).slice(0, 3)).toEqual(['LiveTV', 'Radio', 'Podcasts']);
    await shot(page, 'einstellungen-abos-leer');
  });

  test('Eigene Feeds: ungültiger Feed wird abgelehnt, gültiger erst nach Bestätigung abonniert', async () => {
    await openTab(page, 'podcast-feeds');
    await page.locator('#settingsPodcastFeedUrl').fill(`${base}/broken.xml`);
    await page.locator('#settingsPodcastFeedCheck').click();
    await expect(page.locator('#settingsPodcastFeedMessage')).toContainText('Kein gültiger Podcast-Feed');
    await expect(page.locator('#settingsPodcastFeedPreview')).toBeHidden();
    await page.locator('#settingsPodcastFeedUrl').fill('ftp://x.test/feed');
    await page.locator('#settingsPodcastFeedCheck').click();
    await expect(page.locator('#settingsPodcastFeedMessage')).toContainText('http');
    await page.locator('#settingsPodcastFeedUrl').fill(`${base}/feed1.xml`);
    await page.locator('#settingsPodcastFeedCheck').click();
    await expect(page.locator('#settingsPodcastFeedPreview')).toBeVisible();
    await expect(page.locator('#settingsPodcastFeedPreview')).toContainText('Erste Sendung');
    await expect(page.locator('#settingsPodcastFeedPreview')).toContainText('2 Episoden');
    expect(await titles(page)).toEqual([]);
    await shot(page, 'einstellungen-feed-pruefen');
    await page.locator('#settingsPodcastFeedConfirm').click();
    await expect(page.locator('#settingsPodcastFeedList .settings-podcast-row')).toHaveCount(1);
    await expect(page.locator('#settingsPodcastFeedStatus')).toContainText('abonniert');
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.map(sub => sub.source)))).toEqual(['eigene-podcasts']);
    for (const name of ['feed2', 'feed3']) {
      await page.locator('#settingsPodcastFeedUrl').fill(`${base}/${name}.xml`);
      await page.locator('#settingsPodcastFeedCheck').click();
      await expect(page.locator('#settingsPodcastFeedPreview')).toBeVisible();
      await page.locator('#settingsPodcastFeedConfirm').click();
      await expect(page.locator('#settingsPodcastFeedPreview')).toBeHidden();
    }
    await expect(page.locator('#settingsPodcastFeedList .settings-podcast-row')).toHaveCount(3);
    expect(await titles(page)).toEqual(['Erste Sendung', 'Zweite Sendung', 'Dritte Sendung']);
    // doppelt abonnieren: Hinweis statt zweitem Abo
    await page.locator('#settingsPodcastFeedUrl').fill(`${base}/feed1.xml`);
    await page.locator('#settingsPodcastFeedCheck').click();
    await page.locator('#settingsPodcastFeedConfirm').click();
    await expect(page.locator('#settingsPodcastFeedMessage')).toContainText('bereits abonniert');
    expect((await titles(page)).length).toBe(3);
  });

  test('Abos: Reihenfolge per ▲ und per Drag & Drop', async () => {
    await openTab(page, 'podcast-subs');
    await expect(page.locator('#settingsPodcastSubsSummary')).toHaveText('3 Abos');
    expect(await rowNames(page)).toEqual(['Erste Sendung', 'Zweite Sendung', 'Dritte Sendung']);
    await page.locator('#settingsPodcastSubsList .settings-podcast-row').nth(2).locator('[data-action="up"]').click();
    await expect.poll(() => rowNames(page)).toEqual(['Erste Sendung', 'Dritte Sendung', 'Zweite Sendung']);
    expect(await titles(page)).toEqual(['Erste Sendung', 'Dritte Sendung', 'Zweite Sendung']);
    await expect(page.locator('#settingsPodcastSubsStatus')).toContainText('Reihenfolge gespeichert');
    // Fokus bleibt am verschobenen Eintrag
    await expect(page.locator('#settingsPodcastSubsList .settings-podcast-row').nth(1).locator('[data-action="up"]')).toBeFocused();
    await page.locator('#settingsPodcastSubsList .settings-podcast-row').nth(0).locator('.settings-chan-drag').dragTo(page.locator('#settingsPodcastSubsList .settings-podcast-row').nth(2));
    await expect.poll(() => rowNames(page)).toEqual(['Dritte Sendung', 'Zweite Sendung', 'Erste Sendung']);
    expect(await titles(page)).toEqual(['Dritte Sendung', 'Zweite Sendung', 'Erste Sendung']);
    await shot(page, 'einstellungen-abos');
  });

  test('Abos: Name anpassen, Cover nur nach Prüfung (ungültig/kein Bild abgelehnt), Zurücksetzen', async () => {
    const row = () => page.locator('#settingsPodcastSubsList .settings-podcast-row').nth(1); // Zweite Sendung
    await row().locator('[data-action="edit"]').click();
    const form = row().locator('form');
    await form.locator('[data-field="cover"]').fill('ftp://x.test/c.png');
    await form.locator('[data-action="save"]').click();
    await expect(form).toContainText('http:// oder https://');
    await form.locator('[data-field="cover"]').fill(`${base}/notimage.png`);
    await form.locator('[data-action="save"]').click();
    await expect(form).toContainText('Cover konnte nicht geladen werden');
    expect(await page.evaluate(() => window.podcasts.list().then(list => list.filter(sub => sub.overrides).length))).toBe(0);
    await form.locator('[data-field="title"]').fill('Mein Lieblingspodcast');
    await form.locator('[data-field="cover"]').fill(`${base}/cover.png`);
    await form.locator('[data-action="save"]').click();
    await expect(page.locator('#settingsPodcastSubsStatus')).toContainText('Gespeichert');
    await expect.poll(() => rowNames(page)).toEqual(['Dritte Sendung', 'Mein Lieblingspodcast', 'Erste Sendung']);
    await expect(row()).toContainText('angepasst');
    const sub = await page.evaluate(() => window.podcasts.list().then(list => list[1]));
    expect(sub.overrides).toEqual({ title: 'Mein Lieblingspodcast', cover: `${base}/cover.png` });
    expect(sub.original.title).toBe('Zweite Sendung');
    await expect(row().locator('.podcast-cover img')).toHaveAttribute('src', /^data:image\/png/);
  });

  test('Abos: Abbestellen erst nach Bestätigung; „Behalten“ bricht ab; Jetzt aktualisieren', async () => {
    const row = () => page.locator('#settingsPodcastSubsList .settings-podcast-row').nth(2); // Erste Sendung
    await row().locator('[data-action="remove"]').click();
    await row().locator('[data-action="cancel-remove"]').click();
    expect((await titles(page)).length).toBe(3);
    await page.locator('#settingsPodcastSubsRefresh').click();
    await expect(page.locator('#settingsPodcastSubsStatus')).toContainText('Alle Abos geprüft');
    await expect(row().locator('.settings-podcast-feedstatus')).toContainText('Geprüft');
    await row().locator('[data-action="remove"]').click();
    await row().locator('[data-action="confirm-remove"]').click();
    await expect(page.locator('#settingsPodcastSubsList .settings-podcast-row')).toHaveCount(2);
    expect(await titles(page)).toEqual(['Dritte Sendung', 'Mein Lieblingspodcast']);
    await expect(page.locator('#settingsPodcastSubsSummary')).toHaveText('2 Abos');
  });

  test('Wiedergabe: Einstellungen speichern, Sprungweiten wirken im Mini-Player', async () => {
    await openTab(page, 'podcast-playback');
    await expect(page.locator('#settingsPodcastSharedNote')).toContainText('weiterspielen');
    await shot(page, 'einstellungen-wiedergabe');
    await page.locator('#settingsPodcastRate').selectOption('1.25');
    await expect(page.locator('#settingsPodcastPlaybackStatus')).toContainText('Gespeichert');
    await page.locator('#settingsPodcastSkipBack').selectOption('10');
    await page.locator('#settingsPodcastSkipForward').selectOption('45');
    await page.locator('#settingsPodcastInterval').selectOption('30');
    await page.locator('#settingsPodcast-autoPlayNext').check();
    await page.locator('#settingsPodcast-autoMarkPlayed').uncheck();
    await page.locator('#settingsPodcastVolume').fill('30');
    await expect(page.locator('#settingsPodcastVolumeValue')).toHaveText('30 %');
    await page.locator('#settingsPodcastVolume').dispatchEvent('change');
    await expect.poll(() => page.evaluate(() => window.podcasts.getSettings())).toMatchObject({ rate: 1.25, skipBack: 10, skipForward: 45, refreshIntervalMinutes: 30, autoPlayNext: true, autoMarkPlayed: false });
    await expect.poll(() => page.evaluate(() => window.podcasts.getSettings().then(s => s.volume))).toBe(0.3);
    // abgelehnte Werte erreichen die Einstellungen nicht
    expect(await page.evaluate(() => window.podcasts.setSettings({ refreshIntervalMinutes: 5 }).then(() => 'ok', e => 'abgelehnt'))).toBe('abgelehnt');
    // Mini-Player: Beschriftung der Sprünge folgt der Einstellung, Wiedergabe startet mit der Standardgeschwindigkeit
    const first = await page.evaluate(() => window.podcasts.list().then(list => window.podcasts.episodes(list[0].id).then(feed => ({ podcastId: list[0].id, episodeId: feed.episodes[0].id }))));
    await page.evaluate(key => window.podcasts.player.play(key), first);
    await expect(page.locator('#radioMiniPlayer')).toHaveAttribute('data-mode', 'podcast');
    await expect(page.locator('#radioMiniSkipBack')).toHaveAttribute('aria-label', '10 Sekunden zurück');
    await expect(page.locator('#radioMiniSkipForward')).toHaveAttribute('aria-label', '45 Sekunden vor');
    await expect(page.locator('#radioMiniRate')).toHaveValue('1.25');
    await page.evaluate(() => window.podcasts.player.stop());
  });

  test('Hinweis: gemeinsame Radio-Optionen — Knopf springt zu Radio → Wiedergabe', async () => {
    await page.locator('#settingsPodcastOpenRadioPlayback').click();
    await expect(page.locator('[data-settings-page="radio-playback"]')).toBeVisible();
    await openTab(page, 'podcast-playback');
  });

  test('Nach Neustart bleiben Abos, Reihenfolge, Anpassung und Wiedergabeeinstellungen erhalten', async () => {
    await relaunchApp(ctx);
    page = ctx.page;
    expect(await titles(page)).toEqual(['Dritte Sendung', 'Mein Lieblingspodcast']);
    const settings = await page.evaluate(() => window.podcasts.getSettings());
    expect(settings).toMatchObject({ rate: 1.25, skipBack: 10, skipForward: 45, refreshIntervalMinutes: 30, autoPlayNext: true, autoMarkPlayed: false, volume: 0.3 });
    expect((await page.evaluate(() => window.podcasts.player.getState())).volume).toBe(0.3);
    await openManagement(page);
    await openTab(page, 'podcast-playback');
    await expect(page.locator('#settingsPodcastRate')).toHaveValue('1.25');
    await expect(page.locator('#settingsPodcastSkipBack')).toHaveValue('10');
    await expect(page.locator('#settingsPodcastSkipForward')).toHaveValue('45');
    await expect(page.locator('#settingsPodcastInterval')).toHaveValue('30');
    await expect(page.locator('#settingsPodcast-autoPlayNext')).toBeChecked();
    await expect(page.locator('#settingsPodcast-autoMarkPlayed')).not.toBeChecked();
    await expect(page.locator('#settingsPodcastVolume')).toHaveValue('30');
    await openTab(page, 'podcast-subs');
    await expect(page.locator('#settingsPodcastSubsList .settings-podcast-name')).toHaveText(['Dritte Sendung', 'Mein Lieblingspodcast']);
    await expect(page.locator('#settingsPodcastSubsList .settings-podcast-row').nth(1)).toContainText('angepasst');
  });

  test('Keine Konsolenfehler', async () => {
    expect(ctx.problems).toEqual([]);
  });
});
