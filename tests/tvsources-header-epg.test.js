'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adoptHeaderEpgUrl } = require('../lib/tvsources-header-epg.js');
const { remoteHttpUrl } = require('../lib/input-validation.js');
const { EpgService } = require('../lib/epg/EpgService.js');
const { registerEpgIpc } = require('../lib/epg/ipc.js');

const SRC = 'https://example.org/list.m3u';

test('übernimmt url-tvg bei leerem epgUrl', () => {
  const sources = [{ id: 'a', url: SRC, epgUrl: null }];
  const changed = adoptHeaderEpgUrl(sources, SRC, ['https://epg.example.org/guide.xml'], remoteHttpUrl);
  assert.equal(changed, sources[0]);
  assert.equal(sources[0].epgUrl, 'https://epg.example.org/guide.xml');
});

test('überschreibt vorhandenes epgUrl nicht', () => {
  const sources = [{ id: 'a', url: SRC, epgUrl: 'https://old.example.org/e.xml' }];
  assert.equal(adoptHeaderEpgUrl(sources, SRC, ['https://epg.example.org/guide.xml'], remoteHttpUrl), null);
  assert.equal(sources[0].epgUrl, 'https://old.example.org/e.xml');
});

test('ignoriert ungültige und nicht-http-URLs', () => {
  const sources = [{ id: 'a', url: SRC }];
  const bad = ['file:///etc/passwd', 'ftp://epg.example.org/x.xml', 'kein url', 'http://127.0.0.1/x.xml'];
  assert.equal(adoptHeaderEpgUrl(sources, SRC, bad, remoteHttpUrl), null);
  assert.equal(sources[0].epgUrl, undefined);
});

test('mehrere Werte: erste gültige gewinnt', () => {
  const sources = [{ id: 'a', url: SRC }];
  adoptHeaderEpgUrl(sources, SRC, ['javascript:alert(1)', 'https://one.example.org/a.xml', 'https://two.example.org/b.xml'], remoteHttpUrl);
  assert.equal(sources[0].epgUrl, 'https://one.example.org/a.xml');
});

test('unbekannte Quelle: keine Änderung', () => {
  const sources = [{ id: 'a', url: SRC }];
  assert.equal(adoptHeaderEpgUrl(sources, 'https://other.example.org/x.m3u', ['https://e.example.org/a.xml'], remoteHttpUrl), null);
});

test('epg:now-next dekodiert Titel genau einmal (&amp;lt;b&amp;gt; -> &lt;b&gt;)', async () => {
  const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
  const fmt = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const body = `<tv><programme start="${fmt(NOW - 1800000)}" stop="${fmt(NOW + 1800000)}" channel="c1"><title>&amp;lt;b&amp;gt;</title></programme></tv>`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-dec-'));
  const epg = new EpgService({
    dir,
    getSources: () => [{ id: 'de', epgUrl: 'https://epg.example/de.xml' }],
    fetchImpl: async () => new Response(body),
    validateUrl: u => u,
    now: () => NOW,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  await epg.refresh({ force: true });
  const handlers = new Map();
  const mainSender = {};
  registerEpgIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    epg,
    requireMainRenderer: () => {},
  });
  const res = await handlers.get('epg:now-next')({ sender: mainSender }, ['c1']);
  assert.equal(res[0].current.title, '&lt;b&gt;');
});

test('kommagetrennt: ungültiger erster Teil, zweiter gewinnt', () => {
  const sources = [{ id: 'a', url: SRC }];
  adoptHeaderEpgUrl(sources, SRC, ['kein url, https://epg.example.org/g.xml'], remoteHttpUrl);
  assert.equal(sources[0].epgUrl, 'https://epg.example.org/g.xml');
});

test('kommagetrennt: zwei gültige, erster gewinnt; leere Teile verworfen', () => {
  const sources = [{ id: 'a', url: SRC }];
  adoptHeaderEpgUrl(sources, SRC, [' ,https://one.example.org/a.xml,, https://two.example.org/b.xml '], remoteHttpUrl);
  assert.equal(sources[0].epgUrl, 'https://one.example.org/a.xml');
});

test('echter parseM3UFull-Header mit Komma-Liste -> epgUrl gesetzt', () => {
  const { parseM3UFull } = require('@streaming-hub/typed-core');
  const res = parseM3UFull('#EXTM3U url-tvg="http://a/x.xml, https://epg.example.org/g.xml"\n#EXTINF:-1,A\nhttp://s/1.ts\n', 'tv');
  const sources = [{ id: 'a', url: SRC }];
  adoptHeaderEpgUrl(sources, SRC, res.epgUrls, remoteHttpUrl);
  assert.equal(sources[0].epgUrl, 'https://epg.example.org/g.xml');
});
