'use strict';

// E2E: Einstellungen ▸ Mediatheken ▸ Konten. Kein echter Login, kein Netz: das Anbieter-Fenster ist durch ein festes Ergebnis
// ersetzt (STREAMING_HUB_E2E_MEDIATHEK_LOGIN=ok) und die Mediathek-Abrufe kommen aus Fixtures (Schlüssel "auth:..." gelten nur für
// Abrufe mit Konto-Token). Geprüft: Karten, Anmelden/Testen/Abmelden, Freischaltung eines FSK-Beitrags nach der Anmeldung und die
// Meldung davor/danach.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');
const { fixture } = require('../tests/fixtures/mediathek/index.js');
const parser = require('../lib/mediathek/parser.js');
const { windowOpen } = require('../lib/mediathek/zdf-fsk.js');

const NO_STREAM = 'https://127.0.0.1:9/e2e.mp4';
const episodes = parser.parseArdGrouping(fixture('ardGroupingMurdoch'));
const fskEntry = episodes[1];

function buildRoutes() {
  const noNet = body => body.replace(/https:\/\/[^"]*\.(mp4|m3u8)[^"]*/g, NO_STREAM);
  return {
    'pages/ard/home': fixture('ardHomeSections'),
    'pages/HOME/': fixture('arteHomeGenres'),
    [`/item/${fskEntry.id}`]: fixture('ardItemInstitutFskBlocked'),
    [`auth:/item/${fskEntry.id}`]: noNet(fixture('ardItem')),
    // ZDF: Dokument mit FSK-Sperre, Startseite mit Api-Auth-Token der Web-App, Altersfreigabe des Kontos, Stream-Daten (PTMD)
    '/document/ZDFFSK': JSON.stringify({ document: { id: 'ZDFFSK', titel: 'Nachtkrimi', fsk: 'fsk16', fskCheck: true, streamApiUrlFsk: 'https://api.zdf.de/tmd/2/ios_native_4/vod/ptmd/mediathek/e2e/4' } }),
    'www.zdf.de/': '<html>{\\"videoToken\\":{\\"apiToken\\":\\"e2eVideoToken0123456789abcdef\\"},\\"appToken\\":{\\"apiToken\\":\\"e2eAppToken0123456789abcdef\\"}}</html>',
    '/identity/userinfo': JSON.stringify({ id: 'e2e' }),
    '/identity/fsk/verification': JSON.stringify({ verified: true }),
    'tmd/2/ios_native_4/vod/ptmd/mediathek/e2e/4': JSON.stringify({ priorityList: [{ formitaeten: [{ type: 'h264_aac_mp4_http_na_na', qualities: [{ quality: 'high', audio: { tracks: [{ class: 'main', language: 'deu', uri: NO_STREAM }] } }] }] }] }),
  };
}

let ctx;
let page;
let tmp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediathek-konten-'));
  const routes = path.join(tmp, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify(buildRoutes()));
  const base = Date.now();
  ctx = await launchApp({
    prefix: 'mediathek-konten-e2e-',
    epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
    channels: [{ id: 'E2E.de', name: 'E2E Kanal' }],
    favorites: [],
    env: { STREAMING_HUB_E2E_MEDIATHEK_ROUTES: routes, STREAMING_HUB_E2E_MEDIATHEK_LOGIN: 'ok', STREAMING_HUB_E2E_ZDF_PIN: '1234' },
  });
  page = ctx.page;
  await page.setViewportSize({ width: 1280, height: 860 });
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const resolveFsk = () => page.evaluate(entry => window.mediathek.resolvePlayback(entry, null), { id: fskEntry.id, title: fskEntry.title, sourceId: 'ard', partner: 'ard' });

