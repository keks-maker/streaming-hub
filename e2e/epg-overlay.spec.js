'use strict';

// E2E: EPG-Programmführer (Etappe 3.3, Design B2) — Kopfzeile, Tages-Tabs, LISTE, Detail-MODAL,
// einheitlicher Aufnehmen/Abbrechen-Toggle, Marker, Esc-Kette, Zustände, Großfixture.
// Kein Netz: Quelle ist eine lokale M3U-Datei, das EPG kommt aus einer zur Laufzeit erzeugten
// XMLTV-Datei (Test-Hook STREAMING_HUB_EPG_FIXTURE, gilt nur zusammen mit STREAMING_HUB_USER_DATA).
// Das Overlay liest ausschließlich den Main-Cache (epg:range-many/epg:find); die Netzsperre der
// Plattform-Argumente bleibt aktiv. (Stoppen einer laufenden Aufnahme braucht ffmpeg und ist
// hier nicht Teil des E2E; Zustandslogik und Rückfrage stehen in tests/epg-view-model.test.js.)
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLaunchTarget, launchArgs } = require('./platform');
const { buildXmltv, channelId } = require('../tests/helpers/epg-large-fixture.js');

const KNOWN_HARMLESS = [
  'ERR_NAME_NOT_RESOLVED',
  'Failed to fetch',
  'net::ERR_',
  'Component updater failed',
  'Electron Security Warning',
  'Autofill.enable',
  'Autofill.setAddresses',
];
const isHarmless = text => KNOWN_HARMLESS.some(k => text.includes(k));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MSG_RUNNING =
  'Diese Sendung läuft bereits und kann nicht mehr geplant werden. Zum Aufnehmen der laufenden Sendung nutze den Aufnahme-Button im Player.';

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

