'use strict';

// E2E: Planung geplanter Aufnahmen (Etappe 2a; Konzept §3.7/§5).
// Kein Netz: Quelle ist eine lokale M3U-Datei, das EPG kommt aus einer zur Laufzeit
// erzeugten XMLTV-Datei (Test-Hook STREAMING_HUB_EPG_FIXTURE, gilt nur zusammen mit
// STREAMING_HUB_USER_DATA) — sie speist den Main-EPG-Cache (EpgService); der Renderer
// liest EPG nur noch über die Main-APIs (epg:now-next, epg:channels, epg:range-many). Die Netzsperre der Plattform-Argumente bleibt aktiv.
// Seit Etappe 3.3 ist der Programmführer (epg-view.js) eine LISTE mit Detail-MODAL; die Zeilen tragen
// weiterhin die Klasse .epg-program, das Modal die IDs #epgDetailBackdrop/#epgDetailRecordBtn/#epgDetailNotice.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLaunchTarget, launchArgs } = require('./platform');

const KNOWN_HARMLESS = [
  'ERR_NAME_NOT_RESOLVED',
  'Failed to fetch',
  'net::ERR_',
  'Component updater failed',
  'Electron Security Warning',
  'Autofill.enable',
  'Autofill.setAddresses',
  // Absichtliche Ablehnungen aus den Regel-Tests (Electron loggt abgewiesene invoke-Handler):
  "Error occurred in handler for 'schedule:add': ScheduleError: Diese Sendung läuft bereits",
  "Error occurred in handler for 'schedule:add': ScheduleError: Diese Sendung ist bereits vorbei",
  "Error occurred in handler for 'schedule:add': Error: Vorlauf muss eine ganze Zahl",
  "Error occurred in handler for 'schedule:add': ScheduleError: Für diesen Sender liegt kein planbares EPG im Cache vor",
];
const isHarmless = text => KNOWN_HARMLESS.some(k => text.includes(k));

const MIN = 60 * 1000;
const MSG_RUNNING =
  'Diese Sendung läuft bereits und kann nicht mehr geplant werden. Zum Aufnehmen der laufenden Sendung nutze den Aufnahme-Button im Player.';
const MSG_PAST = 'Diese Sendung ist bereits vorbei und kann nicht aufgenommen werden.';

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

