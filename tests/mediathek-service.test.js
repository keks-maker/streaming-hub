'use strict';

// Tests: MediathekService (Paging, Dublettenfilter, arte-Staffeln mit Nachladen, Wiedergabe-Auflösung, Host-Prüfung) und der
// HTTP-Wrapper (Allowlist auch nach Redirect, Fehlercodes). Transport ist ein Ersatz, keine Netzzugriffe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { createMediathekHttp } = require('../lib/mediathek/http.js');

function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    async getText(url) {
      calls.push(url);
      return handler(url);
    },
  };
}

test('Suche: ARD-Seite 0 mit Serien, Seite 1 ohne Serien', async () => {
  const http = fakeHttp(url => (url.includes('api.ardmediathek.de') ? fixture('ardSearchInstitut') : url.includes('zdf') ? fixture('zdfSearch') : fixture('arteSearch')));
  const service = createMediathekService({ http });
  const p0 = await service.searchPage('Das Institut', 'ard', 0);
  assert.equal(p0.series.length, 2);
  assert.equal(p0.hasMore, true);
  const p1 = await service.searchPage('Das Institut', 'ard', 1);
  assert.deepEqual(p1.series, []);
  assert.ok(http.calls[1].includes('vodPageNumber=1'));
  assert.ok(!http.calls[0].includes('vodPageNumber'));
  assert.equal((await service.searchPage('x', 'zdf', 0)).entries.length, 1);
});

const noSleep = () => Promise.resolve();
const zdfDoc = id => `https://zdf-prod-futura.zdf.de/mediathekV2/document/${id}`;
const httpError = status => Object.assign(new Error(`Server antwortete mit HTTP ${status}`), { code: 'http', status });

test('ZDF-Suche mit Paging: nextPageUrl der Vorseite wird abgerufen, nie nach außen gereicht', async () => {
  const http = fakeHttp(url => (url.includes('page=2') ? fixture('zdfSearchPageLast') : fixture('zdfSearchPage1')));
  const service = createMediathekService({ http, sleep: noSleep });
  const p0 = await service.searchPage('bergdoktor', 'zdf', 0);
  assert.equal(p0.hasMore, true);
  assert.equal('nextPageUrl' in p0, false);
  assert.deepEqual(p0.series.map(s => s.id), ['der-bergdoktor-106']);
  const p1 = await service.searchPage('bergdoktor', 'zdf', 1);
  assert.equal(http.calls[1], 'https://zdf-prod-futura.zdf.de/mediathekV2/search?q=bergdoktor&profile=cellular-5&synth=true&sp=true&page=2');
  assert.deepEqual(p1.entries.map(e => e.id), ['heimweh-100']);
  assert.equal(p1.hasMore, false);
  // ohne gemerkte Adresse (z. B. neuer Dienst): page= aus der Seitennummer
  await createMediathekService({ http, sleep: noSleep }).searchPage('x y', 'zdf', 2);
  assert.equal(http.calls[2], 'https://zdf-prod-futura.zdf.de/mediathekV2/search?q=x%20y&page=3');
});

test('Abruffehler: 503/Zeitüberschreitung werden höchstens zweimal wiederholt, danach als Fehler (nie als leere Liste); 404/ungültig sofort', async () => {
  const sleeps = [];
  let calls = 0;
  const flaky = failures => ({
    async getText() {
      calls += 1;
      if (calls <= failures) throw httpError(503);
      return fixture('zdfSearchPageLast');
    },
  });
  const make = http => createMediathekService({ http, sleep: ms => (sleeps.push(ms), Promise.resolve()) });
  assert.equal((await make(flaky(2)).searchPage('x', 'zdf', 0)).entries.length, 1);
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], 'Backoff');
  calls = 0;
  await assert.rejects(make(flaky(5)).searchPage('x', 'zdf', 0), { code: 'http', status: 503 });
  assert.equal(calls, 3, 'ein Versuch plus zwei Wiederholungen');
  calls = 0;
  const gone = { async getText() { calls += 1; throw httpError(404); } };
  await assert.rejects(make(gone).searchPage('x', 'zdf', 0), { status: 404 });
  assert.equal(calls, 1);
  calls = 0;
  const timeout = { async getText() { calls += 1; throw Object.assign(new Error('Zeitüberschreitung'), { code: 'network' }); } };
  await assert.rejects(make(timeout).fetchHomeSections('zdf'), { code: 'network' });
  assert.equal(calls, 3);
});

