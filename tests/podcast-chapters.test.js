'use strict';

// Tests: Kapitelmarken und Shownotes — Zeitangaben, Normalisierung, JSON-Chapters (kaputtes JSON, Limits), Parser
// (podcast:chapters, psc:chapters, Shownotes-Bereinigung), Kapitel-Lader (SSRF, Cache), IPC podcast:episode-details,
// aktuelles Kapitel im Mini-Player.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chapters = require('../lib/podcast/chapters.js');
const { parseFeed, cleanText } = require('../lib/podcast/feed-parser.js');
const { fetchFeed } = require('../lib/podcast/podcast-fetch.js');
const { createChaptersLoader } = require('../lib/podcast/podcast-chapters.js');
const { PodcastLibrary, MAX_NOTES_BUDGET } = require('../lib/podcast/PodcastLibrary.js');
const { registerPodcastIpc } = require('../lib/podcast/ipc.js');
const { createPodcastRefresher } = require('../lib/podcast/podcast-refresh.js');
const { createUserStorage } = require('../lib/user-storage.js');
const { podcastIdFromFeedUrl } = require('../lib/podcast/podcast-ids.js');
const { notesToParagraphs, episodeOverlayModel } = require('../podcast-overlay-model.js');
const mini = require('../radio-miniplayer-model.js');

const rss = items => `<?xml version="1.0"?><rss xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:psc="http://podlove.org/simple-chapters" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title>${items}</channel></rss>`;
const item = (inner, guid = 'g1') => `<item><title>E</title><guid>${guid}</guid><enclosure url="https://a.test/${guid}.mp3" type="audio/mpeg"/>${inner}</item>`;

// ── Zeitangaben und Normalisierung ──

test('parseTimecode: HH:MM:SS(.fff), MM:SS, Sekunden, npt:-Präfix; Unsinn und >48 h sind null, 0 ist gültig', () => {
  assert.equal(chapters.parseTimecode('00:00:00'), 0);
  assert.equal(chapters.parseTimecode('0'), 0);
  assert.equal(chapters.parseTimecode('01:02:03.5'), 3723.5);
  assert.equal(chapters.parseTimecode('12:30'), 750);
  assert.equal(chapters.parseTimecode('npt:90,5'), 90.5);
  assert.equal(chapters.parseTimecode(42), 42);
  for (const bad of ['', 'abc', '-5', '1:2:3:4', null, undefined, NaN, Infinity, -1, 49 * 3600, {}]) assert.equal(chapters.parseTimecode(bad), null, String(bad));
});

test('normalizeChapters: sortiert, entfernt doppelte Startzeiten, leere Titel und Steuerzeichen, begrenzt auf 200', () => {
  const list = chapters.normalizeChapters([
    { start: 60, title: 'Zwei' },
    { start: 0, title: 'Eins\u0007\n  mit   Umbruch' },
    { start: 60, title: 'Doppelt' },
    { start: 30, title: '   ' },
    { start: 'kaputt', title: 'X' },
    null,
    { start: 5 },
  ]);
  assert.deepEqual(list, [{ start: 0, title: 'Eins mit Umbruch' }, { start: 60, title: 'Zwei' }]);
  const many = chapters.normalizeChapters(Array.from({ length: 500 }, (_, i) => ({ start: i, title: `K${i}` })));
  assert.equal(many.length, chapters.MAX_CHAPTERS);
  assert.equal(chapters.normalizeChapters([{ start: 1, title: 'x'.repeat(1000) }])[0].title.length, chapters.MAX_TITLE);
  assert.deepEqual(chapters.normalizeChapters('x'), []);
});

