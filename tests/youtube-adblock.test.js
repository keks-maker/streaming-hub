'use strict';

// Tests: YouTube-Werbeblocker — Host-Erkennung, URL-Muster, Netzsperre (nur YouTube-Seiten, nur bei aktivem
// Schalter), Einstellungs-Normalisierung, IPC-Validierung/-Handler, Main-World-Hook (Preload) und Verdrahtung.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ab = require('../lib/youtube-adblock.js');
const { validateYoutubeAdblockPatch } = require('../lib/ipc-validation.js');
const { registerYoutubeAdblock } = require('../lib/youtube-adblock-ipc.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Host-Erkennung: youtube.com, Subdomains, youtube-nocookie.com; nichts Ähnliches', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com', 'YouTube.com', 'www.youtube.com.']) {
    assert.equal(ab.isYouTubeHost(host), true, host);
  }
  for (const host of ['notyoutube.com', 'youtube.com.evil.example', 'evil-youtube.com', 'netflix.com', 'doubleclick.net', '', null, undefined, 5]) {
    assert.equal(ab.isYouTubeHost(host), false, String(host));
  }
  assert.equal(ab.isYouTubePageUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(ab.isYouTubePageUrl('https://www.youtube-nocookie.com/embed/abc'), true);
  assert.equal(ab.isYouTubePageUrl('https://www.netflix.com/browse'), false);
  assert.equal(ab.isYouTubePageUrl('https://evil.example/?u=https://www.youtube.com/'), false);
  assert.equal(ab.isYouTubePageUrl('file:///tmp/www.youtube.com'), false);
  assert.equal(ab.isYouTubePageUrl(''), false);
  assert.equal(ab.isYouTubePageUrl('kein url'), false);
});

test('URL-Muster: alle acht mytube-Muster treffen, Normalfälle nicht', () => {
  const ads = [
    'https://securepubads.g.doubleclick.net/gampad/ads?x=1',
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://www.googleadservices.com/pagead/conversion/1/',
    'https://www.google-analytics.com/collect?v=1',
    'https://www.youtube.com/api/stats/ads?ver=2',
    'https://www.youtube.com/pagead/adview?ai=1',
    'https://www.youtube.com/ptracking?pltype=adhost',
    'https://www.youtube.com/get_midroll_info?video_id=x',
    'https://m.youtube.com/pagead/interaction/',
  ];
  for (const url of ads) assert.equal(ab.isAdRequestUrl(url), true, url);
  const fine = [
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/youtubei/v1/player?key=1',
    'https://rr3---sn-x.googlevideo.com/videoplayback?x=1',
    'https://www.youtube.com/api/stats/playback?x=1',
    'https://www.netflix.com/pagead/',
    'https://evil.example/doubleclick.net/x',
    'https://notdoubleclick.net/x',
    'https://license.widevine.com/cenc/getlicense',
    'ftp://www.youtube.com/pagead/',
    '',
    null,
  ];
  for (const url of fine) assert.equal(ab.isAdRequestUrl(url), false, String(url));
  assert.equal(ab.REQUEST_URL_FILTERS.length, 8);
});

test('Netzsperre: nur bei aktivem Schalter UND YouTube-Seite', () => {
  const adUrl = 'https://securepubads.g.doubleclick.net/gampad/ads';
  const yt = 'https://www.youtube.com/watch?v=abc';
  assert.equal(ab.shouldBlockRequest({ url: adUrl, pageUrl: yt, enabled: true }), true);
  assert.equal(ab.shouldBlockRequest({ url: adUrl, pageUrl: yt, enabled: false }), false);
  assert.equal(ab.shouldBlockRequest({ url: adUrl, pageUrl: yt }), false);
  assert.equal(ab.shouldBlockRequest({ url: adUrl, pageUrl: yt, enabled: 'true' }), false);
  // andere Dienste nie, auch bei Treffer der Muster
  for (const page of ['https://www.netflix.com/browse', 'https://www.disneyplus.com/', 'file:///x/tv.html', '', undefined]) {
    assert.equal(ab.shouldBlockRequest({ url: adUrl, pageUrl: page, enabled: true }), false, String(page));
  }
  // YouTube-Seite, aber normale Anfrage
  assert.equal(ab.shouldBlockRequest({ url: 'https://www.youtube.com/youtubei/v1/player', pageUrl: yt, enabled: true }), false);
});

