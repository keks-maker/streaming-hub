'use strict';

// E2E: Update-Dialog mit Release-Notes. Lokaler Mock-Server ersetzt die GitHub-API
// (STREAMING_HUB_UPDATE_URL, nur lokal http bzw. ungepackt wirksam). Es wird nichts installiert:
// der Test bricht ab und prüft, dass weder neu geprüft (apply) noch das Asset geladen wurde.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { resolveLaunchTarget, launchArgs } = require('./platform');
const { RELEASE_TARGETS, targetKey } = require('../lib/github-releases.js');

const SCREENSHOT = process.env.E2E_UPDATE_SCREENSHOT;
const spec = RELEASE_TARGETS[targetKey()];

function release(version, body, base) {
  return {
    tag_name: `v${version}${targetKey() === 'darwin-x64' ? '-x64' : ''}`,
    name: `Version ${version}`,
    draft: false,
    prerelease: false,
    body,
    assets: [{ name: spec.asset(version), browser_download_url: `${base}/dl/${spec.asset(version)}` }],
  };
}

test.skip(!spec || process.platform !== 'darwin', 'Update-Pfad nur auf macOS (mac-release)');

test('Update-Dialog zeigt Notes, schliesst per Abbrechen/Esc und installiert nichts', async () => {
  const hits = { releases: 0, downloads: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/repos/keks-maker/streaming-hub/releases')) {
      hits.releases += 1;
      const base = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([
        release('99.0.1', '## Neu\n- Erstes Feature <script>window.__pwned=1</script>\n- **fett**', base),
        release('99.0.2', '## Behoben\n- Zweiter Fix', base),
      ]));
    } else {
      hits.downloads += 1;
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-e2e-update-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData);
  const target = resolveLaunchTarget();
  const app = await electron.launch({
    executablePath: target.executablePath,
    args: launchArgs(target),
    env: { ...process.env, HOME: tmp, STREAMING_HUB_USER_DATA: userData, STREAMING_HUB_UPDATE_URL: `http://127.0.0.1:${server.address().port}` },
    timeout: 45_000,
  });
  try {
    const page = await app.firstWindow();
    const btn = page.locator('#updateBtn');
    await expect(btn).toHaveClass(/update-available/, { timeout: 30_000 });
    const before = hits.releases;
    await btn.click();
    const overlay = page.locator('#updateNotesOverlay');
    await expect(overlay).toBeVisible();
    await expect(page.locator('#updateNotesTitle')).toContainText('99.0.2');
    const text = await page.locator('#updateNotesBody').innerText();
    expect(text.indexOf('99.0.2')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('99.0.2')).toBeLessThan(text.indexOf('99.0.1'));
    expect(text).toContain('<script>window.__pwned=1</script>');
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.locator('#updateNotesBody script').count()).toBe(0);
    if (SCREENSHOT) await page.screenshot({ path: SCREENSHOT });

    await page.locator('#updateNotesCancel').click();
    await expect(overlay).toBeHidden();
    await btn.click();
    await expect(overlay).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(page.locator('#updateOverlay')).not.toHaveClass(/open/);
    expect(hits.releases).toBe(before);
    expect(hits.downloads).toBe(0);
  } finally {
    await app.close().catch(() => {});
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