test('parseChaptersJson: Podcasting-2.0-Format, Array-Form, toc:false entfällt; Links/Bilder werden nicht übernommen', () => {
  const json = JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro', url: 'https://x.test', img: 'https://x.test/i.png' }, { startTime: 120.5, title: 'Thema' }, { startTime: 130, title: 'Versteckt', toc: false }] });
  assert.deepEqual(chapters.parseChaptersJson(json), [{ start: 0, title: 'Intro' }, { start: 120.5, title: 'Thema' }]);
  assert.deepEqual(chapters.parseChaptersJson(JSON.stringify([{ startTime: 5, title: 'A' }])), [{ start: 5, title: 'A' }]);
  assert.deepEqual(chapters.parseChaptersJson('﻿' + json).length, 2, 'BOM wird toleriert');
});

test('parseChaptersJson: kaputtes JSON, falsche Struktur und zu große Dateien werfen lesbare Fehler', () => {
  assert.throws(() => chapters.parseChaptersJson('{kaputt'), /kein gültiges JSON/);
  assert.throws(() => chapters.parseChaptersJson('"text"'), /keine Kapitel/);
  assert.throws(() => chapters.parseChaptersJson('{"chapters":"x"}'), /keine Kapitel/);
  assert.throws(() => chapters.parseChaptersJson('x'.repeat(chapters.MAX_JSON_CHARS + 1)), /zu groß/);
  assert.throws(() => chapters.parseChaptersJson(null), /zu groß/);
  assert.deepEqual(chapters.parseChaptersJson('{"chapters":[{"startTime":"abc","title":"x"}]}'), []);
});

test('currentChapter: letztes Kapitel mit start <= Position; vor dem ersten Kapitel und ohne Liste null', () => {
  const list = [{ start: 10, title: 'A' }, { start: 100, title: 'B' }, { start: 200, title: 'C' }];
  assert.equal(chapters.currentChapter(list, 5), null);
  assert.deepEqual(chapters.currentChapter(list, 10), { index: 0, chapter: list[0] });
  assert.equal(chapters.currentChapter(list, 150).index, 1);
  assert.equal(chapters.currentChapter(list, 99999).index, 2);
  assert.equal(chapters.currentChapter([], 5), null);
  assert.equal(chapters.currentChapter(null, 5), null);
  assert.equal(chapters.currentChapter(list, NaN), null);
});

// ── Parser: Kapitel und Shownotes ──

test('Parser: podcast:chapters (JSON-URL) und psc:chapters (inline) werden gelesen; unsichere Adressen verworfen', () => {
  const xml = rss(
    item('<podcast:chapters url="https://a.test/c.json" type="application/json+chapters"/>', 'a') +
      item('<podcast:chapters url="file:///etc/passwd" type="application/json"/>', 'b') +
      item('<podcast:chapters url="javascript:alert(1)" type="application/json"/>', 'c') +
      item('<podcast:chapters url="https://u:p@a.test/c.json" type="application/json"/>', 'd') +
      item('<podcast:chapters url="https://a.test/c.xml" type="text/xml"/>', 'e') +
      item('<psc:chapters version="1.2"><psc:chapter start="00:00:00" title="Intro &amp; Start"/><psc:chapter start="00:10:30.250" title="Teil &lt;b&gt;2&lt;/b&gt;" href="javascript:x"/><psc:chapter start="kaputt" title="X"/></psc:chapters>', 'f'),
  );
  const byId = Object.fromEntries(parseFeed(xml).episodes.map(episode => [episode.id, episode]));
  assert.equal(byId.a.chaptersUrl, 'https://a.test/c.json');
  for (const id of ['b', 'c', 'd', 'e']) assert.equal(byId[id].chaptersUrl, null, id);
  assert.deepEqual(byId.f.chapters, [{ start: 0, title: 'Intro & Start' }, { start: 630.3, title: 'Teil <b>2</b>' }], 'Titel bleiben Text; Markup wird nie gerendert');
  assert.deepEqual(byId.a.chapters, []);
});