test('ZDF-Serie: Folgen aus document/<id> mit Staffel und Folge; fremde Adressen werden nie abgerufen', async () => {
  const http = fakeHttp(() => fixture('zdfBrandBergdoktor'));
  const service = createMediathekService({ http, sleep: noSleep });
  const series = { id: 'der-bergdoktor-106', title: 'Der Bergdoktor', sourceId: 'zdf', groupingURL: zdfDoc('der-bergdoktor-106') };
  const episodes = await service.fetchEpisodes(series);
  assert.equal(episodes.length, 5);
  assert.deepEqual(episodes.map(e => e.season), [19, 19, 17, 17, 7]);
  assert.equal(http.calls[0], series.groupingURL);
  for (const groupingURL of ['https://evil.example/mediathekV2/document/x-100', 'http://zdf-prod-futura.zdf.de/mediathekV2/document/x-100', 'https://zdf-prod-futura.zdf.de/mediathekV2/search?q=x', 'https://zdf-prod-futura.zdf.de/mediathekV2/document/a/b', 'https://zdf-prod-futura.zdf.de/mediathekV2/document/x-100?profile=1', '']) {
    await assert.rejects(service.fetchEpisodes({ ...series, groupingURL }), { code: 'invalidURL' }, groupingURL);
  }
  assert.equal(http.calls.length, 1);
});

test('Suche: Folgeseiten ohne Serien, ungültige Antwort -> fetchFailed', async () => {
  const service = createMediathekService({ http: fakeHttp(() => '<html>') });
  await assert.rejects(service.searchPage('x', 'ard'), { code: 'fetchFailed', message: 'Mediathek konnte nicht geladen werden' });
  await assert.rejects(service.fetchHomeSections('ard'), { code: 'fetchFailed' });
  await assert.rejects(service.fetchHomeSections('rtl'), { code: 'unsupportedSource' });
});

test('Home-Abschnitte je Quelle', async () => {
  const service = createMediathekService({ http: fakeHttp(url => (url.includes('ardmediathek') ? fixture('ardHomeSections') : url.includes('zdf') ? fixture('zdfHome') : fixture('arteHomeGenres'))) });
  for (const source of ['ard', 'zdf', 'arte']) assert.ok((await service.fetchHomeSections(source)).length > 0, source);
});

