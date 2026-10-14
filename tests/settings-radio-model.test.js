'use strict';

// Tests: Radio-Einstellungen R3 — Modelle (Suche/Filter/Sortierung/Reihenfolge/Zähler, Anpassungen, Validierungsmeldungen,
// Prüfergebnis-Texte) und die Verdrahtung (Navigation, Seitenmarkup, Senderverwaltung ohne Fallback).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stations = require('../settings-radio-stations-model.js');
const custom = require('../settings-radio-custom-model.js');
const logic = require('../lib/radio/radio-sources-logic.js');
const { SETTINGS_NAV, isValidPage } = require('../settings-view.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function fixture() {
  return [
    {
      id: 'de',
      name: 'Deutsche Radiosender',
      type: 'bundled',
      stations: [
        { id: 'koeln', name: 'Kölner Welle', streamUrl: 'http://k.test/s', genre: 'Pop', region: 'NRW' },
        { id: 'bayern', name: 'Süd Rock', streamUrl: 'http://b.test/s', genre: 'Rock', region: 'Bayern' },
        { id: 'strasse', name: 'Straße 1', streamUrl: 'http://s.test/s', genre: 'Schlager', region: 'Bayern' },
        { id: 'alt', name: 'Altsender', streamUrl: 'http://a.test/s', genre: 'Pop', region: 'NRW', removed: true },
      ],
      favorites: ['bayern', 'koeln', 'alt'],
      favoriteRank: { bayern: 0, koeln: 1, alt: 2 },
      stationOverrides: { koeln: { name: 'Köln Neu' } },
    },
    { id: 'eigene-radiosender', name: 'Eigene Sender', type: 'user', stations: [{ id: 'mine', name: 'Mein Sender', streamUrl: 'http://m.test/s', genre: 'Jazz' }], sortOrder: ['mine'] },
  ];
}
const names = list => list.map(s => s.name);

test('Suche: Name, Genre und Region; Groß-/Kleinschreibung, Umlaute und ß egal', () => {
  const s = fixture();
  assert.deepEqual(names(stations.filterStations(s, { query: 'koln' })), ['Köln Neu']);
  assert.deepEqual(names(stations.filterStations(s, { query: 'SÜD' })), ['Süd Rock']);
  assert.deepEqual(names(stations.filterStations(s, { query: 'strasse' })), ['Straße 1']);
  assert.deepEqual(names(stations.filterStations(s, { query: 'bayern' })), ['Süd Rock', 'Straße 1']);
  assert.deepEqual(names(stations.filterStations(s, { query: 'jazz' })), ['Mein Sender']);
  assert.equal(stations.filterStations(s, { query: 'xyz' }).length, 0);
  assert.deepEqual(names(stations.filterStations(s, { query: 'kölner' })), ['Köln Neu'], 'auch der gelieferte Name eines angepassten Senders findet ihn');
  assert.equal(stations.fold('  Ärger  Über  '), 'arger uber');
});

test('Filter Quelle, Genre und Region wirken zusammen mit Suche und Ansicht', () => {
  const s = fixture();
  assert.deepEqual(names(stations.filterStations(s, { sourceId: 'eigene-radiosender' })), ['Mein Sender']);
  assert.deepEqual(names(stations.filterStations(s, { genre: 'Pop' })), ['Köln Neu', 'Altsender']);
  assert.deepEqual(names(stations.filterStations(s, { region: 'Bayern', genre: 'Rock' })), ['Süd Rock']);
  assert.deepEqual(names(stations.filterStations(s, { view: 'favorites', region: 'NRW' })), ['Köln Neu', 'Altsender']);
});

test('Favoriten-Ansicht folgt der globalen Reihenfolge; Eigene Sender kommen nach ihrem Rang', () => {
  const s = fixture();
  assert.deepEqual(names(stations.filterStations(s, { view: 'favorites' })), ['Süd Rock', 'Köln Neu', 'Altsender']);
  const withMine = logic.setStationFavorite(s, 'eigene-radiosender', 'mine', true);
  assert.deepEqual(names(stations.filterStations(withMine, { view: 'favorites' })).at(-1), 'Mein Sender');
});

test('Zähler: „m Sender“ ohne Einschränkung, sonst „n von m Sendern“', () => {
  const s = fixture();
  assert.equal(stations.countText(5, 5), '5 Sender');
  assert.equal(stations.countText(1, 5), '1 von 5 Sendern');
  assert.equal(stations.totalInView(s, 'all'), 5);
  assert.equal(stations.totalInView(s, 'favorites'), 3);
});

test('Filterwerte: Genres, Regionen und Quellen alphabetisch, ohne Doppelte', () => {
  const f = stations.facets(fixture());
  assert.deepEqual(f.genres, ['Jazz', 'Pop', 'Rock', 'Schlager']);
  assert.deepEqual(f.regions, ['Bayern', 'NRW']);
  assert.deepEqual(f.sources.map(x => x.id), ['de', 'eigene-radiosender']);
});

