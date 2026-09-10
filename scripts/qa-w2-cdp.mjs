// W2-QA per CDP: tv.html direkt in Chromium laden (file:// + Query-Params wie
// der Host es tut) und drei Szenarien pruefen:
//   1. toter Host (invalid.example.test)  -> nach <=30s persistenter Fehlerdialog
//   2. Port ohne Server (127.0.0.1:45999) -> nach <=30s persistenter Fehlerdialog
//   3. echter HLS-Stream (Fixture)        -> kein Fehler, Wiedergabe startet
// Architektur: Page-WS mit Pending-Response-Map (ein Handler), Events via
// Registry. Start: node scripts/qa-w2-cdp.mjs  (QA_ONLY=<label> fuer Einzelszenario)
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const CHROME = process.env.CHROME_BIN;
const TV_HTML = process.env.TV_HTML;
const FIXTURE = 'http://127.0.0.1:45987/live.m3u8';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launchChrome(port) {
  const child = execFile(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--no-sandbox',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank',
  ]);
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.ok) return child;
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP nicht erreichbar');
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.nextId = 0;
    this.ws.on('message', d => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.method + ': ' + JSON.stringify(m.error)));
        else p.resolve(m.result);
      } else if (m.method && this.eventHandlers.has(m.method)) {
        for (const h of this.eventHandlers.get(m.method)) h(m.params);
      }
    });
  }
  open() {
    return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('cdp timeout: ' + method));
        }
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off(method, handler);
        reject(new Error('event timeout: ' + method));
      }, timeoutMs);
      const handler = params => {
        clearTimeout(t);
        this.off(method, handler);
        resolve(params);
      };
      this.on(method, handler);
    });
  }
  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method).add(handler);
  }
  off(method, handler) {
    this.eventHandlers.get(method)?.delete(handler);
  }
  close() { this.ws.close(); }
}

async function runScenario(port, label, channelUrl) {
  const url = 'file://' + TV_HTML +
    '?channel=' + encodeURIComponent(channelUrl) +
    '&name=' + encodeURIComponent('QA-Kanal ' + label) +
    '&logo=&epg=&epgStart=&epgEnd=&epgNext=';
  const res = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' });
  const target = await res.json();
  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  await cdp.open();
  console.log('[' + label + '] ws open');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  console.log('[' + label + '] navigate sent');
  try {
    await cdp.once('Page.loadEventFired', 15000);
    console.log('[' + label + '] loadEventFired');
  } catch {
    console.log('[' + label + '] loadEvent timeout (weiter ohne Event)');
  }
  await sleep(300);

  const t0 = Date.now();
  const result = { label, url: channelUrl, dialogSeen: false, text: '', atMs: -1, playing: false, playingAtMs: -1, pollLog: [] };

  while (Date.now() - t0 < 35000) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const err = document.getElementById('tvError');
        const load = document.getElementById('tvLoading');
        const v = document.querySelector('video');
        return JSON.stringify({
          errVisible: err && err.style.display !== 'none' && getComputedStyle(err).display !== 'none',
          errText: err ? err.textContent : '',
          loadingVisible: load ? load.style.display !== 'none' : false,
          readyState: v ? v.readyState : -1,
          currentTime: v ? v.currentTime : -1,
        });
      })()`,
      returnByValue: true,
    });
    const el = Date.now() - t0;
    if (r.exceptionDetails) {
      result.pollLog.push(el + 'ms EVAL-ERROR ' + JSON.stringify(r.exceptionDetails).slice(0, 150));
      await sleep(1000);
      continue;
    }
    const st = JSON.parse(r.result.value);
    if (st.errVisible && !result.dialogSeen) {
      result.dialogSeen = true;
      result.text = st.errText;
      result.atMs = el;
    }
    if (st.readyState >= 2 && st.currentTime > 0 && !result.playing) {
      result.playing = true;
      result.playingAtMs = el;
    }
    if (result.pollLog.length < 40) {
      result.pollLog.push(el + 'ms rs=' + st.readyState + ' load=' + st.loadingVisible + ' err=' + st.errVisible + ' t=' + Number(st.currentTime).toFixed(1));
    }
    if (result.dialogSeen && result.loadingHiddenAtMs !== 0) {
      // Dialog gesehen -> beim ersten Poll danach abbrechen
      if (result.dialogSeen) break;
    }
    if (result.playing && el > 8000) break;
    await sleep(1000);
  }
  result.elapsedMs = Date.now() - t0;
  cdp.close();
  return result;
}

// ── Szenarien ausfuehren ──────────────────────────────────────
const port = 9223;
const only = process.env.QA_ONLY || null; // z.B. QA_ONLY=W2-dead-host
const chrome = await launchChrome(port);
process.on('exit', () => { try { chrome.kill(); } catch {} });
try {
  const results = [];
  const scenarios = [
    ['W2-dead-host', 'http://invalid.example.test/stream.m3u8'],
    ['W2-conn-refused', 'http://127.0.0.1:45999/live.m3u8'],
    ['W2-live-ok', FIXTURE],
  ];
  for (const [label, url] of scenarios) {
    if (only && label !== only) continue;
    results.push(await runScenario(port, label, url));
  }
  console.log('==== RESULTS ====');
  for (const r of results) {
    console.log(JSON.stringify(r, null, 2));
  }
  let pass;
  if (only) {
    const r = results[0];
    pass = only === 'W2-live-ok'
      ? r.playing && !r.dialogSeen
      : r.dialogSeen && r.atMs <= 30000;
  } else {
    const [dead, refused, ok] = results;
    pass =
      dead.dialogSeen && dead.atMs <= 30000 &&
      refused.dialogSeen && refused.atMs <= 30000 &&
      ok.playing && !ok.dialogSeen;
  }
  console.log('==== VERDICT:', pass ? 'PASS' : 'FAIL', '====');
  process.exitCode = pass ? 0 : 1;
} finally {
  chrome.kill();
}
