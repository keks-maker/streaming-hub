// U1/U2/U3-QA per CDP: tv.html direkt in Electron (Chromium) laden und die
// drei Scrub-Bar-Fixes am echten Player verifizieren:
//   U1: DVR-Kanal  -> genau EIN sichtbarer Balken (Legacy-Bar display:none)
//   U2: Marker sind <= 10 s nach Kanalwechsel/Page-Load sichtbar (sofortiger
//       EPG-Push statt 30s-Poll)
//   U3: Tooltip-Permanenz — Marker-DOM-Identität + sichtbarer Tooltip
//       über 2 s Hover stabil (kein Rebuild-Flicker)
//   (d) Nicht-DVR-Kanal -> unverändert: nur Legacy-Bar, keine DVR-Bar
// Aufbau wie scripts/qa-w2-cdp.mjs: ffmpeg-HLS-Fixtures (live, ohne ENDLIST,
// mit PROGRAM-DATE-TIME), statischer CORS-Fileserver, Electron via xvfb,
// CDP über Remote-Debugging-Port.
// Start: ELECTRON_BIN=... TV_HTML=... node scripts/test-u-scrubbar.cjs
const { execFile, execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// ws liegt nicht im Repo — Hermes-Installation nutzt es mit (gleiche Maschine)
const WebSocket = require('/home/hermes/.hermes/hermes-agent/node_modules/ws');

const ELECTRON = process.env.ELECTRON_BIN;
const TV_HTML = process.env.TV_HTML;
const CDP_PORT = 9224;
const DVR_PORT = 45991; // DVR-Fixture (Fenster >= 900s)
const NONDVR_PORT = 45992; // Nicht-DVR-Fixture (Fenster 120s < 900)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Hilfsformat: UTC-ms -> XMLTV 'YYYYMMDDHHMMSS +0000' ──
function xmltv(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + ' +0000'
  );
}

// ── ffmpeg-HLS-Fixture erzeugen (live-geformt: kein ENDLIST) ──
function makeFixture(dir, seconds, hlsTime, listSize, gop) {
  const args = [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-g', String(gop), '-keyint_min', String(gop),
    '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k',
    '-t', String(seconds),
    '-f', 'hls', '-hls_time', String(hlsTime),
    '-hls_list_size', String(listSize),
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments+program_date_time',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    path.join(dir, 'live.m3u8'),
  ];
  return new Promise((resolve, reject) => {
    const p = execFile('ffmpeg', args, { timeout: 240000 }, err => {
      if (err && !err.killed) return reject(err);
      resolve();
    });
    p.on('error', reject);
  });
}

async function prepareFixtures() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sh-u-fixture-'));
  const dvrDir = path.join(base, 'dvr');
  const nondvrDir = path.join(base, 'nondvr');
  require('node:fs').mkdirSync(dvrDir);
  require('node:fs').mkdirSync(nondvrDir);
  // DVR: 6s-Segmente, Liste 160 -> 960s Fenster (>= DVR_MIN_SEEKABLE 900)
  // 1500s Media -> Playlist behält [540s, 1500s]
  await makeFixture(dvrDir, 1500, 6, 160, 60);
  // Nicht-DVR: 5s-Segmente, Liste 24 -> 120s Fenster (< 900)
  await makeFixture(nondvrDir, 200, 5, 24, 50);
  return { base, dvrDir, nondvrDir };
}

// Erste PROGRAM-DATE-TIME der Playlist (Anker der Media-Zeitachse, wall clock)
function firstPdtMs(dir) {
  const txt = readFileSync(path.join(dir, 'live.m3u8'), 'utf8');
  const m = txt.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/);
  if (!m) throw new Error('keine PROGRAM-DATE-TIME im Fixture');
  return new Date(m[1].trim()).getTime();
}

// ── Statischer Fileserver mit CORS (hls.js lädt per XHR/fetch) ──
function serveDir(dir, port) {
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\/+/, '') || 'live.m3u8';
    const file = path.join(dir, path.basename(name));
    if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ── CDP-Minimalclient (Browser-WS + Target-Sessions, wie qa-w2-cdp.mjs) ──
