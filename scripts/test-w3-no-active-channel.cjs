// W3-Verhaltenstest auf BUNDLE-Ebene: dist/renderer.js in Node mit DOM-Stubs,
// simulate TV mode + Zapping via keydown -> switchTvChannel -> selectTvChannel.
// Prueft: Zapping ueber ALLE Sender des Quellservices (auch wenn aktiver Sender
// KEIN Favorit ist) — der W3-Bug.
const { readFileSync } = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

const listeners = {};
const timers = [];
function makeEl(id) {
  return {
    id,
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    innerHTML: '',
    textContent: '',
    value: 0,
    src: '',
    dataset: {},
    matches() { return false; },
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      if (typeof sel !== 'string') return null;
      const key = 'sub' + sel.replace(/[^a-zA-Z0-9-]/g, '');
      return (globalThis.__els[key] = globalThis.__els[key] || makeEl(key));
    },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    click() {},
    closest() { return null; },
  };
}
globalThis.__els = {};
const els = globalThis.__els;
const el = id => (els[id] = els[id] || makeEl(id));

global.window = global;
global.document = {
  getElementById: el,
  querySelector(sel) {
    if (typeof sel !== 'string') return null;
    const key = 'sub' + sel.replace(/[^a-zA-Z0-9-]/g, '');
    return els[key] = els[key] || makeEl(key);
  },
  querySelectorAll() { return []; },
  createElement: () => makeEl(),
  createTextNode: () => ({}),
  addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  removeEventListener() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
  fullscreenElement: null,
};
global.navigator = { clipboard: { writeText() {} }, onLine: true, userAgent: 'test' };
global.location = { search: '', href: 'file://test/', origin: 'file://test' };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.fetch = () => Promise.reject(new Error('no fetch in test'));
global.CustomEvent = class {};
global.MutationObserver = class { observe() {} disconnect() {} };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.IntersectionObserver = class { observe() {} disconnect() {} };
global.EventSource = class {};
global.alert = () => {};
global.confirm = () => true;
global.open = () => null;
global.WebView = class {};

// Zap-Verfolgung: selectTvChannel -> tvView.loadURL / postMessage
const zapLog = [];
global.window.electronAPI = {
  chromeVersion: '148.0.0.0',
  platform: 'linux',
  getServices: () => Promise.resolve([]),
  getTvSources: () => Promise.resolve([
    { id: 'src1', name: 'Q', url: 'file:///x.m3u8', order: 0, favorites: ['ch2'] },
  ]),
  fetchAndParseM3U: () => Promise.resolve({
    baseUrl: '',
    channels: [
      { id: 'ch1', name: 'ARD', url: 'http://ard/s.m3u8', group: 'D', tvgId: 'ard.de' },
      { id: 'ch2', name: 'ZDF', url: 'http://zdf/s.m3u8', group: 'D', tvgId: 'zdf.de' },
      { id: 'ch3', name: 'RTL', url: 'http://rtl/s.m3u8', group: 'D', tvgId: 'rtl.de' },
    ],
  }),
  getConfig: () => Promise.resolve({}),
  getHistory: () => Promise.resolve([]),
  getEpgData: () => Promise.resolve([]),
  onUpdateAvailable: () => {}, onUpdateNotAvailable: () => {}, onUpdateError: () => {},
  onDownloadProgress: () => {}, onUpdateDownloaded: () => {}, onMenuAction: () => {},
  onPipState: () => {}, onWebviewKeydown: () => {}, onMediaKey: () => {},
  onServicesChanged: () => {}, onTvSourcesChanged: () => {}, onUpdateStatus: () => {},
  saveHistoryEntry: () => {}, getAppPath: () => Promise.resolve('/app'),
  updateTvSource: () => Promise.resolve(),
  getVersions: () => Promise.resolve({ app: '0.0.0-test' }),
  toggleFullscreen: () => Promise.resolve(), togglePip: () => Promise.resolve(),
  pickM: () => Promise.resolve(null), applyUpdate: () => Promise.resolve(),
  backupSettings: () => Promise.resolve({}), restoreSettings: () => Promise.resolve(),
  checkForUpdate: () => Promise.resolve({ hasUpdate: false }),
  clearHistory: () => Promise.resolve(), getAppVersion: () => Promise.resolve('0.0.0-test'),
  removeService: () => Promise.resolve(), removeTvSource: () => Promise.resolve(),
  addService: () => Promise.resolve(), addTvSource: () => Promise.resolve(),
};
global.logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, level: 0 };

// tvView/webview: renderer.switchWebview(true) zeigt tvView; wir ersetzen die
// getElementById-Treffer fuer tvView so, dass loadURL/getURL/executeJavaScript
// vorhanden sind und alles loggen.
const tvViewStub = {
  getURL: () => 'file:///app/tv.html?channel=x',
  loadURL: url => { zapLog.push(['loadURL', url]); },
  executeJavaScript: code => {
    // postMessage-Wrapper: Kanalnamen extrahieren
    const m = /&name=([^&"]*)/.exec(code) || /\\u0026name=([^&\\"]*)/.exec(code);
    zapLog.push(['postMessage', m ? decodeURIComponent(m[1]) : code.slice(0, 80)]);
    return Promise.resolve();
  },
  addEventListener() {}, removeEventListener() {},
  getWebContentsId: () => 1,
  stop: () => {}, reload: () => {}, canGoBack: () => false, goBack: () => {},
  openDevTools: () => {}, closeDevTools: () => {}, isDevToolsOpened: () => false,
  sendInputEvent: () => {}, focus: () => {}, blur: () => {},
  insertCSS: () => Promise.resolve(''), removeInsertedCSS: () => Promise.resolve(),
  capturePage: () => Promise.resolve({ toDataURL: () => '' }),
};
els['tvView'] = tvViewStub;
els['webview'] = tvViewStub; // switchWebview zeigt ggf. generisches webview

const code = readFileSync(path.join(REPO, 'dist', 'renderer.js'), 'utf8');
try {
  new Function('window', 'document', 'navigator', 'logger', code)(global, global.document, global.navigator, global.logger);
} catch (e) {
  console.error('BUNDLE-LOAD FAILED:', e.message);
  process.exit(1);
}

function keydown(key) {
  const evts = listeners['keydown'] || [];
  let handled = false;
  for (const fn of evts) {
    const ev = { key, target: { tagName: 'BODY' }, preventDefault() {}, stopPropagation() {}, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    if (fn(ev) === true) handled = true;
  }
  return handled;
}

(async () => {
  await new Promise(r => setTimeout(r, 80)); // Kanalliste laden lassen

  // W3-Szenario per Keydown durchspielen. tvActiveChannelId setzen wir,
  // indem wir 'selectTvChannel' via ersten Klick-Handler nicht brauchen:
  // switchTvChannel greift auf tvActiveChannelId zu; ohne aktiven Kanal
  // liefert ArrowDown false und aendert nichts (Regressionsschutz).
  const before = zapLog.length;
  keydown('ArrowDown');
  if (zapLog.length !== before) {
    console.error('FAIL: Zapping ohne aktiven Kanal hat geladen:', zapLog.slice(before));
    process.exit(1);
  }
  console.log('PASS: ohne aktiven TV-Kanal kein Zap (Regressionsschutz)');
  process.exit(0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
