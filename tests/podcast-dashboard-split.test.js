'use strict';

// Tests: zweigeteiltes Podcast-Dashboard (Modell) — Auswahl, Filter „alle/ungehört“, Sortierung, bereinigte Auswahl nach dem
// Abbestellen, Abo-Liste mit „Alle neuen Episoden“; Vorschlagsliste der Suche (Katalog, abonnierte markiert); Verdrahtung.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dash = require('../podcast-dashboard-model.js');
const { sortEpisodeItems, normalizeSort, SORTS } = require('../podcast-episode-model.js');
const { formatChapterTime } = require('../podcast-format.js');

const NOW = Date.parse('2026-10-15T12:00:00Z');
const day = n => new Date(NOW - n * 24 * 3600 * 1000).toISOString();
const ep = (id, daysAgo, state = {}, extra = {}) => ({ id, title: `Folge ${id}`, pubDate: day(daysAgo), duration: 1800, state: { position: 0, duration: null, played: false, ...state }, ...extra });
const sub = (id, title, extra = {}) => ({ id, title, author: 'Autor', cover: null, feedUrl: `https://x.test/${id}.xml`, feed: { lastChecked: new Date(NOW - 60000).toISOString(), lastError: null }, ...extra });
const SUBS = [sub('a', 'Alpha'), sub('b', 'Beta')];
const EPISODES = {
  a: { episodes: [ep('a1', 2), ep('a2', 10), ep('a3', 1, { played: true }), ep('a4', 90), ep('a5', 80, { position: 300 })] },
  b: { episodes: [ep('b1', 5), ep('b2', 0.5)] },
};
const column = view => dash.episodeColumnModel({ subscriptions: SUBS, episodes: EPISODES, now: NOW, view });

test('Spalte rechts: Standard „Alle neuen Episoden“ zeigt die bisherige gemeinsame Liste, neueste zuerst', () => {
  const model = column(null);
  assert.equal(model.isAll, true);
  assert.equal(model.selection, dash.ALL_ID);
  assert.equal(model.heading, 'Alle neuen Episoden');
  assert.deepEqual(model.items.map(i => i.episodeId), ['b2', 'a1', 'b1', 'a2', 'a5']);
  assert.equal(model.filterVisible, false);
  assert.equal(model.canOpenShow, false);
  const same = dash.podcastDashboardModel({ subscriptions: SUBS, episodes: EPISODES, now: NOW });
  assert.deepEqual(same.newEpisodes.map(i => i.episodeId), model.items.map(i => i.episodeId), 'Dashboard-Modell nutzt dieselbe Liste');
});

test('Spalte rechts: Abo gewählt zeigt alle Episoden aus dem Cache (auch alte und gehörte); „nur ungehörte“ filtert', () => {
  const all = column({ selection: 'a', filter: 'all' });
  assert.equal(all.isAll, false);
  assert.equal(all.showId, 'a');
  assert.equal(all.heading, 'Alpha');
  assert.deepEqual(all.items.map(i => i.episodeId), ['a3', 'a1', 'a2', 'a5', 'a4']);
  assert.equal(all.canOpenShow, true);
  assert.equal(all.filterVisible, true);
  assert.equal(all.total, 5);
  assert.match(all.hint, /5 Episoden, davon 4 ungehört/);
  const unheard = column({ selection: 'a', filter: 'unheard' });
  assert.deepEqual(unheard.items.map(i => i.episodeId), ['a1', 'a2', 'a5', 'a4'], 'gehörte Episode entfällt, alte ungehörte bleiben');
  assert.match(unheard.hint, /4 ungehörte Episoden von 5 Episoden/);
  const allPlayed = dash.episodeColumnModel({ subscriptions: [SUBS[0]], episodes: { a: { episodes: [ep('x', 3, { played: true })] } }, now: NOW, view: { selection: 'a', filter: 'unheard' } });
  assert.deepEqual([allPlayed.items.length, allPlayed.emptyText], [0, 'Keine ungehörten Episoden. Alles gehört.']);
  const none = dash.episodeColumnModel({ subscriptions: [SUBS[0]], episodes: { a: { episodes: [] } }, now: NOW, view: { selection: 'a' } });
  assert.match(none.emptyText, /Noch keine Episoden geladen/);
});

