'use strict';

// Erzeugt die EPG-Screenshots der README (epg-liste, epg-raster, epg-jetzt-gleich, epg-genre-filter, epg-kanalansicht,
// epg-sendung-detail), den Aufnahme-Dialog (aufnahme-dialog.png) und das GIF der Hover-Vorschau auf einer
// Senderkachel (livetv-hover-vorschau.gif) aus einem isolierten Profil mit erfundenen Daten: Kanal Eins bis Sechs,
// XMLTV-Fixture, Poster/Vorschaubilder als lokal beantwortete SVGs (page.route), Videobild aus einem lokal erzeugten
// HLS-Teststrom (ffmpeg lavfi, Server auf localhost (die E2E-Startargumente sperren IP-Literale)). Kein Netz, keine echten Nutzerdaten.
//
// Aufruf (vorher `npm run build:renderer`): node scripts/readme-screenshots-epg.js [Zielordner]
// Voraussetzung: bin/ffmpeg. Fenster 1280x800 bei Skalierung 2 (PNG 2560x1600, danach `sips -Z 1440 <Datei>`);
// das GIF entsteht bei Skalierung 1 und 800 px Breite. Nur für Doku-Zwecke, scripts/ wird nicht ausgeliefert.

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('@playwright/test');
const { resolveLaunchTarget, launchArgs, backgroundEnv } = require('../e2e/platform');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'assets', 'screenshots'));
const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg');
const MIN = 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const NAMES = ['Kanal Eins', 'Kanal Zwei', 'Kanal Drei', 'Kanal Vier', 'Kanal Fünf', 'Kanal Sechs'];
const COLORS = ['#6c5ce7', '#e0527a', '#2db4c8', '#e8a33c', '#52b86f', '#4a8fe0'];
const SHOWS = [
  ['Musterstadt, Folge 12', 'Serie', 45],
  ['Konzertabend Beispiel', 'Musik', 60],
  ['Abendnachrichten', 'Nachrichten', 30],
  ['Sport Live: Handball', 'Sport', 90],
  ['Reise ins Beispielland', 'Dokumentation', 60],
  ['Das große Ratespiel', 'Show', 75],
  ['Die Testfamilie', 'Serie', 50],
  ['Kleine Entdecker', 'Kinder', 30],
  ['Natur erleben: Wälder', 'Dokumentation', 45],
  ['Magazin Aktuell', 'Nachrichten', 30],
  ['Beispielfilm: Sommerwind', 'Film', 95],
  ['Beispielfilm: Der blaue Koffer', 'Film', 105],
];
const DETAIL = 'Beispielfilm: Der blaue Koffer';

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

function buildEpg(base) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?><tv>'];
  NAMES.forEach((name, i) => out.push(`<channel id="k${i + 1}.example"><display-name>${name}</display-name></channel>`));
  let n = 0;
  NAMES.forEach((_name, i) => {
    let t = base - (35 + i * 9) * MIN;
    for (let k = 0; t < base + 60 * 60 * MIN; k += 1) {
      const [title, genre, minutes] = SHOWS[(k * 5 + i * 3) % SHOWS.length];
      const full = title === DETAIL;
      const extra = full
        ? '<sub-title lang="de">Ein Beispiel-Untertitel</sub-title><credits><director>Anna Beispiel</director><actor>Max Mustermann</actor><actor>Erika Musterfrau</actor><actor>Jan Testmann</actor></credits><date>2021</date><episode-num system="onscreen">S2 E3</episode-num><rating system="FSK"><value>FSK 12</value></rating>'
        : '';
      n += 1;
      out.push(
        `<programme start="${xmltvTime(t)}" stop="${xmltvTime(t + minutes * MIN)}" channel="k${i + 1}.example"><title lang="de">${title}</title>${extra}<desc lang="de">Kurzbeschreibung der Beispielsendung „${title}“. Alle Inhalte sind frei erfundene Testdaten.</desc><category lang="de">${genre}</category><icon src="https://bilder.example/p/${n}.svg"/></programme>`,
      );
      t += minutes * MIN;
    }
  });
  out.push('</tv>');
  return out.join('\n');
}

