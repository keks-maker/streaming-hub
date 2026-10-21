'use strict';

// Tests: Rubriken (ARD, ZDF) und Genres (arte) als Seiten: Kennungen/Adressen, Rubrik-Reihe der Startseiten, Rubrikseiten mit
// Unterrubriken, Fremdinhalt-/Dubletten-/Trailer-Filter, Nachladen (ARD-Widgets), Validierung. Fixtures: gekürzte Strukturen der
// echten Antworten (tests/fixtures/mediathek/ard*Rubrik*, zdf*Rubrik*, ardWidgetMore). Keine Netzzugriffe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const parser = require('../lib/mediathek/parser.js');
const genres = require('../lib/mediathek/genre-pages.js');
const v = require('../lib/mediathek/validation.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { isAllowedApiUrl } = require('../lib/mediathek/sources.js');

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

test('Kennungen und Adressen: ARD/ZDF/arte, Pfadtricks und Fremdquellen abgelehnt', () => {
  assert.equal(genres.genrePageUrl({ sourceId: 'ard', id: 'ard/editorial/filme' }), 'https://api.ardmediathek.de/page-gateway/pages/ard/editorial/filme?embedded=true');
  assert.equal(genres.genrePageUrl({ sourceId: 'ard', id: 'br/compilation/6fIicPgZFD9kQMnuCiXlUb' }), 'https://api.ardmediathek.de/page-gateway/pages/br/compilation/6fIicPgZFD9kQMnuCiXlUb?embedded=true');
  assert.equal(genres.genrePageUrl({ sourceId: 'zdf', id: 'filme-104' }), 'https://zdf-prod-futura.zdf.de/mediathekV2/document/filme-104');
  assert.equal(genres.genrePageUrl({ sourceId: 'arte', id: 'DOR' }), 'https://api.arte.tv/api/emac/v3/de/web/pages/DOR/');
  for (const bad of [
    { sourceId: 'ard', id: 'ard/editorial/../x' },
    { sourceId: 'ard', id: 'ard/item/abc' },
    { sourceId: 'ard', id: 'filme' },
    { sourceId: 'zdf', id: '../x' },
    { sourceId: 'zdf', id: 'a/b' },
    { sourceId: 'arte', id: '../x' },
    { sourceId: 'rtl', id: 'x' },
    null,
  ]) assert.equal(genres.genrePageUrl(bad), null, JSON.stringify(bad));
  assert.equal(genres.ardGenreId('https://api.ardmediathek.de/page-gateway/pages/ard/editorial/filme?embedded=true'), 'ard/editorial/filme');
  assert.equal(genres.ardGenreId('https://evil.example/page-gateway/pages/ard/editorial/filme'), null);
  assert.equal(genres.ardGenreId('https://api.ardmediathek.de/page-gateway/pages/ard/item/abc'), null);
  assert.ok(isAllowedApiUrl(genres.genrePageUrl({ sourceId: 'ard', id: 'ard/editorial/filme' })));
  assert.ok(isAllowedApiUrl(genres.genrePageUrl({ sourceId: 'zdf', id: 'filme-104' })));
  assert.equal(genres.isArdWidgetUrl('https://api.ardmediathek.de/page-gateway/widgets/ard/editorials/x?pageNumber=1'), true);
  assert.equal(genres.isArdWidgetUrl('https://api.ardmediathek.de/page-gateway/pages/ard/home'), false);
  assert.equal(genres.isArdWidgetUrl('http://api.ardmediathek.de/page-gateway/widgets/x'), false);
  assert.equal(genres.isArdWidgetUrl('https://evil.example/page-gateway/widgets/x'), false);
});

test('ARD-Startseite: Reihe "Rubriken" steht zuerst, Menü bleibt ohne Reihe', () => {
  const sections = parser.parseSections(fixture('ardHomeRubriken'), 'ard');
  assert.deepEqual(sections.map(s => s.title), ['Rubriken', 'Unsere Top-Serien']);
  const rubrics = sections[0];
  assert.deepEqual(rubrics.genres.map(g => g.title), ['Alle Rubriken', 'Filme', 'Serien', 'Kinder & Familie']);
  assert.deepEqual(rubrics.genres.map(g => g.id), ['ard/compilation/alle-rubriken', 'ard/editorial/filme', 'ard/editorial/serien', 'ard/editorial/kinderfamilie']);
  assert.ok(rubrics.genres.every(g => g.sourceId === 'ard' && g.imageUrl && !g.imageUrl.includes('{width}')));
  assert.equal(rubrics.entries.length + rubrics.series.length, 0);
  assert.equal(rubrics.nextPage, null);
});

test('ARD-Rubrikseite: Unterrubriken ohne die Seite selbst, Fremdinhalt/Dublette/Trailer entfallen, Serien und Unterseiten', () => {
  const sections = parser.parseGenrePage(fixture('ardRubrikFilme'), 'ard');
  assert.deepEqual(sections.map(s => s.title), ['Unterrubriken', 'Neu verfügbare Film-Highlights', 'Beliebte Krimireihen']);
  assert.deepEqual(sections[0].genres.map(g => g.title), ['Krimi & Thriller', 'Komödie', 'Drama & Arthouse']);
  assert.ok(!sections[0].genres.some(g => g.id === 'ard/editorial/filme'));
  const highlights = sections[1];
  assert.equal(highlights.entries.length, 3); // 3 Folgen; ZDF-Spielfilm (Fremdinhalt) und Dublette entfallen
  assert.ok(!highlights.entries.some(e => e.title.includes('Erfundener ZDF')));
  assert.ok(highlights.entries.every(e => e.sourceId === 'ard' && e.id && !e.id.includes(':')));
  assert.equal(highlights.nextPage, 'https://api.ardmediathek.de/page-gateway/widgets/ard/editorials/5K9EyEcCXoCa0bd2GbUYSK%3A5391434829540709119?pageNumber=1&pageSize=5&embedded=true');
  const krimis = sections[2];
  assert.deepEqual(krimis.genres.map(g => g.id), ['ard/editorial/tatort', 'ard/editorial/polizeiruf-110', 'ard/compilation/6fIicPgZFD9kQMnuCiXlUb']);
  assert.equal(krimis.series.length, 2);
  assert.ok(!sections.some(s => s.title === 'Rubriken' || s.title.includes('Trailer')));
});

test('ARD "Alle Rubriken": Kachelseite aus der Compilation', () => {
  const sections = parser.parseGenrePage(fixture('ardRubrikAlle'), 'ard');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, 'Alle Rubriken');
  assert.ok(sections[0].genres.length >= 5);
  assert.ok(sections[0].genres.every(g => /^ard\/(editorial|compilation)\//.test(g.id)));
  assert.equal(sections[0].nextPage, null);
});

test('ARD-Nachladen: nächste Widget-Seite, Folgen ohne Dubletten, Ende ohne nextPage', () => {
  const more = parser.parseArdMore(fixture('ardWidgetMore'), 'Neu verfügbare Film-Highlights');
  assert.equal(more.title, 'Neu verfügbare Film-Highlights');
  assert.ok(more.entries.length > 0);
  assert.equal(more.nextPage, null); // letzte Seite (pageNumber 1, pageSize 5, 8 Treffer)
  assert.equal(more.entries.length, 4);
  assert.deepEqual(parser.parseArdMore({ teasers: [] }, 'x'), { title: 'x', entries: [], series: [], genres: [], nextPage: null });
});

test('ZDF-Startseite: Cluster "Rubriken" als Kacheln zuerst, nur Rubrik-Teaser', () => {
  const sections = parser.parseSections(fixture('zdfHomeRubriken'), 'zdf');
  assert.deepEqual(sections.map(s => s.title), ['Rubriken', 'Neu in der Mediathek']);
  assert.deepEqual(sections[0].genres.map(g => g.id), ['filme-104', 'serien-100', 'doku-wissen-104', 'krimi-102']);
  assert.deepEqual(sections[0].genres.map(g => g.title), ['Filme', 'Serien', 'Dokus & Reportagen', 'Krimi']);
  assert.ok(sections[0].genres.every(g => g.sourceId === 'zdf' && /^https:\/\/www\.zdf\.de\/assets\//.test(g.imageUrl)));
  assert.equal(sections[1].genres.length, 0);
});

test('ZDF-Rubrikseite: Videos mit Dublettenfilter, Marken ohne Videos entfallen, Unterrubrik ohne die Rubrik selbst', () => {
  const sections = parser.parseGenrePage(fixture('zdfRubrikFilme'), 'zdf');
  assert.deepEqual(sections.map(s => s.title), ['Komödien', 'Mehr entdecken']);
  assert.deepEqual(sections[0].entries.map(e => e.id), ['ein-schrecklich-reiches-paar-102', 'lehrer-kann-jeder-102', 'mit-der-tuer-ins-haus-102']);
  assert.ok(sections[0].entries.every(e => e.sourceId === 'zdf'));
  assert.deepEqual(sections[1].genres.map(g => g.id), ['doku-wissen-unterrubrik-100']);
  assert.equal(sections[1].entries.length, 0);
});

test('Service: Rubrikseiten je Quelle über die gebauten Adressen, Nachladen ARD-Widget und arte', async () => {
  const http = fakeHttp(url => {
    if (url.includes('/pages/ard/editorial/filme')) return fixture('ardRubrikFilme');
    if (url.includes('/widgets/ard/')) return fixture('ardWidgetMore');
    if (url.includes('/mediathekV2/document/filme-104')) return fixture('zdfRubrikFilme');
    throw Object.assign(new Error('weg'), { code: 'network' });
  });
  const service = createMediathekService({ http });
  const ard = await service.fetchGenrePage({ id: 'ard/editorial/filme', title: 'Filme', sourceId: 'ard' });
  assert.equal(ard[1].entries.length, 3);
  const zdf = await service.fetchGenrePage({ id: 'filme-104', title: 'Filme', sourceId: 'zdf' });
  assert.equal(zdf[0].title, 'Komödien');
  assert.equal(http.calls[0], 'https://api.ardmediathek.de/page-gateway/pages/ard/editorial/filme?embedded=true');
  assert.equal(http.calls[1], 'https://zdf-prod-futura.zdf.de/mediathekV2/document/filme-104');
  const more = await service.fetchMore(ard[1]);
  assert.equal(more.title, ard[1].title);
  assert.ok(more.entries.length > 0);
  await assert.rejects(service.fetchGenrePage({ id: 'ard/editorial/../x', title: 'x', sourceId: 'ard' }), { code: 'invalidURL' });
  await assert.rejects(service.fetchGenrePage({ id: 'filme-104', title: 'x', sourceId: 'ard' }), { code: 'invalidURL' });
  await assert.rejects(service.fetchGenrePage({ id: 'x', title: 'x', sourceId: 'rtl' }), { code: 'invalidURL' });
  await assert.rejects(service.fetchMore({ title: 'x', nextPage: 'https://evil.example/page-gateway/widgets/ard/x' }), { code: 'invalidURL' });
  await assert.rejects(service.fetchMore({ title: 'x', nextPage: 'https://api.ardmediathek.de/page-gateway/pages/ard/home' }), { code: 'invalidURL' });
  await assert.rejects(service.fetchGenrePage({ id: 'ard/editorial/unbekannt', title: 'x', sourceId: 'ard' }), { code: 'network' });
});

test('Service: ungültige Antwort einer Rubrikseite ergibt fetchFailed', async () => {
  const service = createMediathekService({ http: fakeHttp(() => 'kein json') });
  await assert.rejects(service.fetchGenrePage({ id: 'filme-104', title: 'Filme', sourceId: 'zdf' }), { code: 'fetchFailed' });
});

test('Validierung: Genre je Quelle, Fremdfelder und Nachlade-Adressen', () => {
  assert.deepEqual(v.validateGenre({ genre: { id: 'ard/editorial/filme', title: 'Filme', imageUrl: null, sourceId: 'ard' } }).genre.id, 'ard/editorial/filme');
  assert.equal(v.validateGenre({ genre: { id: 'filme-104', sourceId: 'zdf' } }).genre.title, 'filme-104');
  assert.equal(v.validateGenre({ genre: { id: 'DOR', sourceId: 'arte' } }).genre.sourceId, 'arte');
  assert.throws(() => v.validateGenre({ genre: { id: 'DOR', sourceId: 'ard' } }), /Genre-ID/);
  assert.throws(() => v.validateGenre({ genre: { id: 'ard/editorial/..', sourceId: 'ard' } }));
  assert.throws(() => v.validateGenre({ genre: { id: '../x', sourceId: 'zdf' } }));
  assert.throws(() => v.validateGenre({ genre: { id: 'filme-104', sourceId: 'rtl' } }), /Mediathek/);
  assert.throws(() => v.validateGenre({ genre: { id: 'filme-104', sourceId: 'zdf', url: 'https://x.test' } }), /Unbekanntes Feld/);
  const ok = v.validateLoadMore({ section: { title: 'T', nextPage: 'https://api.ardmediathek.de/page-gateway/widgets/ard/editorials/x?pageNumber=1' } });
  assert.equal(ok.section.title, 'T');
  assert.throws(() => v.validateLoadMore({ section: { title: 'T', nextPage: 'https://evil.example/page-gateway/widgets/ard/x' } }));
  assert.throws(() => v.validateLoadMore({ section: { title: 'T', nextPage: 'https://zdf-prod-futura.zdf.de/mediathekV2/document/filme-104' } }));
});
