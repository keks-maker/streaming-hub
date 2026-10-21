'use strict';

// E2E: Layout der Mediathek-Karten. Das FSK-Badge darf weder den runden Knöpfen (i, Stern, Entfernen) noch dem Senderbadge, der Dauer
// oder dem Regionshinweis in die Quere kommen - bei schmalen und breiten Karten, in beiden Designs. Fixture-Karten mit den echten
// Klassen und dem Stylesheet der App; kein Netz.
const { test, expect } = require('@playwright/test');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');

let ctx;
let page;

test.beforeAll(async () => {
  const base = Date.now();
  ctx = await launchApp({
    prefix: 'mediathek-card-layout-e2e-',
    epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(base - 30 * MIN)}" stop="${xmltvTime(base + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
    channels: [{ id: 'E2E.de', name: 'E2E Kanal' }],
    favorites: [],
  });
  page = ctx.page;
  await page.setViewportSize({ width: 1000, height: 700 });
});

test.afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

test('FSK-Badge überlappt nie Info-/Stern-/Entfernen-Knopf, Senderbadge, Dauer oder Regionshinweis', async () => {
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'cardLayoutFixture';
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--md-bg,#000);display:flex;flex-wrap:wrap;gap:12px;padding:12px;overflow:auto';
      const make = (width, fsk, buttons) => {
        const card = document.createElement('div');
        card.className = 'mediathek-card';
        card.style.width = `${width}px`;
        card.innerHTML =
          '<span class="mediathek-thumb"><span class="mediathek-pill mediathek-pill-source">arte</span>' +
          '<span class="mediathek-pill mediathek-pill-geo">nur in DE</span>' +
          `<span class="mediathek-pill mediathek-pill-fsk">FSK ${fsk}</span>` +
          '<span class="mediathek-pill mediathek-pill-duration">120 Min.</span></span>' +
          buttons.map(b => `<button class="mediathek-${b}-btn">i</button>`).join('');
        host.appendChild(card);
        return card;
      };
      document.body.appendChild(host);
      const out = [];
      for (const width of [140, 230, 320]) {
        for (const fsk of [6, 12, 16, 18]) {
          for (const buttons of [['info'], ['info', 'remove'], ['star', 'remove']]) {
            const card = make(width, fsk, buttons);
            const rect = node => node.getBoundingClientRect();
            const fskBox = rect(card.querySelector('.mediathek-pill-fsk'));
            const thumbBox = rect(card.querySelector('.mediathek-thumb'));
            const others = [...card.querySelectorAll('button, .mediathek-pill-source, .mediathek-pill-duration, .mediathek-pill-geo')].map(node => [node.className, rect(node)]);
            const overlaps = others.filter(([, box]) => fskBox.left < box.right && fskBox.right > box.left && fskBox.top < box.bottom && fskBox.bottom > box.top).map(([name]) => name);
            const inside = fskBox.left >= thumbBox.left && fskBox.right <= thumbBox.right && fskBox.top >= thumbBox.top && fskBox.bottom <= thumbBox.bottom;
            out.push({ width, fsk, buttons: buttons.join('+'), overlaps, inside });
          }
        }
      }
      return out;
    });
    const bad = results.filter(r => r.overlaps.length || !r.inside);
    expect(bad, `Überlappungen im ${scheme}-Design`).toEqual([]);
    expect(results.length).toBe(36);
    if (process.env.CARD_SHOTS) await page.screenshot({ path: `${process.env.CARD_SHOTS}/cards-${scheme}.png` });
    await page.evaluate(() => document.getElementById('cardLayoutFixture').remove());
  }
});
