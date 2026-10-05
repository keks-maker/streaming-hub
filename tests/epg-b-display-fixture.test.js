'use strict';

// Tests: Fixture der Anzeige B (Etappe 3.6) — alle B-Felder kommen durch den echten Parser, Lücken bleiben Lücken,
// bösartige Werte sind nur Text und unzulässige Icons werden schon im Parser verworfen (zweite Sicherung: safeIconUrl).
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const { XmltvStreamParser } = require('../lib/epg/xmltv-stream-parser.js');
const { normalizeGenre } = require('../lib/epg/genre.js');
const fixture = require('./helpers/epg-b-display-fixture.js');
const detail = require('../epg-detail-model.js');

const BASE = Date.UTC(2026, 9, 5, 18, 0);

function parse(xml) {
  const items = [];
  const parser = new XmltvStreamParser({ onProgramme: p => items.push(p) });
  parser.write(xml);
  parser.end();
  return items;
}

const items = parse(fixture.buildDisplayXmltv({ baseMs: BASE }));
const byTitle = title => items.find(p => p.title === title);

test('Fixture: alle B-Felder des vollen Eintrags kommen an', () => {
  const p = byTitle('Krimi Voll');
  assert.equal(p.subtitle, 'Der Untertitel & mehr');
  assert.equal(p.year, 2019);
  assert.equal(p.episode, 'S2 E3');
  assert.equal(p.rating, 'FSK 12');
  assert.equal(p.icon, `${fixture.IMG_HOST}/p/krimi.png`);
  assert.deepEqual(p.credits.director, ['Regie Eins']);
  assert.equal(p.credits.actor.length, 6);
  assert.equal(normalizeGenre(p.categories), 'film');
  assert.equal(detail.castLine(p.credits), 'Regie: Regie Eins · Mit: Darsteller 1, Darsteller 2, Darsteller 3 … + 3 weitere');
});

test('Fixture: Genres der Chips sind alle vertreten (außer „Show“-Lücke durch bösartigen Eintrag) und ein Eintrag hat keines', () => {
  const genres = new Set(items.map(p => normalizeGenre(p.categories)));
  for (const g of ['film', 'sport', 'news', 'doku', 'serie', 'kinder', 'show', 'musik']) assert.ok(genres.has(g), g);
  assert.equal(normalizeGenre(byTitle('Genre unbekannt').categories), '');
  assert.equal(normalizeGenre(byTitle('Ohne Felder').categories), '');
});

test('Fixture: Lücken — Eintrag ohne Felder bleibt neutral', () => {
  const p = byTitle('Ohne Felder');
  assert.deepEqual({ subtitle: p.subtitle, icon: p.icon, year: p.year, episode: p.episode, rating: p.rating }, { subtitle: '', icon: '', year: 0, episode: '', rating: '' });
  assert.equal(detail.castLine(p.credits), '');
});

test('Fixture: bösartige Werte sind nur Text; javascript:-/data:-Icons erreichen den Renderer nie', () => {
  const evil = items.find(p => p.title.startsWith('<img'));
  assert.equal(evil.title, '<img src=x onerror=window.__pwned=1> & Co');
  assert.equal(evil.subtitle, '<b>fett</b>');
  assert.equal(evil.credits.actor[0], '<script>window.__pwned=1</script>');
  assert.equal(evil.icon, '', 'javascript: wird im Parser verworfen');
  assert.equal(byTitle('Icon data').icon, '', 'data: wird im Parser verworfen');
  // zweite Sicherung im Renderer
  assert.equal(detail.safeIconUrl('javascript:window.__pwned=1'), '');
  assert.equal(detail.safeIconUrl('data:image/png;base64,AAAA'), '');
});

test('Fixture: „Läuft auch“ — sieben weitere Tatort-Termine neben dem von Genre Eins', () => {
  const tatorts = items.filter(p => p.title === 'Tatort');
  assert.equal(tatorts.length, 8);
  assert.equal(new Set(tatorts.map(p => p.icon)).size, 8, 'eindeutige Bild-URLs');
});

test('Fixture: http-Icon wird vom Parser angenommen (die CSP des Renderers lässt dann nur https zu)', () => {
  assert.equal(byTitle('Icon http').icon, 'http://img.e2e.invalid/http.png');
});

test('Thumbnail-Fixture: drei Sendungen je Sender, eindeutige Bild-URLs', () => {
  const thumbItems = parse(fixture.buildThumbXmltv({ baseMs: BASE, channels: 10 }));
  assert.equal(thumbItems.length, 30);
  assert.equal(new Set(thumbItems.map(p => p.icon)).size, 30);
  assert.ok(thumbItems.every(p => p.icon.startsWith(`${fixture.IMG_HOST}/t/`)));
});
