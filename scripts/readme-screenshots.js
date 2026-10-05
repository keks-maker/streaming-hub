'use strict';

// Erzeugt die README-Screenshots (assets/screenshots/*.png, außer den epg-*-Bildern) aus einem isolierten Profil
// mit reinen Beispieldaten: Beispielsender 1-10, EPG-Fixture (STREAMING_HUB_EPG_FIXTURE), eine geplante und drei
// fertige Beispiel-Aufnahmen, vier Verlaufseinträge. Kein Zugriff auf echte Nutzerdaten (userData/HOME liegen unter
// /tmp/shsh; die Pfade erscheinen in den Bildern bewusst neutral).
//
// Aufruf (vorher `npm run build:renderer`; Fenster 1280x800 bei Skalierung 2 ergibt 2560x1600 px wie die bestehenden Bilder):
//   node scripts/readme-screenshots.js [Zielordner]      Standard: assets/screenshots
// Voraussetzung: bin/ffmpeg + bin/ffprobe (für den ffmpeg-Status in den Einstellungen).
// Die Datei ist nur für Doku-Zwecke und wird nicht ausgeliefert-relevant (scripts/ ist vom Lint ausgenommen).

const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('@playwright/test');
const { resolveLaunchTarget, launchArgs } = require('../e2e/platform');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'assets', 'screenshots'));
const ROOT = '/tmp/shsh';
const HOME = path.join(ROOT, 'home');
const USER_DATA = path.join(ROOT, 'ud');
const LOGOS = '/tmp/l';
const MIN = 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const COLORS = ['#6c5ce7', '#e0527a', '#2db4c8', '#e8a33c', '#52b86f', '#a46fdc', '#4a8fe0', '#d8704a', '#5fb0a0', '#9a8fe8'];
const EPG_TITLES = [
  ['Kurzfilm der Woche', 55, 95],
  ['Krimi-Reihe: Folge 3', 70, 40],
  ['Quiz am Abend', 90, 25],
  ['Natur erleben', 45, 55],
  ['Quiz am Abend', 5, 85],
  ['Konzertabend', 80, 20],
];

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

