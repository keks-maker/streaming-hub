'use strict';

// E2E: Programmführer Etappe 3.5 — Kopfzeile nach B2/F3: Suche (Trefferliste, Sprung, Modal), Senderauswahl
// (Favoriten · Alle · Gruppe, wirkt in Liste, Raster, Jetzt & Gleich und Suche), „Mehr ▾“ (Beschreibung,
// Sender ohne EPG), dritter Modus „Jetzt & Gleich“ und konfigurierbare Startansicht (P20).
// Kein Netz: lokale M3U-Quelle + zur Laufzeit erzeugte XMLTV-Datei (Test-Hook STREAMING_HUB_EPG_FIXTURE).
const { test, expect } = require('@playwright/test');
const { buildXmltv, channelId } = require('../tests/helpers/epg-large-fixture.js');
const { MIN, HOUR, xmltvTime, launchApp, waitForEpgChannels, openOverlayFromDashboard } = require('./epg-helpers');

const programme = (channel, s) => {
  const title = s.title.replace(/&/g, '&amp;');
  return `<programme start="${xmltvTime(s.start)}" stop="${xmltvTime(s.stop)}" channel="${channel}"><title>${title}</title><desc>Beschreibung &amp; Details zu ${title}</desc></programme>`;
};

async function setWindowWidth(ctx, width) {
  await ctx.electronApp.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(300, 400);
    win.setSize(w, 800);
  }, width);
  await expect.poll(() => ctx.page.evaluate(() => window.innerWidth)).toBe(width);
}

async function closeOverlay(page) {
  await page.locator('#epgCloseBtn').click();
  await expect(page.locator('#epgOverlay')).toBeHidden();
}

async function reopenOverlay(page) {
  await page.locator('#tvSidebarEpgBtn, #dashboardEpgOpen').first().evaluate(el => el.click());
  await expect(page.locator('#epgOverlay')).toBeVisible();
}

const activeMode = page =>
  page.evaluate(() => ['epgModeList', 'epgModeGrid', 'epgModeJng'].find(id => window.document.getElementById(id).getAttribute('aria-pressed') === 'true') || null);

// ───────────────────────── Kleine Fixture ─────────────────────────