test('Konten-Seite: Karten, experimentell, ZDF mit Anmeldung und PIN-Hinweis, Hinweis zum Passwort', async () => {
  await page.locator('.dashboard-section-tile[data-section="settings"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  const group = page.locator('#settingsNav .settings-nav-group', { hasText: 'Mediatheken' });
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await page.locator('#settingsTab-mediathek-accounts').click();
  await expect(page.locator('.settings-page[data-settings-page="mediathek-accounts"]')).toBeVisible();
  await expect(page.locator('.settings-account-card')).toHaveCount(3);
  await expect(page.locator('#settingsMediathekAccountsIntro')).toContainText('Passwort nie');
  await expect(page.locator('#settingsMediathekAccount-arte-state')).toHaveText('Nicht angemeldet');
  await expect(page.locator('#settingsMediathekAccount-zdf-state')).toHaveText('Nicht angemeldet');
  await expect(page.locator('#settingsMediathekAccount-zdf-login')).toBeEnabled();
  await expect(page.locator('.settings-account-card[data-sender="zdf"]')).toContainText('Altersverifikation');
  await expect(page.locator('.settings-account-card[data-sender="zdf"]')).toContainText('FSK 18 bleibt');
  await expect(page.locator('.settings-account-card[data-sender="arte"] .settings-badge')).toBeVisible();
  await expect(page.locator('#settingsMediathekAccount-ard-logout')).toBeDisabled();
});

test('Vor der Anmeldung: gesperrter Beitrag meldet "Mit Konto freischaltbar"', async () => {
  const result = await resolveFsk();
  expect(result.resolution.kind).toBe('ageRestricted');
  expect(result.message).toContain('Mit Konto freischaltbar – in Einstellungen ▸ Mediatheken ▸ Konten anmelden.');
});

test('Anmelden (Fenster-Ergebnis gemockt): Status, Testen, Freischaltung des Beitrags, Abmelden', async () => {
  await page.locator('#settingsMediathekAccount-ard-login').click();
  await expect(page.locator('#settingsMediathekAccount-ard-state')).toContainText('Angemeldet seit');
  await expect(page.locator('#settingsMediathekAccount-ard-logout')).toBeEnabled();
  await expect(page.locator('#settingsMediathekAccountsStatus')).toContainText('Angemeldet');
  // Status enthält nie Token
  const dump = await page.evaluate(async () => JSON.stringify(await window.mediathek.accounts.status()));
  expect(dump).not.toMatch(/e2e-access|e2e-refresh/);
  await page.locator('#settingsMediathekAccount-ard-test').click();
  await expect(page.locator('#settingsMediathekAccountsStatus')).toContainText('Anmeldung gültig');
  const unlocked = await resolveFsk();
  expect(unlocked.resolution.kind).toBe('playable');
  expect(unlocked.message).toBeNull();
  await page.locator('#settingsMediathekAccount-ard-logout').click();
  await expect(page.locator('#settingsMediathekAccount-ard-state')).toHaveText('Nicht angemeldet');
  await expect(page.locator('#settingsMediathekAccountsStatus')).toContainText('Abgemeldet');
  const locked = await resolveFsk();
  expect(locked.resolution.kind).toBe('ageRestricted');
  expect(ctx.problems.filter(problem => !/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED|Failed to load resource/.test(problem))).toEqual([]);
});

test('Renderer kennt nur Zustände: keine Token-API', async () => {
  const api = await page.evaluate(() => Object.keys(window.mediathek.accounts).sort());
  expect(api).toEqual(['login', 'logout', 'onChanged', 'status', 'test']);
});

test('ZDF: FSK-Beitrag nur mit Konto (Altersfreigabe + PIN) abspielbar; Abmelden sperrt wieder; kein Token im Status', async () => {
  const resolveZdf = () => page.evaluate(entry => window.mediathek.resolvePlayback(entry, null), { id: 'ZDFFSK', title: 'Nachtkrimi', sourceId: 'zdf' });
  const open = windowOpen('fsk16', Date.now()); // im Abrufzeitraum (22-6 Uhr) braucht auch die Website kein Konto
  const before = await resolveZdf();
  if (open) expect(before.resolution.kind).toBe('playable');
  else {
    expect(before.resolution.kind).toBe('ageRestricted');
    expect(before.message).toContain('Mit ZDF-Konto freischaltbar');
  }
  await page.locator('#settingsMediathekAccount-zdf-login').click();
  await expect(page.locator('#settingsMediathekAccount-zdf-state')).toContainText('Angemeldet seit');
  await page.locator('#settingsMediathekAccount-zdf-test').click();
  await expect(page.locator('#settingsMediathekAccountsStatus')).toContainText('Altersverifikation bei ZDF: ja');
  const unlocked = await resolveZdf();
  expect(unlocked.resolution.kind).toBe('playable');
  expect(unlocked.resolution.url).toBe(NO_STREAM);
  const dump = await page.evaluate(async () => JSON.stringify(await window.mediathek.accounts.status()));
  expect(dump).not.toMatch(/e2e-access|1234|pin/i);
  await page.locator('#settingsMediathekAccount-zdf-logout').click();
  await expect(page.locator('#settingsMediathekAccount-zdf-state')).toHaveText('Nicht angemeldet');
  expect((await resolveZdf()).resolution.kind).toBe(open ? 'playable' : 'ageRestricted');
});