test('Umsortieren: nur in der Favoritenansicht ohne Suche/Filter', () => {
  const base = { view: 'favorites', query: '', sourceId: '', genre: '', region: '' };
  assert.equal(stations.canReorder(base), true);
  assert.equal(stations.canReorder({ ...base, view: 'all' }), false);
  assert.equal(stations.canReorder({ ...base, query: 'a' }), false);
  assert.equal(stations.canReorder({ ...base, genre: 'Pop' }), false);
});

test('Reihenfolge: ▲▼ tauschen mit sichtbarem Nachbarn, „nicht mehr in der Liste“ behält den Platz', () => {
  const s = fixture();
  const list = stations.filterStations(s, { view: 'favorites' });
  const [rock, koeln] = list;
  assert.deepEqual(stations.moveFavorite(s, rock, 1).map(e => e.id), ['koeln', 'bayern', 'alt']);
  assert.deepEqual(stations.moveFavorite(s, koeln, -1).map(e => e.id), ['koeln', 'bayern', 'alt']);
  // Der Geist-Favorit ('alt') ist am Ende: nach unten ist für 'koeln' kein sichtbarer Nachbar mehr da
  assert.deepEqual(stations.moveFavorite(s, koeln, 1).map(e => e.id), ['bayern', 'koeln', 'alt']);
  assert.deepEqual(stations.favoritePosition(s, koeln), { index: 1, count: 2 });
  assert.deepEqual(stations.dropFavorite(s, { sourceId: 'de', id: 'koeln' }, { sourceId: 'de', id: 'bayern' }).map(e => e.id), ['koeln', 'bayern', 'alt']);
  assert.deepEqual(stations.removedFavorites(s).map(k => k.id), ['alt']);
});

test('Stern: neuer Favorit ans Ende, vorhandener wird entfernt', () => {
  const s = fixture();
  const strasse = stations.filterStations(s, { query: 'strasse' })[0];
  assert.deepEqual(stations.toggleFavoriteList(s, strasse).map(e => e.id), ['bayern', 'koeln', 'alt', 'strasse']);
  const koeln = stations.filterStations(s, { query: 'koln' })[0];
  assert.deepEqual(stations.toggleFavoriteList(s, koeln).map(e => e.id), ['bayern', 'alt']);
});

test('Anpassung: Entwurf zeigt Original und aktuelle Anpassung; Patch setzt nur Abweichungen', () => {
  const s = fixture();
  const info = stations.overrideDraft(s, { sourceId: 'de', stationId: 'koeln' });
  assert.equal(info.original.name, 'Kölner Welle');
  assert.equal(info.draft.name, 'Köln Neu');
  assert.equal(info.hasOverride, true);
  assert.equal(stations.overrideDraft(s, { sourceId: 'de', stationId: 'bayern' }).hasOverride, false);
  assert.equal(stations.overrideDraft(s, { sourceId: 'de', stationId: 'fehlt' }), null);
  const { original } = info;
  assert.deepEqual(stations.buildOverridePatch({ name: 'Köln Neu', logo: ' ', streamUrl: original.streamUrl }, original), { name: 'Köln Neu', logo: null, streamUrl: null });
  assert.deepEqual(stations.buildOverridePatch({ name: original.name, logo: 'https://x.test/l.png', streamUrl: 'http://neu.test/s' }, original), { name: null, logo: 'https://x.test/l.png', streamUrl: 'http://neu.test/s' });
});

test('Anpassung: Validierungsmeldungen je Feld (leer = Original ist erlaubt)', () => {
  assert.deepEqual(stations.validateOverrideDraft({ name: '', logo: '', streamUrl: '' }), {});
  const errors = stations.validateOverrideDraft({ name: 'x'.repeat(201), logo: 'ftp://x', streamUrl: 'nicht-url' });
  assert.match(errors.name, /zu lang/);
  assert.match(errors.logo, /http/);
  assert.match(errors.streamUrl, /http/);
  assert.match(stations.validateOverrideDraft({ streamUrl: 'http://u:p@x.test/s' }).streamUrl, /Zugangsdaten/);
});

test('Eigene Sender: Liste in Quellenreihenfolge, Genre-Vorschläge mit Standards und vorhandenen Genres', () => {
  const s = fixture();
  assert.deepEqual(custom.customStations(s).map(x => x.name), ['Mein Sender']);
  assert.deepEqual(custom.customStations([]).length, 0);
  const g = custom.genreSuggestions(s);
  for (const genre of ['Jazz', 'Schlager', 'Pop', 'Klassik']) assert.ok(g.includes(genre), genre);
  assert.equal(new Set(g).size, g.length);
});

