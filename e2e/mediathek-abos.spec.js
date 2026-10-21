'use strict';

// E2E: Serien-Abos „Neue Folgen automatisch laden“ — Schalter im Serienkopf (Dialog künftige/vorhandene Folgen, Optionen), Ansicht „Abos“
// im Downloads-Bereich (Liste, Aktiv-Schalter, Jetzt prüfen, Optionen, Entfernen), Abo-Symbol in Meine Serien und die Einstellungen.
// Kein Netz und kein echter Download: das Abo kommt aus einer vorbereiteten subscriptions.json, die Folgen aus festen Fixtures
// (STREAMING_HUB_E2E_MEDIATHEK_ROUTES); im E2E-Lauf prüft die App nur auf Knopfdruck.
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
const series = parser.parseSections(fixture('ardHomeSections'), 'ard').flatMap(section => section.series).find(item => /House of Yang/.test(item.title));

function buildRoutes() {
  const noNet = body => body.replace(/https:\/\/[^"]*\.(mp4|m3u8)[^"]*/g, NO_STREAM);
  return {
    'pages/ard/home': fixture('ardHomeSections'),
    'pages/HOME/': fixture('arteHomeGenres'),
    '/grouping/': fixture('ardGroupingMurdoch'),
    [`/item/${episodes[0].id}`]: noNet(fixture('ardItem')),
    [`/item/${episodes[1].id}`]: fixture('ardItemInstitutFskBlocked'),
    [`/item/${episodes[2].id}`]: noNet(fixture('ardItemGeoBlocked')),
  };
}

let ctx;
let page;
let tmp;