test('Shownotes: bereinigter Baum plus Klartext-Auszug; Skripte, javascript:-Links und Fremd-Attribute entfernt', () => {
  const html = '<![CDATA[<p>Hallo <b>Welt</b>&nbsp;&amp; <a href="https://x.test/a?b=1&amp;c=2" onclick="x()">Link</a></p><ul><li>Eins</li><li>Zwei</li></ul><p><a href="javascript:alert(1)">böse</a> <a href="https://y.test">https://y.test</a></p><script>alert(1)</script><img src=x onerror=alert(1)><p>Ende</p>]]>';
  const [episode] = parseFeed(rss(item(`<content:encoded>${html}</content:encoded><description>kurz</description>`))).episodes;
  assert.equal(episode.notes, 'Hallo Welt & Link\n• Eins\n• Zwei\nböse https://y.test\nEnde');
  assert.deepEqual(episode.notesTree[0], { t: 'p', c: ['Hallo ', { t: 'strong', c: ['Welt'] }, ' & ', { t: 'a', a: { href: 'https://x.test/a?b=1&c=2' }, c: ['Link'] }] });
  const json = JSON.stringify(episode.notesTree);
  assert.ok(!/alert|javascript|onclick|onerror|script/.test(json), json);
  assert.equal(episode.description, 'kurz', 'Kurzbeschreibung (2000 Zeichen) bleibt unverändert');
  const long = parseFeed(rss(item(`<description>${'a'.repeat(30000)}</description>`))).episodes[0];
  assert.ok(long.notes.length <= 600 && long.notes.endsWith('…'));
  assert.equal(JSON.stringify(long.notesTree).length < 40000, true, 'Textlimit des Baums');
  const summary = parseFeed(rss(item('<itunes:summary>Nur Summary</itunes:summary>'))).episodes[0];
  assert.equal(summary.notes, 'Nur Summary');
  assert.deepEqual(summary.notesTree, [{ t: 'p', c: ['Nur Summary'] }]);
  const none = parseFeed(rss(item(''))).episodes[0];
  assert.equal(none.notes, '');
  assert.deepEqual(none.notesTree, []);
  assert.equal(cleanText('<p>a</p><p>b</p>', 100), 'a\nb', 'cleanText bleibt Klartext');
});

test('Shownotes: reichhaltigstes Feld gewinnt (content:encoded vor kurzer description)', () => {
  const rich = '<![CDATA[<h2>Titel</h2><p>Langer Text mit <a href="https://a.test/">Link</a> und viel mehr Inhalt, der länger ist.</p>]]>';
  const [episode] = parseFeed(rss(item(`<description>kurz</description><content:encoded>${rich}</content:encoded>`))).episodes;
  assert.equal(episode.notesTree[0].t, 'h2');
  const [flip] = parseFeed(rss(item(`<description>${rich}</description><content:encoded>kurz</content:encoded>`))).episodes;
  assert.equal(flip.notesTree[0].t, 'h2');
});

test('notesToParagraphs: Absätze, Steuerzeichen und Begrenzung; nie HTML-Auswertung (Text bleibt Text)', () => {
  assert.deepEqual(notesToParagraphs('Eins\n\n\nZwei\nzweite Zeile\n\n   \n\nDrei'), ['Eins', 'Zwei\nzweite Zeile', 'Drei']);
  assert.deepEqual(notesToParagraphs('<b>kein HTML</b>\u0007'), ['<b>kein HTML</b>'], 'wird als Text durchgereicht, die Ansicht nutzt nur textContent');
  assert.deepEqual(notesToParagraphs(''), []);
  assert.deepEqual(notesToParagraphs(null), []);
  assert.ok(notesToParagraphs('a\n\n'.repeat(1000)).length <= 400);
  assert.ok(notesToParagraphs('x'.repeat(50000)).join('').length <= 20000);
});

// ── Kapitel-Lader ──

const okFetchImpl = (body, calls) => async url => {
  calls.push(url);
  return { status: 200, headers: { get: name => ({ 'content-type': 'application/json' })[name.toLowerCase()] || null }, body: null, arrayBuffer: async () => Buffer.from(body) };
};

