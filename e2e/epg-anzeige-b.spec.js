'use strict';

// E2E: Programmführer Etappe 3.6 — Anzeige B (B2/F3): Genre-Chips (Raster dämpft, Liste/Jetzt & Gleich/Suche filtern,
// Filter überlebt den Moduswechsel), Detail-Modal mit Poster/Metazeile/Besetzung/„Läuft auch“, neutrale Modals ohne
// B-Felder, bösartige Werte nur als Text, Bildfehler, Vorschaubilder in „Jetzt & Gleich“ (nur sichtbare Zeilen) samt
// Messung der Zeit bis zur Anzeige der Liste (EPG-E4: < 300 ms). Bilder kommen von einem Fremdhost (img.e2e.invalid) und
// werden per page.route beantwortet; jede Anfrage wird mitgezählt. Kein Netz.
const { test, expect } = require('@playwright/test');
const { MIN, buildDisplayXmltv, buildThumbXmltv, DISPLAY_CHANNELS, IMG_HOST, thumbChannelId } = require('../tests/helpers/epg-b-display-fixture.js');
const { launchApp, waitForEpgChannels, openOverlayFromDashboard } = require('./epg-helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// Meldungen, die zu den absichtlichen Bildfehlern der Tests gehören (404 des Bilddienstes, CSP gegen http-Icons)
const EXPECTED_IMAGE_NOISE = ['Content Security Policy', 'status of 404', 'Failed to load resource', 'img.e2e.invalid'];

/** Beantwortet Bildanfragen des Fremdhosts und zählt sie. mode: 'ok' | 'broken-404' | 'abort' | 'slow'. */
async function installImageHost(page, { delayMs = 0 } = {}) {
  const requests = [];
  const state = { abort: false };
  await page.route(`${IMG_HOST}/**`, async route => {
    const url = route.request().url();
    requests.push(url);
    if (state.abort) return route.abort('failed');
    if (url.endsWith('/broken.png')) return route.fulfill({ status: 404, body: 'nicht gefunden' });
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  return { requests, state };
}

const unexpectedProblems = problems => problems.filter(p => !EXPECTED_IMAGE_NOISE.some(noise => p.includes(noise)));

const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

// ───────────────────────── Fixture mit allen B-Feldern ─────────────────────────

test.describe('Programmführer 3.6 (Genre-Chips, Detail-Modal)', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let host;

  test.beforeAll(async () => {
    const base = Math.floor(Date.now() / MIN) * MIN;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgb-',
      epgXml: buildDisplayXmltv({ baseMs: base }),
      channels: DISPLAY_CHANNELS.map(c => ({ id: c.id, name: c.name, group: 'Test' })),
      favorites: DISPLAY_CHANNELS.map(c => c.id),
    });
    page = ctx.page;
    host = await installImageHost(page);
    await waitForEpgChannels(page, 4);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  const listRow = title => page.locator('.epg-list-row', { hasText: title });
  const block = title => page.locator('.epg-block', { hasText: title });
  const jngRows = () => page.locator('#epgJngItems .epg-jrow');
  const chip = genre => page.locator(`#epgGenre_${genre}`);
  const openDetailOf = async title => {
    await listRow(title).first().locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await expect(page.locator('#epgDetailTitle')).toHaveText(title);
  };
  const closeDetail = async () => {
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgDetailBackdrop')).toBeHidden();
  };
  const clearGenres = async () => {
    await page.locator('#epgGenreAll').click();
    await expect(page.locator('#epgGenreAll')).toHaveAttribute('aria-pressed', 'true');
  };

  test('kein Bild-Request ohne Nutzeraktion: Overlay offen, Liste sichtbar → keine Anfrage an den Bilddienst', async () => {
    await openOverlayFromDashboard(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await expect(listRow('Krimi Voll')).toBeVisible();
    await page.waitForTimeout(800);
    expect(host.requests).toEqual([]);
  });

  test('Chips: „Alle“ + neun Gruppen, Beschriftung als Text, per Tastatur bedienbar (aria-pressed)', async () => {
    const chips = page.locator('#epgGenreChips .epg-chip');
    await expect(chips).toHaveCount(10);
    await expect(chips.locator('.epg-chip-label')).toHaveText(['Film', 'Serie', 'Nachrichten', 'Sport', 'Doku', 'Kinder', 'Show', 'Musik', 'Sonstiges']);
    await expect(page.locator('#epgGenreAll')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('sport')).toHaveAttribute('aria-pressed', 'false');
    // Tastatur: fokussieren, Leertaste schaltet an, Enter wieder aus
    await chip('sport').focus();
    await page.keyboard.press('Space');
    await expect(chip('sport')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#epgGenreAll')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Enter');
    await expect(chip('sport')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#epgGenreAll')).toHaveAttribute('aria-pressed', 'true');
    // die Farbe ist nie alleiniger Träger: jeder Chip trägt seinen Namen als Text, der Punkt ist nur Zierde
    await expect(chip('sport').locator('.epg-chip-dot')).toHaveAttribute('aria-hidden', 'true');
    // aktive Chips tragen ein ✕ (entfernbar)
    await chip('film').click();
    await expect(chip('film').locator('.epg-chip-x')).toBeVisible();
    await expect(chip('film')).toHaveAttribute('title', 'Filter Film entfernen');
    await chip('film').click();
    await expect(chip('film').locator('.epg-chip-x')).toBeHidden();
  });

  test('Liste filtert wirklich: nur Sendungen der gewählten Gruppen; Sendungen ohne Genre fallen heraus; „Alle“ hebt auf', async () => {
    const before = await page.locator('.epg-list-row').count();
    await chip('sport').click();
    await expect(listRow('Sport Live')).toBeVisible();
    await expect(page.locator('.epg-list-row')).toHaveCount(1);
    await expect(listRow('Krimi Voll')).toHaveCount(0);
    await expect(listRow('Genre unbekannt')).toHaveCount(0);
    await chip('film').click();
    // Film + Sport: Krimi Voll (Krimi/Drama → Film), Sport Live, 8 × Tatort (Krimi → Film) — im sichtbaren Ausschnitt mindestens diese
    await expect(listRow('Krimi Voll')).toBeVisible();
    await expect(listRow('Sport Live')).toBeVisible();
    await expect(listRow('Nachrichten Spezial')).toHaveCount(0);
    await clearGenres();
    await expect(listRow('Nachrichten Spezial')).toBeVisible();
    expect(await page.locator('.epg-list-row').count()).toBe(before);
  });

  test('Liste: kein Treffer im Genre → Hinweis mit „Genre-Filter aufheben“', async () => {
    await chip('musik').click();
    await chip('kinder').click();
    await chip('musik').click();
    await chip('kinder').click();
    await chip('sonstiges').click();
    await expect(page.locator('#epgFilterEmpty')).toBeVisible();
    await expect(page.locator('#epgFilterEmpty')).toContainText('Keine passenden Sendungen');
    await expect(page.locator('.epg-list-row')).toHaveCount(0);
    await page.locator('#epgFilterEmptyBtn').click();
    await expect(page.locator('#epgFilterEmpty')).toBeHidden();
    await expect(chip('sonstiges')).toHaveAttribute('aria-pressed', 'false');
    await expect(listRow('Krimi Voll')).toBeVisible();
  });

  test('Raster dämpft: nicht passende Blöcke bleiben (Struktur), erhalten is-dimmed; Filter überlebt den Moduswechsel', async () => {
    await page.locator('#epgModeGrid').click();
    await expect(page.locator('#epgGrid')).toBeVisible();
    await expect(block('Krimi Voll')).toBeVisible();
    const total = await page.locator('.epg-block').count();
    expect(total).toBeGreaterThan(5);
    await expect(page.locator('.epg-block.is-dimmed')).toHaveCount(0);
    await chip('sport').click();
    await expect(block('Krimi Voll')).toHaveClass(/is-dimmed/);
    await expect(block('Sport Live')).not.toHaveClass(/is-dimmed/);
    await expect(block('Genre unbekannt')).toHaveClass(/is-dimmed/);
    expect(await page.locator('.epg-block').count()).toBe(total);
    // gedämpft heißt nicht deaktiviert: Klick öffnet weiterhin das Detail
    await block('Krimi Voll').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await closeDetail();
    // Moduswechsel: Liste → Filter bleibt
    await page.locator('#epgModeList').click();
    await expect(chip('sport')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.epg-list-row')).toHaveCount(1);
    await page.locator('#epgModeGrid').click();
    await expect(block('Krimi Voll')).toHaveClass(/is-dimmed/);
  });

  test('Jetzt & Gleich filtert wirklich: Positionen bleiben, Sender ohne passende Zelle verschwinden', async () => {
    await page.locator('#epgModeJng').click();
    await expect(page.locator('#epgJng')).toBeVisible();
    await expect(chip('sport')).toHaveAttribute('aria-pressed', 'true');
    await expect(jngRows()).toHaveCount(1);
    const row = jngRows().first();
    await expect(row).toContainText('Genre Eins');
    await expect(row.locator('.epg-jcell:not(.is-empty)')).toHaveCount(1);
    await expect(row.locator('.epg-jcell:not(.is-empty)')).toContainText('Sport Live');
    await expect(row.locator('.epg-jslot').first()).toContainText('–'); // „Läuft“: Krimi Voll ist kein Sport
    // anderes Genre → anderer Sender
    await chip('sport').click();
    await chip('doku').click();
    await expect(jngRows()).toHaveCount(1);
    await expect(jngRows().first()).toContainText('Genre Zwei');
    // nichts passt → Hinweis
    await chip('doku').click();
    await chip('kinder').click();
    await expect(jngRows()).toHaveCount(0);
    await expect(page.locator('#epgJngEmpty')).toBeVisible();
    await expect(page.locator('#epgJngEmpty')).toContainText('Keine Sendungen für die gewählten Genres');
    await clearGenres();
    await expect(jngRows()).toHaveCount(4);
  });

  test('Suche filtert die Treffer nach Genre; leerer Filter-Treffer nennt das Genre', async () => {
    await page.locator('#epgModeList').click();
    await page.locator('#epgSearchInput').fill('Tatort');
    await expect(page.locator('.epg-search-hit')).toHaveCount(8);
    await chip('sport').click();
    await expect(page.locator('#epgSearchNote')).toContainText('Keine Treffer im Genre Sport');
    await expect(page.locator('.epg-search-hit')).toHaveCount(0);
    await chip('sport').click();
    await chip('film').click();
    await expect(page.locator('.epg-search-hit')).toHaveCount(8);
    await clearGenres();
    await expect(page.locator('.epg-search-hit')).toHaveCount(8);
    // Suche schließen (Esc leert und verlässt sie)
    await page.locator('#epgSearchInput').press('Escape');
    await expect(page.locator('#epgSearch')).toBeHidden();
  });

  test('Filter bleibt beim Schließen und Öffnen des Overlays (Sitzungszustand, kein Setting)', async () => {
    await chip('news').click();
    await page.locator('#epgCloseBtn').click();
    await expect(page.locator('#epgOverlay')).toBeHidden();
    await page.locator('#tvSidebarEpgBtn, #dashboardEpgOpen').first().evaluate(el => el.click());
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await expect(chip('news')).toHaveAttribute('aria-pressed', 'true');
    await expect(listRow('Nachrichten Spezial')).toBeVisible();
    await expect(page.locator('.epg-list-row')).toHaveCount(1);
    // nicht gespeichert: die Programmführer-Einstellungen kennen nur die Startansicht
    expect(Object.keys(await page.evaluate(() => window.electronAPI.getEpgViewSettings()))).toEqual(['startView']);
    await clearGenres();
  });

  test('Modal mit B-Daten: Untertitel, Metazeile, Besetzung, Altersfreigabe, Poster; Aufnehmen bleibt primärer Button unter der Metazeile', async () => {
    const before = host.requests.length;
    await openDetailOf('Krimi Voll');
    await expect(page.locator('#epgDetailSub')).toHaveText('Der Untertitel & mehr');
    await expect(page.locator('#epgDetailInfo')).toContainText('Film · 2019 · 60 min · S2 E3');
    await expect(page.locator('#epgDetailRating')).toHaveText('FSK 12');
    await expect(page.locator('#epgDetailCast')).toHaveText('Regie: Regie Eins · Mit: Darsteller 1, Darsteller 2, Darsteller 3 … + 3 weitere');
    await expect(page.locator('#epgDetailDesc')).toHaveText('Beschreibung zu Krimi Voll.');
    const poster = page.locator('#epgDetailPoster');
    await expect(poster).toBeVisible();
    await expect(poster.locator('img')).toHaveAttribute('loading', 'lazy');
    await expect(poster).toHaveClass(/has-img/);
    expect(await poster.locator('img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    expect(host.requests.slice(before)).toEqual([`${IMG_HOST}/p/krimi.png`]);
    // Aufnehmen: primärer Button, unterhalb der Metazeile
    const info = await page.locator('#epgDetailInfo').boundingBox();
    const toggle = await page.locator('#epgDetailRecordBtn').boundingBox();
    expect(toggle.y).toBeGreaterThan(info.y + info.height - 1);
    await expect(page.locator('#epgDetailRecordBtn')).toHaveClass(/epg-toggle-primary/);
    await expect(page.locator('#epgDetailRecordBtn')).toBeVisible();
    // der Poster-Rahmen steht rechts (der Text links springt beim Laden nicht)
    const pb = await poster.boundingBox();
    const tb = await page.locator('#epgDetailTitle').boundingBox();
    expect(pb.x).toBeGreaterThan(tb.x);
    await closeDetail();
  });

  test('Modal ohne B-Felder bleibt neutral: keine leeren Zeilen, kein Poster, kein „Läuft auch“, kein Request', async () => {
    const before = host.requests.length;
    await openDetailOf('Ohne Felder');
    await expect(page.locator('#epgDetailDesc')).toHaveText('Keine Beschreibung verfügbar.');
    await expect(page.locator('#epgDetailInfo')).toHaveText('30 min');
    for (const id of ['epgDetailSub', 'epgDetailCast', 'epgDetailRating', 'epgDetailPoster', 'epgDetailAlso']) {
      await expect(page.locator(`#${id}`), id).toBeHidden();
    }
    expect(host.requests.slice(before)).toEqual([]);
    await expect(page.locator('#epgDetailBackdrop img')).toHaveCount(0);
    await expect(page.locator('#epgDetailRecordBtn')).toBeVisible();
    await closeDetail();
  });

  test('„Läuft auch“: weitere Termine desselben Titels, max. 5, aktueller Termin ausgeschlossen; Klick springt zum Termin', async () => {
    await listRow('Tatort').filter({ hasText: 'Genre Eins' }).first().locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailMeta')).toContainText('Genre Eins');
    const also = page.locator('#epgDetailAlso');
    await expect(also).toBeVisible();
    await expect(also.locator('.epg-also-item')).toHaveCount(5);
    await expect(page.locator('.epg-also-more')).toHaveText('+ 2 weitere Termine (Anzeige max. 5)');
    // der aktuelle Termin (Genre Eins) taucht nicht auf
    await expect(also.locator('.epg-also-channel', { hasText: 'Genre Eins' })).toHaveCount(0);
    // erster Eintrag: der laufende Termin von Genre Zwei
    await expect(also.locator('.epg-also-item').first()).toContainText('Genre Zwei');
    await also.locator('.epg-also-item').first().click();
    await expect(page.locator('#epgDetailTitle')).toHaveText('Tatort');
    await expect(page.locator('#epgDetailMeta')).toContainText('Genre Zwei');
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await closeDetail();
  });

  test('Bösartige Werte erscheinen nur als Text: kein HTML, kein Skript, javascript:-Icon wird nie geladen', async () => {
    const before = host.requests.length;
    const literal = '<img src=x onerror=window.__pwned=1> & Co';
    await openDetailOf(literal);
    await expect(page.locator('#epgDetailSub')).toHaveText('<b>fett</b>');
    await expect(page.locator('#epgDetailCast')).toContainText('<script>window.__pwned=1</script>');
    await expect(page.locator('#epgDetailCast')).toContainText('A & B');
    await expect(page.locator('#epgDetailRating')).toHaveText('<i>FSK</i>');
    await expect(page.locator('#epgDetailDesc')).toContainText('<script>window.__pwned=1</script>');
    await expect(page.locator('#epgDetailBackdrop').locator('img, script, b, i')).toHaveCount(0);
    await expect(page.locator('#epgDetailPoster')).toBeHidden();
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(host.requests.slice(before)).toEqual([]);
    await closeDetail();
    // auch in Liste und Raster nur Text
    await expect(listRow(literal).locator('.epg-row-open')).toHaveText(literal);
    await expect(page.locator('.epg-list-row img, .epg-list-row script, .epg-list-row b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test('data:-Icon: kein Poster, keine Anfrage', async () => {
    const before = host.requests.length;
    await openDetailOf('Icon data');
    await expect(page.locator('#epgDetailDesc')).toHaveText('Keine Beschreibung verfügbar.');
    await expect(page.locator('#epgDetailPoster')).toBeHidden();
    await expect(page.locator('#epgDetailBackdrop img')).toHaveCount(0);
    expect(host.requests.slice(before)).toEqual([]);
    await closeDetail();
  });

  test('Bildfehler (404): nur das Bild entfällt, der Rahmen bleibt stehen, das Modal bleibt voll bedienbar', async () => {
    await listRow('Kaputtes Bild').first().locator('.epg-row-open').click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    const poster = page.locator('#epgDetailPoster');
    await expect(poster).toBeVisible();
    await expect(poster).toHaveClass(/is-failed/);
    await expect(poster.locator('img')).toHaveCount(0);
    const box = await poster.boundingBox();
    expect(box.width).toBeGreaterThan(80);
    expect(box.height).toBeGreaterThan(120);
    await expect(page.locator('#epgDetailRecordBtn')).toBeVisible();
    await expect(page.locator('#epgDetailInfo')).toContainText('Serie');
    expect(host.requests.filter(url => url.endsWith('/broken.png')).length).toBeGreaterThan(0);
    await closeDetail();
  });

  test('http-Icon: die vorhandene CSP (img-src nur https) blockiert das Bild — nur das Bild entfällt, keine CSP-Lockerung', async () => {
    const csp = await page.evaluate(() => window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
    expect(csp).toContain("img-src 'self' data: https:;");
    expect(csp).not.toMatch(/img-src[^;]*http:/);
    await openDetailOf('Icon http');
    const poster = page.locator('#epgDetailPoster');
    await expect(poster).toHaveClass(/is-failed/);
    await expect(poster.locator('img')).toHaveCount(0);
    await expect(page.locator('#epgDetailRecordBtn')).toBeVisible();
    await closeDetail();
  });

  test('keine unerwarteten Fehler (außer den absichtlichen Bildfehlern)', async () => {
    expect(unexpectedProblems(ctx.problems)).toEqual([]);
  });
});

// ───────────────────────── Thumbnails in „Jetzt & Gleich“ ─────────────────────────

test.describe('Programmführer 3.6 (Thumbnails in Jetzt & Gleich)', () => {
  test.describe.configure({ mode: 'serial' });

  const CHANNELS = Number(process.env.E2E_THUMB_CHANNELS) || 120;
  let ctx;
  let page;
  let host;

  test.beforeAll(async () => {
    const base = Math.floor(Date.now() / MIN) * MIN;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-epgthumb-',
      epgXml: buildThumbXmltv({ baseMs: base, channels: CHANNELS }),
      channels: Array.from({ length: CHANNELS }, (_, i) => ({ id: thumbChannelId(i), name: `Thumb ${i + 1}`, group: 'Test' })),
      favorites: Array.from({ length: CHANNELS }, (_, i) => thumbChannelId(i)),
    });
    page = ctx.page;
    host = await installImageHost(page);
    await waitForEpgChannels(page, CHANNELS);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  const switchToJng = async () => {
    await page.locator('#epgModeJng').click();
    await expect(page.locator('#epgJngItems .epg-jrow').first()).toBeVisible();
  };
  const visibleRowIndexes = () =>
    page.evaluate(() => {
      const scroll = window.document.getElementById('epgJng');
      const box = scroll.getBoundingClientRect();
      return [...window.document.querySelectorAll('#epgJngItems .epg-jrow')]
        .filter(row => {
          const r = row.getBoundingClientRect();
          return r.bottom > box.top && r.top < box.bottom;
        })
        .map(row => Number(/Thumb (\d+)/.exec(row.textContent)[1]));
    });
  const channelOf = url => Number(/\/t\/(\d+)-\d+\.png$/.exec(url)[1]);

  test('Liste geöffnet → keine Bildanfrage; J&G zeigt Platzhalter, Bilder nur für die sichtbaren Zeilen', async () => {
    await openOverlayFromDashboard(page);
    await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.epg-list-row').first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(host.requests).toEqual([]);
    await switchToJng();
    await expect(page.locator('#epgJngItems .epg-thumb').first()).toBeVisible(); // fester Platzhalter
    await expect.poll(() => page.locator('#epgJngItems .epg-thumb.has-img').count(), { timeout: 15_000 }).toBeGreaterThan(3);
    const visible = await visibleRowIndexes();
    expect(visible.length).toBeGreaterThan(3);
    expect(visible.length).toBeLessThan(40);
    await page.waitForTimeout(600);
    const requested = host.requests.map(channelOf);
    // höchstens die drei Zellen der sichtbaren Zeilen (plus Zeilen, die beim Rendern kurz sichtbar waren: kleine Toleranz)
    expect(host.requests.length).toBeLessThanOrEqual(visible.length * 3 + 6);
    expect(host.requests.length).toBeLessThan(CHANNELS * 3 / 2);
    // nur Sender aus dem sichtbaren Bereich (± 2 Zeilen), nichts aus der Mitte oder vom Ende
    const lo = Math.min(...visible) - 3;
    const hi = Math.max(...visible) + 3;
    expect(requested.every(n => n >= lo && n <= hi), `angefragt: ${[...new Set(requested)].join(',')}, sichtbar ${lo + 3}-${hi - 3}`).toBe(true);
    expect(requested).not.toContain(60);
    expect(requested).not.toContain(CHANNELS);
    // keine Wiederholung: jede URL höchstens einmal
    expect(new Set(host.requests).size).toBe(host.requests.length);
  });

  test('Scrollen holt nur die Zeilen, auf denen die Ansicht stehen bleibt', async () => {
    const before = host.requests.length;
    await page.locator('#epgJng').evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => host.requests.length, { timeout: 15_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(600);
    const visible = await visibleRowIndexes();
    const fresh = host.requests.slice(before).map(channelOf);
    const lo = Math.min(...visible) - 3;
    expect(fresh.every(n => n >= lo), `neu angefragt: ${[...new Set(fresh)].join(',')}`).toBe(true);
    expect(Math.max(...visible)).toBe(CHANNELS);
    // schnelles Durchscrollen ohne Halt lädt nichts aus der Mitte
    expect(host.requests.map(channelOf)).not.toContain(60);
  });

  test('Ausfall des Bilddienstes verändert nur das Bild: Platzhalter bleiben, Zeilen und Bedienung unberührt', async () => {
    host.state.abort = true;
    await page.locator('#epgJng').evaluate(el => {
      el.scrollTop = 0;
    });
    await page.locator('#epgModeList').click();
    await page.locator('#epgCloseBtn').click();
    await expect(page.locator('#epgOverlay')).toBeHidden();
    await page.locator('#tvSidebarEpgBtn, #dashboardEpgOpen').first().evaluate(el => el.click());
    await expect(page.locator('#epgOverlay')).toBeVisible();
    await page.locator('#epgModeJng').click();
    await expect(page.locator('#epgJngItems .epg-jrow').first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator('#epgJngItems .epg-thumb').first()).toBeVisible();
    await expect(page.locator('#epgJngItems .epg-thumb-img')).toHaveCount(0);
    await expect(page.locator('#epgJngItems .epg-jcell:not(.is-empty)').first()).toBeVisible();
    // die Zelle bleibt bedienbar
    await page.locator('#epgJngItems .epg-jcell .epg-row-open').first().click();
    await expect(page.locator('#epgDetailBackdrop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#epgDetailBackdrop')).toBeHidden();
    host.state.abort = false;
  });

  test('Messung: Zeit bis zur Anzeige der Liste „Jetzt & Gleich“ (frisch geladen, Bilder auf 400 ms gedrosselt) < 300 ms', async () => {
    // Bilddienst langsam: wenn Thumbnails die Liste ausbremsen würden, zeigte sich das hier
    await page.unroute(`${IMG_HOST}/**`);
    const slow = await installImageHost(page, { delayMs: 400 });
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      await page.locator('#epgCloseBtn').click();
      await expect(page.locator('#epgOverlay')).toBeHidden();
      await page.locator('#tvSidebarEpgBtn, #dashboardEpgOpen').first().evaluate(el => el.click());
      await expect(page.locator('#epgOverlay')).toHaveAttribute('data-state', 'ready');
      await page.locator('.epg-list-row').first().waitFor();
      const ms = await page.evaluate(
        () =>
          new Promise(resolve => {
            const t0 = window.performance.now();
            const done = () => {
              const rows = window.document.querySelectorAll('#epgJngItems .epg-jrow');
              if (rows.length > 0 && rows[0].querySelector('.epg-jcell .epg-row-open')) resolve(window.performance.now() - t0);
              else window.requestAnimationFrame(done);
            };
            window.document.getElementById('epgModeJng').click();
            window.requestAnimationFrame(done);
          }),
      );
      samples.push(Math.round(ms));
      await page.waitForTimeout(900); // die (gedrosselten) Bilder der sichtbaren Zeilen werden angefragt, ohne dass die Liste wartet
      await page.locator('#epgModeList').click();
    }
    const med = median(samples);
    test.info().annotations.push({ type: 'Thumbnail-Messung (ms bis Liste J&G, 6 Läufe, 120 Sender)', description: `${samples.join(', ')} · Median ${med}` });
    console.log(`[Messung 3.6] Zeit bis Anzeige Jetzt & Gleich (ms): ${samples.join(', ')} · Median ${med} · Bildanfragen gesamt ${slow.requests.length}`);
    expect(slow.requests.length).toBeGreaterThan(samples.length * 3); // die Bilder wurden tatsächlich (verzögert) angefragt
    expect(med).toBeLessThan(300);
    expect(Math.max(...samples)).toBeLessThan(600);
  });

  test('keine unerwarteten Fehler (außer den absichtlichen Bildfehlern)', async () => {
    expect(unexpectedProblems(ctx.problems)).toEqual([]);
  });
});
