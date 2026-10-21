'use strict';

// Tests: Mediathek-Parser (lib/mediathek/parser*.js, entries.js, sources.js). Fixtures aus dem tvOS/iPad-Repo
// (MediathekParserTests.swift, ArteGenreTests.swift): gleiche Eingabe -> gleiche Einträge. Keine Netzzugriffe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const parser = require('../lib/mediathek/parser.js');
const arte = require('../lib/mediathek/parser-arte.js');
const ard = require('../lib/mediathek/parser-ard.js');
const sources = require('../lib/mediathek/sources.js');
const { mergeOriginalVersions, groupBySeason, seasonEpisodeInTitle } = require('../lib/mediathek/entries.js');
const { fskWindow, ageRestrictedMessage } = require('../lib/mediathek/restrictions.js');

const entry = fields => ({ title: fields.id, subtitle: null, season: null, episode: null, originalVersionId: null, audioDescriptionId: null, ...fields });

test('ARD-Home: Live/Editorial/Serien verworfen, Dublette entfernt, ID aus Ziel-Link', () => {
  const entries = parser.parse(fixture('ardHome'), 'ard');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'Y3JpZDovL3N3ci5kZS9hZXgvbzIzNDk1NTQ');
  assert.ok(!entries[0].id.includes(':'));
  assert.equal(entries[0].sourceId, 'ard');
  assert.equal(entries[0].duration, 1638);
  assert.equal(entries[0].airedAt, '2026-10-02T03:00:00.000Z');
  assert.ok(!entries[0].imageUrl.includes('{width}'));
  assert.equal(entries[0].subtitle, 'SWR');
  assert.equal(entries[0].partner, 'swr');
});

test('ARD-Suche (flach): Treffer ohne Links tragen die Item-ID, Serie ohne Link entfällt', () => {
  assert.equal(parser.parse(fixture('ardSearch'), 'ard').length, 1);
});

test('ZDF-Home und Suche: nur Einzelvideos, Dokument-ID statt videoId', () => {
  const home = parser.parse(fixture('zdfHome'), 'zdf');
  assert.deepEqual(home.map(e => e.id), ['auslandsjournal---couchsurfen-in-argentinien-vom-19-maerz-2026-100']);
  assert.ok(home.every(e => e.sourceId === 'zdf'));
  const search = parser.parse(fixture('zdfSearch'), 'zdf');
  assert.deepEqual(search.map(e => e.id), ['261006-heute-sendung-17-uhr-100']);
  assert.ok(search[0].imageUrl);
});

test('arte: Genres und Sammlungen sind nie abspielbare Einträge', () => {
  const home = parser.parse(fixture('arteHomeGenres'), 'arte');
  assert.ok(home.every(e => e.id.endsWith('-A')));
  assert.ok(!home.some(e => e.title === 'Dokus'));
  const search = parser.parse(fixture('arteSearch'), 'arte');
  assert.equal(search.length, 1);
  assert.equal(search[0].duration, 2621);
  assert.equal(search[0].airedAt, '2026-10-02T03:00:00.000Z');
});

test('Stream: ARD HLS vor MP4, Hauptstream vor Gebärdensprache, Schema // ergänzt', () => {
  assert.deepEqual(parser.parseStreamDetail(fixture('ardItem'), 'ard').resolution.kind, 'playable');
  assert.ok(!parser.parseStreamDetail(fixture('ardItem'), 'ard').resolution.url.endsWith('.mp4'));
  assert.deepEqual(parser.parseStreamDetail(fixture('ardItemSignLanguageFirst'), 'ard').resolution, { kind: 'playable', url: 'https://example.invalid/main/master.m3u8' });
});

test('Stream: ARD MP4-Fallback, Geo-Flag mit Stream bleibt abspielbar, ohne Medien unavailable', () => {
  assert.deepEqual(parser.parseStreamDetail(fixture('ardItemMP4Only'), 'ard').resolution, { kind: 'playable', url: 'https://example.invalid/main.mp4' });
  assert.deepEqual(parser.parseStreamDetail(fixture('ardItemGeoBlocked'), 'ard').resolution, { kind: 'playable', url: 'https://example.invalid/geo.m3u8' });
  assert.equal(parser.parseStreamDetail(fixture('ardItemNoMedia'), 'ard').resolution.kind, 'unavailable');
  assert.equal(parser.parseStreamDetail('x', 'ard').resolution.kind, 'unavailable');
});

