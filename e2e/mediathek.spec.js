'use strict';

// E2E: Mediatheken (nativ) — Hub → Serie → Detail → Player, Genre, Suche mit Paging, Weitere Mediatheken und
// Einstellungen. Kein Netz: der Main-Prozess beantwortet alle Mediathek-Abrufe aus festen Fixtures
// (STREAMING_HUB_E2E_MEDIATHEK_ROUTES, nur im isolierten Testlauf). ZDF ist absichtlich nicht erreichbar (Fehlerzustand).
// Screenshots (optional): MEDIATHEK_E2E_SHOTS=<Verzeichnis> (je Hell/Dunkel).
const { test, expect } = require('@playwright/test');
const { shotBoth } = require('./theme-audit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');
const { fixture } = require('../tests/fixtures/mediathek/index.js');
const parser = require('../lib/mediathek/parser.js');

const SHOTS = process.env.MEDIATHEK_E2E_SHOTS || '';
const shot = async (page, name) => {
  if (!SHOTS) return;
  await shotBoth(page, SHOTS, name);
};

const NO_STREAM = 'https://127.0.0.1:9/e2e.mp4'; // Verbindung wird sofort abgelehnt: kein Netzzugriff
const episodes = parser.parseArdGrouping(fixture('ardGroupingMurdoch'));

function buildRoutes() {
  const noNet = body => body.replace(/https:\/\/[^"]*\.(mp4|m3u8)[^"]*/g, NO_STREAM);
  return {
    'pages/ard/home': fixture('ardHomeSections'),
    'pages/HOME/': fixture('arteHomeGenres'),
    'pages/DOR/': fixture('arteGenrePage'),
    MANUAL_TEASERS: fixture('arteMore'),
    '/grouping/': fixture('ardGroupingMurdoch').replaceAll('S10/E01', 'S9/E01'),
    [`/item/${episodes[0].id}`]: noNet(fixture('ardItem')),
    [`/item/${episodes[1].id}`]: fixture('ardItemInstitutFskBlocked'),
    [`/item/${episodes[2].id}`]: noNet(fixture('ardItemGeoBlocked')),
    'pages/ard/search': fixture('ardSearchInstitut'),
    'pageSize=24&vodPageNumber=1': fixture('ardSearch'),
    SEARCH_LISTING: fixture('arteSearch'),
  };
}