function posterSvg(n) {
  const hue = (n * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,24%)"/></linearGradient></defs><rect width="160" height="240" fill="url(#g)"/><circle cx="80" cy="120" r="26" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="3"/><path d="M72 106l24 14-24 14z" fill="#fff" fill-opacity=".8"/></svg>`;
}

/** HLS-Teststrom (VOD-Liste, 14 s buntes Muster) und Server mit CORS auf localhost. */
async function startStream(dir) {
  const hls = path.join(dir, 'hls');
  fs.mkdirSync(hls);
  execFileSync(
    FFMPEG,
    ['-v', 'error', '-f', 'lavfi', '-i', 'gradients=s=640x360:r=25:d=14:speed=0.03:n=4', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '25', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod', path.join(hls, 'live.m3u8')],
    { timeout: 120_000 },
  );
  const server = http.createServer((req, res) => {
    const file = path.join(hls, path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://localhost:${server.address().port}/live.m3u8` };
}

async function launch(root, base, streamUrl, scale) {
  const home = path.join(root, 'home');
  const userData = path.join(root, 'ud');
  const logos = path.join(root, 'logos');
  [home, userData, logos].forEach(d => fs.mkdirSync(d, { recursive: true }));
  const channels = NAMES.map((name, i) => {
    const logo = path.join(logos, `${i + 1}.svg`);
    fs.writeFileSync(logo, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="${COLORS[i]}"/><text x="50" y="66" font-family="Helvetica,Arial,sans-serif" font-size="46" font-weight="700" text-anchor="middle" fill="#fff">K${i + 1}</text></svg>`);
    return { id: `k${i + 1}.example`, name, logo: `file://${logo}` };
  });
  const m3u = path.join(root, 'beispiel.m3u');
  fs.writeFileSync(m3u, '#EXTM3U\n' + channels.map(c => `#EXTINF:-1 tvg-id="${c.id}" tvg-logo="${c.logo}" group-title="Allgemein",${c.name}\n${streamUrl}\n`).join(''));
  const epg = path.join(root, 'epg.xml');
  fs.writeFileSync(epg, buildEpg(base));
  fs.writeFileSync(path.join(userData, 'tvsources.json'), JSON.stringify([{ id: 'bsq', name: 'Beispielquelle', url: m3u, type: 'file', color: '#a78bfa', epgUrl: 'https://epg.example/epg.xml', sortOrder: [], favorites: channels.map(c => c.id) }]));
  const target = resolveLaunchTarget();
  const app = await electron.launch({
    executablePath: target.executablePath,
    args: [...launchArgs(target), `--force-device-scale-factor=${scale}`],
    env: { ...process.env, HOME: home, STREAMING_HUB_USER_DATA: userData, ...backgroundEnv(), STREAMING_HUB_EPG_FIXTURE: epg, STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9' },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  if (process.env.DBG) page.on('console', m => console.log('[c]', m.text().slice(0, 200)));
  await page.waitForLoadState('domcontentloaded');
  await page.emulateMedia({ colorScheme: 'dark' }); // README zeigt das dunkle Design
  await page.locator('#dashboardView').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await page.route('https://bilder.example/**', route => {
    const n = Number((route.request().url().match(/(\d+)\.svg/) || [0, 1])[1]);
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: posterSvg(n) });
  });
  for (let i = 0; i < 60; i += 1) {
    const status = await page.evaluate(() => window.electronAPI.getEpgStatus());
    if (status.sources.reduce((n, s) => n + s.channelCount, 0) >= 6) break;
    await sleep(500);
  }
  await sleep(800);
  return { app, page };
}

async function epgShots(root, base, streamUrl) {
  const { app, page } = await launch(root, base, streamUrl, 2);
  const shot = async name => {
    await page.mouse.move(640, 790);
    await sleep(900);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('ok', name);
  };
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await page.locator('#dashboardEpgOpen').click();
  await page.locator('#epgOverlay').waitFor({ state: 'visible' });
  await page.mouse.move(640, 790);
  await page.locator('#epgOverlay[data-state="ready"]').waitFor();
  await page.locator('#epgModeList').click();
  await sleep(600);
  await shot('epg-liste.png');
  await page.locator('#epgModeGrid').click();
  await page.locator('#epgGrid').waitFor({ state: 'visible' });
  await shot('epg-raster.png');
  await page.locator('#epgModeJng').click();
  await page.locator('#epgJng').waitFor({ state: 'visible' });
  await shot('epg-jetzt-gleich.png');
  await page.locator('#epgModeList').click();
  await page.locator('#epgGenre_film').click();
  await sleep(500);
  await shot('epg-genre-filter.png');
  await page.locator('#epgGenreAll').click();
  await sleep(300);
  await page.locator('.epg-list-row', { hasText: DETAIL }).first().locator('.epg-row-open').click();
  await page.locator('#epgDetailBackdrop').waitFor({ state: 'visible' });
  await shot('epg-sendung-detail.png');
  await page.locator('#epgDetailChannelBtn, #epgDetailAllBtn, button:has-text("Alle Sendungen des Senders")').first().click();
  await sleep(900);
  await shot('epg-kanalansicht.png');
  await app.close().catch(() => {});
}

async function recordDialog(root, base, streamUrl) {
  const { app, page } = await launch(root, base, streamUrl, 2);
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await page.locator('#dashboardHub').waitFor({ state: 'visible' });
  await page.locator('.dashboard-tv-tile', { hasText: 'Kanal Eins' }).first().click();
  await sleep(4000);
  const tv = app.windows().find(w => w.url().includes('tv.html'));
  await tv.emulateMedia({ colorScheme: 'dark' });
  await page.mouse.move(640, 740);
  await sleep(300);
  await page.mouse.move(700, 760);
  await sleep(500);
  await tv.locator('#tvRecordBtn').click({ timeout: 8000 }).catch(() => tv.locator('#tvRecordBtn').dispatchEvent('click'));
  await tv.locator('#tvRecStartShow').waitFor({ state: 'visible' });
  await page.mouse.move(1000, 640);
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'aufnahme-dialog.png') });
  console.log('ok aufnahme-dialog.png');
  await app.close().catch(() => {});
}

async function hoverGif(root, base, streamUrl) {
  const { app, page } = await launch(root, base, streamUrl, 1);
  await page.locator('.dashboard-section-tile[data-section="livetv"]').click();
  await page.locator('#dashboardHub').waitFor({ state: 'visible' });
  const tile = page.locator('.dashboard-tv-tile', { hasText: 'Kanal Zwei' }).first();
  await tile.scrollIntoViewIfNeeded();
  await sleep(800);
  if (process.env.DBG) console.log(await page.evaluate(async u => { try { const r = await fetch(u); const t = await r.text(); const seg = t.split('\n').find(l => l.endsWith('.ts')); const r2 = await fetch(new URL(seg, u)); return r.status + ' ' + t.slice(0, 80).replace(/\n/g, '|') + ' seg ' + r2.status + ' ' + r2.headers.get('content-type'); } catch (e) { return 'ERR ' + e.message; } }, streamUrl));
  const box = await tile.boundingBox();
  if (process.env.DBG) await page.evaluate(() => { window.__ev = []; const t = document.querySelectorAll('.dashboard-tv-tile')[1]; for (const e of ['mouseenter', 'mouseleave', 'focus', 'blur']) t.addEventListener(e, () => window.__ev.push(e + '@' + Math.round(performance.now()))); window.__log = []; new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.tagName === 'VIDEO') { window.__log.push('video+'); for (const e of ['error', 'playing', 'loadeddata', 'emptied']) n.addEventListener(e, () => window.__log.push(e + (n.error ? n.error.message : ''))); } }))).observe(t, { childList: true }); });
  const frames = path.join(root, 'frames');
  fs.mkdirSync(frames);
  let count = 0;
  const grab = async () => page.screenshot({ path: path.join(frames, `f${String(count++).padStart(3, '0')}.png`) });
  await page.mouse.move(640, 790);
  const t0 = Date.now();
  for (let i = 0; i < 4; i += 1) await grab();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  while (Date.now() - t0 < 6500) await grab();
  if (process.env.DBG) console.log(await page.evaluate(() => { const v = document.querySelector('.dashboard-tv-preview'); return JSON.stringify({ v: !!v, err: v && v.error && v.error.message, rs: v && v.readyState, cls: document.querySelector('.is-previewing') !== null, hls: typeof Hls, log: window.__log, ev: window.__ev }); }));
  await page.mouse.move(640, 790, { steps: 6 });
  const t1 = Date.now();
  while (Date.now() - t1 < 1200) await grab();
  const fps = (count / ((Date.now() - t0) / 1000)).toFixed(2);
  console.log('frames', count, 'fps', fps);
  const gif = path.join(OUT, 'livetv-hover-vorschau.gif');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-framerate', fps, '-i', path.join(frames, 'f%03d.png'), '-vf', 'scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', gif], { timeout: 120_000 });
  console.log('ok', gif, fs.statSync(gif).size);
  await app.close().catch(() => {});
}

(async () => {
  const mode = process.argv[3] || 'all';
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shsh-epg-')));
  fs.mkdirSync(OUT, { recursive: true });
  const { server, url } = await startStream(root);
  const base = Math.floor(Date.now() / MIN) * MIN;
  try {
    for (const [key, fn] of [['epg', epgShots], ['rec', recordDialog], ['gif', hoverGif]]) {
      if (mode !== 'all' && mode !== key) continue;
      const sub = path.join(root, key);
      fs.mkdirSync(sub);
      await fn(sub, base, url);
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