test('Stream: ARD Standardton gewinnt, auch wenn die Audiodeskription zuerst gelistet ist (Spike)', () => {
  const root = {
    widgets: [
      {
        mediaCollection: {
          embedded: {
            streams: [
              {
                kind: 'main',
                media: [
                  { mimeType: 'application/vnd.apple.mpegurl', url: 'https://example.invalid/ad.m3u8', audios: [{ kind: 'audio-description', languageCode: 'deu' }] },
                  { mimeType: 'application/vnd.apple.mpegurl', url: 'https://example.invalid/standard.m3u8', audios: [{ kind: 'standard', languageCode: 'deu' }] },
                ],
              },
            ],
          },
        },
      },
    ],
  };
  assert.equal(parser.parseStreamDetail(root, 'ard').resolution.url, 'https://example.invalid/standard.m3u8');
});

test('Stream: ARD Regionshinweis, Geo ohne Stream, FSK', () => {
  const geo = parser.parseStreamDetail(fixture('ardItemMurdochGeoWithStreams'), 'ard');
  assert.equal(geo.resolution.kind, 'playable');
  assert.equal(geo.regionRestricted, true);
  assert.equal(parser.parseStreamDetail(fixture('ardItemMP4Only'), 'ard').regionRestricted, false);
  const none = { widgets: [{ mediaCollection: { embedded: { isGeoBlocked: true, streams: [] } } }] };
  assert.deepEqual(parser.parseStreamDetail(none, 'ard'), { resolution: { kind: 'geoBlocked' }, regionRestricted: false });
  assert.deepEqual(parser.parseStreamDetail(fixture('ardItemInstitutFskBlocked'), 'ard').resolution, { kind: 'ageRestricted', rating: 'FSK16' });
  assert.equal(ageRestrictedMessage('FSK16'), 'Dieser Beitrag ist ab FSK 16 eingestuft (Jugendschutz) und nur von 22 bis 6 Uhr abrufbar.');
  assert.equal(ageRestrictedMessage('FSK6'), 'Dieser Beitrag ist ab FSK 6 eingestuft (Jugendschutz) und derzeit nicht abrufbar.');
  assert.deepEqual([18, 16, 12, 6].map(fskWindow), ['23 bis 6 Uhr', '22 bis 6 Uhr', '20 bis 6 Uhr', null]);
});

test('Stream: ZDF HLS vor MP4, Audiodeskription nie als Standard, FSK ohne Formitäten', () => {
  const zdf = parser.parseStreamDetail(fixture('zdfDocument'), 'zdf').resolution;
  assert.equal(zdf.kind, 'playable');
  assert.ok(zdf.url.endsWith('master.m3u8'));
  assert.equal(parser.parseStreamDetail(fixture('zdfDocumentNoFormats'), 'zdf').resolution.kind, 'unavailable');
  assert.equal(parser.parseStreamDetail('{}', 'zdf').resolution.kind, 'unavailable');
  assert.deepEqual(parser.parseStreamDetail(fixture('zdfDocumentFskBlocked'), 'zdf').resolution, { kind: 'ageRestricted', rating: 'fsk16' });
  const adFirst = { document: { formitaeten: [{ type: 'h264_aac_ts_http_m3u8_http', class: 'ad', url: 'https://example.invalid/ad.m3u8' }, { type: 'h264_aac_ts_http_m3u8_http', class: 'main', url: 'https://example.invalid/main.m3u8' }] } };
  assert.equal(parser.parseStreamDetail(adFirst, 'zdf').resolution.url, 'https://example.invalid/main.m3u8');
});

