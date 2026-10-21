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

test('Suche: ARD-Seite 0 und Folgeseite mit Serien (showPageNumber)', async () => {
  const http = fakeHttp(url => (url.includes('api.ardmediathek.de') ? fixture('ardSearchInstitut') : url.includes('zdf') ? fixture('zdfSearch') : fixture('arteSearch')));
  const service = createMediathekService({ http });
  const p0 = await service.searchPage('Das Institut', 'ard', 0);
  assert.equal(p0.series.length, 2);
  assert.equal(p0.hasMore, true);
  const p1 = await service.searchPage('Das Institut', 'ard', 1);
  assert.equal(p1.series.length, 2);
  assert.ok(http.calls[1].includes('vodPageNumber=1') && http.calls[1].includes('showPageNumber=1'));
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
    return JSON.stringify({ data: [{ type: 'teaser', title: `B${pages}`, programId: `${pages}0-000-A`, kind: { code: 'SHOW' } }], nextPage: `https://api.arte.tv/api/emac/v3/de/web/data/MORE/?page=${pages + 2}` });
  });
  const series = { id: 'RC-1', title: 'S', sourceId: 'arte', groupingURL: 'https://api.arte.tv/api/emac/v3/de/web/pages/RC-1/' };
  const episodes = await createMediathekService({ http: looping }).fetchEpisodes(series);
  assert.equal(pages, 12); // höchstens 12 Nachladeseiten
  assert.equal(episodes.length, 13);
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

const ardPagedHttp = () =>
  fakeHttp(url => {
    if (url.includes('/pages/mdr/grouping/SERIE1')) return fixture('ardGroupingPaged0');
    if (url.includes('pageNumber=1')) return fixture('ardGroupingPaged1');
    if (url.includes('pageNumber=2')) return fixture('ardGroupingPaged2');
    if (url.includes('seasonNumber=2')) return fixture('ardSeasonTwo');
    throw Object.assign(new Error('weg'), { code: 'network', permanent: true });
  });
const ardPagedSeries = { id: 'SERIE1', title: 'Serie', sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/mdr/grouping/SERIE1?embedded=true' };

test('ARD-Serie: fetchEpisodes lädt alle Seiten (nicht nur Seite 0), Extras entfallen, OV zusammengefasst', async () => {
  const http = ardPagedHttp();
  const service = createMediathekService({ http, sleep: noSleep });
  const episodes = await service.fetchEpisodes(ardPagedSeries);
  assert.deepEqual(episodes.map(e => e.id), ['item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6']);
  assert.equal(episodes[3].originalVersionId, 'item-4-ov');
  assert.equal(http.calls.length, 3);
  assert.ok(http.calls[1].includes('pageNumber=1') && http.calls[2].includes('pageNumber=2'));
});

test('ARD-Serienseite: seitenweise (pages), Fortschritt, hasMore und verfügbare Staffeln; Seiten werden kurz zwischengespeichert', async () => {
  const http = ardPagedHttp();
  const service = createMediathekService({ http, sleep: noSleep });
  const first = await service.fetchEpisodeView(ardPagedSeries, { pages: 1 });
  assert.deepEqual(first.entries.map(e => e.id), ['item-1', 'item-2']);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.progress, { loaded: 3, total: 8 });
  assert.deepEqual(first.availableSeasons, [1, 2, 3]);
  const more = await service.fetchEpisodeView(ardPagedSeries, { pages: 3 });
  assert.equal(more.entries.length, 6);
  assert.equal(more.hasMore, false);
  assert.equal(more.progress, null);
  assert.equal(http.calls.length, 3, 'Seite 0 kam aus dem Zwischenspeicher');
  await assert.rejects(service.fetchEpisodeView({ ...ardPagedSeries, groupingURL: 'https://evil.example/x' }, { pages: 1 }), { code: 'invalidURL' });
});

test('ARD-Serienseite: Staffel komplett über das Staffel-Widget, Staffel/Folge gesetzt; unbekannte Staffel wird abgelehnt', async () => {
  const http = ardPagedHttp();
  const service = createMediathekService({ http, sleep: noSleep });
  const view = await service.fetchEpisodeView(ardPagedSeries, { season: 2 });
  assert.deepEqual(view.entries.map(e => [e.id, e.season, e.episode]), [['s2-a', 2, 1], ['s2-b', 2, 2]]);
  assert.deepEqual(view.availableSeasons, [1, 2, 3]);
  assert.ok(http.calls.some(url => url.includes('/widgets/ard/asset/SERIE1') && url.includes('seasonNumber=2')));
  await assert.rejects(service.fetchEpisodeView(ardPagedSeries, { season: 9 }), { code: 'invalidURL' });
});

