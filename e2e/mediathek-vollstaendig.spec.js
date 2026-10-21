'use strict';

// E2E: vollständige Mediatheken-Inhalte (ohne Netz, Fixtures über STREAMING_HUB_E2E_MEDIATHEK_ROUTES):
// ZDF-Marken als Serien mit Staffeln, A–Z, Suche mit Nachladen und Fehlerzustand mit „Erneut versuchen“;
// ARD-Serie seitenweise mit Nachladen und Staffelwahl über das Staffel-Widget; arte-Unterreihen mit Namen.
// Screenshots (optional): MEDIATHEK_E2E_SHOTS=<Verzeichnis> (je Hell/Dunkel).
const { test, expect } = require('@playwright/test');
const { shotBoth } = require('./theme-audit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');
const { fixture } = require('../tests/fixtures/mediathek/index.js');

const SHOTS = process.env.MEDIATHEK_E2E_SHOTS || '';
const shot = async (page, name) => {
  if (SHOTS) await shotBoth(page, SHOTS, name);
};

const ardTeaser = (id, title, href) => ({ id, type: 'show', coreAssetType: 'SEASON_SERIES', longTitle: title, publicationService: { name: 'MDR', partner: 'mdr' }, links: { target: { href } } });
const arteSeries = { type: 'teaser', title: 'Karambolage', programId: 'RC-1', kind: { code: 'TV_SERIES', isCollection: true }, deeplink: 'arte://collection/RC-1' };
const emptyMore = JSON.stringify({ data: [], nextPage: null });

function buildRoutes() {
  return {
    // ZDF: Startseite mit Marken, A–Z, Serie, Suche mit zweiter Seite (längster Schlüssel gewinnt)
    'mediathekV2/start-page': fixture('zdfHomeSerien'),
    'document/sendungen-100': fixture('zdfAz'),
    'document/the-veil-112': fixture('zdfBrandBergdoktor'),
    'document/der-bergdoktor-106': fixture('zdfBrandBergdoktor'),
    'mediathekV2/search?q=bergdoktor': fixture('zdfSearchPage1'),
    'mediathekV2/search?q=bergdoktor&profile=cellular-5&synth=true&sp=true&page=2': fixture('zdfSearchPageLast'),
    // ARD: Startseite mit einer Serie (Folgen seitenweise), Staffel 2 komplett
    'pages/ard/home': JSON.stringify({ widgets: [{ type: 'gridlist', title: 'Lange Serien', teasers: [ardTeaser('SERIE1', 'Lange Serie', 'https://api.ardmediathek.de/page-gateway/pages/mdr/grouping/SERIE1?embedded=true')] }] }),
    '/pages/mdr/grouping/SERIE1': fixture('ardGroupingPaged0'),
    'pageNumber=1&pageSize=3': fixture('ardGroupingPaged1'),
    'pageNumber=2&pageSize=3': fixture('ardGroupingPaged2'),
    'seasonNumber=2': fixture('ardSeasonTwo'),
    // arte: Startseite (Genres + Serie), Sammlung mit zwei benannten Unterreihen
    'pages/HOME/': JSON.stringify({ zones: [{ code: { name: 'genres_HOME' }, title: 'Genres', data: JSON.parse(fixture('arteHomeGenres')).zones.find(zone => zone.code && zone.code.name === 'genres_HOME').data }, { code: { name: 'series' }, title: 'Serien', data: [arteSeries] }] }),
    'pages/RC-1/': fixture('arteCollectionNamed'),
    COLLECTION_VIDEOS: emptyMore,
    COLLECTION_SUBCOLLECTION: emptyMore,
  };
}

let ctx;
let page;
let tmp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediathek-voll-'));
  const routes = path.join(tmp, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify(buildRoutes()));
  const base = Date.now();
  ctx = await launchApp({
    prefix: 'mediathek-voll-e2e-',
    epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
    channels: [{ id: 'E2E.de', name: 'E2E Kanal' }],
    favorites: [],
    env: { STREAMING_HUB_E2E_MEDIATHEK_ROUTES: routes },
  });
  page = ctx.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  // Kein automatisches Nachladen beim Scrollen: die kurzen Testlisten lägen sofort im Sichtbereich; geprüft wird der Knopf
  await page.evaluate(() => {
    window.IntersectionObserver = undefined;
  });
  await page.locator('.dashboard-section-tile[data-section="mediathek"]').click();
  await expect(page.locator('#mediathekDashboard')).toBeVisible();
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const chip = label => page.locator('#mediathekPanel-home .mediathek-chip', { hasText: label });
const back = id => page.locator(id).click();