test('Einstellungen: Standard an, Normalisierung', () => {
  assert.equal(ab.DEFAULT_ENABLED, true);
  assert.deepEqual(ab.normalizeYoutubeAdblockSettings(null), { enabled: true });
  assert.deepEqual(ab.normalizeYoutubeAdblockSettings({}), { enabled: true });
  assert.deepEqual(ab.normalizeYoutubeAdblockSettings({ enabled: false }), { enabled: false });
  assert.deepEqual(ab.normalizeYoutubeAdblockSettings({ enabled: 'nein' }), { enabled: true });
  assert.deepEqual(ab.normalizeYoutubeAdblockSettings([]), { enabled: true });
  assert.deepEqual(ab.normalizeYoutubeAdblockSettings({ enabled: false, extra: 1 }), { enabled: false });
});

test('IPC-Validierung: genau { enabled: boolean }', () => {
  assert.deepEqual(validateYoutubeAdblockPatch({ enabled: false }), { enabled: false });
  assert.deepEqual(validateYoutubeAdblockPatch({ enabled: true }), { enabled: true });
  for (const bad of [null, undefined, 'x', [], {}, { enabled: 1 }, { enabled: 'true' }, { enabled: true, x: 1 }, { x: true }]) {
    assert.throws(() => validateYoutubeAdblockPatch(bad), /Werbeblocker/, JSON.stringify(bad));
  }
});

function fakeMain({ stored = null, mainSender = {} } = {}) {
  const handles = new Map();
  const ons = new Map();
  let filter = null;
  let handler = null;
  let writes = [];
  const ipcMain = { handle: (c, f) => handles.set(c, f), on: (c, f) => ons.set(c, f) };
  const ses = { webRequest: { onBeforeRequest: (f, h) => ((filter = f), (handler = h)) } };
  const session = {
    fromPartition: name => {
      assert.equal(name, 'persist:streaming');
      return ses;
    },
  };
  const storage = { readJson: () => stored, writeJson: (k, v) => writes.push([k, v]) };
  const requireMainRenderer = e => {
    if (e.sender !== mainSender) throw new Error('nicht autorisiert');
  };
  registerYoutubeAdblock({ ipcMain, session, storage, requireMainRenderer });
  const request = (url, pageUrl, hasContents = true) => {
    let result;
    handler({ url, webContents: hasContents ? { getURL: () => pageUrl, isDestroyed: () => false } : null }, r => (result = r));
    return result;
  };
  return { ses, handles, ons, request, getFilter: () => filter, writes: () => writes, mainSender };
}

test('Main: Netzsperre wirkt sofort beim Umschalten, nur auf YouTube-Seiten', async () => {
  const m = fakeMain();
  assert.equal(m.getFilter().urls.length, 8);
  const ad = 'https://www.youtube.com/pagead/adview';
  const yt = 'https://www.youtube.com/watch?v=1';
  assert.deepEqual(m.request(ad, yt), { cancel: true });
  assert.deepEqual(m.request(ad, 'https://www.netflix.com/'), {});
  assert.deepEqual(m.request(ad, yt, false), {});
  assert.deepEqual(m.request('https://www.youtube.com/watch', yt), {});
  const res = await m.handles.get('youtube-adblock:set-settings')({ sender: m.mainSender }, { enabled: false });
  assert.deepEqual(res, { enabled: false });
  assert.deepEqual(m.writes(), [['youtubeAdblockSettings', { enabled: false }]]);
  assert.deepEqual(m.request(ad, yt), {});
  await m.handles.get('youtube-adblock:set-settings')({ sender: m.mainSender }, { enabled: true });
  assert.deepEqual(m.request(ad, yt), { cancel: true });
});

