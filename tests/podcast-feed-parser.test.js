'use strict';

// Tests: Podcast-Feed-Parser (lib/podcast/feed-parser.js) mit Fixture-Feeds unter tests/fixtures/podcast/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFeed, parseDuration, cleanText, MAX_FEED_CHARS } = require('../lib/podcast/feed-parser.js');
const { podcastIdFromFeedUrl, normalizeFeedUrl, episodeIdFromEnclosure } = require('../lib/podcast/podcast-ids.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'podcast', name), 'utf8');

test('Normalfeed: Kanalkopf, Episoden neueste zuerst, Text ohne HTML', () => {
  const { channel, episodes, totalItems, skipped } = parseFeed(fixture('normal.xml'));
  assert.equal(channel.title, 'Der & Test-Podcast');
  assert.equal(channel.author, 'Test Redaktion');
  assert.equal(channel.cover, 'https://example.test/cover.jpg', 'itunes:image vor <image>');
  assert.equal(channel.description, 'Ein Podcast über Tests.', 'HTML und script entfernt');
  assert.deepEqual(episodes.map(e => e.id), ['ep-3', 'ep-2', 'ep-1']);
  assert.equal(totalItems, 3);
  assert.equal(skipped, 0);
  const first = episodes[0];
  assert.equal(first.title, 'Folge 3', 'maskiertes Markup im Titel wird als Markup entfernt');
  assert.equal(first.description, 'Absatz eins\nAbsatz & zwei\nZeile');
  assert.ok(!/[<>]/.test(first.description), 'kein Markup übrig');
  assert.equal(first.audioUrl, 'https://example.test/ep3.mp3');
  assert.equal(first.audioType, 'audio/mpeg');
  assert.equal(first.duration, 3723);
  assert.equal(first.pubDate, '2026-10-14T06:00:00.000Z');
  assert.equal(first.cover, 'https://example.test/ep3.jpg');
  assert.equal('length' in first, false, 'enclosure length wird ignoriert');
});

test('Dauerformate: H:MM:SS, MM:SS, Sekunden, Dezimal, ISO; Unsinn und >48 h ergeben null', () => {
  const durations = Object.fromEntries(parseFeed(fixture('durations.xml')).episodes.map(e => [e.title, e.duration]));
  assert.deepEqual(durations, { hms: 3723, ms: 754, sekunden: 2711, dezimal: 3601, iso: 5400, unsinn: null, riesig: null, fehlt: null });
  assert.equal(parseDuration('0'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration('1,5'), 2);
});

test('nur audio/*-Enclosures: Video verworfen, Audio-Alternative gewählt, fehlender Typ nur mit Audio-Endung', () => {
  const { episodes, totalItems, skipped } = parseFeed(fixture('video.xml'));
  assert.equal(totalItems, 4);
  assert.equal(skipped, 2);
  assert.deepEqual(episodes.map(e => [e.id, e.audioUrl]), [
    ['v2', 'https://example.test/v2.mp3'],
    ['v3', 'https://example.test/v3.mp3?x=1'],
  ]);
});

test('fehlende, leere und doppelte guid: Ersatz-ID aus der Enclosure-URL, Duplikate zusammengefasst', () => {
  const { episodes } = parseFeed(fixture('guid-problems.xml'));
  const byTitle = Object.fromEntries(episodes.map(e => [e.title, e.id]));
  assert.equal(episodes.length, 5, 'D (gleiche Audio-Datei wie A) ist ein Duplikat');
  assert.equal(byTitle['A ohne guid'], episodeIdFromEnclosure('https://example.test/a.mp3'));
  assert.equal(byTitle['B leere guid'], episodeIdFromEnclosure('https://example.test/b.mp3'));
  assert.equal(byTitle['C doppelt 1'], episodeIdFromEnclosure('https://example.test/c1.mp3'));
  assert.equal(byTitle['C doppelt 2 (andere Datei)'], episodeIdFromEnclosure('https://example.test/c2.mp3'));
  assert.equal(byTitle['E eindeutig'], 'unique-e');
  assert.equal(new Set(episodes.map(e => e.id)).size, episodes.length);
  assert.equal(episodes.find(e => e.title === 'E eindeutig').guid, 'unique-e');
  assert.equal(episodes.find(e => e.title === 'A ohne guid').guid, null);
});

test('kaputtes XML: kein Absturz, brauchbare Teile bleiben; Nicht-Feeds werden abgelehnt', () => {
  const broken = parseFeed(fixture('broken.xml'));
  assert.deepEqual(broken.episodes, [], 'unvollständige Items werden ignoriert');
  const partly = parseFeed(fixture('partly-broken.xml'));
  assert.deepEqual(partly.episodes.map(e => e.id), ['g1'], 'javascript:/file:/fehlende Enclosure und trunkiertes Item entfallen');
  assert.throws(() => parseFeed(fixture('not-a-feed.html')), /kein gültiger Podcast-Feed/i);
  assert.throws(() => parseFeed(''), /kein gültiger Podcast-Feed/i);
  assert.throws(() => parseFeed(null), /kein Text/);
  assert.doesNotThrow(() => parseFeed('<rss><channel>' + '<item>'.repeat(5000) + '</channel></rss>'));
});

test('XXE/Entity-Expansion: eigene Entities werden nie aufgelöst, DOCTYPE verworfen', () => {
  const { channel, episodes } = parseFeed(fixture('xxe.xml'));
  assert.equal(channel.title, 'XXE Ende');
  assert.ok(!/root:|passwd|lol/.test(JSON.stringify({ channel, episodes })), 'weder Datei noch Entity-Inhalt');
  assert.equal(episodes[0].title, 'Folge');
  assert.equal(episodes[0].description, '');
});

test('Episodenzahl wird begrenzt (neueste behalten) und Größenlimit greift', () => {
  const items = Array.from({ length: 300 }, (_, i) => `<item><title>E${i}</title><guid>g${i}</guid><pubDate>${new Date(Date.UTC(2026, 0, 1 + (i % 28), i % 24)).toUTCString()}</pubDate><enclosure url="https://example.test/${i}.mp3" type="audio/mpeg"/></item>`).join('');
  const xml = `<rss><channel><title>Viele</title>${items}</channel></rss>`;
  const all = parseFeed(xml);
  assert.equal(all.episodes.length, 200, 'Standardlimit 200');
  assert.equal(all.totalItems, 300);
  assert.equal(parseFeed(xml, { maxEpisodes: 5 }).episodes.length, 5);
  const dates = all.episodes.map(e => Date.parse(e.pubDate));
  assert.deepEqual([...dates].sort((a, b) => b - a), dates, 'nach Datum absteigend');
  assert.throws(() => parseFeed('x'.repeat(MAX_FEED_CHARS + 1)), /zu groß/);
});

test('cleanText: CDATA, Entities, HTML, Steuerzeichen, Längenlimit', () => {
  assert.equal(cleanText('<![CDATA[<b>Fett</b> &amp; <i>schräg</i>]]>'), 'Fett & schräg');
  assert.equal(cleanText('&lt;b&gt;x&lt;/b&gt; &#228;&#x4F;'), 'x äO');
  assert.equal(cleanText('a\u0000b\u0007c'), 'abc');
  assert.equal(cleanText('&unbekannt; ok'), 'ok');
  assert.equal(cleanText('x'.repeat(50), 10).length, 10);
  assert.equal(cleanText(null), '');
});

test('IDs: Abo-ID ist der Hash der normalisierten Feed-URL (Schema/Host klein, Standard-Port und Fragment weg)', () => {
  const id = podcastIdFromFeedUrl('https://example.test/feed.xml');
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(podcastIdFromFeedUrl('HTTPS://Example.TEST:443/feed.xml#frag'), id);
  assert.equal(podcastIdFromFeedUrl(' https://example.test/feed.xml '), id);
  assert.notEqual(podcastIdFromFeedUrl('https://example.test/Feed.xml'), id, 'Pfad ist signifikant');
  assert.notEqual(podcastIdFromFeedUrl('http://example.test/feed.xml'), id);
  assert.equal(normalizeFeedUrl('https://example.test'), 'https://example.test/');
  assert.throws(() => podcastIdFromFeedUrl('kein url'));
});