test('Stream: arte deutsche Version bevorzugt, ohne Streams unavailable, Altersgrenze', () => {
  assert.deepEqual(parser.parseStreamDetail(fixture('artePlayerTwoVersions'), 'arte').resolution, { kind: 'playable', url: 'https://example.invalid/de.m3u8' });
  assert.equal(parser.parseStreamDetail(fixture('artePlayerNoStreams'), 'arte').resolution.kind, 'unavailable');
  assert.ok(parser.parseStreamDetail(fixture('artePlayer'), 'arte').resolution.url.includes('.m3u8'));
  assert.deepEqual(parser.parseStreamDetail(fixture('dl-arte-age'), 'arte').resolution, { kind: 'ageRestricted', rating: 'FSK16' });
});

test('Robustheit: leere, kaputte und falsch typisierte Antworten', () => {
  for (const id of ['ard', 'zdf', 'arte']) {
    assert.equal(parser.parse('{}', id).length, 0);
    assert.throws(() => parser.parse('<html>', id), { code: 'invalidJSON' });
    assert.throws(() => parser.parse('', id));
    assert.throws(() => parser.parse('[]', id));
  }
  assert.equal(parser.parse('{}', 'unbekannt').length, 0);
  const json = '{"widgets":[{"teasers":[1,"x",{"id":5,"longTitle":null},{"id":"a"},{"id":"b","longTitle":"T","duration":"n/a"}]}],"results":"nope","data":{"a":1},"zones":[{"data":null}],"cluster":[{"teaser":7}],"stage":[null]}';
  for (const id of ['ard', 'zdf', 'arte']) assert.doesNotThrow(() => parser.parse(json, id));
  const ardEntries = parser.parse(json, 'ard');
  assert.deepEqual(ardEntries.map(e => e.id), ['b']);
  assert.equal(ardEntries[0].duration, null);
  assert.equal(parser.parseStreamDetail('[]', 'ard').resolution.kind, 'unavailable');
  assert.equal(parser.parseStreamDetail('', 'arte').resolution.kind, 'unavailable');
});

test('URL-Builder: Kodierung, Paging, Partner, ungültige Eingaben', () => {
  const url = sources.searchUrl('Tatort & Co+1 ä', 'ard');
  assert.ok(url.includes('searchString=Tatort%20%26%20Co%2B1%20%C3%A4'), url);
  assert.throws(() => sources.searchUrl('x', 'nope'), { code: 'unsupportedSource' });
  assert.ok(sources.homeUrl('zdf').endsWith('/mediathekV2/start-page'));
  assert.ok(!sources.searchUrl('Das Institut', 'ard').includes('vodPageNumber'));
  assert.ok(sources.searchUrl('Das Institut', 'ard', 2).includes('vodPageNumber=2'));
  assert.ok(sources.streamInfoUrl({ id: 'abc', sourceId: 'ard' }).includes('/pages/ard/item/abc'));
  assert.ok(sources.streamInfoUrl({ id: 'abc', sourceId: 'ard', partner: 'one' }).includes('/pages/one/item/abc'));
  assert.equal(sources.streamInfoUrl({ id: 'abc', sourceId: 'ard', partner: 'x/../y' }), null);
  assert.equal(sources.streamInfoUrl({ id: 'abc', sourceId: 'zdf' }), 'https://zdf-prod-futura.zdf.de/mediathekV2/document/abc');
  assert.equal(sources.streamInfoUrl({ id: 'abc', sourceId: 'x' }), null);
  assert.equal(sources.streamInfoUrl({ id: '', sourceId: 'zdf' }), null);
});

test('Host-Allowlist: nur https und Hosts der Sender', () => {
  assert.ok(sources.isAllowedApiUrl('https://api.ardmediathek.de/page-gateway/pages/ard/home'));
  assert.ok(!sources.isAllowedApiUrl('http://api.ardmediathek.de/x'));
  assert.ok(!sources.isAllowedApiUrl('https://api.ardmediathek.de.evil.example/x'));
  assert.ok(!sources.isAllowedApiUrl('https://user:pw@api.arte.tv/x'));
  assert.ok(sources.isAllowedFetchUrl('https://manifest-arte.akamaized.net/api/manifest/v1/x.m3u8'));
  assert.ok(!sources.isAllowedFetchUrl('https://evilakamaized.net/x'));
  assert.ok(!sources.isAllowedFetchUrl('https://127.0.0.1/x'));
  assert.ok(!sources.isAllowedFetchUrl('file:///etc/passwd'));
});

