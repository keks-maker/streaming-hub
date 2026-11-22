'use strict';

// E2E: Einstellungen → Streaming → iCloud-Abgleich (D10): unter macOS sichtbar, Standard aus, Status-Text, Einschalten
// ohne Helfer meldet „nicht installiert“. Isolierte userData (launchApp), Fenster im Hintergrund, kein echter Helfer
// (STREAMING_HUB_SYNC_HELPER_DIR zeigt auf ein leeres Temp-Verzeichnis). Screenshots (optional): ICLOUD_E2E_SHOTS=<Verzeichnis>.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shotBoth } = require('./theme-audit');
const { MIN, xmltvTime, launchApp } = require('./epg-helpers');

const SHOTS = process.env.ICLOUD_E2E_SHOTS || '';

test.describe('Einstellungen: iCloud-Abgleich', () => {
  test.skip(process.platform !== 'darwin', 'nur unter macOS sichtbar');
  test.describe.configure({ mode: 'serial' });

  let ctx;
  let page;
  let helperDir;

  test.beforeAll(async () => {
    helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-icloud-helper-'));
    const now = Math.floor(Date.now() / MIN) * MIN;
    ctx = await launchApp({
      prefix: 'streaming-hub-e2e-icloud-',
      epgXml: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="E2E.de"><display-name>E2E Kanal</display-name></channel><programme start="${xmltvTime(now - 30 * MIN)}" stop="${xmltvTime(now + 30 * MIN)}" channel="E2E.de"><title>Sendung</title></programme></tv>`,
      channels: [{ id: 'E2E.de', name: 'E2E Kanal', group: 'Test' }],
      favorites: ['E2E.de'],
      env: { STREAMING_HUB_SYNC_HELPER_DIR: helperDir },
    });
    page = ctx.page;
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (helperDir) fs.rmSync(helperDir, { recursive: true, force: true });
  });

  test('Schalter sichtbar, Standard aus, Status-Text vorhanden; Einschalten ohne Helfer zeigt Hinweis', async () => {
    await page.locator('#overlayNav [data-section="settings"]').evaluate(el => el.click());
    await expect(page.locator('#settingsNav').getByRole('heading', { name: 'LiveTV' })).toBeVisible();
    await page.locator('#settingsTab-streaming').click();
    const card = page.locator('#settingsIcloudCard');
    await expect(card).toBeVisible();
    const toggle = page.locator('#settingsIcloudSync');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#settingsIcloudStatus')).toBeAttached();
    await expect(page.locator('#settingsIcloudStatus')).toHaveText('');
    if (SHOTS) {
      await card.scrollIntoViewIfNeeded();
      await shotBoth(page, SHOTS, 'icloud-aus');
    }
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect(page.locator('#settingsIcloudStatus')).not.toHaveText('');
    if (SHOTS) await shotBoth(page, SHOTS, 'icloud-an');
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    // Nur Seiten-/Renderer-Fehler zählen (fehlende Recorder-/Wake-Handler im Main hängen an bin/ffmpeg, nicht am Schalter)
    expect(ctx.problems.filter(text => !text.startsWith('[main console]'))).toEqual([]);
  });
});