test('Kapitel-Lader: lädt über fetchFeed mit Zielfilter, cached Erfolge, merkt Fehler nur 60 s', async () => {
  const calls = [];
  let clock = 1000;
  const body = JSON.stringify({ chapters: [{ startTime: 0, title: 'A' }] });
  const loader = createChaptersLoader({ fetch: (url, options) => fetchFeed(url, { ...options, fetchImpl: okFetchImpl(body, calls) }), guardUrl: () => {}, now: () => clock });
  const first = await loader.load('https://a.test/c.json');
  assert.deepEqual(first, { ok: true, chapters: [{ start: 0, title: 'A' }] });
  await loader.load('https://a.test/c.json');
  assert.equal(calls.length, 1, 'zweiter Aufruf aus dem Cache');
  clock += 7 * 3600 * 1000;
  await loader.load('https://a.test/c.json');
  assert.equal(calls.length, 2, 'nach 6 h neu geladen');

  const bad = createChaptersLoader({ fetch: (url, options) => fetchFeed(url, { ...options, fetchImpl: okFetchImpl('{kaputt', calls) }), guardUrl: () => {}, now: () => clock });
  const before = calls.length;
  assert.deepEqual(await bad.load('https://a.test/kaputt.json'), { ok: false, error: 'Kapitel-Datei ist kein gültiges JSON' });
  await bad.load('https://a.test/kaputt.json');
  assert.equal(calls.length, before + 1, 'Fehler wird kurz gemerkt');
  clock += 61 * 1000;
  await bad.load('https://a.test/kaputt.json');
  assert.equal(calls.length, before + 2, 'nach 60 s erneut versucht');
});

test('Kapitel-Lader: interne und private Ziele werden vor jedem Abruf abgelehnt (SSRF), Meldung ohne Adresse', async () => {
  const calls = [];
  const loader = createChaptersLoader({ fetch: (url, options) => fetchFeed(url, { ...options, fetchImpl: okFetchImpl('{"chapters":[]}', calls) }) });
  for (const url of ['http://127.0.0.1/c.json', 'http://localhost/c.json', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/c.json', 'http://[::1]/c.json', 'ftp://a.test/c.json']) {
    const result = await loader.load(url);
    assert.equal(result.ok, false, url);
    assert.ok(!result.error.includes('127.0.0.1') && !result.error.includes('169.254'), 'Meldung enthält keine Adresse');
  }
  assert.equal(calls.length, 0, 'kein Netzabruf zu unerlaubten Zielen');
});

test('fetchFeed: accept/lookup/guardUrl werden durchgereicht; Größenlimit gilt für Kapitel (1 MB)', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(options);
    return { status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => Buffer.alloc(2048, 'a') };
  };
  const guarded = [];
  await assert.rejects(fetchFeed('https://a.test/x', { fetchImpl, maxBytes: 1024, accept: 'application/json', guardUrl: url => guarded.push(url) }), /zu groß/);
  assert.deepEqual(guarded, ['https://a.test/x']);
  assert.equal(seen[0].headers.Accept, 'application/json');
});

// ── Bibliothek und IPC ──

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-podcast-chapters-'));
  const storage = createUserStorage({ userDataPath: path.join(root, 'u'), bundlePath: path.join(root, 'b') });
  fs.mkdirSync(path.join(root, 'b'), { recursive: true });
  const library = new PodcastLibrary({ userStorage: storage });
  const feedUrl = 'https://own.test/feed';
  const id = podcastIdFromFeedUrl(feedUrl);
  library.subscribe({ feedUrl, title: 'Show', source: 'eigene-podcasts' });
  const xml = rss(
    item('<description>Notizen &lt;b&gt;fett&lt;/b&gt;</description><podcast:chapters url="https://own.test/c.json" type="application/json"/>', 'j') +
      item('<psc:chapters version="1.2"><psc:chapter start="00:00:00" title="Inline"/></psc:chapters>', 'p') +
      item('<description>Ohne</description>', 'n'),
  );
  const refresher = createPodcastRefresher({ library, fetch: async () => ({ status: 'ok', text: xml }) });
  const handlers = new Map();
  const main = { id: 'main' };
  const loadCalls = [];
  const chaptersLoader = {
    load: async url => {
      loadCalls.push(url);
      return url.endsWith('c.json') ? { ok: true, chapters: [{ start: 0, title: 'Aus JSON' }, { start: 60, title: 'Zwei' }] } : { ok: false, error: 'Kapitel nicht abrufbar' };
    },
  };
  registerPodcastIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    library,
    refresher,
    search: { search: async () => ({ results: [], cached: false }) },
    chaptersLoader,
    requireMainRenderer: event => {
      if (event.sender !== main) throw new Error('nicht autorisiert');
    },
    sendToMain: () => {},
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender: main }, ...args);
  return { library, refresher, call, id, loadCalls, chaptersLoader, handlers };
}