test('ARD-Item-ID, Grouping-ID, Partner aus Ziel-Link', () => {
  assert.equal(ard.ardItemId('https://api.ardmediathek.de/page-gateway/pages/wdr/item/ABC?devicetype=pc&embedded=true'), 'ABC');
  assert.equal(ard.ardItemId('https://api.ardmediathek.de/page-gateway/pages/ard/grouping/ABC?embedded=true'), null);
  assert.equal(ard.ardItemId('https://www.zdf.de/live-tv'), null);
  assert.equal(ard.ardPartner('https://api.ardmediathek.de/page-gateway/pages/wdr/item/ABC'), 'wdr');
  assert.equal(ard.ardGroupingUrl('https://api.ardmediathek.de/page-gateway/pages/ard/grouping/ABC'), 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/ABC?embedded=true');
});

test('ARD-Suchseite: Serien, zusammengeführte OV, Paging', () => {
  const page = parser.parseSearchPage(fixture('ardSearchInstitut'), 'ard');
  assert.equal(page.series.length, 2);
  const [series] = page.series;
  assert.equal(series.title, 'Das Institut');
  assert.equal(series.sourceId, 'ard');
  assert.ok(series.groupingURL.includes('/pages/zdf/grouping/'));
  assert.ok(series.groupingURL.includes('embedded=true'));
  assert.ok(!series.imageUrl.includes('{width}'));
  assert.equal(page.hasMore, true);
  assert.equal(page.entries.length, 4); // 6 Treffer, 2 davon OV zusammengefasst
  assert.ok(!page.entries.some(e => e.title.includes('Originalversion')));
  const ep8 = page.entries.find(e => e.title.includes('S10/E08'));
  assert.ok(ep8.originalVersionId);
  assert.equal(ep8.season, 10);
  assert.equal(ep8.episode, 8);
  assert.equal(ep8.partner, 'one');
  assert.deepEqual(parser.parseSearchPage(fixture('ardSearchInstitut'), 'ard', 1).series, []); // Folgeseiten ohne Serien
});

test('ARD-Suchseite: letzte Seite hat kein Weiteres', () => {
  const page = parser.parseSearchPage('{"vodPageNumber":1,"vodPageSize":24,"vodTotal":30,"vodResults":[],"showResults":[]}', 'ard', 1);
  assert.equal(page.hasMore, false);
  assert.throws(() => parser.parseSearchPage('x', 'ard'));
});

test('ARD-Serienfolgen: ohne Trailer/OV, nach Staffel gruppiert', () => {
  const episodes = parser.parseArdGrouping(fixture('ardGroupingMurdoch'));
  assert.ok(!episodes.some(e => e.title.startsWith('Trailer')));
  assert.ok(!episodes.some(e => e.title.includes('Originalversion')));
  assert.equal(episodes.length, 3);
  const seasons = groupBySeason(episodes);
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].number, 10);
  assert.deepEqual(seasons[0].entries.map(e => e.episode), [1, 7, 8]);
});

test('groupBySeason: Reihenfolge, Folgen ohne Staffel zuletzt', () => {
  const result = groupBySeason([entry({ id: 'x' }), entry({ id: 'b', season: 2, episode: 1 }), entry({ id: 'a', season: 1, episode: 2 }), entry({ id: 'c', season: 1, episode: 1 })]);
  assert.deepEqual(result.map(s => s.number), [1, 2, null]);
  assert.deepEqual(result[0].entries.map(e => e.id), ['c', 'a']);
});

