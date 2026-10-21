'use strict';

// E2E: Rubriken (ARD, ZDF) und Genres (arte) — Hub zeigt die Rubriken ganz oben, Klick öffnet die Rubrik-Seite (Reihen,
// Unterrubriken, Nachladen), Zurück-Navigation, Fehler- und Leerzustand. Kein Netz: feste Fixtures über
// STREAMING_HUB_E2E_MEDIATHEK_ROUTES (nur im isolierten Testlauf, Fenster im Hintergrund via launchApp).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');
const { fixture } = require('../tests/fixtures/mediathek/index.js');

// Rubrik, die nur Marken (keine abspielbaren Videos) enthält: Leerzustand
const BRANDS_ONLY = JSON.stringify({ document: { id: 'krimi-102', titel: 'Krimi' }, cluster: [{ name: 'Krimiserien', type: 'teaser', teaser: [{ id: 'sko-100', type: 'brand', contentType: 'brand', titel: 'SOKO', hasVideo: false }] }] });

function buildRoutes() {
  return {
    'pages/ard/home': fixture('ardHomeRubriken'),
    'mediathekV2/start-page': fixture('zdfHomeRubriken'),
    'pages/HOME/': fixture('arteHomeGenres'),
    'pages/ard/editorial/filme?': fixture('ardRubrikFilme'),
    'pages/ard/editorial/filme-krimis-thriller': fixture('ardRubrikAlle').replace('Alle Rubriken', 'Krimi und Thriller'),
    'pages/ard/compilation/alle-rubriken': fixture('ardRubrikAlle'),
    '/widgets/ard/': fixture('ardWidgetMore'),
    'mediathekV2/document/filme-104': fixture('zdfRubrikFilme'),
    'mediathekV2/document/krimi-102': BRANDS_ONLY,
  };
}

let ctx;
let page;
let tmp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediathek-rubriken-'));
  const routes = path.join(tmp, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify(buildRoutes()));
  const base = Date.now();
  ctx = await launchApp({
    prefix: 'mediathek-rubriken-',
    epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
    channels: [{ id: 'E2E.de', name: 'E2E Kanal' }],
    favorites: [],
    env: { STREAMING_HUB_E2E_MEDIATHEK_ROUTES: routes },
  });
  page = ctx.page;
  await page.setViewportSize({ width: 1280, height: 860 });
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const chip = label => page.locator('#mediathekPanel-home .mediathek-chip', { hasText: label });
const rows = () => page.locator('#mediathekDashboard .mediathek-row-title');
const rubricCard = title => page.locator('#mediathekPanel-home .mediathek-genre-card', { hasText: title }).locator('.mediathek-card-main');

test('Hub "Alle": Rubriken-Reihen von ARD und ZDF vor arte-Genres und allen anderen Reihen', async () => {
  await page.locator('.dashboard-section-tile[data-section="mediathek"]').click();
  await expect(page.locator('#mediathekDashboard [data-row="ard-0"]')).toBeVisible();
  const titles = await rows().allInnerTexts();
  expect(titles.slice(0, 3).map(t => t.replace(/\s+/g, ' ').trim())).toEqual(['Rubriken ARD', 'Rubriken ZDF', 'Genres arte']);
  await expect(page.locator('#mediathekDashboard [data-row="ard-0"] .mediathek-genre-card')).toHaveCount(4);
  await expect(page.locator('#mediathekDashboard [data-row="zdf-0"] .mediathek-genre-card')).toHaveCount(4);
  await expect(page.locator('#mediathekDashboard [data-row="ard-0"] .mediathek-card-sub').first()).toHaveText('Rubrik');
  await expect(page.locator('#mediathekDashboard .mediathek-row-title', { hasText: 'Unsere Top-Serien' })).toBeVisible();
});