test('IPC episode-details: Shownotes als Text, Kapitel aus JSON (Adresse nur aus dem Cache), Inline-Kapitel, Listenansicht ohne Shownotes', async () => {
  const { refresher, call, id, loadCalls } = setup();
  await refresher.refreshOne(id, { force: true });
  const list = await call('podcast:episodes', id);
  assert.deepEqual(list.episodes.map(e => [e.id, e.hasNotes, e.hasChapters]).sort(), [['j', true, true], ['n', true, false], ['p', false, true]]);
  for (const episode of list.episodes) assert.deepEqual(Object.keys(episode).filter(k => ['notes', 'chapters', 'chaptersUrl'].includes(k)), [], 'Liste enthält weder Shownotes noch Kapitel');
  const json = await call('podcast:episode-details', { podcastId: id, episodeId: 'j' });
  assert.deepEqual(json, { ok: true, notes: 'Notizen fett', notesTree: ['Notizen ', { t: 'strong', c: ['fett'] }], chapters: [{ start: 0, title: 'Aus JSON' }, { start: 60, title: 'Zwei' }], chaptersError: '' });
  assert.deepEqual(loadCalls, ['https://own.test/c.json']);
  const inline = await call('podcast:episode-details', { podcastId: id, episodeId: 'p' });
  assert.deepEqual(inline.chapters, [{ start: 0, title: 'Inline' }]);
  const none = await call('podcast:episode-details', { podcastId: id, episodeId: 'n' });
  assert.deepEqual([none.notes, none.chapters, none.chaptersError], ['Ohne', [], '']);
  assert.equal(loadCalls.length, 1, 'nur Episoden mit Kapitel-Adresse lösen einen Abruf aus');
});

test('IPC episode-details: Schema und Abo-Prüfung; Abruffehler liefert Hinweis statt Absturz; Renderer kann keine Adresse vorgeben', async () => {
  const { library, refresher, call, id } = setup();
  await refresher.refreshOne(id, { force: true });
  for (const bad of [undefined, null, 'x', {}, { podcastId: id }, { podcastId: id, episodeId: 'j', url: 'http://127.0.0.1/' }, { podcastId: 'a|b', episodeId: 'j' }, { podcastId: id, episodeId: '' }]) {
    await assert.rejects(Promise.resolve().then(() => call('podcast:episode-details', bad)), undefined, JSON.stringify(bad));
  }
  await assert.rejects(call('podcast:episode-details', { podcastId: 'unbekannt', episodeId: 'j' }), /Abo nicht gefunden/);
  await assert.rejects(call('podcast:episode-details', { podcastId: id, episodeId: 'gibt-es-nicht' }), /Episode nicht gefunden/);
  const cache = library.readCache();
  cache.feeds[id].episodes[0].chaptersUrl = 'https://own.test/fehler.json';
  library.userStorage.writeJson('podcastEpisodes', cache);
  const failed = await call('podcast:episode-details', { podcastId: id, episodeId: cache.feeds[id].episodes[0].id });
  assert.equal(failed.ok, true);
  assert.deepEqual(failed.chapters, []);
  assert.equal(failed.chaptersError, 'Kapitel nicht abrufbar');
});

