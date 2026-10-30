'use strict';

// E2E: YouTube-Wiedergabefortschritt (ohne Netz, Fenster im Hintergrund, eigenes userData). Die Streaming-Partition liefert für
// youtube.com eine Testseite mit einem Fake-<video>; das echte Fortschritts-Skript (Preload → Main) meldet, die Datei
// youtube-progress.json entsteht im iPad-Format, und eine gespeicherte Position wird beim Öffnen gesetzt.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backgroundEnv, resolveLaunchTarget, launchArgs } = require('./platform');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';

let tmpRoot;
let userData;
let electronApp;
let page;

const STUB = id => `<!doctype html><html><body><script>
  var v = document.createElement('video');
  var t = 0, sets = [];
  Object.defineProperty(v, 'duration', { get: function () { return 300; } });
  Object.defineProperty(v, 'readyState', { get: function () { return 4; } });
  Object.defineProperty(v, 'currentTime', { get: function () { return t; }, set: function (x) { sets.push(x); t = x; } });
  window.__sets = sets;
  document.body.appendChild(v);
  window.__fire = function (pos, type) { if (pos !== null) { t = pos; } v.dispatchEvent(new Event(type, { bubbles: true })); };
  setTimeout(function () { v.dispatchEvent(new Event('loadedmetadata', { bubbles: true })); }, 300);
</script><title>${id}</title></body></html>`;

async function start() {
  const target = resolveLaunchTarget();
  electronApp = await electron.launch({
    executablePath: target.executablePath,
    args: launchArgs(target),
    env: { ...process.env, HOME: path.join(tmpRoot, 'home'), STREAMING_HUB_USER_DATA: userData, ...backgroundEnv(), STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9' },
    timeout: 45_000,
  });
  const actual = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  if (fs.realpathSync(actual) !== userData) {
    await electronApp.close().catch(() => {});
    throw new Error(`userData nicht isoliert: ${actual}`);
  }
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
  // youtube.com aus der Testseite bedienen (kein Netz)
  await electronApp.evaluate(({ session }, stubSource) => {
    const make = new Function(`return (${stubSource})`)();
    session.fromPartition('persist:streaming').protocol.handle('https', request => {
      const u = new URL(request.url);
      const id = u.searchParams.get('v') || '';
      return new Response(make(id), { headers: { 'content-type': 'text/html' } });
    });
  }, STUB.toString());
}

async function stop() {
  if (!electronApp) return;
  const proc = electronApp.process();
  await Promise.race([electronApp.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  electronApp = null;
}

const progressFile = () => path.join(userData, 'youtube-progress.json');
const guest = fnSource => page.evaluate(src => document.getElementById('contentView').executeJavaScript(src).catch(() => ''), fnSource);
async function load(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  await expect
    .poll(async () => {
      await page.evaluate(u => document.getElementById('contentView').loadURL(u).catch(() => {}), url);
      return guest('location.href');
    }, { timeout: 20_000 })
    .toBe(url);
}

test.beforeAll(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-ytprogress-')));
  userData = path.join(tmpRoot, 'userData');
  fs.mkdirSync(userData);
  fs.mkdirSync(path.join(tmpRoot, 'home'));
  fs.writeFileSync(progressFile(), JSON.stringify([{ id: B, position: 100, duration: 300, updated: 1766000000 }]));
});

test.afterAll(async () => {
  await stop();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Meldung der Seite landet im iPad-Format in youtube-progress.json; gespeicherte Position wird beim Öffnen gesetzt', async () => {
  await start();
  await load(A);
  await expect.poll(() => guest('typeof window.__shProgress'), { timeout: 15_000 }).toBe('boolean');
  await page.waitForTimeout(600); // loadedmetadata der Testseite
  await guest(`window.__fire(42.5, 'pause')`);
  await expect.poll(() => (fs.existsSync(progressFile()) ? JSON.parse(fs.readFileSync(progressFile(), 'utf8')).length : 0), { timeout: 10_000 }).toBe(2);
  const list = JSON.parse(fs.readFileSync(progressFile(), 'utf8'));
  expect(Array.isArray(list)).toBe(true);
  const entry = list.find(e => e.id === A);
  expect(entry).toMatchObject({ id: A, position: 42.5, duration: 300 });
  expect(Object.keys(entry).sort()).toEqual(['duration', 'id', 'position', 'updated']);
  expect(entry.updated).toBeLessThan(1e11);

  await load(B);
  await expect.poll(() => guest('JSON.stringify(window.__sets)'), { timeout: 15_000 }).toBe('[100]');
});
