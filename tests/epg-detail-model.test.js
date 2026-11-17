'use strict';

// Tests: Detail-Erweiterung (Etappe 3.6, EPG-E4/E7, M6) — Bild-URL-Prüfung (P12), Metazeile, Besetzung mit Kürzung,
// Untertitel/Altersfreigabe nur wenn vorhanden, „Läuft auch“-Auswahl; Verdrahtung (kein Settings-Schalter, CSP unverändert).
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../epg-detail-model.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MIN = 60 * 1000;
const NOW = new Date(2026, 9, 5, 20, 32).getTime();

// ── Bild-URL ──

test('safeIconUrl: http und https werden angenommen', () => {
  assert.equal(d.safeIconUrl('https://img.example.org/p/1.jpg?w=300&h=200'), 'https://img.example.org/p/1.jpg?w=300&h=200');
  assert.equal(d.safeIconUrl('http://img.example.org/a.png'), 'http://img.example.org/a.png');
  assert.equal(d.safeIconUrl('  https://img.example.org/a.png  '), 'https://img.example.org/a.png');
  assert.equal(d.safeIconUrl('HTTPS://IMG.example.org/A.png'), 'https://img.example.org/A.png');
});

test('safeIconUrl: javascript:, data:, file:, blob:, ftp:, leer, Nicht-String und Zugangsdaten werden abgelehnt', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\nscript:alert(1)',
    'data:image/png;base64,AAAA',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'blob:https://example.org/uuid',
    'ftp://example.org/a.png',
    '//example.org/a.png',
    '/relativ/a.png',
    'a.png',
    'https://',
    'https://user:pass@example.org/a.png',
    'https://user@example.org/a.png',
    '',
    '   ',
    `https://example.org/${'a'.repeat(600)}`,
    'https://example.org/a\u0000.png',
  ]) {
    assert.equal(d.safeIconUrl(bad), '', JSON.stringify(bad).slice(0, 60));
  }
  for (const bad of [undefined, null, 42, true, {}, [], ['https://example.org/a.png'], () => 'https://example.org/a.png']) {
    assert.equal(d.safeIconUrl(bad), '', String(typeof bad));
  }
});

// ── Metazeile ──

test('metaLine: „Genre · Jahr · Dauer · S2 E3“, Fehlendes entfällt ohne leere Trenner', () => {
  assert.equal(d.metaLine({ genreText: 'Serie', year: 2019, minutes: 45, episode: 'S2 E3' }), 'Serie · 2019 · 45 min · S2 E3');
  assert.equal(d.metaLine({ genreText: '', year: 2019, minutes: 45, episode: '' }), '2019 · 45 min');
  assert.equal(d.metaLine({ genreText: 'Film', year: 0, minutes: 105, episode: '' }), 'Film · 105 min');
  assert.equal(d.metaLine({ genreText: '', year: 0, minutes: 0, episode: '' }), '');
  assert.equal(d.metaLine({}), '');
  assert.equal(d.metaLine(), '');
});

test('metaLine: unplausible Werte werden verworfen, Episode wird gekürzt', () => {
  assert.equal(d.metaLine({ year: 1899, minutes: 30 }), '30 min');
  assert.equal(d.metaLine({ year: 2101, minutes: 30 }), '30 min');
  assert.equal(d.metaLine({ year: 2019.5, minutes: 30 }), '30 min');
  assert.equal(d.metaLine({ year: '2019', minutes: 30 }), '30 min');
  assert.equal(d.metaLine({ minutes: -5 }), '');
  assert.equal(d.metaLine({ minutes: NaN }), '');
  assert.equal(d.metaLine({ episode: 'S1 E9999999999999999999999999999999999999999' }).length <= 24, true);
  assert.equal(d.metaLine({ episode: '  S2   E3 ' }), 'S2 E3');
  assert.equal(d.metaLine({ episode: 42 }), '');
});

// ── Besetzung ──