test.describe('Programmführer 3.5 (kleine Fixture)', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let base;

  test.beforeAll(async () => {
    base = Math.floor(Date.now() / MIN) * MIN;
    const day = new Date(base);
    day.setDate(day.getDate() + 2);
    day.setHours(21, 0, 0, 0);
    const far = day.getTime();
    // Favoriten: E2E.de und E2E2.de (Gruppe Alpha); Füllkanal (Gruppe Beta) und „Ohne EPG“ sind keine Favoriten
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><tv>' +
      '<channel id="E2E.de"><display-name>E2E Kanal</display-name></channel>' +
      '<channel id="E2E2.de"><display-name>Zweiter Kanal</display-name></channel>' +
      '<channel id="E2E3.de"><display-name>Füllkanal</display-name></channel>' +
      programme('E2E.de', { title: 'Vorbei Magazin', start: base - 150 * MIN, stop: base - 40 * MIN }) +
      programme('E2E.de', { title: 'Laufende Sendung', start: base - 30 * MIN, stop: base + 30 * MIN }) +
      programme('E2E.de', { title: 'Kommende Sendung', start: base + 30 * MIN, stop: base + 90 * MIN }) +
      programme('E2E.de', { title: 'Uebernaechste Sendung', start: base + 90 * MIN, stop: base + 150 * MIN }) +
      programme('E2E.de', { title: 'Ferne Sendung Käse', start: far, stop: far + HOUR }) +
      programme('E2E2.de', { title: 'Zweitlauf', start: base - 10 * MIN, stop: base + 50 * MIN }) +
      programme('E2E2.de', { title: 'Nachfolger', start: base + 50 * MIN, stop: base + 80 * MIN }) +
      programme('E2E3.de', { title: 'Fuellkanal Krimi', start: base - 20 * MIN, stop: base + 40 * MIN }) +
      programme('E2E3.de', { title: 'Füllkanal Abend', start: base + 40 * MIN, stop: base + 100 * MIN }) +
      '</tv>';
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgnav-',
      epgXml: xml,
      channels: [
        { id: 'E2E.de', name: 'E2E Kanal', logo: '@file', group: 'Alpha' },
        { id: 'E2E2.de', name: 'Zweiter Kanal', logo: 'https://logo.invalid/zweiter.png', group: 'Alpha' },
        { id: 'E2E3.de', name: 'Füllkanal', group: 'Beta' },
        { id: 'OHNE.de', name: 'Ohne EPG Kanal', group: 'Beta' },
      ],
      favorites: ['E2E.de', 'E2E2.de'],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 3);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  const listRow = title => page.locator('.epg-list-row', { hasText: title });
  const jngCell = title => page.locator('.epg-jcell', { hasText: title });
  const jngRow = name => page.locator('.epg-jrow', { hasText: name });
  const pickSender = async label => {
    await page.locator('#epgSenderMenu').click();
    await page.locator('.epg-menu-item', { hasText: label }).first().click();
  };
  const scheduledEntries = async () => (await page.evaluate(() => window.electronAPI.listSchedules())).filter(e => e.state === 'scheduled');

  // ── Startansicht (P20) ──

  test('Startansicht: Standard Automatisch → Liste bei breitem Fenster; Segment hat drei Modi', async () => {
    expect(await page.evaluate(() => window.electronAPI.getEpgViewSettings())).toEqual({ startView: 'auto' });
    await openOverlayFromDashboard(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.epg-header .epg-seg-btn')).toHaveText(['Liste', 'Raster', 'Jetzt & Gleich']);
    expect(await activeMode(page)).toBe('epgModeList');
    await expect(page.locator('#epgSearchInput')).toBeVisible();
    await expect(page.locator('#epgSenderMenu')).toHaveText('Sender: Favoriten ▾');
    await expect(page.locator('#epgMoreMenu')).toHaveText('Mehr ▾');
    // Genre-Chips kommen erst in 3.6
    await expect(page.locator('.epg-genrechip, .epg-chip')).toHaveCount(0);
  });

  test('Segment-Umschalter wirkt nur für die Sitzung: Moduswechsel wird nicht gespeichert, erneutes Öffnen startet im Startmodus', async () => {
    await page.locator('#epgModeJng').click();
    await expect(page.locator('#epgModeJng')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#epgJng')).toBeVisible();
    expect(await page.evaluate(() => window.electronAPI.getEpgViewSettings())).toEqual({ startView: 'auto' });
    await closeOverlay(page);
    await reopenOverlay(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    expect(await activeMode(page)).toBe('epgModeList');
  });

  test('Einstellung „Startansicht“ (LiveTV: EPG): speichern, ungültige Werte werden abgelehnt, nächstes Öffnen wirkt', async () => {
    await closeOverlay(page);
    await page.locator('#overlayNav [data-section="settings"]').click();
    const group = page.locator('#settingsNav .settings-nav-group');
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
    await page.locator('#settingsTab-livetv-epg').click();
    const select = page.locator('#settingsEpgStartView');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('auto');
    await expect(select.locator('option')).toHaveText(['Automatisch', 'Liste', 'Raster', 'Jetzt & Gleich']);
    await select.selectOption('grid');
    await expect(page.locator('#settingsEpgStartViewStatus')).toContainText('Gespeichert');
    await expect.poll(() => page.evaluate(() => window.electronAPI.getEpgViewSettings())).toEqual({ startView: 'grid' });
    // manipulierte Werte werden im Main abgelehnt und nie gespeichert
    for (const bad of ['x', { startView: 'x' }, { startView: { a: 1 } }, null, ['list']]) {
      const rejected = await page.evaluate(async value => {
        try {
          await window.electronAPI.setEpgViewSettings(value);
          return false;
        } catch {
          return true;
        }
      }, bad);
      expect(rejected, JSON.stringify(bad)).toBe(true);
    }
    expect(await page.evaluate(() => window.electronAPI.getEpgViewSettings())).toEqual({ startView: 'grid' });
    // Wirkung beim nächsten Öffnen
    await page.locator('#overlayNav [data-section="livetv"]').click();
    await page.locator('#dashboardEpgOpen').click();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    expect(await activeMode(page)).toBe('epgModeGrid');
    await expect(page.locator('#epgZoom')).toBeVisible();
    await closeOverlay(page);
    for (const [value, expected] of [['jng', 'epgModeJng'], ['list', 'epgModeList']]) {
      await page.evaluate(v => window.electronAPI.setEpgViewSettings({ startView: v }), value);
      await reopenOverlay(page);
      await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
      expect(await activeMode(page)).toBe(expected);
      await closeOverlay(page);
    }
  });

  test('Startansicht „Automatisch“: Fensterbreite 900 px → Liste, 899 px → Jetzt & Gleich', async () => {
    await page.evaluate(() => window.electronAPI.setEpgViewSettings({ startView: 'auto' }));
    await setWindowWidth(ctx, 900);
    await reopenOverlay(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    expect(await activeMode(page)).toBe('epgModeList');
    await closeOverlay(page);
    await setWindowWidth(ctx, 899);
    await reopenOverlay(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    expect(await activeMode(page)).toBe('epgModeJng');
    await expect(page.locator('#epgJng')).toBeVisible();
  });

  // ── Jetzt & Gleich ──

  test('Jetzt & Gleich im schmalen Fenster (899 px): ohne horizontales Scrollen nutzbar, Zeilen untereinander, Kopf ausgeblendet', async () => {
    const jng = page.locator('#epgJng');
    await expect(jngRow('E2E Kanal')).toBeVisible();
    const metrics = await page.evaluate(() => {
      const scroll = window.document.getElementById('epgJng');
      const row = window.document.querySelector('.epg-jrow');
      const cells = [...row.querySelectorAll('.epg-jcell')].map(c => c.getBoundingClientRect());
      return {
        narrow: window.document.querySelector('.epg-jng').classList.contains('is-narrow'),
        overflowX: scroll.scrollWidth - scroll.clientWidth,
        pageOverflow: window.document.documentElement.scrollWidth - window.document.documentElement.clientWidth,
        headVisible: window.getComputedStyle(window.document.querySelector('.epg-jng-head')).display !== 'none',
        stacked: cells.length >= 3 && cells.every((c, i) => i === 0 || c.top >= cells[i - 1].bottom - 1),
        rowH: row.getBoundingClientRect().height,
        cellsInside: cells.every(c => c.bottom <= row.getBoundingClientRect().bottom + 1),
      };
    });
    expect(metrics.narrow).toBe(true);
    expect(metrics.overflowX).toBeLessThanOrEqual(0);
    expect(metrics.pageOverflow).toBeLessThanOrEqual(0);
    expect(metrics.headVisible).toBe(false);
    expect(metrics.stacked).toBe(true);
    expect(metrics.cellsInside).toBe(true);
    await expect(jng).toBeVisible();
    // Fenster wieder breit
    await setWindowWidth(ctx, 1280);
    await expect(page.locator('.epg-jng')).not.toHaveClass(/is-narrow/);
    await expect(page.locator('.epg-jng-head')).toBeVisible();
  });

  test('Jetzt & Gleich (Favoriten): je Sender laufend (mit Fortschritt) · nächste · übernächste, ohne Thumbnails; Logo mit Kürzel-Fallback', async () => {
    const row = jngRow('E2E Kanal');
    await expect(row.locator('.epg-jcell')).toHaveCount(3);
    await expect(row.locator('.epg-jcell').nth(0)).toContainText('Laufende Sendung');
    await expect(row.locator('.epg-jcell').nth(0)).toHaveClass(/is-now/);
    await expect(row.locator('.epg-jcell').nth(0).locator('.epg-time-sub')).toHaveText(/^noch \d+ min$/);
    await expect(row.locator('.epg-jcell').nth(0).locator('.epg-progress')).toBeVisible();
    await expect(row.locator('.epg-jcell').nth(1)).toContainText('Kommende Sendung');
    await expect(row.locator('.epg-jcell').nth(2)).toContainText('Uebernaechste Sendung');
    await expect(row.locator('.epg-jcell').nth(1).locator('.epg-progress')).toBeHidden();
    await expect(page.locator('.epg-jcell img.thumb, .epg-jcell .epg-thumb')).toHaveCount(0);
    // Vorbei und ferne Sendung stehen nicht darin
    await expect(jngCell('Vorbei Magazin')).toHaveCount(0);
    await expect(jngCell('Ferne Sendung')).toHaveCount(0);
    // Logo: echtes Bild mit file-URL (Kanal 1), Kürzel-Badge bei nicht ladbarer URL (Kanal 2)
    await expect(row.locator('.epg-grid-logo')).toHaveClass(/has-img/);
    await expect(jngRow('Zweiter Kanal').locator('.epg-grid-logo')).not.toHaveClass(/has-img/);
    await expect(jngRow('Zweiter Kanal').locator('.epg-grid-logo')).toHaveText('ZK');
    // Sender ohne Favoritenstatus fehlen
    await expect(jngRow('Füllkanal')).toHaveCount(0);
    // Zweiter Kanal: laufend, nächste, dahinter nichts → Platzhalter statt Zelle
    await expect(jngRow('Zweiter Kanal').locator('.epg-jcell:not(.is-empty)')).toHaveCount(2);
  });

  test('Jetzt & Gleich: Klick auf Sendung öffnet das Detail-Modal (Esc schließt, Fokus zurück), Sendername öffnet die Kanalansicht', async () => {
    await jngCell('Kommende Sendung').locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await expect(page.locator('#epgDetailTitle')).toHaveText('Kommende Sendung');
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgDetailBackdrop')).toBeHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(jngCell('Kommende Sendung').locator('.epg-row-open')).toBeFocused();
    // Sendername → Kanalansicht (3.4); Esc führt zurück in Jetzt & Gleich, Fokus auf den Sendernamen
    await jngRow('E2E Kanal').locator('.epg-jchan').click();
    await expect(page.locator('#epgChannel')).toBeVisible();
    await expect(page.locator('#epgChannelName')).toHaveText('E2E Kanal');
    expect(await page.evaluate(() => window.document.querySelector('.epg-jng').inert)).toBe(true); // darunter, nicht bedienbar
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgChannel')).toBeHidden();
    await expect(page.locator('#epgJng')).toBeVisible();
    expect(await page.evaluate(() => window.document.querySelector('.epg-jng').inert)).toBe(false);
    await expect(jngRow('E2E Kanal').locator('.epg-jchan')).toBeFocused();
    expect(await activeMode(page)).toBe('epgModeJng');
  });

  test('Jetzt & Gleich: Toggle je Sendung wie in 3.3 — Aufnehmen (Planungsdialog), Marker, Abbrechen mit Rückfrage; laufende Sendung: Meldung', async () => {
    const running = jngCell('Laufende Sendung');
    await running.locator('.epg-toggle').click();
    await expect(page.locator('#epgToast')).toContainText('läuft bereits');
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    const next = jngCell('Kommende Sendung');
    await next.locator('.epg-toggle').click();
    await expect(page.locator('#recScheduleOverlay')).toHaveClass(/open/);
    await page.locator('#recScheduleConfirm').click();
    await expect(page.locator('#recScheduleOverlay')).not.toHaveClass(/open/);
    await expect(next.locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    await expect(next.locator('.epg-toggle')).toHaveText('✕ Aufnahme abbrechen');
    expect(await scheduledEntries()).toHaveLength(1);
    // Marker rot, geplant statisch (keine Animation)
    const style = await next.locator('.epg-marker').evaluate(el => {
      const cs = window.getComputedStyle(el);
      return { color: cs.color, animation: cs.animationName };
    });
    expect(style.color).toBe('rgb(255, 93, 93)');
    expect(style.animation).toBe('none');
    // derselbe Marker in Liste und Raster (eine Quelle der Wahrheit)
    await page.locator('#epgModeList').click();
    await expect(listRow('Kommende Sendung').locator('.epg-marker')).toHaveAttribute('data-state', 'scheduled');
    await page.locator('#epgModeJng').click();
    await next.locator('.epg-toggle').click();
    await expect(page.locator('#epgConfirm')).toBeVisible();
    await page.locator('#epgConfirmYes').click();
    await expect(next.locator('.epg-marker')).toHaveAttribute('data-state', '');
    await expect(next.locator('.epg-toggle')).toHaveText('● Aufnehmen');
    expect(await scheduledEntries()).toHaveLength(0);
  });

  test('Jetzt & Gleich: 30-s-Takt aktualisiert ohne Neuaufbau (gleiche DOM-Knoten); Wechsel der laufenden Sendung rückt nach', async () => {
    // Uhr der Seite steuern (vor dem Öffnen, damit der 30-s-Takt des Overlays unter Kontrolle steht)
    await closeOverlay(page);
    await page.clock.install({ time: Date.now() });
    await reopenOverlay(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await page.locator('#epgModeJng').click();
    const cell = () => jngRow('E2E Kanal').locator('.epg-jcell').nth(0);
    await expect(cell()).toContainText('Laufende Sendung');
    await page.evaluate(() => {
      const row = window.document.querySelector('.epg-jrow[data-channel-key="E2E.de"]');
      row.dataset.keep = '1';
      row.querySelector('.epg-jcell').dataset.keep = '1';
    });
    const progress = () => cell().locator('.epg-progress-fill').evaluate(el => parseFloat(el.style.width));
    const before = await progress();
    // 10 min später (laufende Sendung endet erst in 30 min): Fortschritt wächst, derselbe Knoten, keine neuen Zellen
    await page.clock.fastForward(10 * MIN);
    await expect.poll(progress).toBeGreaterThan(before);
    expect(await page.evaluate(() => !!window.document.querySelector('.epg-jrow[data-keep="1"] .epg-jcell[data-keep="1"]'))).toBe(true);
    // 25 min weiter: „Laufende Sendung“ ist vorbei, „Kommende“ läuft, „Übernächste“ ist die nächste
    await page.clock.fastForward(25 * MIN);
    await expect(cell()).toContainText('Kommende Sendung');
    await expect(cell()).toHaveClass(/is-now/);
    await expect(jngRow('E2E Kanal').locator('.epg-jcell').nth(1)).toContainText('Uebernaechste Sendung');
    // die Zeile selbst (Sender, Logo) bleibt derselbe Knoten, nur die Zellen wurden ersetzt
    expect(await page.evaluate(() => !!window.document.querySelector('.epg-jrow[data-keep="1"]'))).toBe(true);
    await page.clock.resume();
  });

  // ── Senderauswahl ──

  test('Senderauswahl: Favoriten (Standard) → Alle Sender → Gruppe; wirkt in Liste, Raster und Jetzt & Gleich; Moduswechsel behält die Auswahl', async () => {
    await page.locator('#epgModeList').click();
    await expect(listRow('Fuellkanal Krimi')).toHaveCount(0);
    await expect(page.locator('#epgSenderMenu')).toHaveText('Sender: Favoriten ▾');
    await page.locator('#epgSenderMenu').click();
    const items = await page.locator('.epg-menu-item').allInnerTexts();
    expect(items.join('|')).toMatch(/Favoriten.*Alle Sender.*Alpha.*Beta/s);
    await expect(page.locator('.epg-menu-item', { hasText: 'Favoriten' })).toHaveAttribute('aria-checked', 'true');
    await page.locator('.epg-menu-item', { hasText: 'Alle Sender' }).click();
    await expect(page.locator('#epgSenderMenu')).toHaveText('Sender: Alle Sender ▾');
    await expect(listRow('Fuellkanal Krimi')).toHaveCount(1);
    await page.locator('#epgModeGrid').click();
    await expect(page.locator('.epg-grid-chan-btn', { hasText: 'Füllkanal' })).toBeVisible();
    await page.locator('#epgModeJng').click();
    await expect(jngRow('Füllkanal')).toBeVisible();
    await expect(page.locator('#epgSenderMenu')).toHaveText('Sender: Alle Sender ▾');
    // Gruppe Beta: nur Füllkanal (Ohne EPG Kanal hat kein EPG und bleibt ausgeblendet)
    await pickSender('Beta');
    await expect(page.locator('#epgSenderMenu')).toHaveText('Sender: Gruppe Beta ▾');
    await expect(page.locator('.epg-jrow')).toHaveCount(1);
    await expect(jngRow('Füllkanal')).toBeVisible();
    await page.locator('#epgModeList').click();
    await expect(listRow('Fuellkanal Krimi')).toHaveCount(1);
    await expect(listRow('Laufende Sendung')).toHaveCount(0);
    await page.locator('#epgModeGrid').click();
    await expect(page.locator('.epg-grid-chan-btn')).toHaveCount(1);
    // zurück auf Favoriten
    await pickSender('Favoriten');
    await expect(page.locator('.epg-grid-chan-btn')).toHaveCount(2);
    await page.locator('#epgModeList').click();
    await expect(listRow('Fuellkanal Krimi')).toHaveCount(0);
    await expect(listRow('Laufende Sendung')).toHaveCount(1);
  });

  test('Auswahl wirkt auch in der Suche; Zeitanker und Tag bleiben beim Wechsel der Auswahl erhalten', async () => {
    await page.locator('#epgSearchInput').fill('krimi');
    await expect(page.locator('#epgSearchNote')).toContainText('Keine Treffer');
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgSearch')).toBeHidden();
    await pickSender('Alle Sender');
    await page.locator('#epgSearchInput').fill('krimi');
    await expect(page.locator('.epg-search-hit')).toHaveCount(1);
    await expect(page.locator('.epg-search-hit')).toContainText('Fuellkanal Krimi');
    await page.keyboard.press('Escape');
    await pickSender('Favoriten');
    // letzten Tag wählen; Auswahlwechsel ändert den Tag nicht
    await page.locator('.epg-daytab').last().click();
    const activeTab = await page.locator('.epg-daytab.active').innerText();
    await pickSender('Alle Sender');
    await expect(page.locator('.epg-daytab.active')).toHaveText(activeTab);
    await pickSender('Favoriten');
    await page.locator('#epgNowBtn').click();
  });

  test('„Mehr ▾“: „Sender ohne EPG ausblenden“ (Standard an) steuert Raster und Jetzt & Gleich', async () => {
    await pickSender('Beta');
    await page.locator('#epgModeJng').click();
    await expect(page.locator('.epg-jrow')).toHaveCount(1);
    await page.locator('#epgMoreMenu').click();
    await expect(page.locator('#epgOptHideNoEpg')).toBeChecked();
    await expect(page.locator('#epgOptDesc')).not.toBeChecked();
    await page.locator('#epgOptHideNoEpg').uncheck();
    await expect(page.locator('.epg-jrow')).toHaveCount(2);
    await expect(jngRow('Ohne EPG Kanal')).toContainText('Kein EPG im Cache');
    await page.keyboard.press('Escape'); // schließt das Menü zuerst, nicht das Overlay
    await expect(page.locator('#epgMoreMenuPanel')).toBeHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await page.locator('#epgModeGrid').click();
    await expect(page.locator('.epg-grid-chan-btn')).toHaveCount(2);
    await page.locator('#epgMoreMenu').click();
    await page.locator('#epgOptHideNoEpg').check();
    await expect(page.locator('.epg-grid-chan-btn')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await pickSender('Favoriten');
  });

  // ── Suche ──

  test('Suche: Trefferliste mit Titel · Sender · Wochentag Uhrzeit; zu kurz, keine Treffer, Umlaute gefaltet', async () => {
    await page.locator('#epgModeList').click();
    const input = page.locator('#epgSearchInput');
    await input.fill('a');
    await expect(page.locator('#epgSearch')).toBeVisible();
    await expect(page.locator('#epgSearchNote')).toContainText('mindestens 2 Zeichen');
    await input.fill('Sendung');
    await expect(page.locator('.epg-search-hit')).toHaveCount(4, { timeout: 5000 });
    const first = page.locator('.epg-search-hit').first();
    await expect(first.locator('.epg-search-title')).toHaveText('Laufende Sendung');
    await expect(first.locator('.epg-search-channel')).toHaveText('E2E Kanal');
    await expect(first.locator('.epg-search-when')).toHaveText(/^(So|Mo|Di|Mi|Do|Fr|Sa) \d\d:\d\d$/);
    await expect(page.locator('#epgSearch')).toContainText('4 Treffer für „Sendung“');
    // keine Treffer
    await input.fill('zaubermaus');
    await expect(page.locator('#epgSearchNote')).toContainText('Keine Treffer');
    await expect(page.locator('.epg-search-hit')).toHaveCount(0);
    // Faltung: „KAESE“ findet „Ferne Sendung Käse“ (ferner Tag, mit Datum)
    await input.fill('KAESE');
    await expect(page.locator('.epg-search-hit')).toHaveCount(1);
    await expect(page.locator('.epg-search-hit .epg-search-title')).toHaveText('Ferne Sendung Käse');
    // zu langer Text wird auf 80 Zeichen begrenzt (Feld), kein Fehler
    await input.fill('x'.repeat(120));
    expect((await input.inputValue()).length).toBeLessThanOrEqual(80);
    await input.fill('');
    await expect(page.locator('#epgSearch')).toBeHidden();
  });

  test('Suche: Beschreibung nur mit Schalter unter „Mehr ▾“ (Standard aus)', async () => {
    const input = page.locator('#epgSearchInput');
    await input.fill('Details zu Zweitlauf');
    await expect(page.locator('#epgSearchNote')).toContainText('Keine Treffer in den Titeln');
    await page.locator('#epgMoreMenu').click();
    await page.locator('#epgOptDesc').check();
    await expect(page.locator('.epg-search-hit')).toHaveCount(1);
    await expect(page.locator('#epgSearch')).toContainText('inkl. Beschreibung');
    await page.locator('#epgOptDesc').uncheck();
    await expect(page.locator('#epgSearchNote')).toContainText('Keine Treffer in den Titeln');
    await page.keyboard.press('Escape'); // Menü
    await page.keyboard.press('Escape'); // Suche
    await expect(page.locator('#epgSearch')).toBeHidden();
  });

  test('Suche: Klick auf Treffer springt in der Liste zum Termin (Tag, Zeile sichtbar) und öffnet das Detail-Modal', async () => {
    await page.locator('#epgSearchInput').fill('Käse');
    await expect(page.locator('.epg-search-hit')).toHaveCount(1);
    await page.locator('.epg-search-hit').click();
    await expect(page.locator('#epgSearch')).toBeHidden();
    await expect(page.locator('#epgSearchInput')).toHaveValue('');
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await expect(page.locator('#epgDetailTitle')).toHaveText('Ferne Sendung Käse');
    const visible = await page.evaluate(() => {
      const list = window.document.getElementById('epgList').getBoundingClientRect();
      const r = [...window.document.querySelectorAll('.epg-list-row')].find(x => x.textContent.includes('Ferne Sendung'));
      if (!r) return false;
      const b = r.getBoundingClientRect();
      return b.top >= list.top && b.bottom <= list.bottom;
    });
    expect(visible).toBe(true);
    // aktiver Tag folgt dem Termin (Übermorgen = vierter Tab nach Gestern/Heute/Morgen o. ä.)
    const activeIdx = await page.evaluate(() => [...window.document.querySelectorAll('.epg-daytab')].findIndex(t => t.classList.contains('active')));
    expect(activeIdx).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgDetailBackdrop')).toBeHidden();
    await expect(page.locator('.epg-list-row.is-selected')).toContainText('Ferne Sendung');
  });

  test('Suche: Sprung im Raster (Zeitanker, Block sichtbar) und in Jetzt & Gleich (Modal, Tag/Anker für den Wechsel)', async () => {
    await page.locator('#epgModeGrid').click();
    await page.locator('#epgSearchInput').fill('Käse');
    await page.locator('.epg-search-hit').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    // Blöcke werden nach dem Scrollen nachgeladen (Buckets): kurz warten, dann muss der Block im Sichtbereich stehen
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scroll = window.document.querySelector('.epg-grid-scroll').getBoundingClientRect();
          const b = [...window.document.querySelectorAll('.epg-block')].find(x => x.textContent.includes('Ferne Sendung'));
          if (!b) return false;
          const r = b.getBoundingClientRect();
          return r.right > scroll.left + 150 && r.left < scroll.right;
        }),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    // Jetzt & Gleich: Sprung öffnet das Modal; der Wechsel in die Liste landet beim Termin
    await page.locator('#epgModeJng').click();
    await page.locator('#epgSearchInput').fill('Käse');
    await page.locator('.epg-search-hit').click();
    await expect(page.locator('#epgDetailTitle')).toHaveText('Ferne Sendung Käse');
    await page.keyboard.press('Escape');
    expect(await activeMode(page)).toBe('epgModeJng');
    await page.locator('#epgModeList').click();
    await expect(listRow('Ferne Sendung Käse')).toBeVisible();
  });

  test('Esc-Kette: Modal > Menü > Suche (leert) > Kanalansicht > Overlay', async () => {
    await page.locator('#epgModeList').click();
    await page.locator('#epgSearchInput').fill('Sendung');
    await expect(page.locator('.epg-search-hit').first()).toBeVisible();
    // Menü über der Suche: Esc schließt zuerst das Menü, die Suche bleibt
    await page.locator('#epgMoreMenu').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgMoreMenuPanel')).toBeHidden();
    await expect(page.locator('#epgSearch')).toBeVisible();
    // Esc aus dem Suchfeld leert und verlässt die Suche, das Overlay bleibt
    await page.locator('#epgSearchInput').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgSearch')).toBeHidden();
    await expect(page.locator('#epgSearchInput')).toHaveValue('');
    await expect(page.locator('#epgOverlay')).toBeVisible();
    // zweites Esc: Kanalansicht (falls offen) bzw. Overlay
    await listRow('Laufende Sendung').locator('.epg-chan-link').click();
    await expect(page.locator('#epgChannel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgChannel')).toBeHidden();
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgOverlay')).toBeHidden();
  });

  test('Wiederholtes Öffnen/Schließen mit Suche, Menüs und Jetzt & Gleich: keine Listener-, Timer- oder DOM-Reste', async () => {
    for (let i = 0; i < 3; i += 1) {
      await reopenOverlay(page);
      await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
      await page.locator('#epgModeJng').click();
      await page.locator('#epgSearchInput').fill('Sendung');
      await page.locator('#epgSenderMenu').click();
      await closeOverlay(page);
      expect(await page.evaluate(() => window.document.getElementById('epgOverlay').dataset.subs)).toBe('0');
      expect(await page.evaluate(() => window.document.querySelectorAll('.epg-jrow, .epg-list-row, .epg-search-hit').length)).toBe(0);
      expect(await page.evaluate(() => window.document.getElementById('epgSearchInput').value)).toBe('');
    }
    // erwartete Main-Meldungen der absichtlich abgelehnten Einstellungswerte (Test „Startansicht“) sind kein Fehler
    expect(ctx.problems.filter(text => !text.includes("handler for 'epg-view:set-settings'"))).toEqual([]);
  });
});

// ───────────────────────── Großfixture ─────────────────────────

test.describe('Programmführer 3.5 (Großfixture 438 Kanäle × 10 Tage, „Alle Sender“)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let ctx;
  let page;

  test.beforeAll(async () => {
    const startMs = Math.floor((Date.now() - 24 * HOUR) / MIN) * MIN;
    const channels = Array.from({ length: 438 }, (_, i) => ({ id: channelId(i), name: `Sender ${i + 1}`, group: i % 2 ? 'Gerade' : 'Ungerade' }));
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgnavbig-',
      epgXml: buildXmltv({ channels: 438, days: 10, startMs, seed: 1 }),
      channels,
      favorites: [],
    });
    page = ctx.page;
    await waitForEpgChannels(page, 438);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test('Alle Sender: Liste, Raster und Jetzt & Gleich bleiben virtualisiert (begrenzter DOM), Jetzt & Gleich schaltet < 300 ms', async () => {
    await openOverlayFromDashboard(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'no-favorites');
    await page.locator('#epgSenderMenu').click();
    await page.locator('.epg-menu-item', { hasText: 'Alle Sender' }).click();
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    const listRows = await page.locator('.epg-list-row').count();
    expect(listRows).toBeGreaterThan(5);
    expect(listRows).toBeLessThan(150);
    // Raster
    await page.locator('#epgModeGrid').click();
    await expect(page.locator('.epg-block').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('.epg-grid-chan-btn').count()).toBeLessThan(60);
    expect(await page.locator('.epg-block').count()).toBeLessThan(900);
    // Jetzt & Gleich: warten, bis der Hintergrund-Abruf der Tage durch ist (Liste), dann messen
    await page.locator('#epgModeList').click();
    await expect
      .poll(async () => page.evaluate(() => window.document.getElementById('epgListItems').offsetHeight), { timeout: 60_000 })
      .toBeGreaterThan(438 * 30 * 44);
    const switchMs = await page.evaluate(async () => {
      const t0 = window.performance.now();
      window.document.getElementById('epgModeJng').click();
      await new Promise(resolve => {
        const check = () => {
          if (window.document.querySelector('.epg-jcell:not(.is-empty)')) resolve();
          else window.requestAnimationFrame(check);
        };
        check();
      });
      return window.performance.now() - t0;
    });
    // erster Wechsel lädt die Daten (438 Kanäle); danach ist der Wechsel sofort
    expect(switchMs).toBeLessThan(2000);
    const rows = await page.locator('.epg-jrow').count();
    expect(rows).toBeGreaterThan(3);
    expect(rows).toBeLessThan(40);
    const second = await page.evaluate(async () => {
      window.document.getElementById('epgModeList').click();
      await new Promise(resolve => window.requestAnimationFrame(resolve));
      const t0 = window.performance.now();
      window.document.getElementById('epgModeJng').click();
      await new Promise(resolve => {
        const check = () => {
          if (window.document.querySelector('.epg-jcell:not(.is-empty)')) resolve();
          else window.requestAnimationFrame(check);
        };
        check();
      });
      return window.performance.now() - t0;
    });
    expect(second).toBeLessThan(300);
    // Scrollen: viele Frames, DOM bleibt begrenzt
    const scroll = await page.evaluate(async () => {
      const list = window.document.getElementById('epgJng');
      let maxRows = 0;
      const t0 = window.performance.now();
      for (let i = 0; i < 100; i += 1) {
        list.scrollTop += 700;
        await new Promise(resolve => window.requestAnimationFrame(resolve));
        maxRows = Math.max(maxRows, window.document.querySelectorAll('.epg-jrow').length);
      }
      return { maxRows, ms: window.performance.now() - t0, total: window.document.getElementById('epgJngItems').offsetHeight };
    });
    expect(scroll.maxRows).toBeLessThan(40);
    expect(scroll.ms).toBeLessThan(100 * 100);
    expect(scroll.total).toBeGreaterThan(438 * 80);
  });

  test('Gruppe filtert 438 → 219 Sender in allen Modi; Suche über alle Sender: Treffer, Sprung < 300 ms, begrenzter DOM', async () => {
    await page.locator('#epgSenderMenu').click();
    await page.locator('.epg-menu-item[data-value="Gerade"]').click();
    await expect(page.locator('#epgSenderMenu')).toHaveText('Sender: Gruppe Gerade ▾');
    await expect
      .poll(async () => page.evaluate(() => window.document.getElementById('epgJngItems').offsetHeight), { timeout: 30_000 })
      .toBe(219 * 84);
    await page.locator('#epgSenderMenu').click();
    await page.locator('.epg-menu-item', { hasText: 'Alle Sender' }).click();
    await expect
      .poll(async () => page.evaluate(() => window.document.getElementById('epgJngItems').offsetHeight), { timeout: 30_000 })
      .toBe(438 * 84);
    // Suche über alle Sender
    await page.locator('#epgModeList').click();
    await page.locator('#epgSearchInput').fill('krimi');
    await expect(page.locator('.epg-search-hit').first()).toBeVisible({ timeout: 10_000 });
    const hits = await page.locator('.epg-search-hit').count();
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThanOrEqual(100);
    const jump = await page.evaluate(async () => {
      const hit = window.document.querySelector('.epg-search-hit');
      const t0 = window.performance.now();
      hit.click();
      await new Promise(resolve => {
        const check = () => {
          const backdrop = window.document.getElementById('epgDetailBackdrop');
          if (!backdrop.hidden) resolve();
          else window.requestAnimationFrame(check);
        };
        check();
      });
      return { ms: window.performance.now() - t0, rows: window.document.querySelectorAll('.epg-list-row').length };
    });
    expect(jump.ms).toBeLessThan(300);
    expect(jump.rows).toBeLessThan(150);
    await page.keyboard.press('Escape');
    await closeOverlay(page);
    expect(ctx.problems).toEqual([]);
  });
});
