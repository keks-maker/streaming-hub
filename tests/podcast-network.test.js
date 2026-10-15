'use strict';

// Tests: Feed-Abruf (echter nodeFetch gegen lokalen Server: gzip, Redirects, 304), Aktualisierung (podcast-refresh.js)
// und iTunes-Suche (podcast-search.js, injizierter Transport).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { fetchFeed } = require('../lib/podcast/podcast-fetch.js');
const { createPodcastRefresher } = require('../lib/podcast/podcast-refresh.js');
const { createPodcastSearch, normalizeTerm, alternativeSpelling, SearchError } = require('../lib/podcast/podcast-search.js');
const { PodcastLibrary } = require('../lib/podcast/PodcastLibrary.js');
const { createUserStorage } = require('../lib/user-storage.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'podcast', name));

async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, requests);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('fetchFeed: gzip wird entpackt, ETag/Last-Modified werden geliefert, Accept-Encoding gesendet', async () => {
  const body = fixture('normal.xml');
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Content-Encoding': 'gzip', ETag: '"v1"', 'Last-Modified': 'Thu, 15 Oct 2026 08:00:00 GMT' });
      res.end(zlib.gzipSync(body));
    },
    async (base, requests) => {
      const result = await fetchFeed(`${base}/feed.xml`);
      assert.equal(result.status, 'ok');
      assert.equal(result.text, body.toString('utf8'));
      assert.equal(result.etag, '"v1"');
      assert.equal(result.lastModified, 'Thu, 15 Oct 2026 08:00:00 GMT');
      assert.match(requests[0].headers['accept-encoding'], /gzip/);
      assert.match(requests[0].headers['user-agent'], /StreamingHub-Podcasts/);
    }
  );
});

test('fetchFeed: bedingter Request liefert 304, Validatoren werden gesendet und bleiben erhalten', async () => {
  await withServer(
    (req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304);
        res.end();
      } else {
        res.writeHead(200, { ETag: '"v1"' });
        res.end('<rss><channel/></rss>');
      }
    },
    async (base, requests) => {
      const result = await fetchFeed(`${base}/f`, { validators: { etag: '"v1"', lastModified: 'Thu, 15 Oct 2026 08:00:00 GMT' } });
      assert.deepEqual(result, { status: 'not-modified', etag: '"v1"', lastModified: 'Thu, 15 Oct 2026 08:00:00 GMT' });
      assert.equal(requests[0].headers['if-none-match'], '"v1"');
      assert.equal(requests[0].headers['if-modified-since'], 'Thu, 15 Oct 2026 08:00:00 GMT');
    }
  );
});

test('fetchFeed: Redirects bis 5 werden verfolgt, mehr nicht; Fehlerstatus und Zeichensatz', async () => {
  await withServer(
    (req, res) => {
      const hop = /^\/r(\d+)$/.exec(req.url);
      if (hop) {
        res.writeHead(302, { Location: Number(hop[1]) >= 99 ? '/r99' : `/r${Number(hop[1]) + 1}` });
        res.end();
      } else if (req.url === '/start5') {
        res.writeHead(302, { Location: '/r96' });
        res.end();
      } else if (req.url === '/final') {
        res.writeHead(200);
        res.end('<rss><channel><title>ok</title></channel></rss>');
      } else if (req.url === '/latin1') {
        res.writeHead(200);
        res.end(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Küche</title></channel></rss>', 'latin1'));
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    },
    async base => {
      // /start5 -> /r96 -> r97 -> r98 -> r99 -> r99 ... Schleife: Limit greift
      await assert.rejects(fetchFeed(`${base}/start5`), /Zu viele Weiterleitungen/);
      await assert.rejects(fetchFeed(`${base}/missing`), /HTTP 404/);
      assert.match((await fetchFeed(`${base}/latin1`)).text, /Küche/);
    }
  );
  await withServer(
    (req, res) => {
      const n = Number(req.url.slice(1)) || 0;
      if (n < 5) {
        res.writeHead(301, { Location: `/${n + 1}` });
        res.end();
      } else {
        res.writeHead(200);
        res.end('<rss><channel><title>fünf Hops</title></channel></rss>');
      }
    },
    async base => assert.match((await fetchFeed(`${base}/0`)).text, /fünf Hops/)
  );
});

test('fetchFeed: Größenlimit (auch entpackt) und Fehlermeldungen ohne URL', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/big') {
        res.writeHead(200);
        res.end(Buffer.alloc(3000, 'a'));
      } else if (req.url === '/bomb') {
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.alloc(1_000_000, 'a')));
      } else if (req.url === '/badgzip') {
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.end('kein gzip');
      } else {
        res.destroy();
      }
    },
    async base => {
      await assert.rejects(fetchFeed(`${base}/big`, { maxBytes: 1000 }), /zu groß/);
      await assert.rejects(fetchFeed(`${base}/bomb`, { maxBytes: 100_000 }), /zu groß/);
      await assert.rejects(fetchFeed(`${base}/badgzip`), /entpackt/);
      await assert.rejects(fetchFeed(`${base}/drop?token=geheim`), error => !/geheim|127\.0\.0\.1/.test(error.message));
      await assert.rejects(fetchFeed('ftp://example.test/x'), /http/i);
    }
  );
});

