'use strict';

// Tests: Dateiablage der Downloads (filenames.js), NFO (nfo.js), Altersfenster (age-window.js), Netzregeln (net.js).

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const f = require('../lib/download/filenames.js');
const { buildEpisodeNfo } = require('../lib/download/nfo.js');
const { nextAttemptAt, windowStartHour } = require('../lib/download/age-window.js');
const { isAllowedDownloadUrl, assertDownloadUrl } = require('../lib/download/net.js');

test('sanitizeName: verbotene Zeichen, Steuerzeichen, Ränder, Länge, reservierte Namen', () => {
  assert.equal(f.sanitizeName('Was? Wie: Wo/Wann*'), 'Was Wie Wo Wann');
  assert.equal(f.sanitizeName('  ..versteckt..  '), 'versteckt');
  assert.equal(f.sanitizeName('a\u0000b\nc'), 'a b c');
  assert.equal(f.sanitizeName(''), 'Unbenannt');
  assert.equal(f.sanitizeName('///'), 'Unbenannt');
  assert.equal(f.sanitizeName('CON'), 'Unbenannt');
  assert.ok(f.sanitizeName('x'.repeat(400)).length <= f.NAME_MAX);
  assert.equal(f.sanitizeName('Über Straße'), 'Über Straße');
});

test('Schema S{season2}E{episode2} - {title}; "(S01/E02)" im ARD-Titel entfällt', () => {
  assert.equal(f.renderFileName('S{season2}E{episode2} - {title}', { title: 'Die Entführung (S01/E02)', season: 1, episode: 2, date: '2026-03-19' }), 'S01E02 - Die Entführung');
  assert.equal(f.renderFileName('S{season2}E{episode2} - {title}', { title: 'Finale', season: 12, episode: 103 }), 'S12E103 - Finale');
});

test('Fallback "Titel (Datum)" ohne Staffel/Folge oder bei Schema ohne Platzhalter-Daten', () => {
  assert.equal(f.renderFileName('S{season2}E{episode2} - {title}', { title: 'heute journal', date: '2026-03-19' }), 'heute journal (2026-03-19)');
  assert.equal(f.renderFileName('S{season2}E{episode2} - {title}', { title: 'Film', season: 1 }), 'Film');
  assert.equal(f.renderFileName('S{season2}E{episode2} - {title}', { title: 'Folge', season: null, episode: 3, date: '2026-01-02' }), 'Folge (2026-01-02)');
});

test('Eigene Schemata: Serie, Datum, Jahr, einfache Zahlen', () => {
  assert.equal(f.renderFileName('{series} - {season}x{episode} - {title}', { title: 'T', seriesTitle: 'Serie', season: 2, episode: 5 }), 'Serie - 2x5 - T');
  assert.equal(f.renderFileName('{title} ({year})', { title: 'Film', date: '2026-03-19' }), 'Film (2026)');
  assert.equal(f.renderFileName('{date} {title}', { title: 'Nachrichten', date: '2026-03-19' }), '2026-03-19 Nachrichten');
});

test('Pfad: <Root>/<Quelle>/<Serie>/<Name>.<Endung> und .part', () => {
  const t = f.buildTarget({ root: '/r/Mediathek', sourceId: 'zdf', seriesTitle: 'Der Bergdoktor', data: { title: 'Folge', season: 17, episode: 1 }, scheme: 'S{season2}E{episode2} - {title}', ext: 'mp4' });
  assert.equal(t.file, path.join('/r/Mediathek', 'ZDF', 'Der Bergdoktor', 'S17E01 - Folge.mp4'));
  assert.equal(t.partFile, `${t.file}.part`);
  const arte = f.buildTarget({ root: '/r', sourceId: 'arte', seriesTitle: null, data: { title: 'Film', date: '2026-01-01' }, scheme: 'S{season2}E{episode2} - {title}', ext: 'mkv' });
  assert.equal(arte.file, path.join('/r', 'arte', 'Film (2026-01-01).mkv'));
});

test('Ordner je Serie abschaltbar; Serientitel wird bereinigt', () => {
  const t = f.buildTarget({ root: '/r', sourceId: 'ard', seriesTitle: 'A/B: C?', data: { title: 'T', season: 1, episode: 1 }, scheme: '{title}', seriesFolders: false, ext: 'mp4' });
  assert.equal(path.dirname(t.file), path.join('/r', 'ARD'));
  const folder = f.buildTarget({ root: '/r', sourceId: 'ard', seriesTitle: 'A/B: C?', data: { title: 'T' }, scheme: '{title}', ext: 'mp4' });
  assert.equal(path.basename(path.dirname(folder.file)), 'A B C');
});

test('Kollision: Zähler, auch bei vorhandener .part-Datei', () => {
  const taken = new Set([path.join('/r', 'ARD', 'S', 'T.mp4'), path.join('/r', 'ARD', 'S', 'T (2).mp4.part')]);
  const t = f.buildTarget({ root: '/r', sourceId: 'ard', seriesTitle: 'S', data: { title: 'T' }, scheme: '{title}', ext: 'mp4', exists: file => taken.has(file) });
  assert.equal(path.basename(t.file), 'T (3).mp4');
});

