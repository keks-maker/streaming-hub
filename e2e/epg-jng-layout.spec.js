'use strict';

// E2E: „Jetzt & Gleich“ Zellenlayout — der runde Aufnahme-Knopf hat eine eigene Spalte und überschneidet weder Titel,
// Zeitzeile (Meta) noch Vorschaubild; Zeit bleibt vollständig, bei Platzmangel entfällt zuerst die Restzeit.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { MIN, xmltvTime, launchApp, waitForEpgChannels, openOverlayFromDashboard } = require('./epg-helpers');

const programme = (channel, title, start, stop) =>
  `<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="${channel}"><title>${title}</title></programme>`;

const LONG = 'Ein sehr langer Sendungstitel der garantiert nicht in eine einzige Zelle passt';

test.describe('Jetzt & Gleich Zellenlayout', () => {
  test.describe.configure({ mode: 'serial' });
  let ctx;
  let page;

  test.beforeAll(async () => {
    const base = Math.floor(Date.now() / MIN) * MIN;
    const ids = ['L1.de', 'L2.de', 'L3.de'];
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><tv>' +
      ids.map(id => `<channel id="${id}"><display-name>Kanal ${id}</display-name></channel>`).join('') +
      ids
        .map(
          (id, i) =>
            programme(id, `${LONG} ${i}`, base - 20 * MIN, base + 25 * MIN) +
            programme(id, `Danach ${LONG} ${i}`, base + 25 * MIN, base + 85 * MIN) +
            programme(id, `Später ${LONG} ${i}`, base + 85 * MIN, base + 140 * MIN),
        )
        .join('') +
      '</tv>';
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-jnglayout-',
      epgXml: xml,
      channels: ids.map(id => ({ id, name: `Kanal ${id}`, group: 'Test' })),
      favorites: ids,
    });
    page = ctx.page;
    await waitForEpgChannels(page, 3);
    await openOverlayFromDashboard(page);
    await page.locator('#epgModeJng').click();
    await expect(page.locator('#epgJngItems .epg-jcell[data-row-id]').first()).toBeVisible();
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  const setWidth = async width => {
    await ctx.electronApp.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(300, 400);
      win.setSize(w, 900);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    await page.waitForTimeout(300);
  };

  const measure = () =>
    page.evaluate(() => {
      const scroll = window.document.getElementById('epgJng').getBoundingClientRect();
      const rect = el => {
        const r = el.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
      };
      const visible = r => r.b > scroll.top && r.t < scroll.bottom && r.w > 0 && r.h > 0;
      return [...window.document.querySelectorAll('#epgJngItems .epg-jcell[data-row-id]')]
        .map(cell => {
          const q = sel => cell.querySelector(sel);
          const time = q('.epg-time');
          const sub = q('.epg-time-sub');
          return {
            cell: rect(cell),
            btn: rect(q('.epg-toggle')),
            title: rect(q('.epg-row-open')),
            meta: rect(q('.epg-jcell-time')),
            time: rect(time),
            timeClipped: time.scrollWidth > time.clientWidth + 1,
            sub: sub && getComputedStyle(sub).display !== 'none' && sub.textContent ? rect(sub) : null,
            thumb: getComputedStyle(q('.epg-thumb')).display !== 'none' ? rect(q('.epg-thumb')) : null,
            titleClipped: q('.epg-row-open').scrollWidth > q('.epg-row-open').clientWidth,
          };
        })
        .filter(c => visible(c.cell));
    });

  const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const within = (inner, outer) => inner.l >= outer.l - 0.5 && inner.r <= outer.r + 0.5;

  for (const width of [700, 900, 1100, 1300, 1500]) {
    test(`Aufnahme-Knopf überschneidet nichts bei ${width} px`, async () => {
      await setWidth(width);
      const cells = await measure();
      expect(cells.length).toBeGreaterThan(2);
      for (const c of cells) {
        expect(Math.round(c.btn.w)).toBe(32);
        expect(hit(c.btn, c.title), 'Knopf/Titel').toBe(false);
        expect(hit(c.btn, c.meta), 'Knopf/Meta-Zeile').toBe(false);
        expect(hit(c.btn, c.time), 'Knopf/Zeit').toBe(false);
        if (c.sub) expect(hit(c.btn, c.sub), 'Knopf/Restzeit').toBe(false);
        if (c.thumb) expect(hit(c.btn, c.thumb), 'Knopf/Bild').toBe(false);
        expect(within(c.btn, c.cell), 'Knopf in der Zelle').toBe(true);
        expect(c.timeClipped, 'Zeit nicht abgeschnitten').toBe(false);
        expect(Math.round(c.time.h), 'Zeit einzeilig').toBeLessThan(20);
        if (c.sub) expect(within(c.sub, c.meta), 'Restzeit nicht abgeschnitten').toBe(true);
      }
      if (process.env.E2E_SHOT_DIR) {
        fs.mkdirSync(process.env.E2E_SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/jng-${width}.png` });
      }
    });
  }

  test('schmale Zellen (900 px, drei Spalten): Restzeit entfällt, Titel per Ellipse gekürzt', async () => {
    await setWidth(900);
    const cells = await measure();
    expect(cells.every(c => c.sub === null)).toBe(true);
    expect(cells.some(c => c.titleClipped)).toBe(true);
  });

  test('Knopf: Icon ohne Text, aria-label, Tab-Reihenfolge Titel → Aufnahme', async () => {
    await setWidth(1500);
    const info = await page.evaluate(() => {
      const cell = window.document.querySelector('#epgJngItems .epg-jcell[data-row-id]');
      const btn = cell.querySelector('.epg-toggle');
      return { text: btn.textContent.trim(), label: btn.getAttribute('aria-label'), icon: !!btn.querySelector('svg'), order: !!(cell.querySelector('.epg-row-open').compareDocumentPosition(btn) & 4) };
    });
    expect(info.text).toBe('');
    expect(info.icon).toBe(true);
    expect(info.order).toBe(true);
    expect(info.label).toMatch(/^Aufnehmen: .+ \(Kanal .+, \d\d:\d\d\)$/);
  });
});