/** Startet die App mit lokaler Quelle (M3U), EPG-Fixture und Favoriten. */
async function launchApp({ prefix, epgXml, channels, favorites }) {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const userData = path.join(tmpRoot, 'userData');
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(userData);
  fs.mkdirSync(home);
  const fixture = path.join(tmpRoot, 'epg.xml');
  fs.writeFileSync(fixture, epgXml);
  const m3u = path.join(tmpRoot, 'e2e.m3u');
  fs.writeFileSync(
    m3u,
    '#EXTM3U\n' + channels.map(c => `#EXTINF:-1 tvg-id="${c.id}" group-title="Test",${c.name}\nhttp://streams.invalid/${c.id}.m3u8\n`).join(''),
  );
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
        favorites,
      },
    ]),
  );
  const target = resolveLaunchTarget();
  const electronApp = await electron.launch({
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
  const problems = [];
  electronApp.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[main console] ${msg.text()}`);
  });
  const page = await electronApp.firstWindow();
  page.on('pageerror', err => problems.push(`[pageerror] ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[renderer console] ${msg.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
  const cleanup = async () => {
    const proc = electronApp.process();
    await Promise.race([electronApp.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };
  return { electronApp, page, problems, cleanup };
}

async function waitForEpgChannels(page, count) {
  await expect
    .poll(async () => (await page.evaluate(() => window.electronAPI.getEpgStatus())).sources.reduce((n, s) => n + s.channelCount, 0), {
      timeout: 60_000,
    })
    .toBe(count);
}

async function openOverlayFromDashboard(page) {
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  await page.locator('#dashboardEpgOpen').click();
  await expect(page.locator('#epgOverlay')).toBeVisible();
}

// ───────────────────────── Kleine Fixture: Liste, Modal, Toggle, Marker ─────────────────────────

test.describe('Programmführer (kleine Fixture)', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let slots;
  let nightStart;

  test.beforeAll(async () => {
    const base = Math.floor(Date.now() / MIN) * MIN;
    slots = {
      past: { title: 'Vergangenes Magazin', start: base - 120 * MIN, stop: base - 60 * MIN },
      running: { title: 'Laufende Sendung', start: base - 30 * MIN, stop: base + 30 * MIN },
      first: { title: 'Kommende Sendung', start: base + 45 * MIN, stop: base + 90 * MIN },
      second: { title: 'Folgesendung', start: base + 90 * MIN, stop: base + 135 * MIN },
      // Titel mit literalem „&amp;lt;“ (im XML doppelt maskiert): darf nie erneut dekodiert werden
      tom: { title: 'Tom &amp;lt; Jerry', start: base + 180 * MIN, stop: base + 210 * MIN },
      end: { title: 'Letzte Sendung', start: base + 9 * 24 * HOUR, stop: base + 9 * 24 * HOUR + HOUR },
    };
    // Nachtsendung: nächster 02:00-Uhr-Start nach base+2 h (steht beim Vorabend-TV-Tag, Badge „Nacht“)
    const night = new Date(base + 2 * HOUR);
    night.setHours(2, 0, 0, 0);
    if (night.getTime() <= base + 2 * HOUR) night.setDate(night.getDate() + 1);
    nightStart = night.getTime();
    const second = { title: 'Zweitlauf', start: base - 10 * MIN, stop: base + 50 * MIN };
    const nightSlot = { title: 'Nachtkrimi', start: nightStart, stop: nightStart + HOUR };
    const programme = (channel, s) => {
      const title = s.title.replace(/&/g, '&amp;');
      return `<programme start="${xmltvTime(s.start)}" stop="${xmltvTime(s.stop)}" channel="${channel}"><title>${title}</title><desc>Beschreibung &amp; Details zu ${title}</desc></programme>`;
    };
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><tv>' +
      '<channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>' +
      '<channel id="E2E2.de"><display-name>Zweiter Kanal</display-name></channel>' +
      Object.values(slots).map(s => programme('E2E.de', s)).join('\n') +
      programme('E2E2.de', second) +
      programme('E2E2.de', nightSlot) +
      '</tv>';
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgov-',
      epgXml: xml,
      channels: [
        { id: 'E2E.de', name: 'E2E Kanal' },
        { id: 'E2E2.de', name: 'Zweiter Kanal' },
      ],
      favorites: ['E2E.de', 'E2E2.de'],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 2);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  const row = title => page.locator('.epg-list-row', { hasText: title });
  const scheduledEntries = async () => (await page.evaluate(() => window.electronAPI.listSchedules())).filter(e => e.state === 'scheduled');

  test('öffnet aus dem Dashboard vom Main-Cache: Kopfzeile, Tages-Tabs, Liste springt auf „Jetzt“', async () => {
    await openOverlayFromDashboard(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await expect(row('Kommende Sendung')).toHaveCount(1);
    // Kopfzeile ohne Mockup-only-Elemente: Jetzt, Aktualisieren (mit Stand), Schließen
    await expect(page.locator('#epgNowBtn')).toBeVisible();
    await expect(page.locator('#epgRefreshBtn')).toBeVisible();
    await expect(page.locator('#epgCloseBtn')).toBeVisible();
    await expect(page.locator('#epgStand')).toHaveText(/^Stand /);
    await expect(page.locator('.epg-slot-btn')).toHaveCount(0);
    // Tages-Tabs: Heute, Morgen, Wochentage — höchstens 7 TV-Tage (+ „Gestern“, falls Daten davor)
    const tabs = await page.locator('.epg-daytab').allInnerTexts();
    expect(tabs).toContain('Heute');
    expect(tabs).toContain('Morgen');
    expect(tabs.filter(t => t !== 'Gestern').length).toBeLessThanOrEqual(7);
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    // „Jetzt“-Linie mit Uhrzeit, ca. 40 % der Listenhöhe (Toleranz wegen Tabellenkopf)
    await expect(page.locator('.epg-now-line')).toHaveText(/^Jetzt \d\d:\d\d$/);
    const ratio = await page.evaluate(() => {
      const list = window.document.getElementById('epgList').getBoundingClientRect();
      const line = window.document.querySelector('.epg-now-line').getBoundingClientRect();
      return (line.top - list.top) / list.height;
    });
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.65);
    // sortiert nach Startzeit, laufende Sendung mit Fortschritt und „noch N min“, Vergangenes gedämpft
    await expect(row('Laufende Sendung').locator('.epg-time-sub')).toHaveText(/^noch \d+ min$/);
    await expect(row('Laufende Sendung')).toHaveClass(/is-now/);
    await expect(row('Laufende Sendung').locator('.epg-progress')).toBeVisible();
    await expect(row('Vergangenes Magazin')).toHaveClass(/is-past/);
    const order = await page.evaluate(() =>
      [...window.document.querySelectorAll('.epg-list-row')].map(r => r.querySelector('.epg-row-open').textContent),
    );
    expect(order.indexOf('Vergangenes Magazin')).toBeLessThan(order.indexOf('Laufende Sendung'));
    expect(order.indexOf('Laufende Sendung')).toBeLessThan(order.indexOf('Kommende Sendung'));
    expect(order.indexOf('Kommende Sendung')).toBeLessThan(order.indexOf('Folgesendung'));
  });

  test('Tages-Tabs: Tageswechsel springt auf den Tagesanfang, aktiver Tab folgt der Scrollposition, „Jetzt“ springt zurück', async () => {
    await page.locator('.epg-daytab', { hasText: 'Morgen' }).click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    await expect(page.locator('.epg-day-head').first()).toContainText('Morgen');
    // Scrollen über die Tagesgrenze: der aktive Tab folgt der Scrollposition
    const lastTab = await page.locator('.epg-daytab').last().innerText();
    await page.locator('.epg-daytab').last().click();
    await expect(page.locator('.epg-daytab.active')).toHaveText(lastTab);
    await page.locator('#epgList').evaluate(el => {
      el.scrollTop -= el.clientHeight * 3;
    });
    await expect(page.locator('.epg-daytab.active')).not.toHaveText(lastTab);
    await page.locator('#epgNowBtn').click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    await expect(page.locator('.epg-now-line')).toBeVisible();
    await expect(row('Laufende Sendung')).toBeVisible();
  });

  test('Nachtsendung: Badge „Nacht“ beim Vorabend-TV-Tag, im Detail Kalenderdatum + Uhrzeit', async () => {
    const d = new Date(nightStart - 5 * HOUR);
    const pad = n => String(n).padStart(2, '0');
    const dayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    await page.locator(`.epg-daytab[data-day-key="${dayKey}"]`).click();
    const night = row('Nachtkrimi');
    await night.scrollIntoViewIfNeeded();
    await expect(night.locator('.epg-night')).toHaveText('Nacht');
    await night.locator('.epg-row-open').click();
    const calendar = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(nightStart).getDay()];
    await expect(page.locator('#epgDetailMeta')).toContainText(`${calendar} ${pad(new Date(nightStart).getDate())}.${pad(new Date(nightStart).getMonth() + 1)}. 02:00–03:00`);
    await page.locator('#epgDetailClose').click();
    await page.locator('#epgNowBtn').click();
  });

  test('Modal: Klick auf Zeile öffnet das Detail; Esc-Kette schließt erst das Modal, dann das Overlay; Fokus kehrt zurück', async () => {
    await row('Folgesendung').locator('.epg-row-open').click();
    const backdrop = page.locator('#epgDetailBackdrop');
    await expect(backdrop).toBeVisible();
    await expect(page.locator('#epgDetailTitle')).toHaveText('Folgesendung');
    await expect(page.locator('#epgDetailMeta')).toContainText('45 min');
    await expect(page.locator('#epgDetailMeta')).toContainText('E2E Kanal');
    await expect(page.locator('#epgDetailDesc')).toHaveText('Beschreibung & Details zu Folgesendung');
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('● Aufnehmen');
    await expect(page.locator('#epgDetailWatchBtn')).toBeVisible();
    // Fokus-Falle: Tab wandert nur durch Bedienelemente des Modals
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!window.document.activeElement.closest('.epg-detail-modal'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(backdrop).toBeHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    // Fokus zurück auf die Zeile, aus der das Modal geöffnet wurde
    expect(await page.evaluate(() => window.document.activeElement.closest('.epg-list-row')?.dataset.rowId || '')).toContain('E2E.de|');
    // Backdrop-Klick schließt ebenfalls
    await row('Folgesendung').locator('.epg-row-open').click();
    await expect(backdrop).toBeVisible();
    await backdrop.click({ position: { x: 4, y: 4 } });
    await expect(backdrop).toBeHidden();
  });

  test('Aufnehmen aus der Liste: laufend → Meldung ohne Dialog; kommend → Planungsdialog; Marker, Abbrechen mit Rückfrage', async () => {
    // laufende Sendung: Zukunftsregel unverändert (Meldung, kein Dialog)
    await row('Laufende Sendung').locator('.epg-toggle').click();
    await expect(page.locator('#epgToast')).toHaveText(MSG_RUNNING);
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    expect(await scheduledEntries()).toHaveLength(0);

    // kommende Sendung: bestehender Planungsdialog
    const upcoming = row('Kommende Sendung');
    await upcoming.locator('.epg-toggle').click();
    const dialog = page.locator('#recScheduleOverlay');
    await expect(dialog).toHaveClass(/open/);
    await expect(page.locator('#recScheduleProg')).toHaveText('Kommende Sendung — E2E Kanal');
    await page.locator('#recScheduleDiscard').click();
    await expect(dialog).not.toHaveClass(/open/);
    expect(await scheduledEntries()).toHaveLength(0);

    await upcoming.locator('.epg-toggle').click();
    await expect(page.locator('#recScheduleConfirm')).toBeEnabled();
    await page.locator('#recScheduleConfirm').click();
    await expect(dialog).not.toHaveClass(/open/);
    await expect(page.locator('#epgToast')).toContainText('Aufnahme geplant: Kommende Sendung');

    // Marker ● und Toggle „✕ Aufnahme abbrechen“ — ohne Neuöffnen
    await expect(upcoming.locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    await expect(upcoming.locator('.epg-toggle')).toHaveText('✕ Aufnahme abbrechen');
    expect(await scheduledEntries()).toHaveLength(1);

    // Abbrechen: Rückfrage; Esc verwirft sie (Eintrag bleibt), „Ja, abbrechen“ sagt ab
    await upcoming.locator('.epg-toggle').click();
    await expect(page.locator('#epgConfirm')).toBeVisible();
    await expect(page.locator('#epgConfirmText')).toHaveText('Geplante Aufnahme „Kommende Sendung“ abbrechen?');
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgConfirm')).toBeHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    expect(await scheduledEntries()).toHaveLength(1);
    await upcoming.locator('.epg-toggle').click();
    await page.locator('#epgConfirmYes').click();
    await expect(upcoming.locator('.epg-marker')).toHaveAttribute('data-state', '');
    await expect(upcoming.locator('.epg-toggle')).toHaveText('● Aufnehmen');
    expect(await scheduledEntries()).toHaveLength(0);
  });

  test('Detail-Modal: „Aufnahme geplant ✓“, Sprung zur Geplant-Liste, Abbrechen mit Rückfrage entfernt den Marker', async () => {
    await row('Kommende Sendung').locator('.epg-row-open').click();
    await page.locator('#epgDetailRecordBtn').click();
    await expect(page.locator('#recScheduleOverlay')).toHaveClass(/open/);
    await page.locator('#recScheduleConfirm').click();
    await expect(page.locator('#epgDetailNotice')).toContainText('Aufnahme geplant: Kommende Sendung');
    await expect(page.locator('#epgDetailPlanned')).toContainText('Aufnahme geplant ✓');
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('✕ Aufnahme abbrechen');
    await expect(row('Kommende Sendung').locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    // abbrechen (Rückfrage im Modal)
    await page.locator('#epgDetailRecordBtn').click();
    await expect(page.locator('#epgConfirm')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgConfirm')).toBeHidden();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await page.locator('#epgDetailRecordBtn').click();
    await page.locator('#epgConfirmYes').click();
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('● Aufnehmen');
    await expect(page.locator('#epgDetailPlanned')).toBeHidden();
    expect(await scheduledEntries()).toHaveLength(0);
    // erneut planen und über „Zur Geplant-Liste“ springen
    await page.locator('#epgDetailRecordBtn').click();
    await page.locator('#recScheduleConfirm').click();
    await expect(page.locator('#epgDetailPlannedLink')).toBeVisible();
    await page.locator('#epgDetailPlannedLink').click();
    await expect(page.locator('#epgOverlay')).toBeHidden();
    await expect(page.locator('#dashboardTitle')).toHaveText('Aufnahmen');
    await expect(
      page.locator('.recording-entry[data-schedule-id]', { has: page.locator('.recording-entry-status', { hasText: /^Geplant$/ }) }),
    ).toHaveCount(1);
    // aufräumen und Overlay wieder öffnen
    const id = (await scheduledEntries())[0].id;
    await page.evaluate(entryId => window.electronAPI.removeSchedule(entryId), id);
    await page.locator('#overlayNav [data-section="livetv"]').click();
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(row('Kommende Sendung')).toHaveCount(1);
  });

  test('Marker live: Planung und Absage im Main aktualisieren die Liste ohne Neuöffnen', async () => {
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const added = await page.evaluate(
      r => window.electronAPI.addSchedule(r),
      {
        channelId: 'E2E.de',
        channelName: 'E2E Kanal',
        tvgId: 'E2E.de',
        sourceId: 'e2e',
        title: slots.second.title,
        epgStart: iso(slots.second.start),
        epgStop: iso(slots.second.stop),
      },
    );
    await expect(row('Folgesendung').locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    await expect(row('Folgesendung').locator('.epg-toggle')).toHaveText('✕ Aufnahme abbrechen');
    await page.evaluate(id => window.electronAPI.removeSchedule(id), added.entry.id);
    await expect(row('Folgesendung').locator('.epg-marker')).toHaveAttribute('data-state', '');
    await expect(row('Folgesendung').locator('.epg-toggle')).toHaveText('● Aufnehmen');
  });

  test('Titel mit literalem „&amp;lt;“ bleibt unverändert: Liste, Detail, Planungsdialog und Eintrag (kein Doppel-Decode)', async () => {
    const literal = 'Tom &amp;lt; Jerry';
    const tom = row(literal);
    await expect(tom).toHaveCount(1);
    await expect(tom.locator('.epg-row-open')).toHaveText(literal);
    await tom.locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailTitle')).toHaveText(literal);
    await expect(page.locator('#epgDetailDesc')).toHaveText(`Beschreibung & Details zu ${literal}`);
    await page.locator('#epgDetailRecordBtn').click();
    await expect(page.locator('#recScheduleProg')).toHaveText(`${literal} — E2E Kanal`);
    await page.locator('#recScheduleConfirm').click();
    await expect(page.locator('#epgDetailNotice')).toContainText(`Aufnahme geplant: ${literal}`);
    const entries = await scheduledEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe(literal);
    expect(entries[0].description).toContain(literal);
    // abbrechen, damit nachfolgende Tests sauber starten
    await page.locator('#epgDetailRecordBtn').click();
    await page.locator('#epgConfirmYes').click();
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('● Aufnehmen');
    await page.locator('#epgDetailClose').click();
  });

  test('Aktualisieren ruft den Main-Cache; Position und Tag bleiben erhalten', async () => {
    await page.locator('.epg-daytab', { hasText: 'Morgen' }).click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    const before = await page.evaluate(() => window.document.getElementById('epgList').scrollTop);
    await page.locator('#epgRefreshBtn').click();
    await expect(page.locator('#epgRefreshBtn')).toHaveText('↻ Aktualisieren');
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    const after = await page.evaluate(() => window.document.getElementById('epgList').scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(200);
    await page.locator('#epgNowBtn').click();
  });

  test('Wiederholtes Öffnen/Schließen: keine Listener-, Timer- oder DOM-Reste', async () => {
    let subsAfterFirstOpen = null;
    for (let i = 0; i < 5; i += 1) {
      await page.locator('#epgCloseBtn').click();
      await expect(page.locator('#epgOverlay')).toBeHidden();
      await expect(page.locator('#epgOverlay')).toHaveAttribute('data-subs', '0');
      expect(await page.locator('#epgListItems').evaluate(el => el.children.length)).toBe(0);
      await page.locator('#dashboardEpgOpen').click();
      await expect(row('Kommende Sendung')).toHaveCount(1);
      const subs = Number(await page.locator('#epgOverlay').getAttribute('data-subs'));
      expect(subs).toBeGreaterThan(0);
      if (subsAfterFirstOpen === null) subsAfterFirstOpen = subs;
      expect(subs).toBe(subsAfterFirstOpen); // Abos/Timer wachsen nicht mit jedem Öffnen
    }
    await page.keyboard.press('Escape'); // keine Rückfrage/Modal offen → schließt das Overlay
    await expect(page.locator('#epgOverlay')).toBeHidden();
  });

  test('keine unerwarteten Fehler in Konsole oder Fenster', async () => {
    expect(ctx.problems).toEqual([]);
  });
});

// ───────────────────────── Großfixture: Virtualisierung, P14 „Alle Sender“ ─────────────────────────

test.describe('Programmführer (Großfixture 438 Kanäle × 10 Tage)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let ctx;
  let page;

  test.beforeAll(async () => {
    const startMs = Math.floor((Date.now() - 24 * HOUR) / MIN) * MIN;
    const channels = Array.from({ length: 438 }, (_, i) => ({ id: channelId(i), name: `Sender ${i + 1}` }));
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgbig-',
      epgXml: buildXmltv({ channels: 438, days: 10, startMs, seed: 1 }),
      channels,
      favorites: [], // keine Favoriten → P14
    });
    page = ctx.page;
    await waitForEpgChannels(page, 438);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test('P14: ohne Favoriten Hinweis + „Alle Sender zeigen“; danach virtualisierte Liste (DOM bleibt klein)', async () => {
    await openOverlayFromDashboard(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'no-favorites');
    await expect(page.locator('#epgState')).toContainText('Keine Favoriten');
    await expect(page.locator('.epg-list-row')).toHaveCount(0);
    await page.locator('.epg-state-btn', { hasText: 'Alle Sender zeigen' }).click();
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(page.locator('.epg-now-line')).toBeVisible();
    const rows = await page.locator('.epg-list-row').count();
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBeLessThan(150);
    // alle Tage werden im Hintergrund geladen: die Liste hat danach viele tausend Zeilen Höhe, aber kaum DOM
    await expect
      .poll(async () => page.evaluate(() => window.document.getElementById('epgListItems').offsetHeight), { timeout: 60_000 })
      .toBeGreaterThan(438 * 30 * 44);
  });

  test('Sprung auf „Jetzt“ und Tageswechsel: Sichtbereich < 300 ms, Scrollen ohne Hängen, DOM-Zeilen begrenzt', async () => {
    const tabCount = await page.locator('.epg-daytab').count();
    expect(tabCount).toBeGreaterThanOrEqual(7);
    // ans Ende scrollen, dann zurück auf „Jetzt“ messen
    await page.locator('.epg-daytab').last().click();
    const measure = () =>
      page.evaluate(async () => {
        const t0 = window.performance.now();
        window.document.getElementById('epgNowBtn').click();
        await new Promise(resolve => {
          const check = () => {
            const list = window.document.getElementById('epgList').getBoundingClientRect();
            const hit = [...window.document.querySelectorAll('.epg-list-row')].some(r => {
              const b = r.getBoundingClientRect();
              return b.bottom > list.top + 40 && b.top < list.bottom;
            });
            if (hit && window.document.querySelector('.epg-now-line')) resolve();
            else window.requestAnimationFrame(check);
          };
          check();
        });
        return window.performance.now() - t0;
      });
    const jump = await measure();
    expect(jump).toBeLessThan(300);
    // Tageswechsel
    const tabJump = await page.evaluate(async () => {
      const t0 = window.performance.now();
      window.document.querySelectorAll('.epg-daytab')[3].click();
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      return window.performance.now() - t0;
    });
    expect(tabJump).toBeLessThan(300);
    // Scrollen: viele Frames, DOM bleibt begrenzt, kein Fehler
    const scroll = await page.evaluate(async () => {
      const list = window.document.getElementById('epgList');
      let maxRows = 0;
      const t0 = window.performance.now();
      for (let i = 0; i < 120; i += 1) {
        list.scrollTop += 1500;
        await new Promise(resolve => window.requestAnimationFrame(resolve));
        maxRows = Math.max(maxRows, window.document.querySelectorAll('.epg-list-row').length);
      }
      return { maxRows, ms: window.performance.now() - t0 };
    });
    expect(scroll.maxRows).toBeLessThan(150);
    expect(scroll.ms).toBeLessThan(120 * 100); // im Mittel unter 100 ms je Frame
    // zurück auf „Jetzt“
    expect(await measure()).toBeLessThan(300);
  });

  test('Schließen gibt Daten frei; erneutes Öffnen funktioniert; keine unerwarteten Fehler', async () => {
    await page.locator('#epgCloseBtn').click();
    await expect(page.locator('#epgOverlay')).toBeHidden();
    expect(await page.locator('#epgListItems').evaluate(el => el.children.length)).toBe(0);
    expect(await page.locator('#epgListItems').evaluate(el => el.style.height)).toBe('');
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    expect(ctx.problems).toEqual([]);
  });
});