test('NFO (Kodi episodedetails): Pflichtfelder, XML-Escape, ohne leere Felder', () => {
  const nfo = buildEpisodeNfo({ title: 'Tom & Jerry <1> (S01/E02)', seriesTitle: 'Serie "X"', season: 1, episode: 2, broadcastDate: '2026-03-19', description: 'Text\u0001 mit Zeichen', durationSec: 2700, sourceId: 'ard' });
  assert.match(nfo, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>\n<episodedetails>/);
  assert.match(nfo, /<title>Tom &amp; Jerry &lt;1&gt;<\/title>/);
  assert.match(nfo, /<showtitle>Serie &quot;X&quot;<\/showtitle>/);
  assert.match(nfo, /<season>1<\/season>\n {2}<episode>2<\/episode>/);
  assert.match(nfo, /<aired>2026-03-19<\/aired>/);
  assert.match(nfo, /<runtime>45<\/runtime>/);
  assert.match(nfo, /<studio>ARD<\/studio>/);
  assert.ok(!nfo.includes('\u0001'));
  const minimal = buildEpisodeNfo({ title: 'Film' });
  assert.ok(!minimal.includes('<season>') && !minimal.includes('<plot>'));
});

test('Altersfenster: FSK 16 ab 22 Uhr (Berliner Zeit), offenes Fenster -> erneut in 15 min', () => {
  assert.equal(windowStartHour('FSK16'), 22);
  assert.equal(windowStartHour('FSK 12'), 20);
  assert.equal(windowStartHour('FSK18'), 23);
  assert.equal(windowStartHour('FSK6'), null);
  const noon = Date.parse('2026-10-20T12:00:00+02:00');
  assert.equal(nextAttemptAt('FSK16', noon), '2026-10-20T20:00:00.000Z'); // 22:00 MESZ
  const winter = Date.parse('2026-12-01T12:00:00+01:00');
  assert.equal(nextAttemptAt('FSK16', winter), '2026-12-01T21:00:00.000Z'); // 22:00 MEZ
  const inWindow = Date.parse('2026-10-20T23:30:00+02:00');
  assert.equal(nextAttemptAt('FSK16', inWindow), new Date(inWindow + 15 * 60000).toISOString());
  const earlyMorning = Date.parse('2026-10-21T03:00:00+02:00');
  assert.equal(nextAttemptAt('FSK16', earlyMorning), new Date(earlyMorning + 15 * 60000).toISOString());
  assert.equal(nextAttemptAt('FSK16', Date.parse('2026-10-20T07:00:00+02:00')), '2026-10-20T20:00:00.000Z');
});

test('Altersfenster: angegebener Zeitpunkt (arte) gilt, wenn er in der Zukunft liegt', () => {
  const now = Date.parse('2026-10-20T12:00:00+02:00');
  assert.equal(nextAttemptAt('FSK16', now, '2026-10-20T20:00:00Z'), '2026-10-20T20:00:00.000Z');
  assert.equal(nextAttemptAt('FSK16', now, '2026-10-19T20:00:00Z'), '2026-10-20T20:00:00.000Z'); // vergangen -> berechnet
  assert.equal(nextAttemptAt(null, now), new Date(now + 30 * 60000).toISOString());
});

test('Netz: Allowlist der Mediathek plus ARD-Anstalten nur für ARD', () => {
  assert.equal(isAllowedDownloadUrl('https://nrodlzdf-a.akamaihd.net/x.mp4', 'zdf'), true);
  assert.equal(isAllowedDownloadUrl('https://wdr-progressive.ard-mcdn.de/x.mp4', 'ard'), true);
  assert.equal(isAllowedDownloadUrl('https://pdodswr-a.akamaihd.net/x.mp4', 'ard'), true);
  assert.equal(isAllowedDownloadUrl('https://download.br.de/x.mp4', 'ard'), true);
  assert.equal(isAllowedDownloadUrl('https://download.br.de/x.mp4', 'zdf'), false);
  assert.equal(isAllowedDownloadUrl('https://evil.example.com/x.mp4', 'ard'), false);
  assert.equal(isAllowedDownloadUrl('http://download.br.de/x.mp4', 'ard'), false);
  assert.equal(isAllowedDownloadUrl('https://user:pw@download.br.de/x.mp4', 'ard'), false);
  assert.equal(isAllowedDownloadUrl('https://br.de.evil.com/x.mp4', 'ard'), false);
  assert.equal(isAllowedDownloadUrl('https://notbr.de/x.mp4', 'ard'), false);
});

test('Netz: assertDownloadUrl meldet Host- und Adressverstöße ohne Adresse', async () => {
  await assert.rejects(assertDownloadUrl('https://evil.example.com/x', 'ard', { assertPublic: async () => {} }), error => error.code === 'forbidden-host' && !error.message.includes('evil'));
  await assert.rejects(assertDownloadUrl('https://download.br.de/x', 'ard', { assertPublic: async () => { throw new Error('privat'); } }), error => error.code === 'forbidden-address');
  await assert.doesNotReject(assertDownloadUrl('https://download.br.de/x', 'ard', { assertPublic: async () => {} }));
});