function prepare(base) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(LOGOS, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(LOGOS, { recursive: true });
  const channels = [];
  for (let i = 1; i <= 10; i += 1) {
    fs.writeFileSync(
      path.join(LOGOS, `${i}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="${COLORS[i - 1]}"/><text x="50" y="66" font-family="Helvetica,Arial,sans-serif" font-size="46" font-weight="700" text-anchor="middle" fill="#fff">B${i}</text></svg>`,
    );
    channels.push({ id: `bs${i}.example`, name: `Beispielsender ${i}`, logo: `file://${LOGOS}/${i}.svg` });
  }
  const m3u = path.join(ROOT, 'beispiel.m3u');
  fs.writeFileSync(m3u, '#EXTM3U\n' + channels.map(c => `#EXTINF:-1 tvg-id="${c.id}" tvg-logo="${c.logo}" group-title="Allgemein",${c.name}\nhttp://streams.invalid/${c.id}.m3u8\n`).join(''));
  const programmes = [];
  EPG_TITLES.forEach(([title, startedMin, restMin], i) => {
    const id = `bs${i + 1}.example`;
    programmes.push(`<programme start="${xmltvTime(base - startedMin * MIN)}" stop="${xmltvTime(base + restMin * MIN)}" channel="${id}"><title>${title}</title><desc>Beispielbeschreibung zu ${title}.</desc></programme>`);
    programmes.push(`<programme start="${xmltvTime(base + (restMin + 60 * (i + 1)) * MIN)}" stop="${xmltvTime(base + (restMin + 60 * (i + 1) + 60) * MIN)}" channel="${id}"><title>Abendprogramm ${i + 1}</title><desc>Beispielbeschreibung.</desc></programme>`);
  });
  const epg = path.join(ROOT, 'epg.xml');
  fs.writeFileSync(epg, `<?xml version="1.0" encoding="UTF-8"?><tv>${channels.slice(0, 6).map(c => `<channel id="${c.id}"><display-name>${c.name}</display-name></channel>`).join('')}${programmes.join('')}</tv>`);
  fs.writeFileSync(
    path.join(USER_DATA, 'tvsources.json'),
    JSON.stringify([{ id: 'bsq', name: 'Beispielquelle', url: m3u, type: 'file', color: '#a78bfa', epgUrl: 'https://epg.example/epg.xml', sortOrder: [], favorites: channels.slice(0, 6).map(c => c.id) }]),
  );
  // Fertige Beispiel-Aufnahmen (Meta-Dateien + Index; keine echten Mediendateien)
  const lib = path.join(HOME, 'Videos', 'Streaming Hub', 'Aufnahmen');
  const recs = [
    ['rec_20261003_a', 'Beispielsender 1', 'bs1.example', 'Magazin am Abend', 3, 45 * 60],
    ['rec_20261002_b', 'Beispielsender 2', 'bs2.example', 'Dokumentation: Küstenlandschaften', 2, 60 * 60],
    ['rec_20261001_c', 'Beispielsender 1', 'bs1.example', 'Wochenrückblick', 1, 75 * 60],
  ].map(([id, channelName, channelId, epgTitle, day, durationSec]) => {
    const start = new Date(2026, 9, day, 22, 22, 0);
    return { id, channelId, channelName, epgTitle, epgDescription: null, startedAt: start.toISOString(), stoppedAt: new Date(start.getTime() + durationSec * 1000).toISOString(), durationSec, fileSizeBytes: null, sourceUrl: 'http://streams.invalid/x.m3u8', status: 'completed', outputFile: null, lastError: null };
  });
  fs.mkdirSync(lib, { recursive: true });
  recs.forEach(r => {
    fs.mkdirSync(path.join(lib, r.id), { recursive: true });
    fs.writeFileSync(path.join(lib, r.id, `${r.id}.recording.json`), JSON.stringify(r, null, 2));
  });
  fs.writeFileSync(path.join(lib, 'recordings.json'), JSON.stringify(recs, null, 2));
  return epg;
}

(async () => {
  const base = Math.floor(Date.now() / MIN) * MIN;
  const epg = prepare(base);
  fs.mkdirSync(OUT, { recursive: true });
  const target = resolveLaunchTarget();
  const app = await electron.launch({
    executablePath: target.executablePath,
    args: [...launchArgs(target), '--force-device-scale-factor=2'],
    env: { ...process.env, HOME, STREAMING_HUB_USER_DATA: USER_DATA, STREAMING_HUB_EPG_FIXTURE: epg, STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9' },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await sleep(800);

  // EPG-Cache abwarten, eine Beispiel-Planung anlegen
  for (let i = 0; i < 60; i += 1) {
    const status = await page.evaluate(() => window.electronAPI.getEpgStatus());
    if (status.sources.reduce((n, s) => n + s.channelCount, 0) >= 6) break;
    await sleep(500);
  }
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await page.evaluate(
    r => window.electronAPI.addSchedule(r),
    { channelId: 'bs1.example', channelName: 'Beispielsender 1', tvgId: 'bs1.example', sourceId: 'bsq', title: 'Abendprogramm 1', epgStart: iso(base + 155 * MIN), epgStop: iso(base + 215 * MIN) },
  );
  for (const entry of [
    { title: 'TV: Dokukanal', serviceKey: '__tv__', serviceName: 'Beispielsender 4' },
    { title: 'Beispielfilm: Die lange Reise', serviceKey: 'netflix', serviceName: 'Netflix' },
    { title: 'Beispiel-Dokumentation: Küstenlandschaften', serviceKey: 'youtube', serviceName: 'YouTube' },
    { title: 'TV: Beispielsender 2', serviceKey: '__tv__', serviceName: 'Beispielsender 2' },
  ]) {
    await page.evaluate(e => window.electronAPI.saveHistoryEntry(e), entry);
    await sleep(50);
  }
  await sleep(1500);

  const park = () => page.mouse.move(640, 760);
  const shot = async name => {
    await park();
    await sleep(700);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('ok', name);
  };
  const nav = key => page.locator(`#overlayNav [data-section="${key}"]`);

  await shot('startseite.png');
  await page.locator('.dashboard-section-tile[data-section="streaming"]').click();
  await page.locator('#dashboardTitle').filter({ hasText: 'Streaming' }).waitFor();
  await shot('navbar.png');
  await nav('livetv').click();
  await page.locator('#dashboardHub').waitFor({ state: 'visible' });
  await page.locator('.hub-card-recordings .hub-card-status', { hasText: 'geplant' }).waitFor();
  await sleep(1500);
  await shot('livetv-dashboard.png');

  await page.locator('#dashboardRecordingsOpen').click();
  await page.locator('#dashboardTitle').filter({ hasText: 'Aufnahmen' }).waitFor();
  await sleep(800);
  await shot('aufnahmen-dashboard.png');

  await nav('settings').click();
  await page.locator('#settingsNav').waitFor();
  const group = page.locator('#settingsNav .settings-nav-group');
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await page.locator('#settingsTab-livetv-channels').click();
  await page.locator('#settingsTvChannelsList').waitFor();
  await sleep(600);
  await shot('settings.png');
  await page.locator('#settingsTvChannelsList').getByRole('button', { name: 'Bearbeiten' }).first().click();
  await sleep(600);
  await shot('tv-senderverwaltung.png');
  await page.locator('#settingsTab-livetv-recordings').click();
  await sleep(1500);
  await shot('einstellungen-aufnahmen.png');

  await nav('livetv').click();
  await sleep(500);
  await page.keyboard.press('Control+h');
  await page.locator('.history-entry').first().waitFor();
  await sleep(600);
  await shot('verlauf.png');

  await app.close().catch(() => {});
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(LOGOS, { recursive: true, force: true });
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