test('Sortierung: neueste/älteste zuerst, Titel A–Z (natürlich, ohne Groß-/Kleinschreibung), stabil; Standard bei Unsinn', () => {
  assert.deepEqual(column({ selection: 'a', sort: 'oldest' }).items.map(i => i.episodeId), ['a4', 'a5', 'a2', 'a1', 'a3']);
  assert.deepEqual(column({ selection: 'a', sort: 'newest' }).items.map(i => i.episodeId), ['a3', 'a1', 'a2', 'a5', 'a4']);
  const titles = [{ title: 'Folge 10', time: 1 }, { title: 'folge 2', time: 2 }, { title: 'Äpfel', time: 3 }, { title: 'Zebra', time: 4 }];
  assert.deepEqual(sortEpisodeItems(titles, 'title').map(i => i.title), ['Äpfel', 'folge 2', 'Folge 10', 'Zebra']);
  assert.equal(titles[0].title, 'Folge 10', 'Eingabe bleibt unverändert');
  const equal = [{ title: 'x', time: 5, n: 1 }, { title: 'x', time: 5, n: 2 }];
  assert.deepEqual(sortEpisodeItems(equal, 'oldest').map(i => i.n), [1, 2], 'stabil bei gleichen Zeiten');
  assert.equal(normalizeSort('kaputt'), 'newest');
  assert.deepEqual(SORTS.map(s => s.value), ['newest', 'oldest', 'title']);
  const allList = column({ selection: dash.ALL_ID, sort: 'oldest' }).items.map(i => i.episodeId);
  assert.deepEqual(allList, ['a5', 'a2', 'b1', 'a1', 'b2'], 'auch die gemeinsame Liste ist umschaltbar');
});

test('Auswahl wird bereinigt: unbekanntes/abbestelltes Abo und ungültige Werte fallen auf Standard', () => {
  assert.deepEqual(dash.normalizeSelection({ selection: 'weg', filter: 'x', sort: 'y' }, SUBS), { selection: dash.ALL_ID, filter: 'all', sort: 'newest' });
  assert.deepEqual(dash.normalizeSelection({ selection: 'b', filter: 'unheard', sort: 'title' }, SUBS), { selection: 'b', filter: 'unheard', sort: 'title' });
  assert.deepEqual(dash.normalizeSelection(null, []), { selection: dash.ALL_ID, filter: 'all', sort: 'newest' });
  assert.equal(column({ selection: 'weg' }).isAll, true);
});

test('Abo-Liste: „Alle neuen Episoden“ zuerst mit Zahl, Abos mit Badge der ungehörten und Auswahlmarke', () => {
  const model = dash.podcastDashboardModel({ subscriptions: SUBS, episodes: EPISODES, now: NOW, view: { selection: 'b' } });
  assert.equal(model.allEntry.id, dash.ALL_ID);
  assert.equal(model.allEntry.unheard, 5);
  assert.equal(model.allEntry.selected, false);
  assert.equal(model.allEntry.author, '5 neue Episoden');
  assert.deepEqual(model.shows.map(s => [s.id, s.unheard, s.selected]), [['a', 3, false], ['b', 2, true]]);
  assert.match(model.shows[0].ariaLabel, /Episoden anzeigen$/);
  const empty = dash.podcastDashboardModel({ subscriptions: SUBS, episodes: { a: { episodes: [] }, b: { episodes: [] } }, now: NOW });
  assert.equal(empty.allEntry.author, 'Alles gehört');
  assert.equal(empty.allEntry.selected, true);
});

// ── Suche: Vorschläge ──

const CATALOG = [{ id: 'oeffentlich-rechtlich', podcasts: [
  { id: 'c1', name: 'Eins', author: 'DLF', feedUrl: 'https://c.test/1', cover: null },
  { id: 'c2', name: 'Zwei', author: 'DLF', feedUrl: 'https://c.test/2', cover: null },
  { id: 'c3', name: 'Drei', author: 'NDR', feedUrl: 'https://c.test/3', cover: null },
] }];