test('Main: gespeicherter Zustand, Absicherung der Kanäle, Preload-Zustand', async () => {
  const m = fakeMain({ stored: { enabled: false } });
  assert.deepEqual(await m.handles.get('youtube-adblock:get-settings')({ sender: m.mainSender }), { enabled: false });
  await assert.rejects(async () => m.handles.get('youtube-adblock:get-settings')({ sender: {} }), /nicht autorisiert/);
  await assert.rejects(async () => m.handles.get('youtube-adblock:set-settings')({ sender: {} }, { enabled: true }), /nicht autorisiert/);
  await assert.rejects(async () => m.handles.get('youtube-adblock:set-settings')({ sender: m.mainSender }, { enabled: 'x' }), /Werbeblocker/);
  assert.deepEqual(m.writes(), []);

  const state = url => {
    const event = { senderFrame: { url }, sender: { getURL: () => url, session: m.ses } };
    m.ons.get('youtube-adblock:page-state')(event);
    return event.returnValue;
  };
  assert.deepEqual(state('https://www.youtube.com/'), { active: false, css: '' }); // Schalter aus
  await m.handles.get('youtube-adblock:set-settings')({ sender: m.mainSender }, { enabled: true });
  const on = state('https://www.youtube.com/watch?v=1');
  assert.equal(on.active, true);
  assert.match(on.css, /ytd-ad-slot-renderer/);
  assert.match(on.css, /ytm-promoted-video-renderer/);
  assert.deepEqual(state('https://www.netflix.com/'), { active: false, css: '' });
  assert.deepEqual(state('file:///x/index.html'), { active: false, css: '' });
  // Andere Partition (persist:tv): nie aktiv, auch nicht auf YouTube
  const tv = { senderFrame: { url: 'https://www.youtube.com/' }, sender: { getURL: () => 'https://www.youtube.com/', session: {} } };
  m.ons.get('youtube-adblock:page-state')(tv);
  assert.deepEqual(tv.returnValue, { active: false, css: '' });
});

// ── Main-World-Hook (preload-content.js) ──

function loadPreload({ adblockState }) {
  const calls = { insertCss: [], executed: [], sync: [] };
  const electron = {
    ipcRenderer: {
      sendSync: channel => (calls.sync.push(channel), adblockState),
      send() {},
      on() {},
    },
    contextBridge: { executeInMainWorld: opts => calls.executed.push(opts) },
    webFrame: { insertCSS: css => calls.insertCss.push(css) },
  };
  const noop = () => {};
  const documentStub = {
    documentElement: { appendChild: noop },
    addEventListener: noop,
    createElement: () => ({}),
  };
  const sandbox = {
    require: name => {
      assert.equal(name, 'electron');
      return electron;
    },
    document: documentStub,
    window: { addEventListener: noop, dispatchEvent: noop },
    location: { pathname: '/', hostname: 'www.youtube.com' },
    process: { platform: 'darwin' },
    CustomEvent: function () {},
  };
  vm.runInNewContext(read('preload-content.js'), sandbox);
  return calls;
}

test('Preload: Hook nur bei aktivem Zustand, synchron beim Start, CSS per webFrame.insertCSS', () => {
  const off = loadPreload({ adblockState: { active: false, css: '' } });
  // zweite Abfrage: Mini-Player (lib/youtube-mini-ipc.js); ohne Skript im Zustand passiert dort nichts
  assert.deepEqual(off.sync, ['youtube-adblock:page-state', 'youtube-mini:page-state']);
  assert.equal(off.executed.length, 0);
  assert.equal(off.insertCss.length, 0);
  const none = loadPreload({ adblockState: undefined });
  assert.equal(none.executed.length, 0);
  const on = loadPreload({ adblockState: { active: true, css: '.x{display:none}' } });
  assert.equal(on.executed.length, 1);
  assert.equal(typeof on.executed[0].func, 'function');
  assert.deepEqual(on.insertCss, ['.x{display:none}']);
});