test('OV/AD: verwaiste Variante bleibt, Dubletten mit Original zusammengefasst', () => {
  const orphan = entry({ id: 'ov', title: 'Nur Original - (Originalversion)', sourceId: 'ard' });
  assert.deepEqual(mergeOriginalVersions([orphan]).map(e => e.id), ['ov']);
  const root = {
    widgets: [
      {
        teasers: [
          { id: 'a1', coreAssetType: 'EPISODE', longTitle: 'Die Entführung (S01/E01)', availableTo: '2027-09-24T21:59:00Z', links: { target: { href: 'https://api.ardmediathek.de/page-gateway/pages/zdf/item/a1?embedded=true' } } },
          { id: 'a1ad', coreAssetType: 'EPISODE', longTitle: 'Die Entführung (S01/E01) (Audiodeskription)', availableTo: '2027-09-24T21:59:00Z', links: { target: { href: 'https://api.ardmediathek.de/page-gateway/pages/zdf/item/a1ad?embedded=true' } } },
          { id: 'b1ad', coreAssetType: 'EPISODE', longTitle: 'Waise (S01/E02) (Audiodeskription)', links: { target: { href: 'https://api.ardmediathek.de/page-gateway/pages/zdf/item/b1ad?embedded=true' } } },
        ],
      },
    ],
  };
  const episodes = parser.parseArdGrouping(root);
  assert.deepEqual(episodes.map(e => e.id), ['a1', 'b1ad']);
  assert.equal(episodes[0].audioDescriptionId, 'a1ad');
  assert.equal(episodes[0].originalVersionId, null);
  assert.equal(episodes[0].availableUntil, '2027-09-24T21:59:00.000Z');
  assert.equal(episodes[1].availableUntil, null);
});

test('ZDF: Audiodeskription zusammengefasst, Verfügbar-bis mit Zeitzonenversatz', () => {
  const json = { results: [{ id: 'z1', type: 'video', contentType: 'episode', titel: 'Das große Telefon', hasVideo: true, offlineAvailability: '2027-09-24T23:59:00.000+02:00' }, { id: 'z1-ad', type: 'video', contentType: 'episode', titel: 'Das große Telefon (Audiodeskription)', hasVideo: true }] };
  const result = parser.parse(json, 'zdf');
  assert.deepEqual(result.map(e => e.id), ['z1']);
  assert.equal(result[0].audioDescriptionId, 'z1-ad');
  assert.equal(result[0].availableUntil, '2027-09-24T21:59:00.000Z');
});

test('arte: Verfügbar-bis aus availability.end', () => {
  const json = { data: [{ type: 'teaser', title: 'X', programId: 'p1', availability: { start: '2026-10-19T03:00:00Z', end: '2027-10-19T03:00:00Z' } }] };
  assert.equal(parser.parse(json, 'arte')[0].availableUntil, '2027-10-19T03:00:00.000Z');
});

test('Staffel/Folge aus dem Titel', () => {
  assert.deepEqual(seasonEpisodeInTitle('Das Institut (S10/E08)'), { season: 10, episode: 8 });
  assert.equal(seasonEpisodeInTitle('Ohne Nummer'), null);
});

test('ARD-Home-Abschnitte: Titel, Serien, übersprungene Typen', () => {
  const sections = parser.parseSections(fixture('ardHomeSections'), 'ard');
  const titles = sections.map(s => s.title);
  assert.ok(titles.includes('Unsere Top-Serien'));
  assert.ok(!titles.includes('Unsere TV-Programme live'));
  assert.ok(!titles.includes('Menü'));
  assert.ok(sections.find(s => s.title === 'Unsere Top-Serien').series.length > 0);
  assert.ok(sections.every(s => s.entries.length || s.series.length));
});

test('ZDF-/arte-Abschnitte; ungültiges JSON wirft', () => {
  assert.ok(parser.parseSections(fixture('zdfHome'), 'zdf').length > 0);
  assert.ok(parser.parseSections(fixture('arteHomeGenres'), 'arte').length > 0);
  assert.throws(() => parser.parseSections('x', 'ard'), { code: 'invalidJSON' });
  // ohne erkennbare Struktur: eine Sektion "Neu & beliebt"
  const flat = parser.parseSections({ results: [{ id: 'z', type: 'video', titel: 'T' }] }, 'zdf');
  assert.deepEqual(flat.map(s => s.title), ['Neu & beliebt']);
});

