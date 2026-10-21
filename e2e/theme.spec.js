'use strict';

// E2E: Hell-/Dunkel-Design (Systemdesign, prefers-color-scheme). Die App folgt dem macOS-Design in allen Bereichen:
//  - Wechsel zur Laufzeit ohne Reload (page.emulateMedia ändert die Media-Query),
//  - jeder Bereich liefert in beiden Designs lesbaren Text (Kontrastprüfung aller sichtbaren Texte, e2e/theme-audit.js),
//  - Player-/Video-Flächen bleiben dunkel.
// Kein Netz: lokale M3U + XMLTV-Fixture (Muster epg-helpers.js). Screenshots (optional): THEME_SHOTS=<Verzeichnis> (je Hell/Dunkel + audit.txt).
const { test, expect } = require('@playwright/test');
const { MIN, HOUR, xmltvTime, launchApp, waitForEpgChannels } = require('./epg-helpers');
const { auditInPage, shotBoth } = require('./theme-audit');

const SHOTS = process.env.THEME_SHOTS || '';
// Mindestkontrast der Textprüfung: 3:1 (große/fette Schrift) als harte Grenze; kleinere Texte unter 4,5:1 stehen im audit.txt zur Durchsicht
const HARD_MIN = 3;

let ctx;
let page;
let slots;