test('Main-World-Hook: entfernt Werbe-Schlüssel aus JSON.parse, Response.json und ytInitialPlayerResponse', async () => {
  const on = loadPreload({ adblockState: { active: true, css: '' } });
  const intervals = [];
  const clicks = [];
  const video = { duration: 100, currentTime: 0 };
  const win = {};
  const doc = {
    querySelector: sel => (sel === 'video' ? video : sel.includes('.ad-showing') ? {} : null),
    querySelectorAll: () => [{ click: () => clicks.push(1) }],
  };
  class FakeResponse {
    json() {
      return Promise.resolve({ adPlacements: [1], playerAds: [2], adSlots: [3], keep: 1, playerResponse: { adSlots: [1], ok: true } });
    }
  }
  const ctx = vm.createContext({ window: win, document: doc, Response: FakeResponse, setInterval: (f, ms) => intervals.push([f, ms]), isFinite });
  vm.runInContext(`(${on.executed[0].func.toString()})()`, ctx);
  ctx.JSON = vm.runInContext('JSON', ctx);

  const parsed = ctx.JSON.parse('{"adPlacements":[1],"adSlots":[],"title":"t","playerResponse":{"playerAds":[1],"x":2}}');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { title: 't', playerResponse: { x: 2 } });
  const viaFetch = await new FakeResponse().json();
  assert.deepEqual(JSON.parse(JSON.stringify(viaFetch)), { keep: 1, playerResponse: { ok: true } });
  win.ytInitialPlayerResponse = { adPlacements: [1], videoDetails: { id: 1 } };
  assert.deepEqual(JSON.parse(JSON.stringify(win.ytInitialPlayerResponse)), { videoDetails: { id: 1 } });
  assert.equal(ctx.JSON.parse('[1,2]').length, 2);
  assert.equal(ctx.JSON.parse('5'), 5);
  assert.equal(ctx.JSON.parse('null'), null);

  // Skip-Fallback im 400-ms-Takt
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0][1], 400);
  intervals[0][0]();
  assert.equal(video.currentTime, 100);
  assert.equal(clicks.length, 1);
  // zweiter Aufruf installiert nichts doppelt
  vm.runInContext(`(${on.executed[0].func.toString()})()`, ctx);
  assert.equal(intervals.length, 1);
});

test('Verdrahtung: Einstellung, Preload-API, Streaming-Seite', () => {
  assert.match(read('lib/user-storage.js'), /youtubeAdblockSettings: 'youtube-adblock-settings\.json'/);
  assert.match(read('main.js'), /registerYoutubeAdblock\(\{ ipcMain, session, storage: userStorage, requireMainRenderer, logger \}\)/);
  const preload = read('preload.js');
  assert.match(preload, /getYoutubeAdblock: \(\) => ipcRenderer\.invoke\('youtube-adblock:get-settings'\)/);
  assert.match(preload, /setYoutubeAdblock: patch => ipcRenderer\.invoke\('youtube-adblock:set-settings', patch\)/);
  const html = read('index.html');
  const streaming = html.slice(html.indexOf('data-settings-page="streaming"'), html.indexOf('data-settings-page="mediathek-sources"'));
  assert.match(streaming, /id="settingsYoutubeAdblock" type="checkbox" checked/);
  assert.match(read('renderer.js'), /setYoutubeAdblock\(\{ enabled: settingsYoutubeAdblock\.checked \}\)/);
});