class CdpRaw {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.pending = new Map();
    this.nextId = 0;
    this.ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(p.method + ': ' + JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    });
  }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 15000);
      this.pending.set(id, { resolve, reject, timer, method });
      const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() { this.ws.close(); }
}

let browserCdp = null;
async function connectBrowser() {
  if (browserCdp) return browserCdp;
  const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
  const v = await res.json();
  browserCdp = new CdpRaw(v.webSocketDebuggerUrl);
  await browserCdp.open();
  return browserCdp;
}

async function launchElectron() {
  // Electron braucht eine App (kein nacktes about:blank wie bei Chrome).
  // Minimaler Harness: unsichtbares Fenster auf about:blank; die tv.html-Seiten
  // werden danach per CDP als eigene Targets erzeugt und navigiert.
  const harnessDir = mkdtempSync(path.join(os.tmpdir(), 'sh-u-electron-'));
  writeFileSync(path.join(harnessDir, 'package.json'), JSON.stringify({ name: 'cdp-harness', main: 'main.js' }));
  writeFileSync(path.join(harnessDir, 'main.js'), [
    "const { app, BrowserWindow } = require('electron');",
    "app.whenReady().then(() => {",
    "  const win = new BrowserWindow({ show: false, width: 1280, height: 720,",
    "    webPreferences: { contextIsolation: false, nodeIntegration: false } });",
    "  win.loadURL('about:blank');",
    "  win.on('closed', () => { });",
    '});',
  ].join('\n'));
  // Electron ist eine GUI-App (kein --headless wie Chrome) → unter Xvfb starten.
  const child = execFile('xvfb-run', [
    '-a', ELECTRON,
    '--remote-debugging-port=' + CDP_PORT,
    '--no-sandbox', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    harnessDir,
  ]);
  let errTail = '';
  child.stderr.on('data', d => { errTail = (errTail + d).slice(-800); });
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
      if (res.ok) return child;
    } catch {}
    await sleep(200);
  }
  child.kill();
  throw new Error('CDP nicht erreichbar (Electron-Boot fehlgeschlagen). stderr: ' + errTail);
}

async function newPage() {
  // Electron-CDP unterstützt kein Target.createTarget ("Not supported") —
  // wir attachen an die existierende Harness-Page (about:blank) und navigieren
  // sie pro Szenario um (Page-Level-WS ist in Electron verfügbar).
  const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('keine page target am Electron');
  const cdp = new CdpRaw(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  return cdp;
}

async function evalJson(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return JSON.parse(r.result.value);
}

// EPG-Update pushen (wie renderer.js pushEpgToTvView es via executeJavaScript tut)
async function pushEpg(cdp, entries, label) {
  await cdp.send('Runtime.evaluate', {
    expression:
      "window.postMessage(" + JSON.stringify({
        type: 'epg-update', epg: label + ' Titel', epgStart: '12:00', epgEnd: '13:00', epgNext: label + ' Next',
        epgEntries: entries,
      }) + ",'*')",
  });
}

async function loadChannel(cdp, channelUrl, name) {
  const url = 'file://' + TV_HTML +
    '?channel=' + encodeURIComponent(channelUrl) +
    '&name=' + encodeURIComponent(name) + '&logo=&epg=&epgStart=&epgEnd=&epgNext=';
  await cdp.send('Page.navigate', { url });
  const t = Date.now();
  while (Date.now() - t < 10000) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'document.readyState + "|" + location.href', returnByValue: true,
      });
      const parts = String(r.result.value).split('|');
      if (parts[0] === 'complete' && parts[1] && parts[1].includes('tv.html')) break;
    } catch { /* Navigation läuft noch */ }
    await sleep(200);
  }
  await sleep(250);
}

