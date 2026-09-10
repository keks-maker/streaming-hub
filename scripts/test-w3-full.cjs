// W3-Vollverdrahtungstest: dist/renderer.js in Node, tvActiveChannelId wird
// REAL gesetzt, indem der Click-Handler eines echten Sidebar-Items gefeuert
// wird (renderTvChannels laeuft beim Kanalladen). Dann Zap per ArrowDown/Up
// und Pruefung der ankommenden postMessage-Kanalnamen.
const { readFileSync } = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

const listeners = {};
const clickHandlers = []; // alle an Items haengenden Click-Handler (in Erzeugungsreihenfolge)
function makeEl(id) {
  const handlers = {};
  const e2 = {    id,
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    innerHTML: '',
    textContent: '',
    value: 0,
    src: '',
    dataset: {},
    matches() { return false; },
    appendChild() {},
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener() {},
    __fire(type, ev) { for (const fn of handlers[type] || []) fn(ev); },
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
  return e2;
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
  createElement: () => {
    const e = makeEl();
    const origAdd = e.addEventListener.bind(e);
    e.addEventListener = (type, fn) => {
      if (type === 'click') clickHandlers.push(fn);
      origAdd(type, fn);
    };
    e.querySelector = sel => {
      if (typeof sel !== 'string') return null;
      const key = 'sub' + sel.replace(/[^a-zA-Z0-9-]/g, '');
      return els[key] = els[key] || makeEl(key);
    };
    e.querySelectorAll = () => [];
    return e;
  },
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

const zapLog = [];
let tvViewReadyStub = true; // ist tv.html schon geladen?
const tvViewStub2 = {
  getURL: () => 'file:///app/tv.html?channel=x', // immer tv.html -> postMessage-Pfad
  loadURL: url => { zapLog.push(decodeURIComponent((url.match(/name=([^&]*)/) || [])[1] || url)); },
  executeJavaScript: c => {
    const m = /"name":"((?:[^"\\]|\\.)*)"/.exec(c);
    zapLog.push(m ? JSON.parse('"' + m[1] + '"') : c.slice(0, 50));
    return Promise.resolve();
  },
  addEventListener() {}, removeEventListener() {},
  getWebContentsId: () => 1, stop() {}, reload() {}, canGoBack: () => false, goBack() {},
  openDevTools() {}, closeDevTools() {}, isDevToolsOpened: () => false,
  sendInputEvent() {}, focus() {}, blur() {},
  insertCSS: () => Promise.resolve(''), removeInsertedCSS: () => Promise.resolve(),
  capturePage: () => Promise.resolve({ toDataURL: () => '' }),
};
els['tvView'] = tvViewStub2;
els['webview'] = tvViewStub2;
els['contentView'] = makeEl('contentView');
// tvView muss ein makeEl-Element mit style sein UND die Stub-Methoden tragen:
// did-attach-Handler sofort ausfuehren, damit tvViewReady=true gesetzt wird
// (im echten Electron feuert das Event beim webview-Attach).
const tvViewEl = Object.assign(makeEl('tvView'), tvViewStub2, {
  addEventListener(type, fn) {
    if (type === 'did-attach') { try { fn(); } catch {} }
  },
});
els['tvView'] = tvViewEl;