test('Main-World-Hook: entfernt Werbe-Kacheln aus Feed-Antworten, Rest und Guide bleiben', () => {
  const on = loadPreload({ adblockState: { active: true, css: '' } });
  const win = {};
  const ctx = vm.createContext({ window: win, document: { querySelector: () => null, querySelectorAll: () => [] }, Response: class {}, setInterval() {}, isFinite });
  vm.runInContext(`(${on.executed[0].func.toString()})()`, ctx);
  const ctxJson = vm.runInContext('JSON', ctx); // Context-eigenes, gehooktes JSON
  const video = id => ({ richItemRenderer: { content: { videoRenderer: { videoId: id } } } });
  const feed = {
    responseContext: {},
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [
      { richItemRenderer: { content: { adSlotRenderer: { x: 1 } } } },
      video('a'),
      { richSectionRenderer: { content: { adSlotRenderer: {} } } },
      { richSectionRenderer: { content: { richShelfRenderer: { title: 'Shorts' } } } },
      { adSlotRenderer: {} },
      video('b'),
      { continuationItemRenderer: {} },
    ] } } } }] } },
  };
  const parsed = JSON.parse(JSON.stringify(ctxJson.parse(JSON.stringify(feed))));
  const items = parsed.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents;
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(i => Object.keys(i)[0]), ['richItemRenderer', 'richSectionRenderer', 'richItemRenderer', 'continuationItemRenderer']);
  assert.equal(items[0].richItemRenderer.content.videoRenderer.videoId, 'a');

  // Fortsetzungen und ytInitialData
  const cont = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [video('c'), { richItemRenderer: { content: { adSlotRenderer: {} } } }] } }] };
  const c2 = JSON.parse(JSON.stringify(ctxJson.parse(JSON.stringify(cont))));
  assert.equal(c2.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems.length, 1);
  const hostJsonParse = JSON.parse;
  const rawFeed = JSON.parse(JSON.stringify(feed)); // Host-JSON, ungehookt (siehe Assertion unten)
  assert.equal(JSON.stringify(rawFeed).includes('adSlotRenderer'), true); // Eingabe enthält Werbung
  win.ytInitialData = rawFeed; // unbereinigt: nur der Setter darf filtern
  assert.equal(JSON.stringify(win.ytInitialData).includes('adSlotRenderer'), false);
  assert.equal(JSON.stringify(win.ytInitialData).includes('"videoId":"a"'), true);
  assert.equal(JSON.parse, hostJsonParse); // Host-JSON bleibt ungehookt

  // itemSectionRenderer: nur reine Werbe-Listen fallen, normale Videos bleiben
  const sections = { responseContext: {}, contents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [{ adSlotRenderer: {} }] } },
    { itemSectionRenderer: { contents: [{ videoRenderer: { videoId: 'v' } }] } },
    { itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, { videoRenderer: { videoId: 'w' } }] } },
    { richSectionRenderer: { content: { richShelfRenderer: { title: 'Shorts', contents: [{ richItemRenderer: { content: { reelItemRenderer: {} } } }] } } } },
  ] } } };
  const s2 = JSON.parse(JSON.stringify(ctxJson.parse(JSON.stringify(sections)))).contents.sectionListRenderer.contents;
  assert.equal(s2.length, 3);
  assert.deepEqual(s2[0].itemSectionRenderer.contents, [{ videoRenderer: { videoId: 'v' } }]);
  assert.deepEqual(s2[1].itemSectionRenderer.contents, [{ videoRenderer: { videoId: 'w' } }]);
  assert.ok(s2[2].richSectionRenderer.content.richShelfRenderer.contents[0].richItemRenderer.content.reelItemRenderer);

  // Regression: Nicht-Werbung und Guide-Antwort unverändert
  const guide = { responseContext: {}, items: [{ guideSectionRenderer: { items: [{ guideEntryRenderer: { icon: { iconType: 'HOME' }, navigationEndpoint: {} } }] } }] };
  assert.deepEqual(JSON.parse(JSON.stringify(ctxJson.parse(JSON.stringify(guide)))), guide);
  const plain = { responseContext: {}, contents: [video('x'), video('y')] };
  assert.deepEqual(JSON.parse(JSON.stringify(ctxJson.parse(JSON.stringify(plain)))), plain);
  assert.deepEqual(ctxJson.parse('[{"adSlotRenderer":{}}]').length, 1); // reine Arrays ohne Feed-Kennzeichen: unberührt
});