test('arte: Genre-Reihe steht oben, sechs Genres mit Codes (Slug-Rückfall)', () => {
  const sections = parser.parseSections(fixture('arteHomeGenres'), 'arte');
  const genres = sections[0];
  assert.equal(genres.title, 'Genres');
  assert.ok(!genres.entries.length && !genres.series.length);
  assert.deepEqual(genres.genres.map(g => g.id), ['ACT', 'DOR', 'SER', 'CIN', 'ARTE_CONCERT', 'EMI']);
  assert.deepEqual(genres.genres.map(g => g.title), ['Info', 'Dokus', 'Serien', 'Filme', 'Konzerte', 'Sendungen']);
  assert.ok(genres.genres.every(g => g.imageUrl));
});

test('arte: Genre-Code aus Deeplink/Slug, Fremdhosts und Pfadtricks abgelehnt', () => {
  assert.equal(arte.arteGenreCode('arte://emac/DOR', null), 'DOR');
  assert.equal(arte.arteGenreCode('arte://emac/arte_concert', null), 'ARTE_CONCERT');
  assert.equal(arte.arteGenreCode(null, 'https://www.arte.tv/de/videos/geschichte/'), 'HIS');
  assert.equal(arte.arteGenreCode(null, 'https://www.arte.tv/de/arte-concert'), 'ARTE_CONCERT');
  assert.equal(arte.arteGenreCode(null, 'https://www.arte.tv/de/newsletter/'), null);
  assert.equal(arte.arteGenreCode(null, 'https://evil.example/de/videos/geschichte/'), null);
  assert.equal(arte.arteGenreCode('arte://emac/../x', null), null);
});

test('arte: Genre-Seite klassifiziert Teaser, Nachladen nur über Emac-URLs', () => {
  const rows = parser.parseArteGenrePage(fixture('arteGenrePage'));
  const topics = rows.find(r => r.title === 'Alle Dokus nach Themen');
  assert.deepEqual(topics.genres.map(g => g.id), ['HIS', 'SCI', 'DEC', 'CPO', 'ACT']);
  assert.equal(topics.entries.length, 0);
  const highlights = rows.find(r => r.title === 'Unsere Doku-Highlights');
  assert.deepEqual(highlights.series.map(s => s.id), ['RC-023814', 'RC-027810', 'RC-028280']);
  assert.equal(highlights.series[0].groupingURL, 'https://api.arte.tv/api/emac/v3/de/web/pages/RC-023814/');
  assert.equal(highlights.series[0].sourceId, 'arte');
  assert.equal(highlights.entries[0].id, '114598-000-A');
  assert.ok(highlights.nextPage);
  assert.ok(!rows.flatMap(r => r.entries).some(e => e.id.startsWith('RC-')));
});

test('arte: EXTERNAL ohne Code wird verworfen', () => {
  const json = '{"zones":[{"title":"Z","code":{"name":"x"},"data":[{"type":"teaser","title":"Newsletter","kind":{"code":"EXTERNAL"},"url":"https://www.arte.tv/de/newsletter/"}]}]}';
  assert.deepEqual(parser.parseArteGenrePage(json), []);
  assert.deepEqual(parser.parse(json, 'arte'), []);
});

test('arte: Nachladen-Reihe und URL-Prüfung', () => {
  const more = parser.parseArteMore(fixture('arteMore'), 'X');
  assert.equal(more.title, 'X');
  assert.ok(more.series.length > 0);
  assert.ok(arte.isValidArteApiUrl(more.nextPage));
  assert.equal(parser.parseArteMore('{"data":[],"nextPage":"https://evil.example/api/emac/v3/de/web/data/X/"}', 'X').nextPage, null);
  assert.ok(!arte.isValidArteApiUrl('http://api.arte.tv/api/emac/v3/de/web/pages/DOR/'));
  assert.ok(!arte.isValidArteApiUrl('https://api.arte.tv.evil.example/api/emac/v3/de/web/pages/DOR/'));
  assert.ok(!arte.isValidArteApiUrl('https://api.arte.tv/other/path'));
});