global.window.electronAPI = {
  chromeVersion: '148.0.0.0', platform: 'linux',
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

const code = readFileSync(path.join(REPO, 'dist', 'renderer.js'), 'utf8');
try {
  new Function('window', 'document', 'navigator', 'logger', code)(global, global.document, global.navigator, global.logger);
} catch (e) {
  console.error('BUNDLE-LOAD FAILED:', e.message);
  process.exit(1);
}

function keydown(key) {
  let handled = false;
  for (const fn of listeners['keydown'] || []) {
    const ev = { key, target: { tagName: 'BODY' }, preventDefault() {}, stopPropagation() {}, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    if (fn(ev) === true) handled = true;
  }
  return handled;
}

(async () => {
  await new Promise(r => setTimeout(r, 120)); // Kanalliste + Render

  if (!clickHandlers.length) {
    console.error('FAIL: keine Click-Handler gefunden (renderTvChannels nicht gelaufen?)');
    process.exit(1);
  }
  // Sidebar-Reihenfolge laut buildZapOrder/Render: Favoriten zuerst => ch2, dann ch1, ch3.
  // Items werden via separateFavorites erzeugt: [ch2] dann regular [ch1, ch3].
  // Click-Handler der Items: Favorites-Items zuerst. Item-Click-Handler sind die,
  // die NICHT via .closest('.tv-channel-drag') abbrechen — wir feuern alle und
  // filtern: selectTvChannel setzt tvActiveChannelId beim ersten echten Item.
  // Wir nehmen an: die ersten drei click-Handler nach Render gehoeren zu
  // ch2, ch1, ch3 (nur Item-Clicks registrieren sich am document createElement
  // Pfad in dieser Reihenfolge).
  // Sidebar-Klick auf ch1 (Index 1 im Render => regular[0]) = NICHT-Favorit:
  const ch1Click = clickHandlers.find(fn => fn.__ch === undefined) // Platzhalter
  // Direkter: Wir feuern alle Click-Handler mit einem Event, dessen target
  // KEIN drag/fav-Element ist — der erste, der selectTvChannel aufruft, gewinnt.
  // Reihenfolge der Handler = Reihenfolge der Items = [ch2(Fav), ch1, ch3].
  // Um ch1 zu aktivieren, feuern wir NUR den zweiten Item-Click-Handler:
  // clickHandlers: [fav-Item ch2, item ch1, item ch3, ...vermutlich weitere]
  // Sicherheit: Wir feuern Handler mit Index 1 (ch1).
  if (clickHandlers.length < 3) {
    console.error('FAIL: zu wenige Click-Handler:', clickHandlers.length);
    process.exit(1);
  }
  const ev = { target: { closest: () => null, tagName: 'DIV' }, stopPropagation() {}, preventDefault() {} };
  zapLog.length = 0;
  // Click-Handler-Reihenfolge: das GERENDERTE Item ruft selectTvChannel im
  // Click-Handler auf — aber nur der Handler am ITEM-Element selbst. Der
  // Gruppe-Header-Handler (toggle collapsed) kommt auch vor Items. Wir feuern
  // jeden Handler isoliert und merken, welcher einen Zap ausloest (Ziel: ch1,
  // das zweite Item der Regular-Gruppe). Strategie: alle Handler der Reihe nach
  // feuern und zapLog zaehlen; der Handler, der zappt, ist das ch2-Item
  // (Favorit, erstes Item). Danach sind Item-Handler bekannt:
  // Wir identifizieren Handler funktional: feuere Handler i; wenn zapLog waechst,
  // war es ein Item-Click. Fuer den W3-Nachweis reicht das Aktivieren von ch1:
  // Item-Reihenfolge im DOM: [ch2 (Fav), ch1, ch3] => die 2. zapppende Funktion
  // ist ch1. Wir merken uns die Indizes der zapppenden Handler.
  const zappingHandlers = [];
  for (let i = 0; i < Math.min(clickHandlers.length, 8); i++) {
    const before = zapLog.length;
    try { clickHandlers[i](ev); } catch { /* Handler ignorieren, die andere Stubs brauchen */ }
    if (zapLog.length > before) zappingHandlers.push(i);
  }
  console.log('zapppende Handler-Indizes:', zappingHandlers, '->', zapLog.map(z => (typeof z === 'string' ? z : '')).filter(Boolean));
  if (zappingHandlers.length < 2) {
    console.error('FAIL: weniger als 2 Item-Click-Handler haben gezappt');
    process.exit(1);
  }
  // ch1 aktivieren: zweites zapppendes Item = ch1 (nach ch2-Favorit)
  zapLog.length = 0;
  clickHandlers[zappingHandlers[1]](ev); // ch1 = NICHT-Favorit
  await new Promise(r => setTimeout(r, 120));
  if (!zapLog.length) {
    console.error('FAIL: Click auf ch1 hat keinen Kanalwechsel ausgeloest');
    process.exit(1);
  }
  const activated = zapLog[0];
  console.log('Aktiviert:', activated);

  // W3-Kernnachweis: Zap ab ch1 (nicht-Favorit), Reihenfolge laut Kanonik
  // [ch2, ch1, ch3] => ArrowDown: ch1 -> ch3, ArrowDown: ch3 -> ch2 (Wrap), ...
  zapLog.length = 0;
  keydown('ArrowDown'); // ch1 -> ch3
  await new Promise(r => setTimeout(r, 40));
  const zap1 = zapLog[0];
  zapLog.length = 0;
  keydown('ArrowDown'); // ch3 -> ch2
  await new Promise(r => setTimeout(r, 40));
  const zap2 = zapLog[0];
  zapLog.length = 0;
  keydown('ArrowDown'); // ch2 -> ch1 (Wrap zurueck in Regular)
  await new Promise(r => setTimeout(r, 40));
  const zap3 = zapLog[0];
  zapLog.length = 0;
  keydown('ArrowUp');   // ch1 -> ch2 (hinter uns in der Order)
  await new Promise(r => setTimeout(r, 40));
  const zap4 = zapLog[0];

  console.log('Zap-Sequenz ab ch1 (nicht-Favorit):', { zap1, zap2, zap3, zap4 });

  // Erwartung: alle Zaps liefern EINEN Kanal (kein stiller Abbruch) und die
  // Sequenz folgt der Kanonik [ch2, ch1, ch3] mit Wrap-around.
  const expected = ['RTL', 'ZDF', 'ARD', 'ZDF'];
  const actual = [zap1, zap2, zap3, zap4].map(z => (z || '').trim());
  const pass = expected.every((e2, i) => actual[i] === e2);
  if (!pass) {
    console.error('FAIL: erwartet', expected, 'bekommen', actual);
    process.exit(1);
  }
  console.log('PASS: W3 – Zapping ab Nicht-Favorit ueber ALLE Sender, Favoriten zuerst, mit Wrap-around');
  process.exit(0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