test('ARD-Serienliste: Obergrenze 2000 Folgen und höchstens 45 Seiten', async () => {
  const page = n => JSON.stringify({ teasers: Array.from({ length: 48 }, (_, i) => ({ id: `e${n}-${i}`, coreAssetType: 'EPISODE', type: 'ondemand', longTitle: `E ${n}-${i}`, links: { target: { href: `https://api.ardmediathek.de/page-gateway/pages/ard/item/e${n}-${i}` } } })), pagination: { pageNumber: n, pageSize: 48, totalElements: 9000 }, links: { self: { href: `https://api.ardmediathek.de/page-gateway/widgets/ard/asset/BIG?pageNumber=${n}&pageSize=48` } } });
  const http = fakeHttp(url => {
    const match = /pageNumber=(\d+)/.exec(url);
    return page(match ? Number(match[1]) : 0).replace('"teasers"', '"widgets":[],"teasers"');
  });
  const service = createMediathekService({ http, sleep: noSleep });
  const big = { id: 'BIG', title: 'Big', sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/BIG?embedded=true' };
  const view = await service.fetchEpisodeView(big, { pages: 0 });
  assert.ok(view.entries.length >= 2000 && view.entries.length <= 2000 + 48, String(view.entries.length));
  assert.ok(http.calls.length <= 45);
  assert.equal(view.hasMore, false, 'bei erreichter Obergrenze gibt es kein Nachladen mehr');
});

const arteNamed = () =>
  fakeHttp(url => {
    if (url.includes('/pages/RC-1/')) return fixture('arteCollectionNamed');
    const next = new URL(url);
    const page = Number(next.searchParams.get('page'));
    const item = (pid, title) => ({ type: 'teaser', title, programId: pid, kind: { code: 'SHOW' } });
    if (next.pathname.endsWith('COLLECTION_VIDEOS/')) return JSON.stringify({ data: [item('100-001-A', 'Folge 1'), item('100-002-A', 'Folge 2'), item('100-003-A', 'Folge 3'), item(`1${page}0-004-A`, `Spät ${page}`)], nextPage: page < 2 ? `${url.replace(/page=\d+/, `page=${page + 1}`)}` : null });
    return JSON.stringify({ data: [item('100-001-A', 'Folge 1'), item('100-002-A', 'Folge 2'), item('200-001-A', 'Alltag 3')], nextPage: null });
  });
const arteSeries = { id: 'RC-1', title: 'Karambolage', sourceId: 'arte', groupingURL: 'https://api.arte.tv/api/emac/v3/de/web/pages/RC-1/' };

test('arte-Serie: Unterreihen mit ihrem Namen statt "Staffel n", Zuordnung zur Unterreihe gewinnt gegen "Alle Videos"', async () => {
  const http = arteNamed();
  const view = await createMediathekService({ http }).fetchEpisodeView(arteSeries);
  assert.deepEqual(view.seasonTitles, { 1: 'Alltag', 2: 'Die Sprache' });
  const bySeason = new Map();
  for (const entry of view.entries) bySeason.set(entry.id, entry.season);
  assert.equal(bySeason.get('100-001-A'), 1, 'in Alltag und Alle Videos: Alltag gewinnt');
  assert.equal(bySeason.get('100-003-A'), 2, 'Die Sprache gewinnt gegen Alle Videos');
  assert.equal(bySeason.get('200-001-A'), 1);
  assert.equal(new Set(view.entries.map(e => e.id)).size, view.entries.length);
  assert.ok(view.entries.filter(e => e.season === null).length >= 1, 'Folgen nur in "Alle Videos" bleiben ohne Unterreihe');
  assert.ok(!view.entries.some(e => e.id === '100-009-A'), '"Demnächst" gehört nicht zur Folgenliste');
  assert.equal(view.hasMore, false);
});

test('arte-Serie: Nachladen mit limit=100 und page=1 (statt 20er-Seiten), bis 1000 Folgen, Dubletten der ersten Seite entfallen', async () => {
  const http = arteNamed();
  await createMediathekService({ http }).fetchEpisodes(arteSeries);
  const more = http.calls.filter(url => url.includes('COLLECTION_VIDEOS'));
  assert.ok(more.length >= 1);
  assert.ok(more[0].includes('limit=100') && more[0].includes('page=1'), more[0]);
  assert.ok(more.every(url => !url.includes('limit=20')));
  const sub = http.calls.find(url => url.includes('COLLECTION_SUBCOLLECTION'));
  assert.ok(sub.includes('limit=100') && sub.includes('subCollectionId=RC-2'), sub);
});

test('arte-Serie: alle Unterreihen "Staffel N" -> echte Staffelnummern ohne Namen; arte-Suche pagt (page 1-basiert)', async () => {
  const zones = ['Staffel 2', 'Staffel 1'].map((name, index) => ({ code: { name: 'collection_subcollection' }, title: `Serie - ${name}`, data: [{ type: 'teaser', title: `E${index}`, programId: `${index}00-000-A`, kind: { code: 'SHOW' } }], nextPage: null }));
  const http = fakeHttp(url => (url.includes('/pages/RC-') ? JSON.stringify({ title: 'Serie', zones }) : JSON.stringify({ data: [], nextPage: null })));
  const view = await createMediathekService({ http }).fetchEpisodeView({ ...arteSeries, id: 'RC-9', groupingURL: 'https://api.arte.tv/api/emac/v3/de/web/pages/RC-9/' });
  assert.deepEqual(view.entries.map(e => [e.id, e.season]), [['000-000-A', 2], ['100-000-A', 1]]);
  assert.deepEqual(view.seasonTitles, {});
  const search = fakeHttp(() => JSON.stringify({ pageNumber: 2, nextPage: 'https://api.arte.tv/api/emac/v3/de/web/data/SEARCH_LISTING/?limit=20&page=3&query=k', data: [{ type: 'teaser', title: 'V', kind: { code: 'SHOW' }, programId: '1-000-A' }] }));
  const service = createMediathekService({ http: search });
  const page = await service.searchPage('Karambolage', 'arte', 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.page, 1);
  assert.ok(search.calls[0].includes('page=2&limit=20'));
});