test('arte: Sammlungszonen (Staffeln) und Videos', () => {
  const zones = parser.parseArteCollection(fixture('arteCollectionSeasons'));
  assert.equal(zones.length, 2);
  assert.ok(zones.every(z => z.isSubcollection));
  assert.equal(zones[0].entries.length, 2);
  assert.equal(zones[0].nextPage, null);
  assert.ok(zones[1].nextPage);
  const videos = parser.parseArteCollection(fixture('arteCollectionVideos'));
  assert.equal(videos[0].isSubcollection, false);
  assert.deepEqual(videos[0].entries.map(e => e.id), ['101352-000-A', '111712-000-A']);
});

test('arte: Seiten-URL und Suche mit Serien', () => {
  assert.equal(parser.arteGenrePageUrl('DOR'), 'https://api.arte.tv/api/emac/v3/de/web/pages/DOR/');
  assert.equal(parser.arteGenrePageUrl('../x'), null);
  const json = '{"data":[{"type":"teaser","title":"S","kind":{"code":"TV_SERIES","isCollection":true},"programId":"RC-1","deeplink":"arte://collection/RC-1"},{"type":"teaser","title":"V","kind":{"code":"SHOW"},"programId":"1-000-A"}]}';
  const page = parser.parseSearchPage(json, 'arte');
  assert.deepEqual(page.series.map(s => s.id), ['RC-1']);
  assert.deepEqual(page.entries.map(e => e.id), ['1-000-A']);
  assert.equal(page.hasMore, false);
});

test('ZDF-Suche: Marken als Serien, Folgen, ohne nextPage kein Nachladen', () => {
  const page0 = parser.parseSearchPage(fixture('zdfSearch'), 'zdf');
  assert.equal(page0.entries.length, 1);
  assert.deepEqual(page0.series.map(s => s.id), ['heute-journal-104']);
  assert.equal(page0.hasMore, false);
});

test('ZDF-Suche mit Paging: nextPage + nextPageUrl nur für die ZDF-Suche der API', () => {
  const page = parser.parseSearchPage(fixture('zdfSearchPage1'), 'zdf', 0);
  assert.deepEqual(page.series.map(s => s.id), ['der-bergdoktor-106']);
  assert.deepEqual(page.entries.map(e => e.id), ['neuanfaenge-110', 'hoehenflug-100']);
  assert.equal(page.hasMore, true);
  assert.match(page.nextPageUrl, /^https:\/\/zdf-prod-futura\.zdf\.de\/mediathekV2\/search\?q=bergdoktor/);
  const last = parser.parseSearchPage(fixture('zdfSearchPageLast'), 'zdf', 1);
  assert.equal(last.hasMore, false);
  assert.equal(last.page, 1);
  for (const bad of ['https://evil.example/mediathekV2/search?q=x&page=2', 'http://zdf-prod-futura.zdf.de/mediathekV2/search?page=2', 'https://zdf-prod-futura.zdf.de/mediathekV2/document/x', 'kaputt']) {
    const root = JSON.stringify({ nextPage: true, nextPageUrl: bad, results: [{ id: 'a-100', type: 'video', contentType: 'episode', titel: 'A' }] });
    const result = parser.parseSearchPage(root, 'zdf', 0);
    assert.equal(result.hasMore, false, bad);
    assert.equal(result.nextPageUrl, null, bad);
  }
});

test('ZDF-Serie (brand): Staffel-Cluster mit Folgen, Extras/Fremdmarken/Clips entfallen, Staffel und Folge aus den Teasern', () => {
  const entries = parser.parseZdfEpisodes(fixture('zdfBrandBergdoktor'));
  assert.deepEqual(entries.map(e => e.id), ['neuanfaenge-110', 'hoehenflug-100', 'der-blick-nach-vorn-1-100', 'der-blick-nach-vorn-2-100', 'mein-freund-102']);
  assert.deepEqual(entries.map(e => [e.season, e.episode]), [[19, 1], [19, 2], [17, 1], [17, 1], [7, 4]]);
  assert.equal(entries[2].airedAt, '2024-01-05T19:15:00.000Z');
  assert.ok(entries.every(e => e.sourceId === 'zdf'));
  assert.deepEqual(groupBySeason(entries).map(g => g.number), [7, 17, 19]);
});