// ── Refresh ──

function setup(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-podcast-refresh-'));
  const storage = createUserStorage({ userDataPath: path.join(root, 'u'), bundlePath: path.join(root, 'b') });
  let nowMs = Date.parse('2026-10-15T10:00:00Z');
  const clock = { now: () => new Date(nowMs), advance: ms => (nowMs += ms) };
  const library = new PodcastLibrary({ userStorage: storage, now: clock.now });
  return { library, clock, ...extra };
}
const feedText = fixture('normal.xml').toString('utf8');

test('Refresh: Erstabruf füllt Cache und Metadaten, danach 304 ändert nichts, Titel eigener Feeds wird ergänzt', async () => {
  const { library, clock } = setup();
  const { subscription } = library.subscribe({ feedUrl: 'https://a.test/feed', source: 'eigene-podcasts' });
  const calls = [];
  const fetch = async (url, { validators }) => {
    calls.push(validators);
    return validators.etag ? { status: 'not-modified', etag: validators.etag, lastModified: null } : { status: 'ok', text: feedText, etag: '"e1"', lastModified: 'Thu, 15 Oct 2026 08:00:00 GMT' };
  };
  const refresher = createPodcastRefresher({ library, fetch, now: clock.now });
  const first = await refresher.refreshOne(subscription.id);
  assert.deepEqual([first.status, first.episodeCount, first.newEpisodes], ['updated', 3, 0]);
  assert.equal(library.getEpisodes(subscription.id).episodes.length, 3);
  assert.equal(library.getSubscription(subscription.id).title, 'Der & Test-Podcast');
  assert.equal(library.getFeedMeta(subscription.id).etag, '"e1"');
  clock.advance(10 * 60 * 1000);
  const second = await refresher.refreshOne(subscription.id);
  assert.equal(second.status, 'not-modified');
  assert.deepEqual(calls[1], { etag: '"e1"', lastModified: 'Thu, 15 Oct 2026 08:00:00 GMT' });
  assert.equal(library.getFeedMeta(subscription.id).lastChecked, clock.now().toISOString());
  assert.equal(library.getEpisodes(subscription.id).episodes.length, 3, 'Cache bleibt bei 304');
});

test('Refresh: Feeds ohne Validatoren höchstens alle 60 min (force umgeht), neue Episoden werden gezählt', async () => {
  const { library, clock } = setup();
  const { subscription } = library.subscribe({ feedUrl: 'https://a.test/feed', title: 'A', source: 'eigene-podcasts' });
  let text = feedText;
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { status: 'ok', text, etag: null, lastModified: null };
  };
  const refresher = createPodcastRefresher({ library, fetch, now: clock.now });
  assert.equal((await refresher.refreshOne(subscription.id)).status, 'updated');
  clock.advance(59 * 60 * 1000);
  assert.equal((await refresher.refreshOne(subscription.id)).status, 'skipped');
  assert.equal(calls, 1);
  assert.equal((await refresher.refreshOne(subscription.id, { force: true })).status, 'updated');
  clock.advance(61 * 60 * 1000);
  text = feedText.replace('<item>', '<item><title>Neu</title><guid>ep-4</guid><pubDate>Thu, 15 Oct 2026 06:00:00 +0000</pubDate><enclosure url="https://example.test/ep4.mp3" type="audio/mpeg"/></item><item>');
  const result = await refresher.refreshOne(subscription.id);
  assert.deepEqual([result.status, result.newEpisodes], ['updated', 1]);
  assert.equal(calls, 3);
});

