'use strict';

// E2E: EPG-Programmführer (Etappe 3.3, Design B2) — Kopfzeile, Tages-Tabs, LISTE, Detail-MODAL,
// einheitlicher Aufnehmen/Abbrechen-Toggle, Marker, Esc-Kette, Zustände, Großfixture.
// Kein Netz: Quelle ist eine lokale M3U-Datei, das EPG kommt aus einer zur Laufzeit erzeugten
// XMLTV-Datei (Test-Hook STREAMING_HUB_EPG_FIXTURE, gilt nur zusammen mit STREAMING_HUB_USER_DATA).
// Das Overlay liest ausschließlich den Main-Cache (epg:range-many/epg:find); die Netzsperre der
// Plattform-Argumente bleibt aktiv. (Stoppen einer laufenden Aufnahme braucht ffmpeg und ist
// hier nicht Teil des E2E; Zustandslogik und Rückfrage stehen in tests/epg-view-model.test.js.)
const { test, expect } = require('@playwright/test');
const { buildXmltv, channelId } = require('../tests/helpers/epg-large-fixture.js');
const { MIN, HOUR, MSG_RUNNING, xmltvTime, launchApp, waitForEpgChannels, openOverlayFromDashboard } = require('./epg-helpers');

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
        { id: 'E2E.de', name: 'E2E Kanal', logo: '@file' },
        { id: 'E2E2.de', name: 'Zweiter Kanal', logo: 'https://logo.invalid/zweiter.png' },
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
    // V2: bei jedem Block mit Aufnahme-Toggle endet der Textbereich vor dem Toggle (Toggle gibt es nur mit Aufnahme)
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const planned = await page.evaluate(r => window.electronAPI.addSchedule(r), {
      channelId: 'E2E.de',
      channelName: 'E2E Kanal',
      tvgId: 'E2E.de',
      sourceId: 'e2e',
      title: slots.second.title,
      epgStart: iso(slots.second.start),
      epgStop: iso(slots.second.stop),
    });
    await expect(page.locator('.epg-block.has-rec')).toHaveCount(1);
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
    expect(overlaps.checked).toBe(1);
    expect(overlaps.bad).toEqual([]);
    await page.evaluate(id => window.electronAPI.removeSchedule(id), planned.entry.id);
    await expect(page.locator('.epg-block.has-rec')).toHaveCount(0);
  });

  test('Raster: echte Senderlogos aus der Playlist (img, lazy), Fallback auf das Kürzel-Badge bei defekter oder fehlender URL', async () => {
    const cells = page.locator('.epg-grid-chan');
    const first = cells.nth(0).locator('.epg-grid-logo');
    await expect(first).toHaveClass(/has-img/);
    const img = first.locator('img.epg-grid-logo-img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(img).toHaveAttribute('alt', '');
    expect(await img.evaluate(el => el.getAttribute('src'))).toMatch(/^file:\/\/.*E2E\.de\.png$/);
    expect(await img.evaluate(el => window.getComputedStyle(el).objectFit)).toBe('contain');
    // defekte URL (https://logo.invalid, Netz gesperrt): Bild entfernt, Kürzel steht
    const second = cells.nth(1).locator('.epg-grid-logo');
    await expect(second).toHaveText('ZK');
    await expect(second.locator('img')).toHaveCount(0);
    await expect(second).not.toHaveClass(/has-img/);
    // ohne Logo-Feld: Kürzel
    await expect(cells.nth(2).locator('.epg-grid-logo')).toHaveText('FÜL');
    expect(await cells.nth(2).locator('img').count()).toBe(0);
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
    // Sendernamen sind Buttons (Einstieg in die Kanalansicht, Etappe 3.4)
    await expect(page.locator('.epg-grid-chan-btn')).toHaveCount(3);
    await expect(page.locator('.epg-grid-chan-btn').first()).toHaveAttribute('aria-label', 'Alle Sendungen von E2E Kanal');
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
    const markerStyle = await block('Kommende Sendung').locator('.epg-marker').evaluate(el => {
      const st = window.getComputedStyle(el);
      return { color: st.color, animation: st.animationName };
    });
    expect(markerStyle).toEqual({ color: 'rgb(255, 93, 93)', animation: 'none' }); // geplant: rot, statisch
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

  test('Raster: Toggle im Block nur bei geplanter/laufender Aufnahme; Aufnehmen über das Modal, Abbrechen mit Rückfrage', async () => {
    // ohne Aufnahme: kein Punkt/Button in den Blöcken
    await expect(page.locator('.epg-block-rec')).toHaveCount(0);
    await expect(page.locator('.epg-block.has-rec')).toHaveCount(0);
    // Aufnehmen: Block → Modal → Planungsdialog
    await block('Kommende Sendung').click();
    await page.locator('#epgDetailRecordBtn').click();
    await expect(page.locator('#recScheduleOverlay')).toHaveClass(/open/);
    await expect(page.locator('#recScheduleProg')).toHaveText('Kommende Sendung — E2E Kanal');
    await page.locator('#recScheduleConfirm').click();
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    await page.keyboard.press('Escape'); // Modal schließen
    // jetzt erscheint der ✕-Toggle (nur dieser Block) neben dem Marker
    await expect(block('Kommende Sendung').locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    const id = await block('Kommende Sendung').getAttribute('data-block-key');
    const rec = page.locator(`.epg-block-rec[data-rec-key="${id}"]`);
    await expect(rec).toHaveText('✕');
    await expect(page.locator('.epg-block-rec')).toHaveCount(1);
    // Abbrechen mit Rückfrage entfernt den Toggle wieder
    await rec.click();
    await expect(page.locator('#epgConfirm')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgConfirm')).toBeHidden();
    await expect(rec).toHaveText('✕');
    await rec.click();
    await page.locator('#epgConfirmYes').click();
    await expect(page.locator('.epg-block-rec')).toHaveCount(0);
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


  // Main-Simulation einer laufenden Aufnahme (Stoppen braucht ffmpeg): Planungseintrag bleibt wie beim echten
  // Scheduler bis zum nächsten 30-s-Takt 'recording'; recording:stop antwortet erst nach der Nachbearbeitung.
  const installFakeRecording = async (mode, entry) => {
    await ctx.electronApp.evaluate(
      ({ ipcMain, BrowserWindow }, { fake, stopMode }) => {
        const g = globalThis;
        const broadcast = (channel, payload) => {
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
        };
        if (!g.__fakeInstalled) {
          g.__fakeInstalled = true;
          g.__origScheduleList = ipcMain._invokeHandlers.get('schedule:list');
          g.__origRecordingList = ipcMain._invokeHandlers.get('recording:list');
          ipcMain.removeHandler('schedule:list');
          ipcMain.handle('schedule:list', async event => {
            const real = await g.__origScheduleList(event);
            return g.__fakeEntry ? [...real, g.__fakeEntry] : real;
          });
          ipcMain.removeHandler('recording:list');
          ipcMain.handle('recording:list', async event => {
            const real = await g.__origRecordingList(event);
            return g.__fakeRec ? [...real, g.__fakeRec] : real;
          });
          ipcMain.removeHandler('recording:stop');
          ipcMain.handle('recording:stop', async () => {
            g.__stopCalls = (g.__stopCalls || 0) + 1;
            await new Promise(resolve => setTimeout(resolve, 1200)); // ffmpeg beendet den Job
            g.__fakeRec = { ...g.__fakeRec, status: 'remux-pending' };
            broadcast('recording:changed', { recId: g.__fakeRec.id, meta: g.__fakeRec });
            await new Promise(resolve => setTimeout(resolve, 1200)); // Remux
            if (g.__stopMode === 'fail') throw new Error('Remux fehlgeschlagen');
            g.__fakeRec = { ...g.__fakeRec, status: 'completed' };
            return g.__fakeRec;
          });
        }
        g.__stopMode = stopMode;
        g.__fakeEntry = fake;
        g.__fakeRec = fake ? { id: fake.recId, status: 'recording', channelId: fake.channelId, startedAt: fake.epgStart } : null;
        broadcast('schedule:changed', {});
      },
      {
        stopMode: mode,
        fake: entry && {
          id: 'sch_e2efake',
          state: 'recording',
          recId: 'rec_e2efake',
          title: 'Laufende Sendung',
          tvgId: 'E2E.de',
          channelId: 'E2E.de',
          channelName: 'E2E Kanal',
          epgStart: new Date(entry.start).toISOString(),
          epgStop: new Date(entry.stop).toISOString(),
        },
      },
    );
  };

  test('Raster, laufende Aufnahme: links pulsiert der Marker, der Toggle rechts ist ein statischer Stopp-Knopf (■); Stoppen gibt Rückmeldung und der Marker verschwindet', async () => {
    await page.locator('#epgModeGrid').click();
    await installFakeRecording('ok', slots.running);
    const live = block('Laufende Sendung');
    await expect(live.locator('.epg-marker')).toHaveAttribute('data-state', 'recording');
    const rec = page.locator(`.epg-block-rec[data-rec-key="${await live.getAttribute('data-block-key')}"]`);
    await expect(rec).toHaveText('■');
    await expect(rec).toHaveAttribute('data-kind', 'stop');
    const anim = el => window.getComputedStyle(el).animationName;
    expect(await live.locator('.epg-marker').evaluate(anim)).toBe('epgPulse');
    expect(await rec.evaluate(anim)).toBe('none'); // genau ein pulsierender Punkt
    await rec.click();
    await expect(page.locator('#epgConfirmText')).toContainText('Laufende Aufnahme „Laufende Sendung“ stoppen?');
    await page.locator('#epgConfirmYes').click();
    // sofortige Rückmeldung; Main arbeitet noch: Marker gedämpft ohne Pulsieren, Knopf deaktiviert
    await expect(page.locator('#epgToast')).toContainText('Aufnahme „Laufende Sendung“ wird beendet');
    await expect(live.locator('.epg-marker')).toHaveAttribute('data-state', 'stopping');
    expect(await live.locator('.epg-marker').evaluate(anim)).toBe('none');
    await expect(rec).toBeDisabled();
    // Bibliothek meldet die Aufnahme nicht mehr als laufend (recording:changed): Marker weg, obwohl der Planungseintrag noch 'recording' ist
    await expect(live.locator('.epg-marker')).toHaveAttribute('data-state', '');
    await expect(rec).toHaveCount(0);
    // IPC-Antwort nach der Nachbearbeitung: Erfolgsmeldung
    await expect(page.locator('#epgToast')).toContainText('Aufnahme „Laufende Sendung“ beendet. Sie liegt in der Aufnahmen-Bibliothek.');
    await expect(page.locator('#epgToast')).toHaveClass(/ok/);
    expect(await ctx.electronApp.evaluate(() => globalThis.__stopCalls)).toBe(1);
  });

  test('Liste, laufende Aufnahme: Stopp mit Fehler der Nachbearbeitung zeigt eine Meldung, der Marker verschwindet trotzdem', async () => {
    await page.locator('#epgModeList').click();
    await installFakeRecording('fail', slots.running);
    const live = row('Laufende Sendung');
    await expect(live.locator('.epg-marker')).toHaveAttribute('data-state', 'recording');
    await expect(live.locator('.epg-toggle')).toHaveText('■ Aufnahme stoppen');
    await live.locator('.epg-toggle').click();
    await page.locator('#epgConfirmYes').click();
    await expect(live.locator('.epg-marker')).toHaveAttribute('data-state', 'stopping');
    await expect(live.locator('.epg-toggle')).toHaveText('■ Wird beendet …');
    await expect(live.locator('.epg-toggle')).toBeDisabled();
    await expect(live.locator('.epg-marker')).toHaveAttribute('data-state', '');
    await expect(page.locator('#epgToast')).toContainText('Aufnahme beendet, die Nachbearbeitung ist fehlgeschlagen: Remux fehlgeschlagen');
    await installFakeRecording('ok', null); // Simulation zurücknehmen
    ctx.problems = ctx.problems.filter(p => !p.includes("recording:stop': Error: Remux fehlgeschlagen")); // beabsichtigter Simulationsfehler
    await expect(live.locator('.epg-marker')).toHaveAttribute('data-state', '');
  });

  test('Navbar im Programmführer: eingeklappte Navbar liegt über dem Overlay, Hover blendet sie ein, Navigation beendet den Programmführer; danach stimmt der Navbar-Zustand', async () => {
    await expect(page.locator('body')).toHaveClass(/epg-open/);
    await expect(page.locator('#overlayBar')).toHaveClass(/nav-collapsed/);
    const probe = await page.evaluate(() => {
      const bar = window.document.getElementById('overlayBar').getBoundingClientRect();
      const x = bar.left + bar.width / 2;
      const hit = window.document.elementFromPoint(x, 4);
      return { x, onBar: !!(hit && hit.closest('#overlayBar')), height: bar.height };
    });
    expect(probe.onBar).toBe(true);
    expect(probe.height).toBeLessThan(20);
    await page.mouse.move(probe.x, 4);
    await expect(page.locator('.nav-section-item[data-section="recording"]')).toBeVisible();
    await expect.poll(() => page.locator('#overlayBar').evaluate(el => Math.round(el.getBoundingClientRect().height))).toBeGreaterThan(60);
    // Overlay-Layout bleibt: Rahmen und Kopfzeile unverändert unter der Navbar
    await expect(page.locator('#epgNowBtn')).toBeVisible();
    await page.locator('.nav-section-item[data-section="recording"]').click();
    await expect(page.locator('#epgOverlay')).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/epg-open/);
    await expect(page.locator('#dashboardTitle')).toHaveText('Aufnahmen');
    await expect(page.locator('#overlayBar')).toHaveClass(/always-visible/);
    await page.locator('.nav-section-item[data-section="livetv"]').click();
    await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    // Esc schließt wie bisher und stellt den Navbar-Zustand des Dashboards her
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgOverlay')).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/epg-open/);
    await expect(page.locator('#overlayBar')).toHaveClass(/always-visible/);
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toBeVisible();
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

// ───────────────────────── Kanalansicht (Etappe 3.4) ─────────────────────────

test.describe('Kanalansicht (kleine Fixture)', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let nightStart;
  let farStart;

  const pad = n => String(n).padStart(2, '0');
  const dayKeyOf = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  test.beforeAll(async () => {
    const base = Math.floor(Date.now() / MIN) * MIN;
    const todayStart = new Date(base);
    if (todayStart.getHours() < 5) todayStart.setDate(todayStart.getDate() - 1);
    todayStart.setHours(5, 0, 0, 0);
    const night = new Date(base + 2 * HOUR);
    night.setHours(2, 0, 0, 0);
    if (night.getTime() <= base + 2 * HOUR) night.setDate(night.getDate() + 1);
    nightStart = night.getTime();
    farStart = base + 9 * 24 * HOUR;
    const one = [
      { title: 'Vorlauf-Magazin', start: base - 120 * MIN, stop: base - 60 * MIN },
      { title: 'Laufende Show', start: base - 30 * MIN, stop: base + 30 * MIN },
      { title: 'Nächste Show', start: base + 45 * MIN, stop: base + 90 * MIN, cat: 'Nachrichten' },
      { title: 'Spätere Show', start: base + 90 * MIN, stop: base + 135 * MIN },
      { title: 'Nachtkrimi', start: nightStart, stop: nightStart + HOUR },
      { title: 'Weitentfernt', start: farStart, stop: farStart + HOUR },
    ];
    for (let day = 1; day <= 3; day += 1) {
      const t = new Date(todayStart);
      t.setDate(t.getDate() + day);
      for (let i = 0; i < 25; i += 1) {
        const start = t.getTime() + i * 30 * MIN;
        one.push({ title: `Füller ${day}-${i}`, start, stop: start + 30 * MIN });
      }
    }
    const two = [
      { title: 'Zwei läuft', start: base - 10 * MIN, stop: base + 50 * MIN },
      { title: 'Zwei danach', start: base + 50 * MIN, stop: base + 100 * MIN },
    ];
    // Spätkanal: nur eine Sendung gestern Abend (im Cache, aber nicht in den 7 TV-Tagen ab heute)
    const three = [{ title: 'Altsendung', start: todayStart.getTime() - 6 * HOUR, stop: todayStart.getTime() - 5 * HOUR }];
    const programme = (channel, s) => {
      const title = s.title.replace(/&/g, '&amp;');
      const category = s.cat ? `<category lang="de">${s.cat}</category>` : '';
      return `<programme start="${xmltvTime(s.start)}" stop="${xmltvTime(s.stop)}" channel="${channel}"><title>${title}</title>${category}<desc>Beschreibung zu ${title}</desc></programme>`;
    };
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><tv>' +
      '<channel id="KV1.de"><display-name>Kanal Eins</display-name></channel>' +
      '<channel id="KV2.de"><display-name>Kanal Zwei</display-name></channel>' +
      '<channel id="KV3.de"><display-name>Spätkanal</display-name></channel>' +
      one.map(s => programme('KV1.de', s)).join('\n') +
      two.map(s => programme('KV2.de', s)).join('\n') +
      three.map(s => programme('KV3.de', s)).join('\n') +
      '</tv>';
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgch-',
      epgXml: xml,
      channels: [
        { id: 'KV1.de', name: 'Kanal Eins', logo: '@file' },
        { id: 'KV2.de', name: 'Kanal Zwei', logo: 'https://logo.invalid/zwei.png' },
        { id: 'KV3.de', name: 'Spätkanal' },
      ],
      favorites: ['KV1.de', 'KV2.de', 'KV3.de'],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 3);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  const listRow = title => page.locator('.epg-list-row', { hasText: title });
  const crow = title => page.locator('.epg-crow', { hasText: title });
  const scheduledEntries = async () => (await page.evaluate(() => window.electronAPI.listSchedules())).filter(e => e.state === 'scheduled');
  const channelVisible = () => expect(page.locator('#epgChannel')).toBeVisible();
  const channelHidden = () => expect(page.locator('#epgChannel')).toBeHidden();

  test('Einstieg per Sendername in der Liste: Kopfzeile mit Kanalname/Logo, Segment bleibt Liste | Raster, Esc führt zurück (Fokus auf den Sendernamen)', async () => {
    await openOverlayFromDashboard(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await channelHidden();
    const link = listRow('Laufende Show').locator('.epg-chan-link');
    await expect(link).toHaveText('Kanal Eins');
    await expect(link).toHaveAttribute('aria-label', 'Alle Sendungen von Kanal Eins');
    await link.click();
    await channelVisible();
    await expect(page.locator('#epgChannelName')).toHaveText('Kanal Eins');
    await expect(page.locator('#epgChannelBack')).toHaveText('← Alle Sender');
    // Logo wie im Raster: echtes Bild aus der Playlist, sonst Kürzel
    await expect(page.locator('#epgChannel .epg-channel-logo')).toHaveClass(/has-img/);
    // P7: kein Segment-Button für die Kanalansicht (Segment: Liste | Raster | Jetzt & Gleich); keiner ist hervorgehoben
    await expect(page.locator('.epg-header .epg-seg-btn')).toHaveCount(3);
    await expect(page.locator('#epgModeList')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#epgModeGrid')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#epgModeJng')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#epgZoom')).toBeHidden();
    // Herkunftsansicht liegt darunter und ist inert (kein Fokus/Klick dahinter)
    expect(await page.locator('#epgList').evaluate(el => el.inert)).toBe(true);
    // Kopf: Jetzt-Zeile, 7 TV-Tage + „Weitere Tage“ (Cache reicht über 8 Tage hinaus)
    await expect(page.locator('#epgChannelNow')).toHaveText(/^Jetzt läuft: Laufende Show · noch \d+ min$/);
    const tabs = await page.locator('.epg-daytab[data-day-key]').allInnerTexts();
    expect(tabs.slice(0, 2)).toEqual(['Heute', 'Morgen']);
    expect(tabs).toHaveLength(7);
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    await expect(page.locator('#epgChannelMore')).toBeVisible();
    // Esc → zurück zur Herkunft (Overlay bleibt), Fokus auf dem Sendernamen der Zeile
    await page.keyboard.press('Escape');
    await channelHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(link).toBeFocused();
    expect(await page.locator('#epgList').evaluate(el => el.inert)).toBe(false);
  });

  test('Tastatur: Enter am Sendernamen (Liste) und Leertaste (Raster) öffnen die Kanalansicht, Zurück-Button führt zurück', async () => {
    const link = listRow('Zwei läuft').locator('.epg-chan-link');
    await link.focus();
    await page.keyboard.press('Enter');
    await channelVisible();
    await expect(page.locator('#epgChannelName')).toHaveText('Kanal Zwei');
    await expect(page.locator('#epgChannel .epg-channel-logo')).toHaveText('KZ'); // https-Logo gesperrt → Kürzel
    await expect(page.locator('#epgChannelBack')).toBeFocused();
    await page.locator('#epgChannelBack').click();
    await channelHidden();
    await expect(link).toBeFocused();
    // Raster
    await page.locator('#epgModeGrid').click();
    const cell = page.locator('.epg-grid-chan-btn', { hasText: 'Kanal Eins' });
    await expect(cell).toHaveAttribute('aria-label', 'Alle Sendungen von Kanal Eins');
    await cell.focus();
    await page.keyboard.press('Space');
    await channelVisible();
    await expect(page.locator('#epgChannelName')).toHaveText('Kanal Eins');
    await page.keyboard.press('Escape');
    await channelHidden();
    await expect(cell).toBeFocused();
    await page.locator('#epgModeList').click();
    await expect(page.locator('#epgList')).toBeVisible();
  });

  test('Jetzt und Nächste hervorgehoben, laufende Sendung mit Fortschritt, Genre-Spalte/Farbbalken, Liste springt auf „Jetzt“', async () => {
    await listRow('Laufende Show').locator('.epg-chan-link').click();
    await channelVisible();
    const running = crow('Laufende Show');
    await expect(running).toHaveClass(/is-now/);
    await expect(running.locator('.epg-flag')).toHaveText('Jetzt');
    await expect(running.locator('.epg-time-sub')).toHaveText(/^noch \d+ min$/);
    await expect(running.locator('.epg-progress')).toBeVisible();
    const next = crow('Nächste Show');
    await expect(next).toHaveClass(/is-next/);
    await expect(next.locator('.epg-flag')).toHaveText('Nächste');
    await expect(crow('Spätere Show').locator('.epg-flag')).toBeHidden();
    // Zeitspanne Start–Ende, Dauer, Genre als Text und Farbbalken (Mechanik aus 3.3)
    await expect(next.locator('.epg-time')).toHaveText(/^\d\d:\d\d–\d\d:\d\d$/);
    await expect(next.locator('.epg-col-dur')).toHaveText('45 min');
    await expect(next.locator('.epg-col-genre')).toHaveText('Nachrichten');
    await expect(next).toHaveAttribute('data-g', 'news');
    expect(await next.evaluate(el => window.getComputedStyle(el).boxShadow)).toContain('rgb(74, 163, 255)');
    await expect(running.locator('.epg-col-genre')).toHaveText('–');
    // laufende Sendung steht im Sichtbereich (Jetzt-Anker ca. 30 %)
    const ratio = await page.evaluate(() => {
      const list = window.document.getElementById('epgChannelList').getBoundingClientRect();
      const row = [...window.document.querySelectorAll('.epg-crow.is-now')][0].getBoundingClientRect();
      return (row.top - list.top) / list.height;
    });
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThan(0.7);
    // Fortschritt/Kennzeichen ändern sich ohne Neuaufbau: Knotenidentität bleibt nach dem Tick-Update
    await page.evaluate(() => {
      window.__rowNode = [...window.document.querySelectorAll('.epg-crow.is-now')][0];
    });
    await page.locator('#epgNowBtn').click();
    expect(await page.evaluate(() => window.__rowNode === [...window.document.querySelectorAll('.epg-crow.is-now')][0])).toBe(true);
  });

  test('Tageswechsel: Tab springt auf 05:00 des Tages, aktiver Tab folgt der Scrollposition, „Jetzt“ springt zurück', async () => {
    const list = page.locator('#epgChannelList');
    await page.locator('.epg-daytab', { hasText: 'Morgen' }).click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    const tomorrow = dayKeyOf(Date.now() + 24 * HOUR);
    const offset = await page.evaluate(() => {
      const l = window.document.getElementById('epgChannelList').getBoundingClientRect().top;
      const head = [...window.document.querySelectorAll('.epg-cday-head')].find(h => /^Morgen/.test(h.textContent));
      return head.getBoundingClientRect().top - l;
    });
    expect(Math.abs(offset)).toBeLessThan(4);
    await page.waitForTimeout(300);
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen'); // explizite Wahl bleibt
    expect(tomorrow).toMatch(/^\d{4}-\d\d-\d\d$/);
    await expect(crow('Füller 1-0')).toBeVisible();
    // Scrollen: aktiver Tab folgt
    await list.evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.epg-daytab.active')).not.toHaveText('Morgen');
    await page.locator('#epgNowBtn').click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    await expect(crow('Laufende Show')).toBeInViewport();
    // Tage ohne Sendungen: ausgegraut, mit Hinweis in der Liste
    const emptyTab = page.locator('.epg-daytab.is-empty').first();
    await expect(emptyTab).toBeVisible();
    await emptyTab.click();
    await expect(page.locator('.epg-cday.is-empty .epg-cday-note').first()).toContainText('Sendungen');
    await page.locator('#epgNowBtn').click();
  });

  test('Nachtsendung steht beim Vorabend-TV-Tag mit Badge „Nacht“ (wie in der Liste)', async () => {
    const eveningKey = dayKeyOf(nightStart - 5 * HOUR);
    const block = page.locator(`.epg-cday[data-day-key="${eveningKey}"]`);
    const night = block.locator('.epg-crow', { hasText: 'Nachtkrimi' });
    await expect(night).toHaveCount(1);
    await night.scrollIntoViewIfNeeded();
    await expect(night.locator('.epg-night')).toHaveText('Nacht');
    // nicht beim Folgetag
    const morningKey = dayKeyOf(nightStart);
    if (morningKey !== eveningKey) await expect(page.locator(`.epg-cday[data-day-key="${morningKey}"] .epg-crow`, { hasText: 'Nachtkrimi' })).toHaveCount(0);
    await night.locator('.epg-row-open').click();
    const calendar = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(nightStart).getDay()];
    await expect(page.locator('#epgDetailMeta')).toContainText(`${calendar} ${pad(new Date(nightStart).getDate())}.${pad(new Date(nightStart).getMonth() + 1)}. 02:00–03:00`);
    await page.locator('#epgDetailClose').click();
    await expect(night.locator('.epg-row-open')).toBeFocused();
    await page.locator('#epgNowBtn').click();
  });

  test('Toggle in der Kanalansicht: Aufnehmen → Planungsdialog → Marker; Abbrechen mit Rückfrage entfernt den Marker (Esc verwirft die Rückfrage)', async () => {
    // laufende Sendung ohne Aufnahme: Zukunftsregel-Meldung, kein Dialog
    await crow('Laufende Show').locator('.epg-toggle').click();
    await expect(page.locator('#epgToast')).toHaveText(MSG_RUNNING);
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    // kommende Sendung: bestehender Planungsdialog
    const upcoming = crow('Nächste Show');
    await upcoming.locator('.epg-toggle').click();
    const dialog = page.locator('#recScheduleOverlay');
    await expect(dialog).toHaveClass(/open/);
    await expect(page.locator('#recScheduleProg')).toHaveText('Nächste Show — Kanal Eins');
    await page.locator('#recScheduleDiscard').click();
    await expect(dialog).not.toHaveClass(/open/);
    expect(await scheduledEntries()).toHaveLength(0);
    await upcoming.locator('.epg-toggle').click();
    await page.locator('#recScheduleConfirm').click();
    await expect(dialog).not.toHaveClass(/open/);
    await expect(upcoming.locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    await expect(upcoming.locator('.epg-toggle')).toHaveText('✕ Aufnahme abbrechen');
    expect(await scheduledEntries()).toHaveLength(1);
    // Marker ist rot und statisch
    expect(await upcoming.locator('.epg-marker').evaluate(el => {
      const st = window.getComputedStyle(el);
      return { color: st.color, animation: st.animationName };
    })).toEqual({ color: 'rgb(255, 93, 93)', animation: 'none' });
    // Abbrechen: Rückfrage, Esc verwirft NUR die Rückfrage (Kanalansicht bleibt)
    await upcoming.locator('.epg-toggle').click();
    await expect(page.locator('#epgConfirmText')).toHaveText('Geplante Aufnahme „Nächste Show“ abbrechen?');
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgConfirm')).toBeHidden();
    await channelVisible();
    await expect(upcoming.locator('.epg-toggle')).toBeFocused();
    expect(await scheduledEntries()).toHaveLength(1);
    await upcoming.locator('.epg-toggle').click();
    await page.locator('#epgConfirmYes').click();
    await expect(upcoming.locator('.epg-marker')).toHaveAttribute('data-state', '');
    await expect(upcoming.locator('.epg-toggle')).toHaveText('● Aufnehmen');
    expect(await scheduledEntries()).toHaveLength(0);
    // Marker live: Planung im Main (schedule:changed) erscheint ohne Neuöffnen
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const laterId = await crow('Spätere Show').getAttribute('data-row-id');
    const laterStart = Number(laterId.slice(laterId.lastIndexOf('|') + 1));
    const later = await page.evaluate(
      r => window.electronAPI.addSchedule(r),
      { channelId: 'KV1.de', channelName: 'Kanal Eins', tvgId: 'KV1.de', sourceId: 'e2e', title: 'Spätere Show', epgStart: iso(laterStart), epgStop: iso(laterStart + 45 * MIN) },
    );
    await expect(page.locator('#epgChannelList .epg-marker[data-state="scheduled"]').first()).toBeVisible();
    await page.evaluate(id => window.electronAPI.removeSchedule(id), later.entry.id);
    await expect(page.locator('#epgChannelList .epg-marker[data-state="scheduled"]')).toHaveCount(0);
  });

  test('Laufende Aufnahme: „■ Aufnahme stoppen“ mit Rückfrage (Aufnahme-Zustand aus dem Main simuliert)', async () => {
    const running = await page.evaluate(() => {
      const slotRow = [...window.document.querySelectorAll('.epg-crow')].find(r => r.textContent.includes('Laufende Show'));
      return slotRow.dataset.rowId;
    });
    const start = Number(running.slice(running.lastIndexOf('|') + 1));
    const stop = start + 60 * MIN;
    // Test-Hook im Main: schedule:list liefert zusätzlich einen laufenden Eintrag (Stoppen braucht ffmpeg, daher ohne echte Aufnahme)
    await ctx.electronApp.evaluate(
      ({ ipcMain, BrowserWindow }, fake) => {
        if (!globalThis.__origScheduleList) {
          globalThis.__origScheduleList = ipcMain._invokeHandlers.get('schedule:list');
          ipcMain.removeHandler('schedule:list');
          ipcMain.handle('schedule:list', async event => {
            const real = await globalThis.__origScheduleList(event);
            return globalThis.__fakeRunning ? [...real, globalThis.__fakeRunning] : real;
          });
        }
        globalThis.__fakeRunning = fake;
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('schedule:changed', {});
      },
      {
        id: 'sch_e2efake',
        state: 'recording',
        recId: 'rec_e2efake',
        title: 'Laufende Show',
        tvgId: 'KV1.de',
        channelId: 'KV1.de',
        channelName: 'Kanal Eins',
        epgStart: new Date(start).toISOString(),
        epgStop: new Date(stop).toISOString(),
      },
    );
    const row = crow('Laufende Show');
    await expect(row.locator('.epg-marker')).toHaveAttribute('data-state', 'recording');
    await expect(row.locator('.epg-toggle')).toHaveText('■ Aufnahme stoppen');
    expect(await row.locator('.epg-marker').evaluate(el => window.getComputedStyle(el).animationName)).toBe('epgPulse');
    await row.locator('.epg-toggle').click();
    await expect(page.locator('#epgConfirmText')).toHaveText('Laufende Aufnahme „Laufende Show“ stoppen? Die bisher aufgenommene Zeit bleibt erhalten.');
    await page.locator('#epgConfirmNo').click();
    await expect(page.locator('#epgConfirm')).toBeHidden();
    await expect(row.locator('.epg-toggle')).toBeFocused();
    await ctx.electronApp.evaluate(({ BrowserWindow }) => {
      globalThis.__fakeRunning = null;
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('schedule:changed', {});
    });
    await expect(row.locator('.epg-marker')).toHaveAttribute('data-state', '');
    await expect(row.locator('.epg-toggle')).toHaveText('● Aufnehmen');
  });

  test('P9: „+ Weitere Tage“ zeigt Tage jenseits der 8-Tage-Grenze: Hinweis sichtbar, Aufnehmen deaktiviert, kein Dialog', async () => {
    await page.locator('#epgChannelMore').click();
    await expect(page.locator('#epgChannelMore')).toHaveAttribute('aria-pressed', 'true');
    const farKey = dayKeyOf(farStart - 5 * HOUR) === dayKeyOf(farStart) ? dayKeyOf(farStart) : dayKeyOf(farStart);
    const far = crow('Weitentfernt');
    await expect(far).toHaveCount(1);
    await page.locator('.epg-daytab[data-day-key]').last().click();
    await far.scrollIntoViewIfNeeded();
    await expect(far.locator('.epg-toggle')).toBeDisabled();
    await expect(far.locator('.epg-row-hint')).toHaveText('Planung nur bis 8 Tage im Voraus');
    await far.locator('.epg-toggle').click({ force: true });
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    expect(farKey).toMatch(/^\d{4}-\d\d-\d\d$/);
    // Im Detail-Modal gilt dieselbe Regel
    await far.locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailRecordBtn')).toBeDisabled();
    await expect(page.locator('#epgDetailHint')).toHaveText('Planung nur bis 8 Tage im Voraus');
    await page.keyboard.press('Escape');
    // zurück auf 7 Tage: „Weitentfernt“ verschwindet, Position springt auf heute
    await page.locator('#epgChannelMore').click();
    await expect(page.locator('#epgChannelMore')).toHaveAttribute('aria-pressed', 'false');
    await expect(crow('Weitentfernt')).toHaveCount(0);
    await expect(page.locator('.epg-daytab.active')).toHaveText('Heute');
    await expect(page.locator('.epg-daytab[data-day-key]')).toHaveCount(7);
  });

  test('Einstieg über den Link „Alle Sendungen des Senders“ im Detail-Modal; Esc-Kette Modal → Kanalmodus → Overlay; Fokus-Rückgabe', async () => {
    await page.keyboard.press('Escape'); // Kanalmodus → Liste
    await channelHidden();
    await listRow('Spätere Show').locator('.epg-row-open').click();
    const link = page.locator('#epgDetailChannelBtn');
    await expect(link).toHaveText('Alle Sendungen des Senders');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator('#epgDetailBackdrop')).toBeHidden();
    await channelVisible();
    await expect(page.locator('#epgChannelName')).toHaveText('Kanal Eins');
    // in der Kanalansicht ist der Link überflüssig (schon dort)
    await crow('Spätere Show').locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await expect(page.locator('#epgDetailChannelBtn')).toBeHidden();
    // Esc 1: Modal zu (Kanalansicht bleibt, Fokus auf der Zeile)
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgDetailBackdrop')).toBeHidden();
    await channelVisible();
    await expect(crow('Spätere Show').locator('.epg-row-open')).toBeFocused();
    // Esc 2: Kanalmodus zu, Fokus auf der Herkunftszeile
    await page.keyboard.press('Escape');
    await channelHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(listRow('Spätere Show').locator('.epg-row-open')).toBeFocused();
    // Esc 3 wäre das Overlay; Auswahl bleibt in der Herkunftsansicht markiert
    await expect(page.locator('.epg-list-row.is-selected')).toContainText('Spätere Show');
  });

  test('Zurück ohne Zustandsverlust: Liste (Tag, Scrollposition, Auswahl) und Raster (Modus, Zoom, Scroll) bleiben unverändert', async () => {
    // Liste: Tag „Morgen“, Auswahl, Scrollposition merken
    await page.locator('.epg-daytab', { hasText: 'Morgen' }).click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    await listRow('Füller 1-4').locator('.epg-row-open').click();
    await page.keyboard.press('Escape');
    const before = await page.evaluate(() => window.document.getElementById('epgList').scrollTop);
    await listRow('Füller 1-6').locator('.epg-chan-link').click();
    await channelVisible();
    await page.locator('.epg-daytab', { hasText: 'Heute' }).click();
    await page.locator('#epgChannelBack').click();
    await channelHidden();
    const after = await page.evaluate(() => window.document.getElementById('epgList').scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(2);
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    await expect(page.locator('#epgModeList')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.epg-list-row.is-selected')).toContainText('Füller 1-4');
    await expect(listRow('Füller 1-6').locator('.epg-chan-link')).toBeFocused();
    // Raster: Zoom 8, horizontal gescrollt
    await page.locator('#epgModeGrid').click();
    await page.locator('.epg-zoom-btn[data-zoom="8"]').click();
    await page.locator('#epgGrid').evaluate(el => {
      el.scrollLeft += 1500;
    });
    await page.waitForTimeout(200);
    const gridBefore = await page.locator('#epgGrid').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
    const dayBefore = await page.locator('.epg-daytab.active').innerText();
    await page.locator('.epg-grid-chan-btn', { hasText: 'Kanal Zwei' }).click();
    await channelVisible();
    await expect(page.locator('#epgChannelName')).toHaveText('Kanal Zwei');
    expect(await page.locator('#epgGrid').evaluate(el => el.inert)).toBe(true);
    await page.locator('#epgChannelBack').click();
    await channelHidden();
    const gridAfter = await page.locator('#epgGrid').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
    expect(Math.abs(gridAfter.left - gridBefore.left)).toBeLessThan(2);
    expect(gridAfter.top).toBe(gridBefore.top);
    await expect(page.locator('#epgGrid')).toBeVisible();
    await expect(page.locator('.epg-zoom-btn.active')).toHaveText('8 px/min');
    await expect(page.locator('.epg-daytab.active')).toHaveText(dayBefore);
    await expect(page.locator('.epg-grid-chan-btn', { hasText: 'Kanal Zwei' })).toBeFocused();
    // Segment in der Kanalansicht: Klick auf „Liste“ führt zurück und wechselt den Modus
    await page.locator('.epg-grid-chan-btn', { hasText: 'Kanal Eins' }).click();
    await channelVisible();
    await page.locator('#epgModeList').click();
    await channelHidden();
    await expect(page.locator('#epgList')).toBeVisible();
    await expect(page.locator('#epgModeList')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#epgZoom')).toBeHidden(); // Zoom-Leiste ist in der Liste ausgeblendet
    await page.locator('#epgNowBtn').click();
  });

  test('Zustände: Kanal ohne Programm in den nächsten 7 TV-Tagen zeigt „Kein Programm“ mit „Jetzt aktualisieren“', async () => {
    await page.locator('#epgModeGrid').click();
    await page.locator('.epg-grid-chan-btn', { hasText: 'Spätkanal' }).click();
    await channelVisible();
    await expect(page.locator('#epgChannelName')).toHaveText('Spätkanal');
    await expect(page.locator('#epgChannel')).toHaveAttribute('data-state', 'no-programmes');
    await expect(page.locator('#epgChannelState')).toContainText('Kein Programm');
    await expect(page.locator('#epgChannelState')).toContainText('Spätkanal');
    await expect(page.locator('#epgChannelList')).toBeHidden();
    await page.locator('#epgChannelState .epg-state-btn', { hasText: 'Jetzt aktualisieren' }).click();
    await expect(page.locator('#epgRefreshBtn')).toHaveText('↻ Aktualisieren');
    await expect(page.locator('#epgChannel')).toHaveAttribute('data-state', 'no-programmes');
    await expect(page.locator('#epgChannelNow')).toHaveText('Gerade keine Sendung im EPG');
    await page.keyboard.press('Escape');
    await channelHidden();
    await page.locator('#epgModeList').click();
  });

  test('Neu laden bei epg:changed: Kanalansicht, Tag und Scrollposition bleiben erhalten (Aktualisieren)', async () => {
    await listRow('Laufende Show').locator('.epg-chan-link').click();
    await channelVisible();
    await page.locator('.epg-daytab', { hasText: 'Morgen' }).click();
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    const before = await page.locator('#epgChannelList').evaluate(el => el.scrollTop);
    await page.locator('#epgRefreshBtn').click();
    await expect(page.locator('#epgRefreshBtn')).toHaveText('↻ Aktualisieren');
    await expect(page.locator('#epgChannel')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.epg-daytab.active')).toHaveText('Morgen');
    const after = await page.locator('#epgChannelList').evaluate(el => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(200);
    await expect(page.locator('#epgChannelName')).toHaveText('Kanal Eins');
    await page.keyboard.press('Escape');
    await channelHidden();
  });

  test('Wiederholtes Öffnen/Schließen mit Kanalansicht: keine Listener-, Timer- oder DOM-Reste, Neustart in der Liste', async () => {
    let subsAfterFirstOpen = null;
    for (let i = 0; i < 4; i += 1) {
      await listRow('Laufende Show').locator('.epg-chan-link').click();
      await channelVisible();
      await expect(crow('Laufende Show')).toHaveCount(1);
      await page.locator('#epgCloseBtn').click(); // Schließen aus der Kanalansicht schließt das ganze Overlay
      await expect(page.locator('#epgOverlay')).toBeHidden();
      await expect(page.locator('#epgOverlay')).toHaveAttribute('data-subs', '0');
      await channelHidden();
      expect(await page.locator('#epgChannelList').evaluate(el => el.children.length)).toBe(0);
      expect(await page.locator('#epgListItems').evaluate(el => el.children.length)).toBe(0);
      await page.locator('#dashboardEpgOpen').click();
      await expect(listRow('Laufende Show')).toHaveCount(1);
      await channelHidden(); // Öffnen startet immer in der Herkunftsansicht
      const subs = Number(await page.locator('#epgOverlay').getAttribute('data-subs'));
      if (subsAfterFirstOpen === null) subsAfterFirstOpen = subs;
      expect(subs).toBe(subsAfterFirstOpen);
    }
    expect(await page.locator('#epgList').evaluate(el => el.inert)).toBe(false);
  });

  test('keine unerwarteten Fehler in Konsole oder Fenster', async () => {
    expect(ctx.problems).toEqual([]);
  });

  test('Fehler beim Laden: Zustand „Programm konnte nicht geladen werden“ mit „Jetzt aktualisieren“', async () => {
    await ctx.electronApp.evaluate(({ ipcMain }) => ipcMain.removeHandler('epg:range-many'));
    await listRow('Laufende Show').locator('.epg-chan-link').click();
    await channelVisible();
    await expect(page.locator('#epgChannel')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#epgChannelState')).toContainText('Programm konnte nicht geladen werden');
    await expect(page.locator('#epgChannelState .epg-state-btn')).toHaveText('Jetzt aktualisieren');
    await expect(page.locator('#epgChannelList')).toBeHidden();
    // Zurück bleibt möglich
    await page.keyboard.press('Escape');
    await channelHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
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
    // V2 auf der Großfixture (viele Blockbreiten): ohne Aufnahme kein Toggle, sonst nur ab 90 px und nie über dem Text
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
    expect(rec.withRec).toBe(0); // ohne Aufnahmen kein Toggle in den Blöcken
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

  test('Kanalansicht auf der Großfixture (438 Kanäle): Klick auf den Sendernamen bis zur sichtbaren Liste < 300 ms, Zurück ohne Verlust', async () => {
    await page.locator('#epgNowBtn').click();
    const before = await page.evaluate(() => window.document.getElementById('epgList').scrollTop);
    const opened = await page.evaluate(async () => {
      const link = [...window.document.querySelectorAll('.epg-list-row .epg-chan-link')].find(l => l.getBoundingClientRect().top > 160);
      const t0 = window.performance.now();
      link.click();
      await new Promise(resolve => {
        const check = () => {
          const list = window.document.getElementById('epgChannelList');
          const box = list.getBoundingClientRect();
          const hit = !list.hidden && [...list.querySelectorAll('.epg-crow')].some(r => {
            const b = r.getBoundingClientRect();
            return b.bottom > box.top + 20 && b.top < box.bottom;
          });
          if (hit) resolve();
          else window.requestAnimationFrame(check);
        };
        check();
      });
      return { ms: window.performance.now() - t0, rows: window.document.querySelectorAll('.epg-crow').length };
    });
    expect(opened.ms).toBeLessThan(300);
    expect(opened.rows).toBeGreaterThan(50);
    await expect(page.locator('#epgChannel')).toBeVisible();
    await expect(page.locator('.epg-daytab[data-day-key]')).toHaveCount(7);
    // Tageswechsel in der Kanalansicht ebenfalls schnell
    const tab = await page.evaluate(async () => {
      const t0 = window.performance.now();
      window.document.querySelectorAll('.epg-daytab[data-day-key]')[4].click();
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      return window.performance.now() - t0;
    });
    expect(tab).toBeLessThan(300);
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgChannel')).toBeHidden();
    const after = await page.evaluate(() => window.document.getElementById('epgList').scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(2);
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