test('ARD-Serie: Folgen ohne Dubletten; fremde oder ungültige Adressen werden nie abgerufen', async () => {
  const http = fakeHttp(() => fixture('ardGroupingMurdoch'));
  const service = createMediathekService({ http });
  const ok = await service.fetchEpisodes({ id: 's', title: 'S', sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/s?embedded=true' });
  assert.equal(ok.length, 3);
  assert.equal(new Set(ok.map(e => e.id)).size, 3);
  for (const groupingURL of ['https://evil.example/page-gateway/pages/ard/grouping/s', 'http://api.ardmediathek.de/page-gateway/pages/ard/grouping/s', 'https://api.ardmediathek.de/other', 'kaputt', '']) {
    await assert.rejects(service.fetchEpisodes({ id: 's', title: 'S', sourceId: 'ard', groupingURL }), { code: 'invalidURL' }, groupingURL);
  }
  await assert.rejects(service.fetchEpisodes({ id: 's', title: 'S', sourceId: 'zdf', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/s' }), { code: 'invalidURL' });
  assert.equal(http.calls.length, 1);
});

test('arte-Serie: Unterreihen werden Staffeln, Nachladen mit Dublettenfilter', async () => {
  const http = fakeHttp(url => {
    if (url.includes('/pages/RC-')) return fixture('arteCollectionSeasons');
    return JSON.stringify({ data: [{ type: 'teaser', title: 'Nachgeladen', programId: '999999-000-A', kind: { code: 'SHOW' } }], nextPage: null });
  });
  const service = createMediathekService({ http });
  const series = { id: 'RC-1', title: 'S', sourceId: 'arte', groupingURL: 'https://api.arte.tv/api/emac/v3/de/web/pages/RC-1/' };
  const episodes = await service.fetchEpisodes(series);
  assert.deepEqual([...new Set(episodes.map(e => e.season))].sort(), [1, 2]);
  assert.ok(episodes.some(e => e.id === '999999-000-A' && e.season === 2));
  assert.equal(new Set(episodes.map(e => e.id)).size, episodes.length);
  await assert.rejects(service.fetchEpisodes({ ...series, groupingURL: 'https://evil.example/api/emac/v3/de/web/pages/RC-1/' }), { code: 'invalidURL' });
});

test('arte-Serie: einzelne Zone bleibt ohne Staffel, Nachladen ist begrenzt, Fehler beim Nachladen beenden still', async () => {
  let pages = 0;
  const looping = fakeHttp(url => {
    if (url.includes('/pages/RC-')) return JSON.stringify({ zones: [{ code: { name: 'collection_videos' }, data: [{ type: 'teaser', title: 'A', programId: '1-000-A', kind: { code: 'SHOW' } }], nextPage: 'https://api.arte.tv/api/emac/v3/de/web/data/MORE/?page=2' }] });
    pages += 1;
    return JSON.stringify({ data: [{ type: 'teaser', title: `B${pages}`, programId: `${pages}0-000-A`, kind: { code: 'SHOW' } }], nextPage: 'https://api.arte.tv/api/emac/v3/de/web/data/MORE/?page=3' });
  });
  const series = { id: 'RC-1', title: 'S', sourceId: 'arte', groupingURL: 'https://api.arte.tv/api/emac/v3/de/web/pages/RC-1/' };
  const episodes = await createMediathekService({ http: looping }).fetchEpisodes(series);
  assert.equal(pages, 8); // höchstens 8 Nachladeseiten
  assert.equal(episodes.length, 9);
  assert.ok(episodes.every(e => e.season === null));
  const failing = fakeHttp(url => {
    if (url.includes('/pages/RC-')) return JSON.stringify({ zones: [{ code: { name: 'collection_videos' }, data: [{ type: 'teaser', title: 'A', programId: '1-000-A', kind: { code: 'SHOW' } }], nextPage: 'https://api.arte.tv/api/emac/v3/de/web/data/MORE/' }] });
    throw new Error('weg');
  });
  assert.equal((await createMediathekService({ http: failing }).fetchEpisodes(series)).length, 1);
});

test('Genre-Seite und Nachladen: nur arte und Emac-Adressen', async () => {
  const http = fakeHttp(url => (url.includes('/pages/DOR/') ? fixture('arteGenrePage') : fixture('arteMore')));
  const service = createMediathekService({ http });
  const rows = await service.fetchGenrePage({ id: 'DOR', title: 'Dokus', sourceId: 'arte' });
  assert.ok(rows.length > 0);
  await assert.rejects(service.fetchGenrePage({ id: '../x', title: 'x', sourceId: 'arte' }), { code: 'invalidURL' });
  await assert.rejects(service.fetchGenrePage({ id: 'DOR', title: 'x', sourceId: 'ard' }), { code: 'invalidURL' });
  const row = rows.find(r => r.nextPage);
  const more = await service.fetchMore(row);
  assert.equal(more.title, row.title);
  assert.ok(more.entries.length + more.series.length > 0);
  await assert.rejects(service.fetchMore({ title: 'x', nextPage: 'https://evil.example/api/emac/v3/de/web/data/X/' }), { code: 'invalidURL' });
  await assert.rejects(service.fetchMore({ title: 'x', nextPage: null }), { code: 'invalidURL' });
});

test('Wiedergabe: frisch aufgelöst, vorhandene streamUrl gilt, Fehler -> unavailable', async () => {
  const http = fakeHttp(url => (url.includes('/item/') ? fixture('ardItemMurdochGeoWithStreams') : fixture('zdfDocument')));
  const service = createMediathekService({ http });
  const ard = await service.resolveStreamDetail({ id: 'abc', sourceId: 'ard', partner: 'one' });
  assert.equal(ard.resolution.kind, 'playable');
  assert.equal(ard.regionRestricted, true);
  assert.ok(http.calls[0].includes('/pages/one/item/abc'));
  assert.ok((await service.resolveStreamDetail({ id: 'z', sourceId: 'zdf' })).resolution.url.endsWith('master.m3u8'));
  const before = http.calls.length;
  assert.deepEqual(await service.resolveStreamDetail({ id: 'h', sourceId: 'ard', streamUrl: 'https://x.test/a.m3u8' }), { resolution: { kind: 'playable', url: 'https://x.test/a.m3u8' }, regionRestricted: false });
  assert.equal(http.calls.length, before);
  assert.equal((await service.resolveStreamDetail({ id: 'x', sourceId: 'rtl' })).resolution.kind, 'unavailable');
  const broken = createMediathekService({ http: fakeHttp(() => { throw new Error('x'); }) });
  assert.equal((await broken.resolveStreamDetail({ id: 'a', sourceId: 'ard' })).resolution.kind, 'unavailable');
});

function response(status, body, headers = {}) {
  return { status, headers: { get: name => headers[name.toLowerCase()] ?? null }, async arrayBuffer() { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }, body: { cancel: async () => {} } };
}

test('HTTP: Allowlist vor dem Abruf und nach Redirect, Fehlercodes, Größenlimit', async () => {
  const requested = [];
  const fetchImpl = async url => {
    requested.push(url);
    if (url.includes('redirect-out')) return response(302, '', { location: 'https://evil.example/x' });
    if (url.includes('redirect-in')) return response(302, '', { location: 'https://api.arte.tv/ok' });
    if (url.includes('missing')) return response(404, 'nein');
    if (url.includes('big')) return response(200, 'x'.repeat(100));
    if (url.includes('badjson')) return response(200, '<html>');
    return response(200, '{"a":1}');
  };
  const http = createMediathekHttp({ fetchImpl, lookup: undefined, maxBytes: 50 });
  assert.deepEqual(await http.getJson('https://api.arte.tv/api/emac/v3/de/web/pages/HOME/'), { a: 1 });
  await assert.rejects(http.getText('https://evil.example/x'), { code: 'forbidden-host' });
  await assert.rejects(http.getText('http://api.arte.tv/x'), { code: 'forbidden-host' });
  await assert.rejects(http.getText('https://127.0.0.1/x'), { code: 'forbidden-host' });
  assert.ok(!requested.some(url => url.includes('evil.example') || url.includes('127.0.0.1')));
  await assert.rejects(http.getText('https://api.arte.tv/redirect-out'), { code: 'network', message: 'Adresse nicht erlaubt' });
  assert.ok(!requested.includes('https://evil.example/x'), 'Redirect-Ziel wurde nicht abgerufen');
  assert.equal(await http.getText('https://api.arte.tv/redirect-in'), '{"a":1}');
  await assert.rejects(http.getText('https://api.arte.tv/missing'), { code: 'http', status: 404 });
  await assert.rejects(http.getText('https://api.arte.tv/big'), { code: 'too-large' });
  await assert.rejects(http.getJson('https://api.arte.tv/badjson'), { code: 'invalid-json' });
});

test('HTTP: Netzwerkfehler tragen keine Adresse', async () => {
  const http = createMediathekHttp({ fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }); }, lookup: undefined });
  await assert.rejects(http.getText('https://api.arte.tv/geheim/pfad?token=abc'), error => error.code === 'network' && !/geheim|token/.test(error.message));
});