let tmpRoot;
let electronApp;
let page;
const problems = [];
let slots;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-sched-')));
  const userData = path.join(tmpRoot, 'userData');
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(userData);
  fs.mkdirSync(home);

  // Ganze Minuten, relativ zu jetzt
  const base = Math.floor(Date.now() / MIN) * MIN;
  slots = {
    past: { title: 'Vergangenes Magazin', start: base - 120 * MIN, stop: base - 60 * MIN },
    running: { title: 'Laufende Sendung', start: base - 30 * MIN, stop: base + 30 * MIN },
    first: { title: 'Kommende Sendung', start: base + 45 * MIN, stop: base + 90 * MIN },
    second: { title: 'Folgesendung', start: base + 90 * MIN, stop: base + 135 * MIN },
  };
  const programmes = Object.values(slots)
    .map(
      s => `<programme start="${xmltvTime(s.start)}" stop="${xmltvTime(s.stop)}" channel="E2E.de"><title>${s.title}</title><desc>Beschreibung &amp; Details zu ${s.title}</desc></programme>`,
    )
    .join('\n');
  const fixture = path.join(tmpRoot, 'epg.xml');
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>${programmes}</tv>`);

  const m3u = path.join(tmpRoot, 'e2e.m3u');
  fs.writeFileSync(m3u, '#EXTM3U\n#EXTINF:-1 tvg-id="E2E.de" group-title="Test",E2E Kanal\nhttp://streams.invalid/e2e.m3u8\n');
  fs.writeFileSync(
    path.join(userData, 'tvsources.json'),
    JSON.stringify([
      {
        id: 'e2e',
        name: 'E2E Quelle',
        url: m3u,
        type: 'file',
        color: '#a78bfa',
        epgUrl: 'https://e2e-epg.example/epg.xml',
        sortOrder: [],
        favorites: ['E2E.de'],
      },
    ]),
  );

  const target = resolveLaunchTarget();
  electronApp = await electron.launch({
    executablePath: target.executablePath,
    args: launchArgs(target),
    env: {
      ...process.env,
      HOME: home,
      STREAMING_HUB_USER_DATA: userData,
      STREAMING_HUB_EPG_FIXTURE: fixture,
      STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9',
    },
    timeout: 45_000,
  });
  electronApp.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[main console] ${msg.text()}`);
  });
  page = await electronApp.firstWindow();
  page.on('pageerror', err => problems.push(`[pageerror] ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[renderer console] ${msg.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
});

test.afterAll(async () => {
  if (electronApp) {
    const proc = electronApp.process();
    await Promise.race([electronApp.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const program = title => page.locator('.epg-program', { hasText: title });

async function openDetail(title) {
  await program(title).first().click();
  await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
  await expect(page.locator('#epgDetailTitle')).toHaveText(title);
}

test('Main-EPG-Cache und Programmführer werden aus der lokalen Fixture gefüllt (kein Netz)', async () => {
  await expect
    .poll(async () => (await page.evaluate(() => window.electronAPI.getEpgStatus())).sources.reduce((n, s) => n + s.channelCount, 0), {
      timeout: 20_000,
    })
    .toBe(1);
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  await expect(page.locator('#dashboardEpgOpen')).toBeVisible();
  await expect(page.locator('#dashboardEpgOpen')).toBeEnabled();
  await page.locator('#dashboardEpgOpen').click();
  await expect(program('Kommende Sendung')).toHaveCount(1, { timeout: 20_000 });
});

test('„Aufnehmen“ ist immer sichtbar; laufende und vergangene Sendungen zeigen nur eine Meldung (kein Dialog)', async () => {
  await openDetail('Laufende Sendung');
  const rec = page.locator('#epgDetailRecordBtn');
  await expect(rec).toBeVisible();
  await rec.click();
  await expect(page.locator('#epgDetailNotice')).toHaveText(MSG_RUNNING);
  await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
  await page.locator('#epgDetailClose').click();

  await openDetail('Vergangenes Magazin');
  await expect(page.locator('#epgDetailNotice')).toBeHidden();
  await page.locator('#epgDetailRecordBtn').click();
  await expect(page.locator('#epgDetailNotice')).toHaveText(MSG_PAST);
  await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
  await page.locator('#epgDetailClose').click();
  expect(await page.evaluate(() => window.electronAPI.listSchedules())).toHaveLength(0);
});

test('Main lehnt laufende/vergangene Sendungen auch an der UI vorbei ab (schedule:add)', async () => {
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const request = s => ({
    channelId: 'E2E.de', channelName: 'E2E Kanal', tvgId: 'E2E.de', sourceId: 'e2e',
    title: s.title, epgStart: iso(s.start), epgStop: iso(s.stop),
  });
  const running = await page.evaluate(r => window.electronAPI.addSchedule(r).then(() => 'ok', e => e.message), request(slots.running));
  expect(running).toContain('läuft bereits und kann nicht mehr geplant werden');
  const past = await page.evaluate(r => window.electronAPI.addSchedule(r).then(() => 'ok', e => e.message), request(slots.past));
  expect(past).toContain('bereits vorbei');
  const longBuffer = await page.evaluate(
    r => window.electronAPI.addSchedule({ ...r, bufferBeforeSec: 3600 }).then(() => 'ok', e => e.message),
    request(slots.first),
  );
  expect(longBuffer).toContain('Vorlauf');
  expect(await page.evaluate(() => window.electronAPI.listSchedules())).toHaveLength(0);
});

test('Planungsdialog: Vorbelegung, Hinweis, Esc verwirft, Planen legt den Eintrag an', async () => {
  await openDetail('Kommende Sendung');
  await page.locator('#epgDetailRecordBtn').click();
  const dialog = page.locator('#recScheduleOverlay');
  await expect(dialog).toHaveClass(/open/);
  await expect(page.locator('#recScheduleProg')).toHaveText('Kommende Sendung — E2E Kanal');
  await expect(page.locator('#recScheduleBefore')).toHaveValue('2');
  await expect(page.locator('#recScheduleAfter')).toHaveValue('5');
  await expect(dialog).toContainText('Streaming Hub muss zur Startzeit laufen (das Fenster darf geschlossen sein).');
  await expect(page.locator('#recScheduleConfirm')).toBeEnabled();
  await expect(page.locator('#recScheduleConflict')).toBeHidden();

  // Esc = Verwerfen
  await page.keyboard.press('Escape');
  await expect(dialog).not.toHaveClass(/open/);
  expect(await page.evaluate(() => window.electronAPI.listSchedules())).toHaveLength(0);

  await page.locator('#epgDetailRecordBtn').click();
  await expect(page.locator('#recScheduleConfirm')).toBeEnabled();
  await page.locator('#recScheduleConfirm').click();
  await expect(dialog).not.toHaveClass(/open/);
  await expect(page.locator('#epgDetailNotice')).toContainText('Aufnahme geplant: Kommende Sendung');
  // Marker und Toggle ziehen live nach (schedule:changed): „Aufnahme geplant ✓“ + „✕ Aufnahme abbrechen“
  await expect(page.locator('#epgDetailPlanned')).toContainText('Aufnahme geplant ✓');
  await expect(page.locator('#epgDetailRecordBtn')).toHaveText('✕ Aufnahme abbrechen');
  const list = await page.evaluate(() => window.electronAPI.listSchedules());
  expect(list).toHaveLength(1);
  expect(list[0].state).toBe('scheduled');
  expect(list[0].bufferBeforeSec).toBe(120);
  expect(list[0].bufferAfterSec).toBe(300);
  expect(list[0].epgStart).toMatch(/[+-]\d{2}:\d{2}$|Z$/);
  expect(list[0].description).toContain('Beschreibung & Details');
  await page.locator('#epgDetailClose').click();
});

test('Direkt anschließende Sendung: Mittelpunkt-Regel und „Eine durchgehende Aufnahme“ sind sichtbar', async () => {
  await openDetail('Folgesendung');
  await page.locator('#epgDetailRecordBtn').click();
  await expect(page.locator('#recScheduleConfirm')).toBeEnabled();
  const adj = page.locator('#recScheduleAdjacency');
  await expect(adj).toBeVisible();
  await expect(adj).toContainText('„Kommende Sendung“ direkt vorher geplant');
  await expect(adj).toContainText('wechseln um');
  await expect(adj).toContainText('Kommende Sendung + Folgesendung');
  await expect(page.locator('#recScheduleMerge')).toBeVisible();
  // Fokus-Trap: Tab wandert durch die Bedienelemente und verlässt den Dialog nicht
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!window.document.activeElement.closest('#recScheduleOverlay'))).toBe(true);
  }
  await page.locator('#recScheduleMerge').click();
  await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#epgDetailNotice')).toContainText('Aufnahme verlängert');
  const list = await page.evaluate(() => window.electronAPI.listSchedules());
  expect(list).toHaveLength(1);
  expect(list[0].title).toBe('Kommende Sendung + Folgesendung');
  await page.locator('#epgDetailClose').click();
  await page.locator('#epgCloseBtn').click();
});

test('Planungsliste „Geplant“: Eintrag sichtbar, Puffer bearbeiten, live per schedule:changed, Absagen, Leerzustand', async () => {
  // 3.6b: Aufnahmen-Bereich über die Karte im LiveTV-Dashboard (kein NavBar-Eintrag mehr)
  await page.locator('#overlayNav [data-section="livetv"]').click();
  await page.locator('#dashboardRecordingsOpen').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Aufnahmen');
  await page.locator('#recordingsTab-planned').click();
  const row = page.locator('.recording-entry[data-schedule-id]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.recording-entry-title')).toHaveText('Kommende Sendung + Folgesendung');
  await expect(row.locator('.recording-entry-status')).toHaveText('Geplant');
  await expect(row).toContainText('E2E Kanal');
  await expect(row).toContainText('Puffer −2/+5 Min.');

  // Bearbeiten (Puffer)
  await row.getByRole('button', { name: 'Bearbeiten' }).click();
  const edit = row.locator('.schedule-inline-edit');
  await expect(edit).toBeVisible();
  await edit.locator('input').nth(0).fill('4');
  await edit.locator('input').nth(1).fill('10');
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect(row).toContainText('Puffer −4/+10 Min.');
  expect((await page.evaluate(() => window.electronAPI.listSchedules()))[0].bufferAfterSec).toBe(600);

  // Live-Update: ein zweiter Eintrag, im Main angelegt, erscheint ohne manuelles Neuladen
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await page.evaluate(async r => window.electronAPI.addSchedule(r), {
    channelId: 'E2E.de', channelName: 'E2E Kanal', tvgId: 'E2E.de', sourceId: 'e2e', title: 'Laufende Sendung',
    epgStart: iso(slots.running.start + 24 * 60 * MIN), epgStop: iso(slots.running.stop + 24 * 60 * MIN),
  }).catch(() => null);
  // (Ohne EPG-Slot im Cache lehnt der Main ab — der Eintrag darf NICHT erscheinen)
  await expect(page.locator('.recording-entry[data-schedule-id]')).toHaveCount(1);

  // Absagen (Start in > 30 min → ohne Rückfrage)
  await row.getByRole('button', { name: 'Absagen' }).click();
  await expect(row.locator('.recording-entry-status')).toHaveText('Abgesagt');
  await expect(page.locator('.schedule-section-title')).toHaveText(['Verlauf']);
  await row.getByRole('button', { name: 'Entfernen' }).click();
  await expect(page.locator('#scheduleEmpty')).toBeVisible();
  await expect(page.locator('#scheduleEmpty')).toContainText('Keine Aufnahmen geplant');
  expect(await page.evaluate(() => window.electronAPI.listSchedules())).toHaveLength(0);
});

test('Settings „LiveTV → Aufnahmen“: Karte „Planung“ speichert Puffer und Spätstart', async () => {
  await page.locator('#overlayNav [data-section="settings"]').click();
  const group = page.locator('#settingsNav .settings-nav-group');
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await page.locator('#settingsTab-livetv-recordings').click();
  await expect(page.locator('#recBufferBeforeInput')).toHaveValue('2');
  await expect(page.locator('#recBufferAfterInput')).toHaveValue('5');
  await expect(page.locator('#recLateStartInput')).toBeChecked();
  await page.locator('#recBufferAfterInput').fill('45'); // wird im Main auf 30 geklemmt
  await page.locator('#recBufferAfterInput').blur();
  await expect(page.locator('#recBufferAfterInput')).toHaveValue('30');
  await page.locator('#recLateStartInput').uncheck();
  await expect.poll(async () => (await page.evaluate(() => window.electronAPI.getRecordingSettings())).lateStart).toBe(false);
  const saved = await page.evaluate(() => window.electronAPI.getRecordingSettings());
  expect(saved.bufferAfterMin).toBe(30);
  expect(saved.bufferBeforeMin).toBe(2);
});

test('keine unerwarteten Fehler in Konsole oder Fenster', async () => {
  expect(problems).toEqual([]);
});