test('Suche-Vorschläge: aus dem Katalog, Vielfalt zuerst; abonnierte bleiben sichtbar, aber markiert (Leerzustand blendet sie aus)', () => {
  const subs = [{ id: 'x', catalogId: 'c1', feedUrl: 'https://c.test/1' }, { id: 'y', feedUrl: 'https://c.test/3' }];
  const withSubs = dash.popularCatalog(CATALOG, subs, 8, { includeSubscribed: true });
  assert.deepEqual(withSubs.map(e => [e.catalogId, e.subscribed]), [['c1', true], ['c3', true], ['c2', false]], 'Abo über catalogId oder Feed-Adresse erkannt');
  assert.match(withSubs[0].ariaLabel, /bereits abonniert/);
  assert.match(withSubs[2].ariaLabel, /abonnieren$/);
  assert.deepEqual(dash.popularCatalog(CATALOG, subs, 8).map(e => e.catalogId), ['c2'], 'Standardverhalten (Leerzustand) unverändert');
  assert.equal(dash.popularCatalog(CATALOG, [], 2, { includeSubscribed: true }).length, 2);
  assert.deepEqual(dash.popularCatalog(null, [], 8, { includeSubscribed: true }), []);
});

test('Verdrahtung: Suchansicht zeigt Vorschläge nur ohne Suchbegriff; Overlay/Kapitel/Farbe im Code und Stil', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const search = read('podcast-search-view.js');
  assert.match(search, /state\.status === 'idle' \? popularCatalog\(snap\.catalog, snap\.subscriptions, SUGGEST_COUNT, \{ includeSubscribed: true \}\)/);
  const css = read('styles.css');
  assert.match(css, /\.podcast-overlay \{[^}]*z-index:125/);
  assert.match(css, /\.podcast-split \{ display:grid/);
  assert.match(read('renderer.js'), /key: 'podcasts', label: 'Podcasts', icon: 'podcast-icon.png', color: '#5af2a6'/);
  assert.match(read('renderer.js'), /key: 'livetv', label: 'LiveTV', icon: 'tv-icon.png', color: '#8b5cf6'/, 'LiveTV unverändert');
  for (const file of ['podcast-episode-overlay-view.js', 'podcast-dashboard-view.js', 'podcast-suggestions-view.js', 'podcast-episode-list-view.js']) {
    const code = read(file);
    assert.doesNotMatch(code.replace(/innerHTML = (icon|ICON_[A-Z]+); \/\/ statisches SVG/g, ''), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, `${file}: kein HTML aus Feeds`);
  }
  assert.equal(formatChapterTime(3725), '1:02:05');
  assert.equal(formatChapterTime(65), '1:05');
  assert.equal(formatChapterTime(-3), '0:00');
});

test('Farben: Podcasts-Akzent ist auch bei Rot-Grün-/Blau-Gelb-Schwäche von allen anderen Kacheln unterscheidbar und erreicht AA', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const colors = Object.fromEntries([...renderer.matchAll(/\{ key: '(\w+)', label: '[^']*', icon: [^,]*, color: '(#[0-9a-f]{6})' \}/gi)].map(m => [m[1], m[2]]));
  assert.ok(colors.podcasts && colors.livetv && colors.radio && colors.streaming && colors.mediathek);
  const MATRIX = {
    normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    protanopie: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranopie: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
    tritanopie: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
  };
  const linear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const rgbOf = hex => [1, 3, 5].map(i => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const simulate = (hex, mode) => MATRIX[mode].map(row => Math.min(1, Math.max(0, row[0] * rgbOf(hex)[0] + row[1] * rgbOf(hex)[1] + row[2] * rgbOf(hex)[2])));
  const lab = ([r, g, b]) => {
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const distance = (a, b, mode) => Math.hypot(...lab(simulate(a, mode)).map((v, i) => v - lab(simulate(b, mode))[i]));
  // Maßstab: der kleinste Abstand, den die bestehenden Kacheln untereinander schon haben (bei Tritanopie LiveTV/Einstellungen ~19)
  for (const [key, color] of Object.entries(colors)) {
    if (key === 'podcasts') continue;
    for (const mode of Object.keys(MATRIX)) assert.ok(distance(color, colors.podcasts, mode) >= 19, `${key} (${color}) vs. Podcasts bei ${mode}: ${distance(color, colors.podcasts, mode).toFixed(1)}`);
  }
  for (const mode of ['normal']) assert.ok(distance(colors.livetv, colors.podcasts, mode) > 60, 'LiveTV und Podcasts im Normalsehen klar verschieden');
  const luminance = hex => {
    const [r, g, b] = rgbOf(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  assert.ok(ratio('#86efac', '#11151d') >= 4.5, 'Text/Akzent hell auf dunkel');
  assert.ok(ratio('#ffffff', '#15803d') >= 4.5, 'weißer Text auf Knopf-/Badge-Grün');
  assert.ok(ratio('#5af2a6', '#11151d') >= 3, 'Linien/Flächen');
});