const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// Screenshot + Kontrastprüfung beider Designs (hart: kein Text unter HARD_MIN)
async function check(name) {
  const findings = SHOTS ? await shotBoth(page, SHOTS, name, { minRatio: 4.5 }) : [];
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(450); // Farbübergänge (transition) abwarten
    const bad = await page.evaluate(auditInPage, HARD_MIN);
    expect.soft(bad.map(f => `${f.ratio}:1 ${f.sel} "${f.text}"`), `${name} (${scheme}): Text unter ${HARD_MIN}:1`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  return findings;
}

async function goStart() {
  await page.evaluate(() => window.document.getElementById('overlayLocation').click());
  await expect(page.locator('#dashboardView')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const base = Math.floor(Date.now() / MIN) * MIN;
  slots = {
    running: { title: 'Laufende Sendung', start: base - 30 * MIN, stop: base + 30 * MIN, cat: 'Nachrichten' },
    first: { title: 'Kommende Sendung', start: base + 45 * MIN, stop: base + 90 * MIN, cat: 'Sport' },
    second: { title: 'Folgesendung', start: base + 90 * MIN, stop: base + 135 * MIN, cat: 'Film' },
    late: { title: 'Spätfilm', start: base + 5 * HOUR, stop: base + 7 * HOUR, cat: 'Dokumentation' },
  };
  const programme = (channel, s) =>
    `<programme start="${xmltvTime(s.start)}" stop="${xmltvTime(s.stop)}" channel="${channel}"><title>${s.title}</title><category lang="de">${s.cat}</category><desc>Beschreibung zu ${s.title}</desc></programme>`;
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><channel id="E2E2.de"><display-name>Zweiter Kanal</display-name></channel>' +
    Object.values(slots).map(s => programme('E2E.de', s)).join('') +
    programme('E2E2.de', { ...slots.running, title: 'Zweitlauf' }) +
    '</tv>';
  ctx = await launchApp({
    prefix: 'streaming-hub-e2e-theme-',
    epgXml: xml,
    channels: [{ id: 'E2E.de', name: 'E2E Kanal', logo: '@file' }, { id: 'E2E2.de', name: 'Zweiter Kanal' }],
    favorites: ['E2E.de', 'E2E2.de'],
  });
  page = ctx.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await waitForEpgChannels(page, 2);
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

test('Systemwechsel zur Laufzeit ohne Reload: Hintergrund, Text und Navigationsleiste tauschen das Design', async () => {
  await page.evaluate(() => { window.__themeMarker = 'bleibt'; });
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = { body: await bg(), text: await page.evaluate(() => getComputedStyle(document.body).color) };
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(bg).not.toBe(dark.body);
  const light = { body: await bg(), text: await page.evaluate(() => getComputedStyle(document.body).color) };
  expect(light.text).not.toBe(dark.text);
  // heller Grund, dunkle Schrift (und umgekehrt)
  const lum = rgb => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  expect(lum(light.body)).toBeGreaterThan(200);
  expect(lum(light.text)).toBeLessThan(80);
  expect(lum(dark.body)).toBeLessThan(40);
  expect(lum(dark.text)).toBeGreaterThan(200);
  // Navigationsleiste folgt dem System (auf jeder Seite), Wechsel ohne Reload
  await page.locator('.dashboard-section-tile[data-section="settings"]').click();
  const barBg = () => page.locator('#overlayBar').evaluate(node => getComputedStyle(node).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(barBg).toBe('rgb(255, 255, 255)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(barBg).toBe('rgb(23, 23, 23)');
  expect(await page.evaluate(() => window.__themeMarker)).toBe('bleibt');
  await goStart();
});

test('Startseite: Kacheln (dunkle Illustration) und Beschriftung lesbar', async () => {
  await goStart();
  await check('01-start');
});

test('LiveTV-Hub', async () => {
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await expect(page.locator('#dashboardHub')).toBeVisible();
  await check('02-livetv-hub');
});

test('Programmführer: Liste, Raster, Jetzt & Gleich, Suche, Detail-Modal', async () => {
  await page.locator('#dashboardEpgOpen').click();
  await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
  await page.mouse.move(640, 600);
  await page.locator('#epgModeList').click();
  await check('03-epg-liste');
  await page.locator('#epgModeGrid').click();
  await page.waitForTimeout(400);
  await check('04-epg-raster');
  await page.locator('#epgModeJng').click();
  await page.waitForTimeout(300);
  await check('05-epg-jetzt-gleich');
  await page.locator('#epgModeList').click();
  await page.locator('#epgSearchInput').fill('Sendung');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await check('06-epg-suche');
  await page.keyboard.press('Escape');
  await page.locator('#epgSearchInput').fill('');
  await page.locator('#epgList .epg-list-row', { hasText: 'Laufende Sendung' }).first().click();
  await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
  await check('07-epg-detail');
  await page.locator('#epgDetailRecordBtn').click();
  await page.waitForTimeout(400);
  await check('08-epg-detail-laufend-hinweis');
  await page.keyboard.press('Escape');
  // Zukünftige Sendung: Planungsdialog (Vor-/Nachlauf)
  await page.locator('#epgList .epg-list-row', { hasText: 'Kommende Sendung' }).first().click();
  await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
  await page.locator('#epgDetailRecordBtn').click();
  await page.waitForTimeout(600);
  await check('08b-epg-planungsdialog');
  await page.locator('#recScheduleConfirm').click();
  await expect(page.locator('#epgDetailPlanned')).toBeVisible();
  await check('08c-epg-geplant');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('Aufnahmen-Bereich: Bibliothek und Geplant', async () => {
  await goStart();
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await page.locator('#dashboardRecordingsOpen').click();
  await expect(page.locator('.recordings-dashboard-panel')).toBeVisible();
  await check('09-aufnahmen-bibliothek');
  const planned = page.locator('.recordings-tab', { hasText: /Geplant/ });
  if (await planned.count()) {
    await planned.click();
    await page.waitForTimeout(300);
    await check('10-aufnahmen-geplant');
  }
});

test('Streaming-Bereich', async () => {
  await goStart();
  await page.locator('.dashboard-section-tile[data-section="streaming"]').click();
  await page.waitForTimeout(400);
  await check('11-streaming');
});

test('Einstellungen: alle Unterseiten', async () => {
  await goStart();
  await page.locator('.dashboard-section-tile[data-section="settings"]').click();
  await page.waitForTimeout(400);
  const pages = await page.evaluate(() => [...document.querySelectorAll('#settingsNav .settings-nav-item')].map(b => b.dataset.page));
  expect(pages.length).toBeGreaterThan(5);
  for (const name of pages) {
    await page.evaluate(n => document.querySelector(`#settingsNav .settings-nav-item[data-page="${n}"]`).click(), name);
    await page.waitForTimeout(250);
    await check(`12-einstellungen-${name}`);
  }
});

test('Verlauf, Tastenkürzel, Dienst-Formular und Hinweise', async () => {
  await goStart();
  await page.locator('.dashboard-section-tile[data-section="settings"]').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('historyBtn').click());
  await page.waitForTimeout(300);
  await check('13-verlauf');
  await page.evaluate(() => document.getElementById('historyClose').click());
  await page.keyboard.press('?');
  await page.waitForTimeout(300);
  await check('14-tastenkuerzel');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#settingsNav .settings-nav-item[data-page="streaming"]').click());
  await page.evaluate(() => document.getElementById('settingsAddDienstBtn').click());
  await page.waitForTimeout(300);
  await check('15-dienst-formular');
  // Willkommens-Bildschirm (Pfeil, Kürzel) unter der Startseite ist nur im Dienst-Modus sichtbar; Update-Hinweis wird im Update-Spec geprüft
});

test('Dienst-Ansicht: Willkommens-Bildschirm und Fehlerüberlagerung', async () => {
  await goStart();
  // Darstellung der Dienst-Ansicht ohne geladenen Dienst: Dashboard aus, Willkommens-Bildschirm an, Fehlerüberlagerung an
  await page.evaluate(() => {
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('welcomeScreen').style.display = '';
  });
  await page.waitForTimeout(300);
  await check('16-willkommen');
  await page.evaluate(() => {
    document.getElementById('errorMsg').textContent = 'Die Seite konnte nicht geladen werden (ERR_INTERNET_DISCONNECTED).';
    document.getElementById('errorOverlay').style.display = '';
  });
  await page.waitForTimeout(300);
  await check('17-fehlerueberlagerung');
  await page.evaluate(() => {
    document.getElementById('errorOverlay').style.display = 'none';
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('dashboardView').style.display = '';
  });
});