function seedUserData({ userData, tmpRoot }) {
  const dlRoot = path.join(tmpRoot, 'downloads');
  fs.mkdirSync(dlRoot, { recursive: true });
  // Ein Abo, dem die letzte Folge noch unbekannt ist: „Jetzt prüfen“ reiht genau diese eine ein
  const sub = {
    id: 'sub_e2e00001',
    sourceId: 'ard',
    seriesId: series.id,
    title: series.title,
    imageUrl: null,
    description: null,
    groupingURL: series.groupingURL,
    createdAt: '2026-10-20T10:00:00.000Z',
    knownEntryIds: episodes.slice(0, 2).map(entry => entry.id),
    lastCheckAt: null,
    lastResult: null,
    overrides: {},
    enabled: true,
  };
  fs.writeFileSync(path.join(userData, 'subscriptions.json'), JSON.stringify({ version: 1, items: [sub] }));
  fs.writeFileSync(path.join(userData, 'download-settings.json'), JSON.stringify({ storageRoot: dlRoot }));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediathek-abo-routes-'));
  const routes = path.join(tmp, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify(buildRoutes()));
  const base = Date.now();
  ctx = await launchApp({
    prefix: 'mediathek-abo-e2e-',
    epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
    channels: [{ id: 'E2E.de', name: 'E2E Kanal' }],
    favorites: [],
    env: { STREAMING_HUB_E2E_MEDIATHEK_ROUTES: routes },
    seed: seedUserData,
  });
  page = ctx.page;
  await page.setViewportSize({ width: 1280, height: 860 });
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const chip = label => page.locator('#mediathekPanel-home .mediathek-chip', { hasText: label });
const rows = () => page.locator('#mediathekDownloads .mediathek-sub-item');
const auto = () => page.locator('#mediathekSeriesAuto');
const openSeries = () => page.locator('#mediathekDashboard .mediathek-series-card', { hasText: 'House of Yang' }).first().locator('.mediathek-card-main').click();

test('Abos-Ansicht: Liste mit Serie, Quelle, Zuletzt geprüft, Schalter und Knöpfen', async () => {
  await page.locator('.dashboard-section-tile[data-section="mediathek"]').click();
  await expect(page.locator('#mediathekDashboard')).toBeVisible();
  await chip('Downloads').click();
  await page.locator('#mediathekDownloads .mediathek-seg', { hasText: 'Abos' }).click();
  await expect(page.locator('#mediathekDownloads .mediathek-seg.is-on')).toHaveText('Abos (1)');
  await expect(rows()).toHaveCount(1);
  const row = rows().first();
  await expect(row).toContainText('House of Yang');
  await expect(row).toContainText('ARD');
  await expect(row).toContainText('Zuletzt geprüft: noch nie');
  await expect(row).toContainText('Optionen: Standard');
  const toggle = row.locator('[data-action="toggle"]');
  await expect(toggle).toHaveAttribute('role', 'switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveAccessibleName(/^Neue Folgen automatisch laden: House of Yang/);
  await expect(row.locator('[data-action="check"]')).toHaveAccessibleName(/^Jetzt prüfen: House of Yang/);
  await expect(row.locator('[data-action="options"]')).toBeVisible();
  await expect(row.locator('[data-action="remove"]')).toBeVisible();
  await expect(page.locator('#mediathekSubsHeadline')).toContainText('1 aktives Abo');
  await expect(page.locator('#mediathekSubsHeadline')).toContainText('Die App muss dafür laufen');
  await shot(page, 'abo-liste');
});

test('Jetzt prüfen: die unbekannte Folge wird eingereiht, Ergebnis und Warteschlange stimmen', async () => {
  const row = rows().first();
  await row.locator('[data-action="check"]').click();
  await expect(row.locator('.mediathek-dl-msg').first()).toContainText('1 neue Folge wird geladen', { timeout: 15000 });
  await expect(row).toContainText('Zuletzt geprüft: gerade eben');
  await expect(page.locator('#mediathekDownloads .mediathek-seg', { hasText: 'Warteschlange' })).toHaveText('Warteschlange (1)');
  // zweite Prüfung: nichts Neues, nichts doppelt
  await row.locator('[data-action="check"]').click();
  await expect(row.locator('.mediathek-dl-msg').first()).toHaveText('Keine neuen Folgen.', { timeout: 15000 });
  await expect(page.locator('#mediathekDownloads .mediathek-seg', { hasText: 'Warteschlange' })).toHaveText('Warteschlange (1)');
});

test('Aktiv-Schalter pausiert das Abo, Jetzt prüfen ist dann gesperrt', async () => {
  const row = rows().first();
  await row.locator('[data-action="toggle"]').click();
  await expect(row.locator('[data-action="toggle"]')).toHaveAttribute('aria-checked', 'false');
  await expect(row).toContainText('Pausiert');
  await expect(row.locator('[data-action="check"]')).toBeDisabled();
  await expect(page.locator('#mediathekSubsHeadline')).toHaveText('Keine aktiven Abos.');
  await row.locator('[data-action="toggle"]').click();
  await expect(row.locator('[data-action="toggle"]')).toHaveAttribute('aria-checked', 'true');
});

test('Abo-Optionen: abweichende Qualität speichern, anzeigen und auf Standard zurücksetzen', async () => {
  const row = rows().first();
  await row.locator('[data-action="options"]').click();
  const dialog = page.locator('.mediathek-dialog-options');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-labelledby', 'mediathekSubOptTitle');
  await dialog.locator('#mediathekSubOptHeight').selectOption('720');
  await shot(page, 'abo-optionen');
  await page.locator('#mediathekSubOptGo').click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText('Optionen: Bis 720p');
  await row.locator('[data-action="options"]').click();
  await page.locator('#mediathekSubOptReset').click();
  await expect(row).toContainText('Optionen: Standard');
});

test('Serienkopf: Schalter ist an (Abo vorhanden); ausschalten entfernt das Abo, einschalten öffnet den Dialog', async () => {
  await page.locator('#mediathekDownloads').scrollIntoViewIfNeeded();
  await chip('Alle').click();
  await openSeries();
  await expect(auto()).toBeVisible();
  await expect(auto()).toHaveAttribute('aria-pressed', 'true');
  await expect(auto()).toContainText('Auto-Laden an');
  await shot(page, 'abo-serienkopf');
  await auto().click();
  await expect(auto()).toHaveAttribute('aria-pressed', 'false');
  await auto().click();
  const dialog = page.locator('.mediathek-dialog-options');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#mediathekSubMode-future')).toBeChecked();
  await expect(dialog.locator('#mediathekSubMode-all')).not.toBeChecked();
  await expect(dialog.locator('#mediathekSubOptHeight')).toHaveCount(0);
  await dialog.locator('#mediathekSubCustom').check();
  await expect(dialog.locator('#mediathekSubOptHeight')).toBeVisible();
  await dialog.locator('#mediathekSubOptHeight').selectOption('540');
  await shot(page, 'abo-dialog');
  await page.locator('#mediathekSubGo').click();
  await expect(dialog).toHaveCount(0);
  await expect(auto()).toHaveAttribute('aria-pressed', 'true');
});

test('Dialog „auch bereits vorhandene Folgen“ öffnet die Serien-Auswahl; Abbrechen legt kein Abo an', async () => {
  await auto().click(); // aus
  await expect(auto()).toHaveAttribute('aria-pressed', 'false');
  await auto().click();
  await page.locator('#mediathekSubMode-all').check();
  await expect(page.locator('#mediathekSubGo')).toHaveText('Weiter zur Auswahl');
  await page.locator('#mediathekSubGo').click();
  const select = page.locator('.mediathek-dialog-select');
  await expect(select).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(select).toHaveCount(0);
  await expect(auto()).toHaveAttribute('aria-pressed', 'false');
});

test('Meine Serien: Abo-Symbol an der Serienkarte mit Screenreader-Text', async () => {
  await auto().click();
  await page.locator('#mediathekSubGo').click();
  await expect(auto()).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#mediathekSeriesFav').click();
  await expect(page.locator('#mediathekSeriesFav')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#mediathekSeriesBack').click();
  await chip('Meine Serien').click();
  const card = page.locator('#mediathekPanel-home .mediathek-series-card', { hasText: 'House of Yang' }).first();
  const badge = card.locator('.mediathek-sub-badge');
  await expect(badge).toHaveAccessibleName(/^House of Yang.*: Neue Folgen werden automatisch geladen$/);
  await shot(page, 'abo-meine-serien');
});

test('Abos-Ansicht: Entfernen leert die Liste, der Serienkopf folgt', async () => {
  await chip('Downloads').click();
  await page.locator('#mediathekDownloads .mediathek-seg', { hasText: 'Abos' }).click();
  await expect(rows()).toHaveCount(1);
  await rows().first().locator('[data-action="remove"]').click();
  await expect(rows()).toHaveCount(0);
  await expect(page.locator('#mediathekDownloads .mediathek-empty')).toContainText('Keine Abos');
  await expect(page.locator('#mediathekDownloads .mediathek-seg.is-on')).toHaveText('Abos (0)');
  await chip('Meine Serien').click();
  await expect(page.locator('#mediathekPanel-home .mediathek-sub-badge')).toHaveCount(0);
});

test('Einstellungen ▸ Steuerung: Schalter, Intervall und Maximum je Prüfung (mit Begrenzung)', async () => {
  const settings = await page.evaluate(() => window.downloads.getSettings());
  expect(settings.autoDownloadEnabled).toBe(true);
  expect(settings.autoCheckIntervalHours).toBe(6);
  expect(settings.maxPerCheck).toBe(10);
  const clamped = await page.evaluate(() => window.downloads.setSettings({ autoCheckIntervalHours: 99, maxPerCheck: 0 }));
  expect(clamped.autoCheckIntervalHours).toBe(24);
  expect(clamped.maxPerCheck).toBe(1);
  await page.evaluate(() => window.downloads.setSettings({ autoDownloadEnabled: false, autoCheckIntervalHours: 6, maxPerCheck: 10 }));
  const disabled = await page.evaluate(() => window.downloads.subscriptions.checkNow());
  expect(disabled.ok).toBe(false);
  expect(disabled.code).toBe('disabled');
  await page.evaluate(() => window.downloads.setSettings({ autoDownloadEnabled: true }));
});

test('IPC: ungültige Eingaben werden abgelehnt', async () => {
  const outcome = await page.evaluate(async () => {
    const results = [];
    for (const call of [() => window.downloads.subscriptions.add({ series: { id: 'x' } }), () => window.downloads.subscriptions.update({ id: 'sub_e2e00001' }), () => window.downloads.subscriptions.remove('../x')]) {
      try {
        await call();
        results.push('angenommen');
      } catch {
        results.push('abgelehnt');
      }
    }
    return results;
  });
  expect(outcome).toEqual(['abgelehnt', 'abgelehnt', 'abgelehnt']);
});