test('Formularprüfung: Pflichtfelder und URL-Regeln wie im Main, klare Meldungen', () => {
  const empty = custom.validateStationForm({});
  assert.equal(empty.errors.name, 'Bitte einen Namen eingeben');
  assert.equal(empty.errors.streamUrl, 'Bitte eine Stream-URL eingeben');
  assert.match(custom.validateStationForm({ name: 'A', streamUrl: 'ftp://x.test/s' }).errors.streamUrl, /http:\/\/ oder https:\/\//);
  assert.match(custom.validateStationForm({ name: 'A', streamUrl: 'http://x.test/a b' }).errors.streamUrl, /Leer-/);
  assert.match(custom.validateStationForm({ name: 'A', streamUrl: 'http://u:p@x.test/s' }).errors.streamUrl, /Zugangsdaten/);
  assert.match(custom.validateStationForm({ name: 'A', streamUrl: 'http://x.test/s', logo: 'javascript:1' }).errors.logo, /Logo-URL/);
  assert.match(custom.validateStationForm({ name: 'A', streamUrl: 'http://x.test/s', genre: 'g'.repeat(101) }).errors.genre, /zu lang/);
  const ok = custom.validateStationForm({ name: '  Mein Sender ', streamUrl: ' http://localhost:8000/s ', logo: '', genre: ' Rock ' });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value, { name: 'Mein Sender', streamUrl: 'http://localhost:8000/s', logo: '', genre: 'Rock' });
  assert.deepEqual(custom.toAddInput(ok.value), { name: 'Mein Sender', streamUrl: 'http://localhost:8000/s', genre: 'Rock' });
  assert.deepEqual(custom.toUpdatePatch(ok.value, { name: 'Mein Sender', streamUrl: 'http://x.test/s', logo: 'https://l.test/l.png', genre: 'Rock' }), { streamUrl: 'http://localhost:8000/s', logo: '' });
});

test('Prüfergebnis: Erreichbarkeit, Format, Bitrate und Fehlerklartext', () => {
  assert.deepEqual(custom.probeResultText({ ok: true, kind: 'direct', contentType: 'audio/mpeg', bitrate: '128', icyName: 'Testradio' }), {
    ok: true,
    text: 'Erreichbar · Format: MP3 · 128 kbit/s · Sender meldet „Testradio“',
  });
  assert.match(custom.probeResultText({ ok: true, kind: 'hls', contentType: 'application/vnd.apple.mpegurl' }).text, /HLS/);
  assert.match(custom.probeResultText({ ok: true, kind: 'direct', contentType: 'audio/aacp' }).text, /AAC/);
  assert.match(custom.probeResultText({ ok: true, kind: 'direct', contentType: 'audio/ogg' }).text, /Ogg/);
  assert.match(custom.probeResultText({ ok: true, kind: 'direct', contentType: '', via: ['pls'] }).text, /Playlist \(pls\)/);
  assert.deepEqual(custom.probeResultText({ ok: false, error: 'Server antwortet mit HTTP 404' }), { ok: false, text: 'Nicht erreichbar: Server antwortet mit HTTP 404' });
  assert.equal(custom.probeResultText(null).ok, false);
});

test('Navigation: Gruppe „Radio“ mit drei Seiten nach LiveTV, jede Seite genau einmal im Markup', () => {
  const group = SETTINGS_NAV.find(entry => entry.key === 'radio');
  assert.equal(group.label, 'Radio');
  assert.deepEqual(group.children.map(c => c.page), ['radio-stations', 'radio-custom', 'radio-playback']);
  assert.equal(SETTINGS_NAV.findIndex(e => e.key === 'radio'), SETTINGS_NAV.findIndex(e => e.key === 'livetv') + 1);
  const html = read('index.html');
  for (const page of group.children.map(c => c.page)) {
    assert.ok(isValidPage(page));
    assert.equal(html.split(`data-settings-page="${page}"`).length - 1, 1, page);
  }
  for (const id of ['settingsRadioStationsRoot', 'settingsRadioCustomRoot', 'settingsRadioPlaybackRoot']) assert.ok(html.includes(`id="${id}"`), id);
});

test('Verdrahtung: Senderverwaltung öffnet die Seite ohne Fallback; Seiten laden beim Anzeigen', () => {
  const renderer = read('renderer.js');
  assert.ok(!renderer.includes('folgt in einer späteren Version'));
  assert.match(renderer, /function openRadioManagement\(\) \{\s*openSettingsPage\(RADIO_MANAGEMENT_PAGE\);\s*\}/);
  assert.match(renderer, /RADIO_MANAGEMENT_PAGE = 'radio-stations'/);
  assert.match(renderer, /page === 'radio-stations'\) settingsRadioStationsView\.refresh\(\)/);
  assert.match(renderer, /page === 'radio-custom'\) settingsRadioCustomView\.refresh\(\)/);
  assert.match(renderer, /page === 'radio-playback'\) settingsRadioPlaybackView\.refresh\(\)/);
});

test('Sicherheit: Nutzerdaten nie über innerHTML in die Radio-Einstellungsseiten', () => {
  for (const file of ['settings-radio-stations.js', 'settings-radio-custom.js', 'settings-radio-playback.js', 'settings-radio-dom.js']) {
    assert.ok(!/\.(innerHTML|outerHTML)\b|insertAdjacentHTML\(/.test(read(file)), file);
  }
});