let ctx;
let page;
let tmp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediathek-routes-'));
  const routes = path.join(tmp, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify(buildRoutes()));
  const base = Date.now();
  ctx = await launchApp({
    prefix: 'mediathek-e2e-',
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

test('Navigation: Kachel öffnet den nativen Bereich; Quellenleiste mit Downloads-Chip', async () => {
  await page.locator('.dashboard-section-tile[data-section="mediathek"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Mediatheken');
  await expect(page.locator('#mediathekDashboard')).toBeVisible();
  await expect(page.locator('#dashboardGrid .dashboard-tile')).toHaveCount(0); // alte Kachel-Ansicht entfällt
  const chips = await page.locator('#mediathekDashboard .mediathek-chips .mediathek-chip').allTextContents();
  expect(chips).toEqual(['Alle', 'ARD', 'ZDF', 'arte', 'Meine Serien', 'Weiterschauen', 'Downloads']); // ohne eigene Weblink-Dienste kein „Weitere Mediatheken“
  await expect(page.locator('#mediathekDashboard .mediathek-chip[aria-pressed="true"]')).toHaveText('Alle');
  await expect(page.locator('#mediathekDashboard .mediathek-search-input')).toBeVisible();
});

test('Hub: Reihen je Quelle, Fehlerzustand mit Wiederholen, Genres, Nachladen', async () => {
  const rows = page.locator('#mediathekDashboard .mediathek-row-title');
  await expect(rows.filter({ hasText: 'Unsere Top-Serien' })).toBeVisible();
  await expect(rows.filter({ hasText: 'Film-Empfehlungen' })).toBeVisible();
  await expect(page.locator('#mediathekDashboard .mediathek-error')).toContainText('ZDF'); // ZDF nicht erreichbar
  await expect(page.locator('#mediathekDashboard .mediathek-error button')).toHaveText('Erneut versuchen');
  // arte: Genres zuerst, Highlights mit Nachladen
  await expect(page.locator('#mediathekDashboard .mediathek-genre-card')).toHaveCount(6);
  const firstTitle = await rows.first().innerText();
  expect(firstTitle).toContain('Genres');
  const highlights = page.locator('#mediathekDashboard [data-row="arte-1"] .mediathek-entry-card');
  await expect(highlights).toHaveCount(2);
  await page.locator('#mediathekDashboard [data-row="arte-1"] .mediathek-more-btn').click();
  await expect(highlights).toHaveCount(4);
  await expect(page.locator('#mediathekDashboard [data-row="arte-1"] .mediathek-more-btn')).toHaveCount(1); // nextPage der zweiten Seite
  // Quelle filtern
  await chip('ARD').click();
  await expect(page.locator('#mediathekDashboard .mediathek-genre-card')).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Unsere Top-Serien' })).toBeVisible();
  await chip('Alle').click();
  await shot(page, 'hub');
});

test('Serie: Kopf, Staffelauswahl, Sortierung, Merken, Zurück', async () => {
  await page.locator('#mediathekDashboard .mediathek-series-card', { hasText: 'House of Yang' }).locator('.mediathek-card-main').click();
  await expect(page.locator('#mediathekSeriesTitle')).toContainText('House of Yang');
  await expect(page.locator('#mediathekSeriesPlay')).toHaveText('Abspielen');
  const items = page.locator('#mediathekDashboard .mediathek-episode');
  await expect(items).toHaveCount(3);
  // zwei Staffeln (S9 / S10) -> Auswahl
  const seasons = page.locator('#mediathekDashboard .mediathek-season-chips .mediathek-chip');
  await expect(seasons).toHaveText(['Alle', 'Staffel 9', 'Staffel 10']);
  await expect(page.locator('#mediathekDashboard .mediathek-season-title')).toHaveText(['Staffel 9', 'Staffel 10']);
  await seasons.filter({ hasText: 'Staffel 10' }).click();
  await expect(items).toHaveCount(2);
  await expect(seasons.filter({ hasText: 'Staffel 10' })).toHaveAttribute('aria-pressed', 'true');
  // Sortierung: Standard älteste zuerst (E07 vor E08), umschaltbar
  await expect(items.first()).toContainText('Folge 7');
  await page.locator('#mediathekDashboard [data-sort="newest"]').click();
  await expect(items.first()).toContainText('Folge 8');
  await expect(page.locator('#mediathekDashboard [data-sort="newest"]')).toBeFocused(); // Fokus bleibt bei Neuaufbau
  await seasons.filter({ hasText: 'Alle' }).click();
  await expect(items).toHaveCount(3);
  // Merken
  const fav = page.locator('#mediathekSeriesFav');
  await expect(fav).toHaveAttribute('aria-pressed', 'false');
  await fav.click();
  await expect(fav).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'serie');
  await page.locator('#mediathekSeriesBack').click();
  await expect(page.locator('#mediathekPanel-series')).toBeHidden();
  await expect(page.locator('#mediathekDashboard [data-row="favorites"] .mediathek-series-card')).toContainText('House of Yang');
  await chip('Meine Serien').click();
  await expect(page.locator('#mediathekDashboard [data-group="favorites"] .mediathek-series-card')).toHaveCount(1);
  await chip('Alle').click();
});

test('Detail und Wiedergabe: Hinweise (FSK/Geo), Abspielen öffnet den Player, Esc schließt', async () => {
  await page.locator('#mediathekDashboard .mediathek-series-card', { hasText: 'House of Yang' }).first().locator('.mediathek-card-main').click();
  const items = page.locator('#mediathekDashboard .mediathek-episode');
  await expect(items).toHaveCount(3);
  // Detail-Fenster der ersten Folge (E08): Titel, Abspielen, Merken
  await items.filter({ hasText: 'Folge 8' }).locator('.mediathek-info-btn').click();
  const dialog = page.locator('.mediathek-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog.locator('.mediathek-dialog-title')).toContainText('Folge 8');
  await expect(page.locator('#mediathekDetailPlay')).toBeFocused();
  await expect(page.locator('#mediathekDetailFav')).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'detail');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // FSK-gesperrte Folge (E07): Hinweis im Detail, Sperre auf der Karte
  await items.filter({ hasText: 'Folge 7' }).locator('.mediathek-episode-main').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.mediathek-dialog-hint')).toContainText('FSK');
  await expect(page.locator('#mediathekDetailPlay')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(items.filter({ hasText: 'Folge 7' })).toHaveClass(/is-blocked/);

  // Abspielbare Folge: Player-Overlay
  await items.filter({ hasText: 'Folge 8' }).locator('.mediathek-episode-main').click();
  const player = page.locator('.mediathek-player');
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute('role', 'dialog');
  await expect(player.locator('.mediathek-player-title')).toContainText('Folge 8');
  await expect(player.locator('video')).toBeAttached();
  await shot(page, 'player');
  await page.keyboard.press('Escape');
  await expect(player).toHaveCount(0);
  // Zurück zur Serie; Abspielen-Knopf wählt nun passend
  await expect(page.locator('#mediathekSeriesPlay')).toBeVisible();
  await page.locator('#mediathekSeriesBack').click();
});

test('Genre-Seite (arte)', async () => {
  await page.locator('#mediathekDashboard .mediathek-genre-card', { hasText: 'Dokus' }).locator('.mediathek-card-main').click();
  await expect(page.locator('#mediathekGenreTitle')).toHaveText('Dokus');
  await expect(page.locator('#mediathekDashboard .mediathek-row-title', { hasText: 'Unsere Doku-Highlights' })).toBeVisible();
  await page.locator('#mediathekGenreBack').click();
  await expect(page.locator('#mediathekPanel-genre')).toBeHidden();
});

test('Suche: Gruppen, Zähler je Quelle, Paging, Leer- und Teilfehler-Zustand', async () => {
  const input = page.locator('#mediathekSearch');
  await input.fill('institut');
  await expect(page.locator('#mediathekDashboard [data-group="series"] .mediathek-series-card')).toHaveCount(2);
  await expect(page.locator('#mediathekDashboard [data-group="entries"] .mediathek-entry-card')).toHaveCount(5); // 4 ARD + 1 arte
  await expect(chip('ARD (6)')).toBeVisible();
  await expect(chip('arte (1)')).toBeVisible();
  await expect(chip('ZDF (0)')).toBeVisible(); // ZDF-Anfrage scheitert, Rest bleibt nutzbar
  await expect(page.locator('#mediathekDashboard .mediathek-error')).toHaveCount(0);
  // Paging (ARD)
  await page.locator('#mediathekDashboard [data-sentinel] button').click();
  await expect(page.locator('#mediathekDashboard [data-group="entries"] .mediathek-entry-card')).toHaveCount(6);
  await expect(page.locator('#mediathekDashboard [data-sentinel]')).toHaveCount(0);
  // Quellenfilter
  await chip('arte (1)').click();
  await expect(page.locator('#mediathekDashboard [data-group="series"]')).toHaveCount(0);
  await expect(page.locator('#mediathekDashboard [data-group="entries"] .mediathek-entry-card')).toHaveCount(1);
  await shot(page, 'suche');
  await page.locator('.mediathek-search-clear').click();
  await expect(input).toHaveValue('');
  await expect(page.locator('#mediathekDashboard [data-row="arte-0"]')).toBeVisible(); // Quellenfilter arte bleibt
  await chip('Alle').click();
  await expect(page.locator('#mediathekDashboard [data-row="favorites"]')).toBeVisible();
  // Esc im Feld löscht den Begriff
  await input.fill('x');
  await input.press('Escape');
  await expect(input).toHaveValue('');
});

test('Weitere Mediatheken: nur eigene Weblink-Dienste, Standard-Weblinks fehlen', async () => {
  await expect(chip('Weitere Mediatheken')).toHaveCount(0);
  const added = await page.evaluate(() => window.electronAPI.addService({ name: 'Testmediathek', url: 'https://example.com/', group: 'mediathek', color: '#1AB8E0' }));
  expect(added).toBeTruthy();
  await page.locator('#mediathekDashboard .mediathek-search-input').focus();
  await page.locator('#overlayNav [data-section="livetv"]').click();
  await page.locator('#overlayNav [data-section="mediathek"]').click();
  await expect(chip('Weitere Mediatheken')).toBeVisible();
  await chip('Weitere Mediatheken').click();
  await expect(page.locator('#mediathekDashboard .mediathek-service-btn')).toHaveCount(1);
  await expect(page.locator('#mediathekDashboard .mediathek-service-btn', { hasText: 'Testmediathek' })).toBeVisible();
  await chip('Alle').click();
  const id = await page.evaluate(async () => (await window.electronAPI.getServices()).find(s => s.name === 'Testmediathek').id);
  await page.evaluate(serviceId => window.electronAPI.removeService(serviceId), id);
});

test('Einstellungen: Quellen ein/aus wirken im Hub, Wiedergabe wird gespeichert', async () => {
  await page.locator('#overlayNav [data-section="settings"]').click();
  const group = page.locator('#settingsNav .settings-nav-group', { hasText: 'Mediatheken' });
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await page.locator('#settingsTab-mediathek-sources').click();
  await expect(page.locator('#settingsServiceListMediathek')).toBeVisible();
  await expect(page.locator('#settingsMediathekSource-zdf')).toBeChecked();
  await page.locator('#settingsMediathekSource-zdf').uncheck();
  await expect(page.locator('#settingsMediathekSourcesStatus')).toContainText('Gespeichert');
  await page.locator('#settingsTab-mediathek-playback').click();
  await page.locator('#settingsMediathek-quality').selectOption('720');
  await expect(page.locator('#settingsMediathekPlaybackStatus')).toContainText('Gespeichert');
  await page.locator('#settingsMediathek-subtitles').selectOption('de');
  await expect.poll(() => page.evaluate(async () => (await window.mediathek.getSettings()).settings)).toMatchObject({ quality: '720', subtitles: 'de', sources: { zdf: false, ard: true, arte: true } });
  await shot(page, 'einstellungen');
  await page.locator('#overlayNav [data-section="mediathek"]').click();
  await expect(chip('ZDF')).toHaveCount(0);
  await expect(page.locator('#mediathekDashboard .mediathek-error')).toHaveCount(0);
  expect(ctx.problems.filter(problem => !/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED|Failed to load resource/.test(problem))).toEqual([]);
});