test('ZDF-Serie (topic): Cluster "<Reihe> - Staffel N" und namenlose Folgen-Cluster, "Auch interessant" nicht', () => {
  const entries = parser.parseZdfEpisodes(fixture('zdfTopicSchlachtfeld'));
  assert.deepEqual(entries.map(e => [e.id, e.season, e.episode]), [['marathon-100', 2, 1], ['hastings-100', 2, 4]]);
});

test('ZDF: Staffelzahl ab 1900 ist ein Jahr (keine Staffel, keine Folge), Zahlen als Text werden gelesen', () => {
  const { zdfSeasonEpisode } = require('../lib/mediathek/parser-zdf.js');
  assert.deepEqual(zdfSeasonEpisode({ seasonNumber: '2025', episodeNumber: '28' }), { season: null, episode: null });
  assert.deepEqual(zdfSeasonEpisode({ seasonNumber: '1900', episodeNumber: '3' }), { season: 1900, episode: 3 });
  assert.deepEqual(zdfSeasonEpisode({ seasonNumber: '3', episodeNumber: '04' }), { season: 3, episode: 4 });
  assert.deepEqual(zdfSeasonEpisode({ seasonNumber: '0' }), { season: null, episode: null });
  assert.deepEqual(zdfSeasonEpisode({ seasonNumber: '4' }), { season: 4, episode: null });
  assert.deepEqual(zdfSeasonEpisode({}), { season: null, episode: null });
});

test('ZDF-Startseite: Marken/Themen als Serienkarten (ohne Video-lose), A–Z als Rubrik-Kachel, Live/Sendung verpasst fehlen', () => {
  const sections = parser.parseSections(fixture('zdfHomeSerien'), 'zdf');
  assert.deepEqual(sections.map(s => s.title), ['Rubriken', 'Top-Serien zum Streamen', 'Doku-Reihen']);
  assert.deepEqual(sections[0].genres.map(g => [g.id, g.title]), [['serien-100', 'Serien'], ['sendungen-100', 'Sendungen A–Z']]);
  assert.deepEqual(sections[1].series.map(s => s.id), ['the-veil-112', 'tschappel-100']);
  assert.equal(sections[1].series[0].description, 'Agentin im Einsatz');
  assert.deepEqual(sections[2].series.map(s => s.id), ['schlachtfeld-100']);
  assert.deepEqual(sections[2].entries.map(e => e.id), ['ein-film-100']);
  const ids = JSON.stringify(sections);
  assert.ok(!ids.includes('epg-livetv') && !ids.includes('sendung-verpasst'));
});

test('ZDF A–Z: je Buchstabe eine Reihe aus Serien', () => {
  const sections = parser.parseGenrePage(fixture('zdfAz'), 'zdf');
  assert.deepEqual(sections.map(s => [s.title, s.series.map(x => x.id)]), [['A', ['aktenzeichen-xy-100']], ['B', ['der-bergdoktor-106', 'die-welt-der-antike-100']], ['0 - 9', ['3sat-100']]]);
});

test('OV-Zusammenführung: geschütztes Leerzeichen im Titel wird wie ein Leerzeichen behandelt', () => {
  const merged = mergeOriginalVersions([entry({ id: 'a', title: 'Titel X' }), entry({ id: 'o', title: 'Titel X - (Originalversion)' })]);
  assert.deepEqual(merged.map(e => e.id), ['a']);
  assert.equal(merged[0].originalVersionId, 'o');
});

test('ARD-Suche: zdf/arte-Fremdinhalte (Einzelfilm, Magazin) und Einzelvideos ohne Folgen entfallen, Serien mit abrufbaren Folgen bleiben', () => {
  const page = parser.parseSearchPage(fixture('ardSearchForeign'), 'ard');
  assert.deepEqual(page.series.map(item => item.title), ['Exorzismus-Doku', 'ZDF-Serie bei ARD']);
  assert.deepEqual(page.entries, []);
});