test('Refresh: Fehlerzustand pro Abo (Meldung, Zeit), Cache bleibt, nächster Lauf versucht es erneut, Erfolg löscht den Fehler', async () => {
  const { library, clock } = setup();
  const good = library.subscribe({ feedUrl: 'https://good.test/feed', title: 'Gut', source: 'eigene-podcasts' }).subscription;
  const bad = library.subscribe({ feedUrl: 'https://bad.test/feed?token=geheim', title: 'Schlecht', source: 'eigene-podcasts' }).subscription;
  let failing = true;
  const logged = [];
  const fetch = async url => {
    if (url.includes('bad.test')) {
      if (failing) throw new Error('Server antwortete mit HTTP 404');
      return { status: 'ok', text: feedText, etag: null, lastModified: null };
    }
    return { status: 'ok', text: feedText, etag: null, lastModified: null };
  };
  const refresher = createPodcastRefresher({ library, fetch, now: clock.now, logger: { warn: (...a) => logged.push(a.join(' ')) } });
  const summary = await refresher.refreshAll();
  assert.deepEqual([summary.updated, summary.failed], [1, 1]);
  assert.equal(library.getFeedMeta(bad.id).lastError, 'Server antwortete mit HTTP 404');
  assert.ok(library.getFeedMeta(bad.id).lastErrorAt);
  assert.equal(library.getEpisodes(good.id).episodes.length, 3, 'ein Fehler stoppt die anderen nicht');
  assert.ok(!logged.join(' ').includes('geheim'), 'URL wird nie geloggt');
  clock.advance(60 * 1000);
  failing = false;
  const again = await refresher.refreshAll();
  assert.equal(again.results.find(r => r.id === bad.id).status, 'updated', 'Fehler -> sofort erneut, auch ohne Validatoren');
  assert.equal(library.getFeedMeta(bad.id).lastError, null);
  const broken = createPodcastRefresher({ library, fetch: async () => ({ status: 'ok', text: '<html></html>' }), now: clock.now });
  const result = await broken.refreshOne(good.id, { force: true });
  assert.equal(result.status, 'error');
  assert.match(result.error, /kein gültiger Podcast-Feed/i);
  assert.equal(library.getEpisodes(good.id).episodes.length, 3, 'Cache bleibt nach Parse-Fehler');
  assert.equal((await refresher.refreshOne('unbekannt')).status, 'error');
});

test('Refresh: höchstens 4 Feeds parallel; gleiches Abo wird nicht doppelt geladen', async () => {
  const { library, clock } = setup();
  for (let i = 0; i < 10; i += 1) library.subscribe({ feedUrl: `https://p${i}.test/feed`, title: `P${i}`, source: 'eigene-podcasts' });
  let active = 0;
  let peak = 0;
  let total = 0;
  const fetch = async () => {
    total += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return { status: 'ok', text: feedText, etag: null, lastModified: null };
  };
  const refresher = createPodcastRefresher({ library, fetch, now: clock.now });
  const summary = await refresher.refreshAll();
  assert.equal(summary.updated, 10);
  assert.equal(peak, 4);
  const id = library.getSubscriptions()[0].id;
  total = 0;
  await Promise.all([refresher.refreshOne(id, { force: true }), refresher.refreshOne(id, { force: true })]);
  assert.equal(total, 1);
});

// ── Suche ──