test('Bibliothek: Shownotes-Budget je Feed (neueste zuerst), Liste bleibt vollständig', () => {
  const { library, id } = setup();
  const big = [{ t: 'p', c: ['x'.repeat(20000)] }];
  const episodes = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, title: `E${i}`, notes: 'Auszug', notesTree: big, audioUrl: 'https://a.test/a.mp3' }));
  library.setEpisodes(id, { episodes, channel: null });
  const cached = library.getCachedFeed(id).episodes;
  assert.equal(cached.length, 50);
  const total = cached.reduce((sum, e) => sum + (e.notesTree ? JSON.stringify(e.notesTree).length : 0), 0);
  assert.ok(total <= MAX_NOTES_BUDGET, String(total));
  assert.equal(cached[0].notesTree[0].c[0].length, 20000);
  assert.equal(cached[49].notesTree, undefined);
  assert.equal(cached[49].notes, 'Auszug', 'Klartext-Auszug bleibt');
});

// ── Overlay-Modell und Mini-Player ──

test('Overlay-Modell: Kapitelliste mit aktuellem Kapitel, Shownotes-Zustände, Play-Beschriftung', () => {
  const episode = { id: 'e1', title: 'Folge', pubDate: '2026-10-14T06:00:00Z', duration: 3600, state: { position: 130, duration: 3600, played: false } };
  const base = { podcastId: 'p', episodeId: 'e1', subscriptions: [{ id: 'p', title: 'Show', cover: null }], episodes: { p: { episodes: [episode] } }, now: Date.parse('2026-10-15T12:00:00Z') };
  const loading = episodeOverlayModel({ ...base });
  assert.equal(loading.found, true);
  assert.equal(loading.notes.state, 'loading');
  assert.equal(loading.hasChapters, false);
  assert.equal(loading.playLabel, 'Abspielen');
  const player = { status: 'playing', episode: { podcastId: 'p', episodeId: 'e1' }, position: 130, duration: 3600 };
  const ready = episodeOverlayModel({ ...base, player, detailsState: 'ready', details: { notes: 'Eins\n\nZwei', chapters: [{ start: 0, title: 'A' }, { start: 100, title: 'B' }, { start: 3700, title: 'C' }] } });
  assert.deepEqual(ready.notes.paragraphs, ['Eins', 'Zwei']);
  assert.deepEqual(ready.chapters.map(c => [c.startText, c.current]), [['0:00', false], ['1:40', true], ['1:01:40', false]]);
  assert.equal(ready.chapterNote, 'Aktuell: B');
  assert.equal(ready.playLabel, 'Pausieren');
  assert.equal(episodeOverlayModel({ ...base, detailsState: 'ready', details: { notes: '', chapters: [] } }).notes.state, 'none');
  assert.equal(episodeOverlayModel({ ...base, detailsState: 'error' }).notes.state, 'error');
  assert.equal(episodeOverlayModel({ ...base, episodeId: 'weg' }).found, false);
});

test('Mini-Player-Modell: aktuelles Kapitel als Zusatztext; ohne Kapitel kein Text', () => {
  const state = { status: 'playing', episode: { podcastId: 'p', episodeId: 'e', title: 'T', show: 'S', cover: null }, position: 130, duration: 3600, rate: 1, volume: 0.5, error: null };
  const list = [{ start: 0, title: 'Intro' }, { start: 100, title: 'Hauptteil' }];
  assert.equal(mini.podcastMiniPlayerModel(state, { chapters: list }).chapterText, 'Kapitel 2/2: Hauptteil');
  assert.equal(mini.podcastMiniPlayerModel({ ...state, position: 3 }, { chapters: list }).chapterText, 'Kapitel 1/2: Intro');
  assert.equal(mini.podcastMiniPlayerModel(state).chapterText, '');
  assert.equal(mini.podcastMiniPlayerModel(state, { chapters: [] }).chapterText, '');
  assert.equal(mini.podcastMiniPlayerModel({ ...state, status: 'error', error: 'x' }, { chapters: list }).chapterText, '');
  assert.equal(mini.podcastMiniPlayerModel({ ...state, status: 'idle', episode: null }, { chapters: list }).chapterText, '');
});