test('ZDF: Marken als Serienkarten, Serienseite mit Staffeln, A–Z als Rubrik-Kachel', async () => {
  await chip('ZDF').click();
  const veil = page.locator('#mediathekDashboard [data-row="zdf-1"] .mediathek-series-card', { hasText: 'The Veil' });
  await expect(veil).toBeVisible();
  await expect(page.locator('#mediathekDashboard [data-row="zdf-1"] .mediathek-series-card')).toHaveCount(2); // Marke ohne Video entfällt
  await expect(page.locator('#mediathekDashboard .mediathek-row-title', { hasText: 'Alles auf einen Blick' })).toHaveCount(0);
  await expect(page.locator('#mediathekDashboard [data-row="zdf-0"] .mediathek-genre-card')).toHaveText([/Serien/, /Sendungen A–Z/]);
  await shot(page, 'zdf-serien');
  await veil.locator('.mediathek-card-main').click();
  await expect(page.locator('#mediathekSeriesTitle')).toHaveText('The Veil');
  const seasons = page.locator('#mediathekDashboard .mediathek-season-chips .mediathek-chip');
  await expect(seasons).toHaveText(['Alle', 'Staffel 7', 'Staffel 17', 'Staffel 19']);
  await expect(page.locator('#mediathekDashboard .mediathek-episode')).toHaveCount(5);
  await seasons.filter({ hasText: 'Staffel 19' }).click();
  await expect(page.locator('#mediathekDashboard .mediathek-episode')).toHaveCount(2);
  await expect(page.locator('#mediathekDashboard .mediathek-hero-text')).toContainText('ZDF');
  await shot(page, 'zdf-serie');
  await back('#mediathekSeriesBack');
  await page.locator('#mediathekDashboard .mediathek-genre-card', { hasText: 'Sendungen A–Z' }).locator('.mediathek-card-main').click();
  await expect(page.locator('#mediathekGenreTitle')).toHaveText('Sendungen A–Z');
  await expect(page.locator('#mediathekPanel-genre .mediathek-row-title')).toHaveText(['A', 'B', '0 - 9']);
  await expect(page.locator('#mediathekPanel-genre .mediathek-series-card')).toHaveCount(4);
  await back('#mediathekGenreBack');
});

test('ZDF-Suche: Serie und Folgen, „Weitere Treffer laden“; Ausfall anderer Quellen als Fehler mit Wiederholen', async () => {
  await chip('Alle').click();
  const input = page.locator('#mediathekSearch');
  await input.fill('bergdoktor');
  await expect(page.locator('#mediathekDashboard [data-group="series"] .mediathek-series-card')).toHaveCount(1);
  await expect(page.locator('#mediathekDashboard [data-group="entries"] .mediathek-entry-card')).toHaveCount(2);
  // ARD und arte haben hier keine Antwort: Fehler je Quelle statt „keine Treffer“, ZDF-Treffer bleiben
  await expect(page.locator('#mediathekDashboard .mediathek-error[data-failed-source="ard"]')).toContainText('ARD: Suche fehlgeschlagen');
  await expect(page.locator('#mediathekDashboard .mediathek-error[data-failed-source="arte"] button')).toHaveText('Erneut versuchen');
  await expect(page.locator('#mediathekDashboard .mediathek-empty')).toHaveCount(0);
  await shot(page, 'suche-fehler');
  await chip('ZDF (3)').click();
  await expect(page.locator('#mediathekDashboard .mediathek-error')).toHaveCount(0);
  await page.locator('#mediathekDashboard [data-sentinel] button').click();
  await expect(page.locator('#mediathekDashboard [data-group="entries"] .mediathek-entry-card')).toHaveCount(3);
  await expect(page.locator('#mediathekDashboard [data-sentinel]')).toHaveCount(0);
  await page.locator('.mediathek-search-clear').click();
  await chip('Alle').click();
});

test('ARD: lange Serie seitenweise nachladen, Staffelwahl über das Staffel-Widget', async () => {
  await chip('ARD').click();
  await page.locator('#mediathekDashboard .mediathek-series-card', { hasText: 'Lange Serie' }).locator('.mediathek-card-main').click();
  const episodes = page.locator('#mediathekDashboard .mediathek-episode');
  await expect(episodes).toHaveCount(2);
  const more = page.locator('#mediathekDashboard .mediathek-more button');
  await expect(more).toHaveText('Weitere Folgen laden (3 von 8)');
  // Staffeln stehen schon vor dem Nachladen bereit
  const seasons = page.locator('#mediathekDashboard .mediathek-season-chips .mediathek-chip');
  await expect(seasons).toHaveText(['Alle', 'Staffel 1', 'Staffel 2', 'Staffel 3']);
  await shot(page, 'ard-serie-seitenweise');
  await seasons.filter({ hasText: 'Staffel 2' }).click();
  await expect(episodes).toHaveCount(2);
  await expect(episodes.first()).toContainText('Neue Zeit 1');
  await expect(more).toHaveCount(0); // eine komplett geladene Staffel braucht kein Nachladen
  await seasons.filter({ hasText: 'Alle' }).click();
  await expect(more).toBeVisible();
  await more.click();
  await expect(episodes).toHaveCount(6);
  await expect(more).toHaveCount(0);
  await expect(page.locator('#mediathekDashboard .mediathek-group-count')).toHaveText('6');
  await back('#mediathekSeriesBack');
});

test('arte: Unterreihen mit ihrem Namen, ergänzte Genres', async () => {
  await chip('arte').click();
  await expect(page.locator('#mediathekDashboard .mediathek-genre-card')).toHaveCount(13);
  await expect(page.locator('#mediathekDashboard .mediathek-genre-card', { hasText: 'Geschichte' })).toBeVisible();
  await expect(page.locator('#mediathekDashboard .mediathek-genre-card', { hasText: 'Meistgesehen' })).toBeVisible();
  await expect(page.locator('#mediathekDashboard .mediathek-genre-card', { hasText: /Live|TV-Programm/ })).toHaveCount(0);
  await page.locator('#mediathekDashboard .mediathek-series-card', { hasText: 'Karambolage' }).locator('.mediathek-card-main').click();
  await expect(page.locator('#mediathekSeriesTitle')).toHaveText('Karambolage');
  const seasons = page.locator('#mediathekDashboard .mediathek-season-chips .mediathek-chip');
  await expect(seasons).toHaveText(['Alle', 'Alltag', 'Die Sprache']);
  await expect(page.locator('#mediathekDashboard .mediathek-season-title')).toHaveText(['Alltag', 'Die Sprache']);
  await shot(page, 'arte-unterreihen');
  await back('#mediathekSeriesBack');
  expect(ctx.problems.filter(problem => !/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED|Failed to load resource/.test(problem))).toEqual([]);
});