function fakeResponse(status, body) {
  const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { status, headers: { get: () => null }, body: null, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
}
const hit = (name, feedUrl, extra = {}) => ({ collectionName: name, artistName: 'Autor', feedUrl, artworkUrl600: 'https://img.test/600.jpg', artworkUrl100: 'https://img.test/100.jpg', primaryGenreName: 'Nachrichten', ...extra });

test('Suche-Normalisierung: NFC, Leerraum, Steuerzeichen, Länge; alternative Schreibweise', () => {
  assert.equal(normalizeTerm('  Küche \t\n heute  '), 'Küche heute');
  assert.equal(normalizeTerm('a'), '');
  assert.equal(normalizeTerm(42), '');
  assert.equal(normalizeTerm('x'.repeat(300)).length, 100);
  assert.equal(alternativeSpelling('Küche'), 'Kueche');
  assert.equal(alternativeSpelling('Kueche'), 'Küche');
  assert.equal(alternativeSpelling('Müller Öl'), 'Mueller Oel');
  assert.equal(alternativeSpelling('Radio'), null);
});

test('Suche: Anfrage mit limit <= 25 und nur dem Suchbegriff, Ergebnisse gemappt, ungültige Feeds verworfen', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(new URL(url));
    return fakeResponse(200, {
      results: [
        hit('Gut', 'https://good.test/feed'),
        hit('Duplikat', 'HTTPS://GOOD.test/feed'),
        hit('Ohne Feed', undefined),
        hit('Falsches Schema', 'ftp://x.test/feed'),
        hit('Mit Zugangsdaten', 'https://u:p@x.test/feed'),
        hit('<b>Fett</b> &amp; Co', 'https://other.test/feed', { artworkUrl600: 'javascript:1', artworkUrl100: 'https://img.test/100.jpg' }),
      ],
    });
  };
  const { search } = createPodcastSearch({ fetchImpl });
  const { results, cached } = await search('  Nachrichten  ', { limit: 999 });
  assert.equal(cached, false);
  assert.equal(urls[0].origin + urls[0].pathname, 'https://itunes.apple.com/search');
  assert.equal(urls[0].searchParams.get('term'), 'Nachrichten');
  assert.equal(urls[0].searchParams.get('limit'), '25');
  assert.equal(urls[0].searchParams.get('media'), 'podcast');
  assert.deepEqual([...urls[0].searchParams.keys()].sort(), ['country', 'entity', 'limit', 'media', 'term']);
  assert.deepEqual(results.map(r => r.title), ['Gut', 'Fett & Co']);
  assert.equal(results[0].cover, 'https://img.test/600.jpg');
  assert.equal(results[1].cover, 'https://img.test/100.jpg', 'Fallback auf kleineres Cover bei ungültiger URL');
  assert.match(results[0].id, /^[0-9a-f]{24}$/);
});

test('Suche: 24-h-Cache (Groß-/Kleinschreibung egal), danach neue Anfrage; Umlaut-Variante bei 0 Treffern', async () => {
  let clock = 1_000_000;
  const terms = [];
  const fetchImpl = async url => {
    const term = new URL(url).searchParams.get('term');
    terms.push(term);
    return fakeResponse(200, { results: term === 'Kueche' ? [hit('Küchenradio', 'https://k.test/feed')] : [] });
  };
  const { search } = createPodcastSearch({ fetchImpl, now: () => clock });
  const first = await search('Küche');
  assert.deepEqual(terms, ['Küche', 'Kueche']);
  assert.equal(first.results.length, 1);
  assert.equal((await search('küche')).cached, true);
  assert.equal(terms.length, 2);
  clock += 24 * 3600 * 1000 + 1;
  assert.equal((await search('Küche')).cached, false);
  assert.equal(terms.length, 4);
  await assert.rejects(search('a'), error => error instanceof SearchError && error.code === 'invalid');
});

test('Suche: HTTP 429 und lokale Ratenbremse melden „rate-limited“, andere Fehler eigene Codes', async () => {
  const { search } = createPodcastSearch({ fetchImpl: async () => fakeResponse(429, 'Too Many Requests') });
  await assert.rejects(search('Wissen'), error => error.code === 'rate-limited' && /später/.test(error.message));
  const http500 = createPodcastSearch({ fetchImpl: async () => fakeResponse(500, 'x') });
  await assert.rejects(http500.search('Wissen'), error => error.code === 'http');
  const garbage = createPodcastSearch({ fetchImpl: async () => fakeResponse(200, 'kein json') });
  await assert.rejects(garbage.search('Wissen'), error => error.code === 'http');
  const down = createPodcastSearch({ fetchImpl: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  await assert.rejects(down.search('Wissen'), error => error.code === 'network');
  let requests = 0;
  const limited = createPodcastSearch({ fetchImpl: async () => { requests += 1; return fakeResponse(200, { results: [hit('X', 'https://x.test/f')] }); }, now: () => 5000 });
  for (let i = 0; i < 18; i += 1) await limited.search(`begriff ${i}`);
  await assert.rejects(limited.search('begriff 99'), error => error.code === 'rate-limited');
  assert.equal(requests, 18, 'die 19. Anfrage geht gar nicht erst raus');
});