// ── Szenario: DVR-Kanal (U1 + U2 + U3) ──
async function scenarioDvr(cdp, channelUrl, pdt0) {
  const t0 = Date.now(); // Messbeginn = Ladebeginn (Äquivalent zum Kanalwechsel)
  await loadChannel(cdp, channelUrl, 'U-DVR-Test');
  // U2: Host-PUSH sofort (im Betrieb: renderer pushEpgToTvView beim Wechsel)
  // EPG im PDT-Zeitraum des Fixtures: B [pdt0+600s..960s], C [pdt0+960s..1320s]
  await pushEpg(cdp, [
    { title: 'U2 Sendung B', start: xmltv(pdt0 + 600 * 1000), stop: xmltv(pdt0 + 960 * 1000) },
    { title: 'U2 Sendung C', start: xmltv(pdt0 + 960 * 1000), stop: xmltv(pdt0 + 1320 * 1000) },
  ], 'DVR');

  // U2: auf erste Marker warten (<= 10s gefordert)
  let markerAtMs = -1, markerCount = 0;
  while (Date.now() - t0 < 12000) {
    const st = await evalJson(cdp, `JSON.stringify({
      dvrBar: document.getElementById('tvScrubBar').classList.contains('visible'),
      markers: document.querySelectorAll('#tvScrubMarkers .tv-scrub-marker').length
    })`);
    if (st.dvrBar && st.markers > 0) { markerAtMs = Date.now() - t0; markerCount = st.markers; break; }
    await sleep(200);
  }

  const out = { markerAtMs, markerCount, u1: {}, u3: {} };

  // U1: genau EIN sichtbarer Balken; Legacy-Bar display:none; html.tv-dvr-mode
  out.u1 = await evalJson(cdp, `(() => {
    const legacy = document.getElementById('tvProgress');
    const scrub = document.getElementById('tvScrubBar');
    const legacyVisible = getComputedStyle(legacy).display !== 'none';
    const dvrVisible = scrub.classList.contains('visible') && getComputedStyle(scrub).display !== 'none';
    return JSON.stringify({
      legacyVisible, dvrVisible,
      visibleBarCount: (legacyVisible ? 1 : 0) + (dvrVisible ? 1 : 0),
      dvrModeClass: document.documentElement.classList.contains('tv-dvr-mode'),
    });
  })()`);

  // U3: Hover auf Marker[1] — Identität + Tooltip über 2 s stabil
  if (markerCount >= 2) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 360 }); // Overlay wecken
    await sleep(400);
    const rect = await evalJson(cdp, `(() => {
      const el = document.querySelectorAll('#tvScrubMarkers .tv-scrub-marker')[1];
      window.__probe = el;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    const mx = Math.round(rect.x), my = Math.round(rect.y);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my });
    await sleep(400); // Tooltip-Transition .15s
    let identityKept = true, tooltipVisible = true, log = [];
    for (let i = 0; i < 8; i++) { // ~2 s Hover
      const s = await evalJson(cdp, `(() => {
        const probe = window.__probe;
        const cur = document.querySelectorAll('#tvScrubMarkers .tv-scrub-marker')[1];
        const tip = probe && probe.firstElementChild;
        return JSON.stringify({
          connected: !!(probe && probe.isConnected),
          same: probe === cur,
          tooltipVisible: !!tip && getComputedStyle(tip).visibility === 'visible',
        });
      })()`);
      if (!s.connected || !s.same) identityKept = false;
      if (!s.tooltipVisible) tooltipVisible = false;
      log.push(i + ':' + (s.connected && s.same ? 'id' : 'LOST') + '/' + (s.tooltipVisible ? 'tip' : 'NOTIP'));
      if (i % 2 === 1) {
        // Mikro-Bewegung innerhalb des Markers (echte Maus bleibt drauf)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx + (i % 4 === 1 ? 2 : -2), y: my });
      }
      await sleep(250);
    }
    out.u3 = { identityKept, tooltipVisible, hoverLog: log.join(' ') };
  }
  return out;
}

// ── Szenario: Nicht-DVR-Kanal (d) ──
async function scenarioNonDvr(cdp, channelUrl, pdt0) {
  await loadChannel(cdp, channelUrl, 'U-NonDVR-Test');
  const t0 = Date.now();
  await pushEpg(cdp, [
    { title: 'NonDVR A', start: xmltv(pdt0 + 60 * 1000), stop: xmltv(pdt0 + 90 * 1000) },
  ], 'ND');
  // auf Wiedergabe warten
  let playingAtMs = -1;
  while (Date.now() - t0 < 20000) {
    const st = await evalJson(cdp, `JSON.stringify({
      rs: document.querySelector('video').readyState, t: document.querySelector('video').currentTime,
      err: document.getElementById('tvError').style.display !== 'none'
    })`);
    if (st.rs >= 2 && st.t > 0 && !st.err) { playingAtMs = Date.now() - t0; break; }
    if (st.err) break;
    await sleep(300);
  }
  return evalJson(cdp, `(() => {
    const legacy = document.getElementById('tvProgress');
    const scrub = document.getElementById('tvScrubBar');
    const legacyVisible = getComputedStyle(legacy).display !== 'none';
    const dvrVisible = scrub.classList.contains('visible') && getComputedStyle(scrub).display !== 'none';
    return JSON.stringify({
      playingAtMs: ${playingAtMs},
      legacyVisible, dvrVisible,
      visibleBarCount: (legacyVisible ? 1 : 0) + (dvrVisible ? 1 : 0),
      dvrModeClass: document.documentElement.classList.contains('tv-dvr-mode'),
      markers: document.querySelectorAll('#tvScrubMarkers .tv-scrub-marker').length,
    });
  })()`);
}

// ── Hauptprogramm ──
(async () => {
const prep = await prepareFixtures();
console.log('fixtures ready:', prep.base);
const pdtDvr = firstPdtMs(prep.dvrDir);
const pdtNd = firstPdtMs(prep.nondvrDir);
console.log('pdt anchors:', new Date(pdtDvr).toISOString(), new Date(pdtNd).toISOString());

const srvDvr = await serveDir(prep.dvrDir, DVR_PORT);
const srvNd = await serveDir(prep.nondvrDir, NONDVR_PORT);

const electron = await launchElectron();
process.on('exit', () => { try { electron.kill(); } catch {} });

function killElectronHard() {
  try { electron.kill('SIGKILL'); } catch {}
  // xvfb-run-Kind (Electron selbst) überlebt electron.kill() womöglich —
  // gezielt über die eindeutige Harness-Dir/Port-Referenz killen.
  try { execFileSync('pkill', ['-9', '-f', 'sh-u-electron-'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('pkill', ['-9', '-f', 'remote-debugging-port=' + CDP_PORT], { stdio: 'ignore' }); } catch {}
}

let verdict = true;
try {
  const cdp = await newPage();
  const dvr = await scenarioDvr(cdp, 'http://127.0.0.1:' + DVR_PORT + '/live.m3u8', pdtDvr);
  console.log('DVR scenario:', JSON.stringify(dvr, null, 2));
  const u2ok = dvr.markerAtMs >= 0 && dvr.markerAtMs <= 10000;
  const u1ok = dvr.u1.dvrVisible && !dvr.u1.legacyVisible && dvr.u1.visibleBarCount === 1 && dvr.u1.dvrModeClass;
  const u3ok = dvr.u3.identityKept && dvr.u3.tooltipVisible;
  if (!u2ok) verdict = false; console.log('U2 (Marker <= 10s):', u2ok ? 'PASS' : 'FAIL', dvr.markerAtMs + 'ms');
  if (!u1ok) verdict = false; console.log('U1 (genau 1 Bar, Legacy aus):', u1ok ? 'PASS' : 'FAIL');
  if (!u3ok) verdict = false; console.log('U3 (Tooltip-Permanenz):', u3ok ? 'PASS' : 'FAIL');

  const nd = await scenarioNonDvr(cdp, 'http://127.0.0.1:' + NONDVR_PORT + '/live.m3u8', pdtNd);
  console.log('NonDVR scenario:', JSON.stringify(nd, null, 2));
  const dOK = nd.playingAtMs > 0 && nd.legacyVisible && !nd.dvrVisible && nd.visibleBarCount === 1 &&
    !nd.dvrModeClass && nd.markers === 0;
  if (!dOK) verdict = false; console.log('(d) Nicht-DVR unverändert:', dOK ? 'PASS' : 'FAIL');
  cdp.close();
} finally {
  killElectronHard();
  srvDvr.close(); srvNd.close();
  try { rmSync(prep.base, { recursive: true, force: true }); } catch {}
}
console.log('==== VERDICT:', verdict ? 'PASS' : 'FAIL', '====');
process.exitCode = verdict ? 0 : 1;
})().catch(e => {
  console.error('E2E-Fehler:', e);
  process.exitCode = 1;
});