test('castLine: „Regie: … · Mit: …“; bis 4 Namen alle, darüber drei und „… + N weitere“', () => {
  assert.equal(d.castLine({ director: ['Mira Lindgren'], actor: ['A', 'B', 'C'], presenter: [] }), 'Regie: Mira Lindgren · Mit: A, B, C');
  assert.equal(d.castLine({ director: [], actor: ['A', 'B', 'C', 'D'], presenter: [] }), 'Mit: A, B, C, D');
  assert.equal(d.castLine({ director: [], actor: ['A', 'B', 'C', 'D', 'E'], presenter: [] }), 'Mit: A, B, C … + 2 weitere');
  assert.equal(d.castLine({ director: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'], actor: ['A'], presenter: [] }), 'Regie: R1, R2, R3 … + 3 weitere · Mit: A');
  assert.equal(d.castLine({ director: [], actor: [], presenter: ['Mod Eins'] }), 'Moderation: Mod Eins');
});

test('castLine: fehlende/kaputte Credits ergeben keine Zeile; Dubletten und Nicht-Strings entfallen; Namen werden gekürzt', () => {
  assert.equal(d.castLine(undefined), '');
  assert.equal(d.castLine(null), '');
  assert.equal(d.castLine({}), '');
  assert.equal(d.castLine({ director: [], actor: [], presenter: [] }), '');
  assert.equal(d.castLine({ director: 'Text', actor: 5 }), '');
  assert.equal(d.castLine({ actor: ['A', 'A', ' A ', null, 7, '', 'B'] }), 'Mit: A, B');
  const long = d.castLine({ actor: ['X'.repeat(200)] });
  assert.ok(long.length <= 'Mit: '.length + 60);
  assert.deepEqual(d.castEntries({ director: ['R'], actor: ['A'], presenter: [] }), [{ label: 'Regie', text: 'R' }, { label: 'Mit', text: 'A' }]);
});

test('Untertitel und Altersfreigabe: nur wenn vorhanden (EPG-E7), Steuerzeichen und Überlänge werden bereinigt', () => {
  assert.equal(d.subtitleText(''), '');
  assert.equal(d.subtitleText(undefined), '');
  assert.equal(d.subtitleText(null), '');
  assert.equal(d.subtitleText('Der Untertitel & mehr'), 'Der Untertitel & mehr');
  assert.equal(d.subtitleText('a\nb\u0000c'), 'a b c');
  assert.ok(d.subtitleText('U'.repeat(500)).length <= 160);
  assert.equal(d.ratingText('FSK 12'), 'FSK 12');
  assert.equal(d.ratingText(''), '');
  assert.equal(d.ratingText(5), '');
  assert.ok(d.ratingText('R'.repeat(80)).length <= 24);
});

// ── Läuft auch ──

const chan = key => ({ id: key, name: `Sender ${key}`, tvgId: key });
const byKey = new Map(['A.de', 'B.de', 'C.de', 'D.de', 'E.de', 'F.de', 'G.de', 'H.de'].map(k => [k, chan(k)]));
const current = { id: 'A.de|' + (NOW + 60 * MIN), channelKey: 'A.de', start: NOW + 60 * MIN, stop: NOW + 120 * MIN, title: 'Tatort' };
const hit = (key, startMin, title = 'Tatort', len = 60) => ({ channelKey: key, start: NOW + startMin * MIN, stop: NOW + (startMin + len) * MIN, title });

test('alsoQuery: Titel als Suchtext nur, wenn die Suche ihn annimmt', () => {
  assert.equal(d.alsoQuery('Tatort'), 'Tatort');
  assert.equal(d.alsoQuery('  Tatort '), 'Tatort');
  assert.equal(d.alsoQuery('X'), '');
  assert.equal(d.alsoQuery(''), '');
  assert.equal(d.alsoQuery(undefined), '');
  assert.equal(d.alsoQuery('a\nb'), '');
  assert.equal(d.alsoQuery('T'.repeat(81)), '');
  assert.equal(d.alsoQuery('T'.repeat(80)).length, 80);
});

test('alsoPicks: exakter Titel, aktueller Termin ausgeschlossen, nach Start sortiert', () => {
  const hits = [
    hit('A.de', 60), // der aktuelle Termin
    hit('C.de', 300),
    hit('B.de', 200),
    hit('B.de', 400, 'Tatort: Nachtschatten'), // anderer Titel (nur Teilstring)
    hit('D.de', 250, 'tatort'), // andere Schreibung: nicht exakt
    hit('A.de', 1500), // derselbe Sender, anderer Tag: zählt
  ];
  const result = d.alsoPicks({ hits, current, channelByKey: byKey, nowMs: NOW });
  assert.deepEqual(result.items.map(r => `${r.channelKey}@${(r.start - NOW) / MIN}`), ['B.de@200', 'C.de@300', 'A.de@1500']);
  assert.equal(result.more, 0);
  assert.equal(result.items[0].channel.name, 'Sender B.de');
  assert.equal(result.items[0].id, `B.de|${NOW + 200 * MIN}`);
});

test('alsoPicks: höchstens 5 Einträge, Rest als Zahl; vergangene Termine und Termine unbekannter Sender entfallen', () => {
  const hits = [];
  ['B.de', 'C.de', 'D.de', 'E.de', 'F.de', 'G.de', 'H.de'].forEach((k, i) => hits.push(hit(k, 100 + i * 10)));
  hits.push(hit('B.de', -300)); // vorbei
  hits.push(hit('Z.de', 90)); // Sender nicht in der Auswahl
  const result = d.alsoPicks({ hits, current, channelByKey: byKey, nowMs: NOW });
  assert.equal(result.items.length, 5);
  assert.equal(result.more, 2);
  assert.deepEqual(result.items.map(r => r.channelKey), ['B.de', 'C.de', 'D.de', 'E.de', 'F.de']);
  assert.ok(result.items.every(r => r.stop > NOW));
});

test('alsoPicks: laufender Termin eines anderen Senders zählt; gleicher Schlüssel in anderer Schreibweise = aktueller Termin', () => {
  const lower = new Map([...byKey, ['a.DE', chan('a.DE')]]);
  const hits = [hit('B.de', -20, 'Tatort', 60), hit('a.DE', 60)];
  const result = d.alsoPicks({ hits, current, channelByKey: lower, nowMs: NOW });
  assert.deepEqual(result.items.map(r => r.channelKey), ['B.de']);
});

test('alsoPicks: robust gegen kaputte Treffer und leere Eingaben', () => {
  assert.deepEqual(d.alsoPicks({ hits: undefined, current, channelByKey: byKey, nowMs: NOW }), { items: [], more: 0 });
  assert.deepEqual(d.alsoPicks({ hits: [], current, channelByKey: byKey, nowMs: NOW }), { items: [], more: 0 });
  const junk = [null, 5, {}, { channelKey: 'B.de', title: 'Tatort' }, { channelKey: 'B.de', title: 'Tatort', start: 'x', stop: 1 }];
  assert.deepEqual(d.alsoPicks({ hits: junk, current, channelByKey: byKey, nowMs: NOW }), { items: [], more: 0 });
  assert.deepEqual(d.alsoPicks({ hits: [hit('B.de', 100)], current, channelByKey: null, nowMs: NOW }), { items: [], more: 0 });
});

test('alsoLabel: Wochentag/Uhrzeit und Sendername', () => {
  const result = d.alsoPicks({ hits: [hit('B.de', 24 * 60 + 30)], current, channelByKey: byKey, nowMs: NOW });
  const label = d.alsoLabel(result.items[0], NOW);
  assert.match(label.when, /^Di \d{2}:\d{2}$/);
  assert.equal(label.channel, 'Sender B.de');
});

// ── Verdrahtung ──

test('Verdrahtung: kein Settings-Schalter für Bilder (P12); Bilder nur als img.src nach safeIconUrl; CSP unverändert', () => {
  const settingsFiles = ['lib/epg-view-settings.js', 'lib/ipc-validation.js', 'preload.js'];
  for (const file of settingsFiles) assert.ok(!/showImages|loadImages|bilder laden|epgImages/i.test(read(file)), file);
  const detailView = read('epg-detail-view.js');
  assert.match(detailView, /detailModel\.safeIconUrl\(slot\.icon\)/);
  assert.match(detailView, /img\.src = url/);
  assert.match(read('epg-row-dom.js'), /detailModel\.safeIconUrl\(url\)/);
  assert.ok(!/style\.backgroundImage|setAttribute\('src'|\.srcset/.test(detailView + read('epg-row-dom.js')));
  // die Vorschau-/Poster-Bilder laufen unter der bestehenden CSP (img-src 'self' data: https:), die nicht gelockert wird
  const html = read('index.html');
  assert.match(html, /img-src 'self' data: https:;/);
  assert.ok(!/img-src[^;]*http:/.test(html));
});

test('Verdrahtung: Poster/Thumbnails lazy, ohne Referrer, Fehler → Bild entfällt; kein Vorab-Laden', () => {
  for (const file of ['epg-detail-view.js', 'epg-row-dom.js']) {
    const src = read(file);
    assert.match(src, /loading: 'lazy'/, file);
    assert.match(src, /referrerpolicy: 'no-referrer'/, file);
    assert.match(src, /addEventListener\('error'/, file);
  }
  const jngView = read('epg-jng-view.js');
  assert.match(jngView, /viewportCells\(\)/, 'nur Zeilen im Viewport');
  assert.ok(!/new Image\(\)|fetch\(/.test(jngView + read('epg-view.js') + read('epg-detail-view.js')), 'kein Vorab-Download');
});

test('Verdrahtung: „Läuft auch“ nutzt epg:search (keine neue IPC), Modal ohne Daten bleibt neutral', () => {
  const view = read('epg-view.js');
  assert.match(view, /api\.searchEpg\(chunk, query, plan\.fromMs, plan\.toMs, detailModel\.ALSO_FETCH_LIMIT/);
  const preload = read('preload.js');
  assert.ok(!/epg:also|epg:poster|epg:thumb/.test(preload));
  const detailView = read('epg-detail-view.js');
  for (const id of ['epgDetailSub', 'epgDetailInfo', 'epgDetailCast', 'epgDetailPoster', 'epgDetailAlso']) {
    assert.match(detailView, new RegExp(`id: '${id}'[^)]*hidden: true`), `${id} startet verborgen (keine leeren Zeilen)`);
  }
});
