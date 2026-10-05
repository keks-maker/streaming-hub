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
      running: { title: 'Laufende Sendung', start: base - 30 * MIN, stop: base + 30 * MIN, cat: 'Xyzzy-unbekannt' },
      first: { title: 'Kommende Sendung', start: base + 45 * MIN, stop: base + 90 * MIN },
      second: { title: 'Folgesendung', start: base + 90 * MIN, stop: base + 135 * MIN, cat: 'Nachrichten' },
      // Titel mit literalem „&amp;lt;“ (im XML doppelt maskiert): darf nie erneut dekodiert werden
      tom: { title: 'Tom &amp;lt; Jerry', start: base + 180 * MIN, stop: base + 210 * MIN },
      end: { title: 'Letzte Sendung', start: base + 9 * 24 * HOUR, stop: base + 9 * 24 * HOUR + HOUR },
    };
    // Nachtsendung: nächster 02:00-Uhr-Start nach base+2 h (steht beim Vorabend-TV-Tag, Badge „Nacht“)
    const night = new Date(base + 2 * HOUR);
    night.setHours(2, 0, 0, 0);
    if (night.getTime() <= base + 2 * HOUR) night.setDate(night.getDate() + 1);
    nightStart = night.getTime();
    // Füllkanal: je 25 halbstündige Sendungen an den nächsten drei TV-Tagen → Liste ist scrollbar
    const filler = [];
    for (let day = 1; day <= 3; day += 1) {
      const t = new Date(base);
      t.setDate(t.getDate() + day);
      t.setHours(5, 0, 0, 0);
      for (let i = 0; i < 25; i += 1) {
        const start = t.getTime() + i * 30 * MIN;
        filler.push({ title: `Füller ${day}-${i}`, start, stop: start + 30 * MIN });
      }
    }
    const second = { title: 'Zweitlauf', start: base - 10 * MIN, stop: base + 50 * MIN };
    const nightSlot = { title: 'Nachtkrimi', start: nightStart, stop: nightStart + HOUR };
    const short = { title: 'Kurzmeldung', start: base + 55 * MIN, stop: base + 58 * MIN, cat: 'Sport' }; // 3 min → im Raster schmaler Block
    const programme = (channel, s) => {
      const title = s.title.replace(/&/g, '&amp;');
      const category = s.cat ? `<category lang="de">${s.cat}</category>` : '';
      return `<programme start="${xmltvTime(s.start)}" stop="${xmltvTime(s.stop)}" channel="${channel}"><title>${title}</title>${category}<desc>Beschreibung &amp; Details zu ${title}</desc></programme>`;
    };
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><tv>' +
      '<channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>' +
      '<channel id="E2E2.de"><display-name>Zweiter Kanal</display-name></channel>' +
      '<channel id="E2E3.de"><display-name>Füllkanal</display-name></channel>' +
      Object.values(slots).map(s => programme('E2E.de', s)).join('\n') +
      programme('E2E2.de', second) +
      programme('E2E2.de', short) +
      programme('E2E2.de', nightSlot) +
      filler.map(f => programme('E2E3.de', f)).join('\n') +
      '</tv>';
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgov-',
      epgXml: xml,
      channels: [
        { id: 'E2E.de', name: 'E2E Kanal' },
        { id: 'E2E2.de', name: 'Zweiter Kanal' },
        { id: 'E2E3.de', name: 'Füllkanal' },
      ],
      favorites: ['E2E.de', 'E2E2.de', 'E2E3.de'],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 3);
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
    await expect(page.locator('.epg-now-line')).toHaveText(/^Jetzt \d\d:\d\d · Vergangenes liegt darüber$/);
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
    await expect(page.locator('.epg-day-head', { hasText: 'Morgen' })).toBeVisible();
    // der Tag bleibt aktiv, wenn die Position nicht weiter scrollbar ist (explizite Wahl)
    await page.waitForTimeout(300);
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    // Die Fixture ist durch den Füllkanal scrollbar: der aktive Tab folgt der Scrollposition
    const scrollable = await page.locator('#epgList').evaluate(el => el.scrollHeight - el.clientHeight);
    expect(scrollable).toBeGreaterThan(500);
    await page.locator('#epgList').evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.epg-daytab.active')).not.toHaveText('Morgen');
    await page.locator('#epgList').evaluate(el => {
      el.scrollTop = 0;
    });
    await expect(page.locator('.epg-daytab.active')).toHaveText(/^(Gestern|Heute)$/);
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
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('✕ Aufnahme abbrechen');
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


  // ── Raster (zweiter Modus) ──

  const grid = () => page.locator('#epgGrid');
  const block = title => page.locator('.epg-block', { hasText: title });
  const gridEval = fn => page.locator('#epgGrid').evaluate(fn);

  test('Raster: Moduswechsel ohne Zustandsverlust (Tag, Auswahl), Zoom nur im Raster, Senderspalte nur mit EPG', async () => {
    await expect(page.locator('#epgModeList')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#epgZoom')).toBeHidden();
    await expect(page.locator('#epgJump2015')).toBeHidden();
    // Auswahl im Listenmodus
    await row('Laufende Sendung').locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.epg-list-row.is-selected')).toContainText('Laufende Sendung');
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');

    await page.locator('#epgModeGrid').click();
    await expect(page.locator('#epgModeGrid')).toHaveAttribute('aria-pressed', 'true');
    await expect(grid()).toBeVisible();
    await expect(page.locator('#epgList')).toBeHidden();
    await expect(page.locator('#epgZoom')).toBeVisible();
    await expect(page.locator('#epgJump2015')).toBeVisible();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    // Auswahl bleibt (Block der gewählten Sendung ist markiert)
    await expect(page.locator('.epg-block.is-selected')).toContainText('Laufende Sendung');
    // nur Sender mit EPG, je Zeile 64 px, Senderspalte 150 px
    await expect(page.locator('.epg-grid-cn')).toHaveText(['E2E Kanal', 'Zweiter Kanal', 'Füllkanal']);
    await expect(page.locator('.epg-grid-corner')).toHaveText('Favoriten');
    const dims = await page.evaluate(() => {
      const c = window.document.querySelector('.epg-grid-chan').getBoundingClientRect();
      const col = window.document.querySelector('.epg-grid-chancol').getBoundingClientRect();
      return { rowH: c.height, colW: col.width };
    });
    expect(dims.rowH).toBe(64);
    expect(dims.colW).toBe(150);
    // zurück in die Liste: Tag und Auswahl unverändert
    await page.locator('#epgModeList').click();
    await expect(page.locator('#epgList')).toBeVisible();
    await expect(grid()).toBeHidden();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    await expect(page.locator('.epg-list-row.is-selected')).toContainText('Laufende Sendung');
    await page.locator('#epgModeGrid').click();
    await expect(grid()).toBeVisible();
  });

  test('Raster: „jetzt“ ca. ein Viertel vom linken Rand, Senderspalte und Zeitleiste sticky, Gitter und Tagesgrenzen', async () => {
    await page.locator('#epgNowBtn').click();
    await expect(page.locator('.epg-grid-nowline')).toBeVisible();
    const ratio = await page.evaluate(() => {
      const g = window.document.getElementById('epgGrid').getBoundingClientRect();
      const x = window.document.querySelector('.epg-grid-nowline').getBoundingClientRect().left;
      return (x - g.left - 150) / (g.width - 150);
    });
    expect(ratio).toBeGreaterThan(0.18);
    expect(ratio).toBeLessThan(0.32);
    // sticky: Senderspalte bleibt beim horizontalen Scrollen links, Zeitleiste ist sticky
    const before = await page.locator('.epg-grid-chan').first().evaluate(el => el.getBoundingClientRect().left);
    await gridEval(el => {
      el.scrollLeft += 700;
    });
    const after = await page.locator('.epg-grid-chan').first().evaluate(el => el.getBoundingClientRect().left);
    expect(after).toBe(before);
    expect(await page.locator('.epg-grid-ruler').evaluate(el => window.getComputedStyle(el).position)).toBe('sticky');
    expect(await page.locator('.epg-grid-corner').evaluate(el => window.getComputedStyle(el).position)).toBe('sticky');
    // Zeitleiste: Stundenmarken und beschriftete Tagesgrenzen 05:00; Gitterlinien alle 30 min (Hintergrund = 30 × px/min)
    await expect(page.locator('.epg-ruler-hour').first()).toHaveText(/^\d\d:00$/);
    expect(await page.locator('.epg-ruler-day').count()).toBeGreaterThanOrEqual(8);
    await expect(page.locator('.epg-ruler-day').first()).toHaveText(/^(Mo|Di|Mi|Do|Fr|Sa|So) \d\d\.\d\d\. · 05:00$/);
    await expect(page.locator('.epg-grid-nowlabel')).toHaveText(/^jetzt \d\d:\d\d$/);
    expect(await page.locator('.epg-grid-dayline').count()).toBe(await page.locator('.epg-ruler-day').count());
    expect(await page.locator('#epgGridRows').evaluate(el => window.getComputedStyle(el).backgroundSize)).toContain('150px'); // 30 min × 5 px/min
    await page.locator('#epgNowBtn').click();
  });

  test('Raster: Blöcke mit Titel (fett), Zeit, Fortschritt, gedämpft vergangen, schmale Blöcke mit Tooltip', async () => {
    const running = block('Laufende Sendung');
    await expect(running).toHaveCount(1);
    await expect(running.locator('.epg-block-title')).toHaveText('Laufende Sendung');
    await expect(running.locator('.epg-block-time')).toHaveText(/^\d\d:\d\d · noch \d+ min$/);
    expect(Number(await running.locator('.epg-block-title').evaluate(el => window.getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);
    await expect(running.locator('.epg-block-bar')).toBeVisible();
    await expect(running).toHaveClass(/is-now/);
    await expect(running).toHaveAttribute('title', /^Laufende Sendung\n\d\d:\d\d–\d\d:\d\d · 60 min · Genre: Sonstiges$/);
    await expect(block('Vergangenes Magazin')).toHaveClass(/is-past/);
    expect(Number(await block('Vergangenes Magazin').evaluate(el => window.getComputedStyle(el).opacity))).toBeLessThan(1);
    // 3-Minuten-Sendung: schmaler Block ohne Text, aber mit vollem Titel im Tooltip
    const narrow = page.locator('.epg-block.is-narrow[title^="Kurzmeldung"]');
    await expect(narrow).toHaveCount(1);
    expect(await narrow.locator('.epg-block-title').count()).toBe(0);
    expect(await narrow.evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(28);
    await expect(narrow).toHaveAttribute('title', /Kurzmeldung\n\d\d:\d\d–\d\d:\d\d · 3 min/);
    // Zeilen: Blöcke von Sender 1 liegen in Zeile 0, Sender 2 in Zeile 1 (64 px Raster)
    const tops = await page.evaluate(() => {
      const top = t => [...window.document.querySelectorAll('.epg-block')].find(b => b.textContent.includes(t)).offsetTop;
      return { a: top('Laufende Sendung'), b: top('Zweitlauf') };
    });
    expect(tops.b - tops.a).toBe(64);
  });

  test('Raster: Titel brechen nur an Wortgrenzen um, Text rückt bei links angeschnittenen Blöcken an den sichtbaren Rand, Aufnahme-Toggle überlappt nie den Text', async () => {
    // V1: kein Umbruch mitten im Wort (nur Wortgrenzen, höchstens 2 Zeilen)
    const wrap = await page.locator('.epg-block-title').first().evaluate(el => {
      const st = window.getComputedStyle(el);
      return { wrap: st.overflowWrap, brk: st.wordBreak, clamp: st.webkitLineClamp };
    });
    expect(wrap).toEqual({ wrap: 'normal', brk: 'normal', clamp: '2' });
    // V3: „Laufende Sendung“ (300 px breit) so scrollen, dass der Blockanfang 120 px links vom sichtbaren Rand liegt
    await page.locator('#epgNowBtn').click();
    const probe = () =>
      page.evaluate(() => {
        const g = window.document.getElementById('epgGrid');
        const b = [...window.document.querySelectorAll('.epg-block')].find(x => x.textContent.includes('Laufende Sendung'));
        const edge = g.getBoundingClientRect().left + 150; // rechts der Senderspalte
        const box = b.getBoundingClientRect();
        const text = b.querySelector('.epg-block-text').getBoundingClientRect();
        return { edge, blockLeft: box.left, textLeft: text.left, textRight: text.right, blockRight: box.right };
      });
    await gridEval(el => {
      const b = [...el.querySelectorAll('.epg-block')].find(x => x.textContent.includes('Laufende Sendung'));
      el.scrollLeft = b.offsetLeft + 120;
    });
    await expect.poll(async () => (await probe()).blockLeft < (await probe()).edge - 100).toBe(true);
    await expect.poll(async () => {
      const p = await probe();
      return p.textLeft >= p.edge - 1 && p.textLeft <= p.edge + 16;
    }).toBe(true);
    const cut = await probe();
    expect(cut.textRight).toBeLessThanOrEqual(cut.blockRight + 0.5);
    await page.locator('#epgNowBtn').click();
    // V2: bei jedem Block mit Aufnahme-Toggle endet der Textbereich vor dem Toggle
    const overlaps = await page.evaluate(() => {
      let checked = 0;
      const bad = [];
      for (const b of window.document.querySelectorAll('.epg-block.has-rec')) {
        const rec = window.document.querySelector(`.epg-block-rec[data-rec-key="${b.dataset.blockKey}"]`);
        const text = b.querySelector('.epg-block-text').getBoundingClientRect();
        const title = b.querySelector('.epg-block-title').getBoundingClientRect();
        checked += 1;
        if (!rec || text.right > rec.getBoundingClientRect().left + 0.5 || title.right > rec.getBoundingClientRect().left + 0.5) bad.push(b.dataset.blockKey);
      }
      return { checked, bad };
    });
    expect(overlaps.bad).toEqual([]);
  });

  test('Raster: Zoom 3/5/8 hält den Zeitanker, Breite skaliert, Standard ist 5', async () => {
    await expect(page.locator('.epg-zoom-btn.active')).toHaveText('5 px/min');
    const probe = () =>
      page.evaluate(() => {
        const g = window.document.getElementById('epgGrid');
        const b = [...window.document.querySelectorAll('.epg-block')].find(x => x.textContent.includes('Laufende Sendung'));
        const zoom = Number(window.document.querySelector('.epg-zoom-btn.active').dataset.zoom);
        return { zoom, minutesFromLeft: (b.offsetLeft - g.scrollLeft) / zoom, width: window.document.getElementById('epgGridRows').offsetWidth };
      });
    await gridEval(el => {
      el.scrollLeft += 300;
    });
    const p5 = await probe();
    await page.locator('.epg-zoom-btn[data-zoom="8"]').click();
    await expect(page.locator('.epg-zoom-btn.active')).toHaveText('8 px/min');
    const p8 = await probe();
    await page.locator('.epg-zoom-btn[data-zoom="3"]').click();
    const p3 = await probe();
    expect(p5.zoom).toBe(5);
    expect(Math.abs(p8.minutesFromLeft - p5.minutesFromLeft)).toBeLessThan(1);
    expect(Math.abs(p3.minutesFromLeft - p5.minutesFromLeft)).toBeLessThan(1);
    expect(p8.width / p3.width).toBeGreaterThan(2.6);
    expect(p8.width / p3.width).toBeLessThan(2.7);
    await page.locator('.epg-zoom-btn[data-zoom="5"]').click();
    await page.locator('#epgNowBtn').click();
  });

  test('Raster: Klick auf Block öffnet dasselbe Modal; Esc schließt es, Fokus kehrt auf den Block zurück', async () => {
    await block('Folgesendung').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await expect(page.locator('#epgDetailTitle')).toHaveText('Folgesendung');
    await expect(page.locator('#epgDetailMeta')).toContainText('45 min');
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('● Aufnehmen');
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgDetailBackdrop')).toBeHidden();
    await expect(page.locator('#epgGrid')).toBeVisible();
    expect(await page.evaluate(() => window.document.activeElement.classList.contains('epg-block'))).toBe(true);
    // Hinweis auf die Kanalansicht: Sendernamen sind (noch) kein Button
    expect(await page.locator('.epg-grid-chan-btn').count()).toBe(0);
  });

  test('Raster: Marker geplant/laufend live, Toggle im Modal plant und bricht ab', async () => {
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const added = await page.evaluate(r => window.electronAPI.addSchedule(r), {
      channelId: 'E2E.de',
      channelName: 'E2E Kanal',
      tvgId: 'E2E.de',
      sourceId: 'e2e',
      title: slots.first.title,
      epgStart: iso(slots.first.start),
      epgStop: iso(slots.first.stop),
    });
    await expect(block('Kommende Sendung').locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    expect(await block('Kommende Sendung').locator('.epg-marker').evaluate(el => window.getComputedStyle(el).color)).not.toBe('');
    await block('Kommende Sendung').click();
    await expect(page.locator('#epgDetailPlanned')).toContainText('Aufnahme geplant ✓');
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('✕ Aufnahme abbrechen');
    await page.keyboard.press('Escape');
    await page.evaluate(id => window.electronAPI.removeSchedule(id), added.entry.id);
    await expect(block('Kommende Sendung').locator('.epg-marker')).toHaveAttribute('data-state', '');
    // Planen aus dem Raster-Modal über den bestehenden Dialog
    await block('Folgesendung').click();
    await page.locator('#epgDetailRecordBtn').click();
    await expect(page.locator('#recScheduleOverlay')).toHaveClass(/open/);
    await page.locator('#recScheduleConfirm').click();
    await expect(page.locator('#epgDetailNotice')).toContainText('Aufnahme geplant: Folgesendung');
    await expect(block('Folgesendung').locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    await expect(page.locator('#epgDetailRecordBtn')).toHaveText('✕ Aufnahme abbrechen');
    await page.locator('#epgDetailRecordBtn').click();
    await page.locator('#epgConfirmYes').click();
    await expect(block('Folgesendung').locator('.epg-marker')).toHaveAttribute('data-state', '');
    await page.keyboard.press('Escape');
    expect(await scheduledEntries()).toHaveLength(0);
  });

  test('Raster: kleiner Aufnahme-Toggle im Block (Aufnehmen → Planungsdialog, Abbrechen mit Rückfrage), nicht bei Vergangenem', async () => {
    const recFor = async title => {
      const id = await block(title).getAttribute('data-block-key');
      return page.locator(`.epg-block-rec[data-rec-key="${id}"]`);
    };
    await expect(block('Vergangenes Magazin')).toHaveCount(1);
    await expect(page.locator('.epg-block-rec[data-rec-key*="|' + (slots.past.start) + '"]')).toHaveCount(0);
    const upcoming = await recFor('Kommende Sendung');
    await expect(upcoming).toHaveText('●');
    await upcoming.click();
    await expect(page.locator('#recScheduleOverlay')).toHaveClass(/open/);
    await expect(page.locator('#recScheduleProg')).toHaveText('Kommende Sendung — E2E Kanal');
    await page.locator('#recScheduleConfirm').click();
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    await expect(block('Kommende Sendung').locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    await expect(upcoming).toHaveText('✕');
    await upcoming.click();
    await expect(page.locator('#epgConfirm')).toBeVisible();
    await page.locator('#epgConfirmYes').click();
    await expect(upcoming).toHaveText('●');
    await expect(block('Kommende Sendung').locator('.epg-marker')).toHaveAttribute('data-state', '');
    expect(await scheduledEntries()).toHaveLength(0);
  });

  test('Raster: P9 — Sendung mehr als 8 Tage voraus: Hinweis sichtbar, Aufnehmen deaktiviert; Tages-Tab und Schnellsprung', async () => {
    await gridEval(el => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(block('Letzte Sendung')).toHaveCount(1);
    await block('Letzte Sendung').click();
    await expect(page.locator('#epgDetailTitle')).toHaveText('Letzte Sendung');
    await expect(page.locator('#epgDetailRecordBtn')).toBeDisabled();
    await expect(page.locator('#epgDetailHint')).toBeVisible();
    await expect(page.locator('#epgDetailHint')).toHaveText('Planung nur bis 8 Tage im Voraus');
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    await page.keyboard.press('Escape');
    // Tages-Tab springt horizontal auf 05:00 des Tages und bleibt aktiv; Schnellsprung 20:15
    await page.locator('.epg-daytab', { hasText: 'Morgen' }).click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    await page.waitForTimeout(300);
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    await page.locator('#epgJump2015').click();
    await expect(page.locator('.epg-block', { hasText: 'Füller 1-' }).first()).toBeVisible();
    await page.locator('#epgNowBtn').click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    // zurück in die Liste für die folgenden Tests: Tag bleibt
    await page.locator('.epg-daytab', { hasText: 'Morgen' }).click();
    await page.locator('#epgModeList').click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    await expect(page.locator('.epg-day-head', { hasText: 'Morgen' })).toBeVisible();
    await page.locator('#epgNowBtn').click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
  });


  test('Genre: Spalte und Farbbalken in der Liste, Text im Detail, neutral ohne Kategorie', async () => {
    const withNews = row('Folgesendung');
    await expect(withNews.locator('.epg-col-genre')).toHaveText('Nachrichten');
    await expect(withNews).toHaveAttribute('data-g', 'news');
    const bar = await withNews.evaluate(el => window.getComputedStyle(el).boxShadow);
    expect(bar).toContain('rgb(74, 163, 255)'); // --g-news, 4 px links
    expect(bar).toContain('inset');
    // Kategorie ohne Zuordnung → „Sonstiges“ (neutraler Balken), keine Kategorie → „–“ ohne Balken
    await expect(row('Laufende Sendung').locator('.epg-col-genre')).toHaveText('Sonstiges');
    await expect(row('Laufende Sendung')).toHaveAttribute('data-g', 'sonstiges');
    const none = row('Vergangenes Magazin');
    await expect(none.locator('.epg-col-genre')).toHaveText('–');
    expect(await none.getAttribute('data-g')).toBeNull();
    expect(await none.evaluate(el => window.getComputedStyle(el).boxShadow)).toBe('none');
    await expect(page.locator('.epg-list-head')).toContainText('Genre');
    await expect(page.locator('.epg-list-head')).toContainText('Dauer');
    await expect(withNews.locator('.epg-col-dur')).toHaveText('45 min');
    // Detail: Genre als Text
    await withNews.locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailMeta')).toContainText('Nachrichten');
    await page.keyboard.press('Escape');
    await row('Vergangenes Magazin').locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailMeta')).not.toContainText('Nachrichten');
    await expect(page.locator('#epgDetailMeta')).not.toContainText('Sonstiges');
    await page.keyboard.press('Escape');
  });

  test('Genre im Raster: Farbbalken links im Block (4 px), Genre als Text im Tooltip, neutral ohne Kategorie', async () => {
    await page.locator('#epgModeGrid').click();
    await expect(grid()).toBeVisible();
    const news = block('Folgesendung');
    await expect(news).toHaveAttribute('data-g', 'news');
    await expect(news).toHaveAttribute('title', /Genre: Nachrichten$/);
    expect(await news.evaluate(el => window.getComputedStyle(el).borderLeftWidth)).toBe('4px');
    expect(await news.evaluate(el => window.getComputedStyle(el).borderLeftColor)).toBe('rgb(74, 163, 255)');
    const sport = page.locator('.epg-block.is-narrow[title^="Kurzmeldung"]');
    await expect(sport).toHaveAttribute('title', /Genre: Sport$/);
    await expect(sport).toHaveAttribute('data-g', 'sport');
    const none = block('Vergangenes Magazin');
    expect(await none.getAttribute('data-g')).toBeNull();
    await expect(none).not.toHaveAttribute('title', /Genre/);
    expect(await none.evaluate(el => window.getComputedStyle(el).borderLeftWidth)).toBe('1px');
    await page.locator('#epgModeList').click();
    await expect(page.locator('#epgList')).toBeVisible();
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


  test('Raster auf der Großfixture: virtualisiert (Zeilen und Zeitbereich), Sprung < 300 ms, Scrollen ohne Hängen', async () => {
    const switched = await page.evaluate(async () => {
      const t0 = window.performance.now();
      window.document.getElementById('epgModeGrid').click();
      await new Promise(resolve => {
        const check = () => {
          if (window.document.querySelector('.epg-block')) resolve();
          else window.requestAnimationFrame(check);
        };
        check();
      });
      return window.performance.now() - t0;
    });
    expect(switched).toBeLessThan(2000); // inkl. erstem Nachladen über epg:range-many
    await expect(page.locator('.epg-block').first()).toBeVisible();
    const counts = () =>
      page.evaluate(() => ({
        blocks: window.document.querySelectorAll('.epg-block').length,
        chans: window.document.querySelectorAll('.epg-grid-chan').length,
      }));
    let c = await counts();
    expect(c.chans).toBeLessThan(60);
    expect(c.blocks).toBeLessThan(1500);
    // V2 auf der Großfixture (viele Blockbreiten): Toggle nur ab 90 px und nie über dem Text
    const rec = await page.evaluate(() => {
      let withRec = 0;
      const bad = [];
      for (const b of window.document.querySelectorAll('.epg-block')) {
        const width = b.getBoundingClientRect().width;
        const r = window.document.querySelector(`.epg-block-rec[data-rec-key="${b.dataset.blockKey}"]`);
        if (r) {
          withRec += 1;
          const rb = r.getBoundingClientRect();
          const t = b.querySelector('.epg-block-text').getBoundingClientRect();
          if (width < 90 || t.right > rb.left + 0.5) bad.push(b.dataset.blockKey);
        }
      }
      return { withRec, bad };
    });
    expect(rec.withRec).toBeGreaterThan(10);
    expect(rec.bad).toEqual([]);
    // horizontal scrollen: DOM bleibt begrenzt, Frames hängen nicht
    const scroll = await page.evaluate(async () => {
      const g = window.document.getElementById('epgGrid');
      let maxBlocks = 0;
      const t0 = window.performance.now();
      for (let i = 0; i < 120; i += 1) {
        g.scrollLeft += 900;
        await new Promise(resolve => window.requestAnimationFrame(resolve));
        maxBlocks = Math.max(maxBlocks, window.document.querySelectorAll('.epg-block').length);
      }
      return { maxBlocks, ms: window.performance.now() - t0 };
    });
    expect(scroll.maxBlocks).toBeLessThan(1500);
    expect(scroll.ms).toBeLessThan(120 * 100);
    // vertikal bis ans Ende: letzter Sender erscheint, Zeilen bleiben begrenzt
    await page.evaluate(() => {
      const g = window.document.getElementById('epgGrid');
      g.scrollTop = g.scrollHeight;
    });
    await expect(page.locator('.epg-grid-cn', { hasText: /^Sender 438$/ })).toHaveCount(1);
    c = await counts();
    expect(c.chans).toBeLessThan(60);
    // Sprung auf „Jetzt“: Block im Sichtbereich in < 300 ms (Daten dieses Fensters werden dafür nachgeladen)
    await page.evaluate(() => {
      window.document.getElementById('epgGrid').scrollTop = 0;
    });
    const jump = await page.evaluate(async () => {
      const t0 = window.performance.now();
      window.document.getElementById('epgNowBtn').click();
      await new Promise(resolve => {
        const check = () => {
          const g = window.document.getElementById('epgGrid').getBoundingClientRect();
          const hit = [...window.document.querySelectorAll('.epg-block')].some(b => {
            const r = b.getBoundingClientRect();
            return r.right > g.left + 160 && r.left < g.right && r.bottom > g.top + 40 && r.top < g.bottom;
          });
          if (hit) resolve();
          else window.requestAnimationFrame(check);
        };
        check();
      });
      return window.performance.now() - t0;
    });
    expect(jump).toBeLessThan(300);
    await page.locator('#epgModeList').click();
    await expect(page.locator('#epgList')).toBeVisible();
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