test('ARD-Rubrik: Seite mit Unterrubriken, Reihen ohne Fremdinhalt/Dublette/Trailer, Nachladen, Zurück', async () => {
  await chip('ARD').click();
  await expect(rows().first()).toHaveText('Rubriken');
  await rubricCard('Filme').click();
  await expect(page.locator('#mediathekGenreTitle')).toHaveText('Filme');
  await expect(page.locator('#mediathekPanel-genre .mediathek-eyebrow')).toHaveText('ARD · RUBRIK');
  await expect(page.locator('#mediathekPanel-genre .mediathek-row-title')).toHaveText(['Unterrubriken', 'Neu verfügbare Film-Highlights', 'Beliebte Krimireihen']);
  const highlights = page.locator('#mediathekPanel-genre [data-row="genre-1"] .mediathek-entry-card');
  await expect(highlights).toHaveCount(3); // ZDF-Fremdinhalt und Dublette entfallen
  await page.locator('#mediathekPanel-genre [data-row="genre-1"] .mediathek-more-btn').click();
  await expect(highlights).toHaveCount(7);
  await expect(page.locator('#mediathekPanel-genre [data-row="genre-1"] .mediathek-more-btn')).toHaveCount(0);
  // Karte der Rubrikseite: Detail (Merken/Download-Funktionen der Folgenkarten) öffnet wie überall
  await highlights.first().locator('.mediathek-info-btn').click();
  await expect(page.locator('.mediathek-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mediathek-dialog')).toHaveCount(0);
  // Unterrubrik öffnen, zweimal zurück
  await page.locator('#mediathekPanel-genre .mediathek-genre-card', { hasText: 'Krimi & Thriller' }).locator('.mediathek-card-main').click();
  await expect(page.locator('#mediathekGenreTitle')).toHaveText('Krimi & Thriller');
  await page.locator('#mediathekGenreBack').click();
  await expect(page.locator('#mediathekGenreTitle')).toHaveText('Filme');
  await page.locator('#mediathekGenreBack').click();
  await expect(page.locator('#mediathekPanel-genre')).toBeHidden();
  await expect(rows().first()).toHaveText('Rubriken');
});

test('ARD "Alle Rubriken" öffnet eine Kachelseite', async () => {
  await rubricCard('Alle Rubriken').click();
  await expect(page.locator('#mediathekGenreTitle')).toHaveText('Alle Rubriken');
  await expect(page.locator('#mediathekPanel-genre .mediathek-genre-card')).toHaveCount(6);
  await page.locator('#mediathekGenreBack').click();
  await expect(page.locator('#mediathekPanel-genre')).toBeHidden();
});

test('ZDF-Rubrik: Reihen mit Videos, Fehlerzustand mit Wiederholen, Leerzustand', async () => {
  await chip('ZDF').click();
  await expect(rows().first()).toHaveText('Rubriken');
  await rubricCard('Filme').click();
  await expect(page.locator('#mediathekGenreTitle')).toHaveText('Filme');
  await expect(page.locator('#mediathekPanel-genre .mediathek-eyebrow')).toHaveText('ZDF · RUBRIK');
  await expect(page.locator('#mediathekPanel-genre .mediathek-row-title')).toHaveText(['Komödien', 'Romantische Filme und Serien', 'Mehr entdecken']);
  await expect(page.locator('#mediathekPanel-genre [data-row="genre-0"] .mediathek-entry-card')).toHaveCount(3);
  await page.locator('#mediathekGenreBack').click();
  // nicht erreichbare Rubrik (Serien): Fehlerzustand mit Wiederholen
  await rubricCard('Serien').click();
  await expect(page.locator('#mediathekPanel-genre .mediathek-error')).toContainText('Laden fehlgeschlagen');
  await expect(page.locator('#mediathekPanel-genre .mediathek-error button')).toHaveText('Erneut versuchen');
  await page.locator('#mediathekGenreBack').click();
  // Rubrik ohne abspielbare Videos: Hinweis statt leerer Seite
  await rubricCard('Krimi').click();
  await expect(page.locator('#mediathekPanel-genre .mediathek-empty')).toContainText('nichts direkt Abspielbares');
  await page.locator('#mediathekGenreBack').click();
  await expect(page.locator('#mediathekPanel-genre')).toBeHidden();
});
