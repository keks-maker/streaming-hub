'use strict';

// Tests: EpgService/EpgStore im Main (Etappe 1; Konzept §3.2, §5).
// Alles lokal: XMLTV-Dateien aus dem Test, lokaler HTTP-Server auf 127.0.0.1
// (URL-Validierung per Seam gelockert), kein Netz zur echten EPG-Quelle.
// Kein Fenster/Renderer beteiligt — der Dienst läuft rein im Main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EpgService } = require('../lib/epg/EpgService.js');
const { createEpgStore, channelKey } = require('../lib/epg/EpgStore.js');
const { fetchEpgResponse, parseXmltvResponse } = require('../lib/epg/download.js');
const { httpUrl } = require('../lib/input-validation.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0); // 05.10.2026 12:00 UTC

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** Zeit als XMLTV-String mit festem +0200-Offset. */
function xmltvTime(ms) {
  const d = new Date(ms + 2 * HOUR);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0200`
  );
}

/**
 * Erzeugt ein XMLTV mit stündlichen Sendungen je Kanal von fromMs bis toMs.
 */
function buildXmltv({ channels, fromMs, toMs, slotMs = HOUR, titlePrefix = 'Sendung' }) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n'];
  for (const ch of channels) parts.push(`<channel id="${ch}"><display-name>${ch}</display-name></channel>\n`);
  for (const ch of channels) {
    for (let t = fromMs; t < toMs; t += slotMs) {
      parts.push(
        `<programme start="${xmltvTime(t)}" stop="${xmltvTime(t + slotMs)}" channel="${ch}">` +
          `<title>${titlePrefix} ${ch} ${t}</title><desc>Beschreibung &amp; mehr</desc></programme>\n`,
      );
    }
  }
  parts.push('</tv>\n');
  return parts.join('');
}

function responseFor(text, { gzip = false } = {}) {
  const body = gzip ? zlib.gzipSync(Buffer.from(text, 'utf-8')) : Buffer.from(text, 'utf-8');
  return new Response(body, { status: 200 });
}

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'epg-test-'));
}

/** fetch-Seam: URL → Antwort-Factory; zählt Aufrufe. */
function makeFetch(map) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(url);
    const handler = map[url];
    if (!handler) throw new Error(`unerwartete URL ${url}`);
    return typeof handler === 'function' ? handler(opts) : handler;
  };
  fn.calls = calls;
  return fn;
}

const URL_A = 'https://epg.example/de.xml';
const SOURCES = [{ id: 'de', name: 'Deutsch', epgUrl: URL_A }];

function makeService({ dir = makeDir(), xml, fetchImpl, sources = SOURCES, clock = { t: NOW }, ...rest } = {}) {
  const fetchFn = fetchImpl || makeFetch({ [URL_A]: () => responseFor(xml) });
  const service = new EpgService({
    dir,
    getSources: () => sources,
    fetchImpl: fetchFn,
    validateUrl: u => u,
    now: () => clock.t,
    timers: { setInterval: () => 0, clearInterval: () => {} },
    ...rest,
  });
  return { service, dir, clock, fetchFn };
}

// ── (b) Cache ≥ 7 Tage ohne Fenster per API verfügbar ──

test('Wochen-Cache: ≥ 7 Tage sind ohne Fenster per API verfügbar (range/find/status)', async () => {
  const xml = buildXmltv({
    channels: ['DasErste.de', 'ZDF.de'],
    fromMs: NOW - 3 * DAY, // ältere Sendungen: außerhalb des Fensters (jetzt − 1 Tag)
    toMs: NOW + 12 * DAY, // über +10 Tage hinaus: wird abgeschnitten
  });
  const { service } = makeService({ xml });
  await service.refresh({ force: true });

  // Abfrage mit der tvgId aus der Senderliste (Suffix @HD wird normalisiert)
  const week = service.range('DasErste.de@HD', NOW, NOW + 7 * DAY);
  assert.ok(week.length >= 7 * 24, `7 Tage stündlich: ${week.length}`);
  assert.ok(week[0].start <= NOW && week[0].stop > NOW, 'beginnt mit der laufenden Sendung');
  assert.ok(week[week.length - 1].stop >= NOW + 7 * DAY, 'reicht mindestens 7 Tage');
  for (let i = 1; i < week.length; i += 1) assert.ok(week[i].start >= week[i - 1].start, 'sortiert');

  const current = service.find('DasErste.de@HD', NOW + 30 * 60 * 1000);
  assert.equal(current.start, NOW);
  assert.equal(current.stop, NOW + HOUR);
  assert.equal(current.desc, 'Beschreibung & mehr');
  assert.equal(service.find('DasErste.de', NOW - 2 * DAY), null, 'älter als jetzt − 1 Tag: nicht im Cache');
  assert.equal(service.find('DasErste.de', NOW + 11 * DAY), null, 'jenseits +10 Tage: nicht im Cache');
  assert.equal(service.find('Unbekannt.de', NOW), null);

  const status = service.status();
  assert.ok(status.coverageDays >= 7, `Abdeckung ${status.coverageDays} Tage`);
  assert.ok(status.coverageDays <= 10.1);
  assert.equal(status.sources[0].channelCount, 2);
  assert.equal(status.sources[0].url, URL_A);
  assert.equal(status.lastSuccessAt, NOW);
  assert.equal(status.nextRefreshAt, NOW + 12 * HOUR);
  assert.equal(status.refreshing, false);
});

test('Cache überlebt den Neustart: sofort nutzbar ohne Netz (Start aus dem Cache)', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + 10 * DAY });
  const first = makeService({ xml });
  await first.service.refresh({ force: true });
  assert.ok(fs.existsSync(path.join(first.dir, 'epg-cache.json')));

  // „App-Neustart“ ohne Netz: Fetch wirft — der Cache ist trotzdem sofort da
  const offline = makeService({
    dir: first.dir,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  await offline.service.start();
  assert.ok(offline.service.range('ZDF.de', NOW, NOW + 7 * DAY).length >= 7 * 24, 'Cache sofort nutzbar');
  assert.ok(offline.service.status().coverageDays >= 7);
  offline.service.stop();
});

test('Refresh-Fehlschlag: alter Cache bleibt, Status zeigt den Fehler', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + 10 * DAY });
  let mode = 'ok';
  const fetchImpl = makeFetch({
    [URL_A]: () => {
      if (mode === 'ok') return responseFor(xml);
      if (mode === 'http') return new Response('nope', { status: 503 });
      if (mode === 'empty') return responseFor('<tv></tv>');
      throw new Error('Netzwerk weg');
    },
  });
  const { service, clock } = makeService({ fetchImpl });
  await service.refresh({ force: true });
  const before = service.range('ZDF.de', NOW, NOW + 7 * DAY).length;
  assert.ok(before > 0);

  for (const failMode of ['http', 'empty', 'network']) {
    mode = failMode;
    clock.t += HOUR;
    const results = await service.refresh({ force: true });
    assert.equal(results[0].ok, false, failMode);
    assert.equal(service.range('ZDF.de', NOW, NOW + 7 * DAY).length, before, `Cache unverändert (${failMode})`);
    assert.ok(service.status().sources[0].lastError, `Fehler sichtbar (${failMode})`);
  }
  // Datei auf der Platte ebenfalls unverändert gültig
  const reloaded = createEpgStore({ dir: service.store.file.replace(/[/\\]epg-cache\.json$/, '') });
  await reloaded.load();
  assert.equal(reloaded.range('ZDF.de', NOW, NOW + 7 * DAY).length, before);

  // Erholung: nächster erfolgreicher Refresh löscht den Fehler
  mode = 'ok';
  await service.refresh({ force: true });
  assert.equal(service.status().sources[0].lastError, null);
});

test('Takt: Start-Refresh, 12-h-Takt, Wiederholung nach Fehlschlag (injizierte Uhr)', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + 10 * DAY });
  let ok = true;
  const fetchImpl = makeFetch({
    [URL_A]: () => {
      if (!ok) throw new Error('weg');
      return responseFor(xml);
    },
  });
  const { service, clock } = makeService({ fetchImpl });
  await service.tick({ atStart: true }); // kein Cache → sofort
  assert.equal(fetchImpl.calls.length, 1);

  clock.t += 11 * HOUR;
  assert.equal(await service.tick(), null, 'vor 12 h nicht fällig');
  assert.equal(fetchImpl.calls.length, 1);

  clock.t += 61 * 60 * 1000; // 12 h 1 min seit dem letzten Erfolg
  ok = false;
  await service.tick();
  assert.equal(fetchImpl.calls.length, 2, '2×/Tag: nach 12 h fällig');
  assert.ok(service.status().sources[0].lastError);

  clock.t += 10 * 60 * 1000;
  await service.tick();
  assert.equal(fetchImpl.calls.length, 2, 'nach Fehlschlag erst nach 30 min wieder');
  clock.t += 25 * 60 * 1000;
  ok = true;
  await service.tick();
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(service.status().sources[0].lastError, null);
});

test('Start mit frischem Cache (< 30 min) lädt nicht erneut; mit altem Cache schon', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + 10 * DAY });
  const first = makeService({ xml });
  await first.service.refresh({ force: true });

  const fresh = makeService({ dir: first.dir, xml, clock: { t: NOW + 10 * 60 * 1000 } });
  await fresh.service.start();
  await fresh.service.initialRefresh;
  assert.equal(fresh.fetchFn.calls.length, 0, 'frischer Cache: kein Download beim Start');
  fresh.service.stop();

  const stale = makeService({ dir: first.dir, xml, clock: { t: NOW + 2 * HOUR } });
  await stale.service.start();
  await stale.service.initialRefresh;
  assert.equal(stale.fetchFn.calls.length, 1, 'älterer Cache: Refresh beim Start');
  stale.service.stop();
});

test('Mehrere Quellen: je URL ein Download, Duplikate zusammengelegt, entfernte Quellen aus dem Cache gepruned', async () => {
  const urlB = 'https://epg.example/at.xml';
  const xmlA = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - HOUR, toMs: NOW + 2 * DAY, titlePrefix: 'A' });
  const xmlB = buildXmltv({ channels: ['ORF1.at'], fromMs: NOW - HOUR, toMs: NOW + 2 * DAY, titlePrefix: 'B' });
  const fetchImpl = makeFetch({ [URL_A]: () => responseFor(xmlA), [urlB]: () => responseFor(xmlB) });
  let sources = [
    { id: 'de', epgUrl: URL_A },
    { id: 'de2', epgUrl: URL_A },
    { id: 'at', epgUrl: urlB },
    { id: 'ohne' },
  ];
  const { service } = makeService({ fetchImpl, sources });
  service.getSources = () => sources;
  await service.refresh({ force: true });
  assert.equal(fetchImpl.calls.length, 2, 'URL_A nur einmal geladen');
  assert.ok(service.find('ZDF.de', NOW));
  assert.ok(service.find('ORF1.at', NOW));
  assert.deepEqual(service.status().sources.find(s => s.url === URL_A).sourceIds, ['de', 'de2']);

  sources = [{ id: 'at', epgUrl: urlB }];
  await service.tick();
  assert.equal(service.find('ZDF.de', NOW), null, 'entfernte Quelle: Cache gepruned');
  assert.ok(service.find('ORF1.at', NOW));
});

test('Kanal-Zuordnung: gleiche Normalisierung wie der Renderer (typed-core normalizeTvId)', async () => {
  assert.equal(channelKey('DasErste.de@HD'), 'daserste.de');
  assert.equal(channelKey('ard@hdr.de'), 'ard.de');
  assert.equal(channelKey(' ZDF.de '), 'zdf.de');
  assert.equal(channelKey(null), '');
  const xml = buildXmltv({ channels: ['DasErste.de'], fromMs: NOW - HOUR, toMs: NOW + DAY });
  const { service } = makeService({ xml });
  await service.refresh({ force: true });
  for (const id of ['DasErste.de', 'DasErste.de@HD', 'daserste.de@SD', 'DASERSTE.DE']) {
    assert.ok(service.find(id, NOW), `tvgId ${id} → Slot`);
  }
});

// ── Download: Validierung, Größenlimit, gzip ──

test('Download-Validierung: private/ungültige URLs und Redirect-Ziele werden abgelehnt (remoteHttpUrl)', async () => {
  const never = async () => {
    throw new Error('darf nicht aufgerufen werden');
  };
  await assert.rejects(() => fetchEpgResponse('http://127.0.0.1/epg.xml', { fetchImpl: never }), /EPG-URL/);
  await assert.rejects(() => fetchEpgResponse('ftp://example.com/epg.xml', { fetchImpl: never }), /EPG-URL/);
  await assert.rejects(() => fetchEpgResponse('http://localhost/epg.xml', { fetchImpl: never }), /EPG-URL/);
  // Redirect auf interne Adresse
  const redirect = async () => new Response(null, { status: 302, headers: { location: 'http://192.168.0.1/x.xml' } });
  await assert.rejects(() => fetchEpgResponse('https://example.com/epg.xml', { fetchImpl: redirect }), /Redirect-Ziel/);
  // Redirect-Schleife
  const loop = async () => new Response(null, { status: 302, headers: { location: 'https://example.com/again.xml' } });
  await assert.rejects(() => fetchEpgResponse('https://example.com/epg.xml', { fetchImpl: loop }), /Zu viele Redirects/);
  // Redirect ohne Ziel / HTTP-Fehler
  await assert.rejects(
    () => fetchEpgResponse('https://example.com/epg.xml', { fetchImpl: async () => new Response(null, { status: 302 }) }),
    /ohne Redirect-Ziel/,
  );
  await assert.rejects(
    () => fetchEpgResponse('https://example.com/epg.xml', { fetchImpl: async () => new Response('x', { status: 404 }) }),
    /HTTP 404/,
  );
  // Service nutzt dieselbe Validierung (Default remoteHttpUrl): interne URL → ungültige Quelle, kein Fetch
  const calls = [];
  const service = new EpgService({
    dir: makeDir(),
    getSources: () => [{ id: 'x', epgUrl: 'http://127.0.0.1/epg.xml' }],
    fetchImpl: async u => calls.push(u),
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  await service.refresh({ force: true });
  assert.equal(calls.length, 0);
  assert.equal(service.status().invalidSources.length, 1);
});

test('Redirects werden gefolgt und jeweils validiert', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - HOUR, toMs: NOW + DAY });
  const fetchImpl = makeFetch({
    [URL_A]: () => new Response(null, { status: 302, headers: { location: '/files/hash123/de.xml' } }),
    'https://epg.example/files/hash123/de.xml': () => responseFor(xml),
  });
  const { service } = makeService({ fetchImpl });
  const [result] = await service.refresh({ force: true });
  assert.equal(result.ok, true);
  assert.deepEqual(fetchImpl.calls, [URL_A, 'https://epg.example/files/hash123/de.xml']);
});

test('MAX_EPG_BYTES: zu große Antworten werden abgebrochen (übertragen UND entpackt)', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - HOUR, toMs: NOW + 5 * DAY });
  const small = makeService({ xml, maxBytes: 2000 });
  const [r1] = await small.service.refresh({ force: true });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /zu groß/);

  // Dekompressionsbombe: kleiner Download, riesig entpackt
  const bomb = zlib.gzipSync(Buffer.from('<tv>' + ' '.repeat(5 * 1024 * 1024) + '</tv>'));
  assert.ok(bomb.length < 20000);
  await assert.rejects(
    () => parseXmltvResponse(new Response(bomb), { maxBytes: 1024 * 1024, onProgramme: () => {} }),
    /zu groß \(entpackt\)/,
  );
  // Content-Length-unabhängig: Streaming-Abbruch
  await assert.rejects(
    () => parseXmltvResponse(new Response(Buffer.alloc(3000, 0x20)), { maxBytes: 1000, onProgramme: () => {} }),
    /zu groß/,
  );
});

test('gzip: rohe .gz-Antwort (Magic 1f 8b) wird per Stream entpackt', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - HOUR, toMs: NOW + 2 * DAY });
  const gzUrl = 'https://epg.example/de.xml.gz';
  const fetchImpl = makeFetch({ [gzUrl]: () => responseFor(xml, { gzip: true }) });
  const { service } = makeService({ fetchImpl, sources: [{ id: 'de', epgUrl: gzUrl }] });
  const [result] = await service.refresh({ force: true });
  assert.equal(result.ok, true);
  assert.ok(service.find('ZDF.de', NOW));
  const stats = await parseXmltvResponse(responseFor(xml, { gzip: true }), { onProgramme: () => {} });
  assert.equal(stats.gzip, true);
  const plain = await parseXmltvResponse(responseFor(xml), { onProgramme: () => {} });
  assert.equal(plain.gzip, false);
  assert.equal(plain.emitted, stats.emitted);
});

test('gzip: defekter gzip-Stream lässt den Cache unverändert', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - HOUR, toMs: NOW + 2 * DAY });
  const good = zlib.gzipSync(Buffer.from(xml));
  let broken = false;
  const fetchImpl = makeFetch({
    [URL_A]: () => new Response(broken ? good.subarray(0, Math.floor(good.length / 2)) : good),
  });
  const { service } = makeService({ fetchImpl });
  await service.refresh({ force: true });
  const before = service.range('ZDF.de', NOW - DAY, NOW + 3 * DAY).length;
  broken = true;
  const [r] = await service.refresh({ force: true });
  assert.equal(r.ok, false);
  assert.equal(service.range('ZDF.de', NOW - DAY, NOW + 3 * DAY).length, before);
});

test('HTTP: Node-fetch sendet Accept-Encoding gzip und dekodiert Content-Encoding transparent', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - HOUR, toMs: NOW + 2 * DAY });
  const gz = zlib.gzipSync(Buffer.from(xml));
  const seen = {};
  const server = http.createServer((req, res) => {
    seen.acceptEncoding = req.headers['accept-encoding'];
    if (/gzip/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xml);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/epg-de.xml`;
    const { service } = makeService({
      fetchImpl: fetch, // echtes fetch gegen den lokalen Server
      validateUrl: httpUrl, // 127.0.0.1 nur im Test erlaubt
      sources: [{ id: 'de', epgUrl: url }],
    });
    const [result] = await service.refresh({ force: true });
    assert.equal(result.ok, true, result.error);
    assert.match(seen.acceptEncoding, /gzip/, 'Accept-Encoding: gzip wird gesendet');
    assert.ok(service.find('ZDF.de', NOW));
  } finally {
    server.close();
  }
});

test('Nicht-UTF-8-Kodierung laut XML-Deklaration (ISO-8859-1) wird korrekt dekodiert', async () => {
  const xml =
    '<?xml version="1.0" encoding="ISO-8859-1"?><tv><programme start="20261005140000 +0200" stop="20261005150000 +0200" channel="ZDF.de">' +
    '<title>Käse &amp; Würstchen</title></programme></tv>';
  const items = [];
  await parseXmltvResponse(new Response(Buffer.from(xml, 'latin1')), { onProgramme: p => items.push(p) });
  assert.equal(items[0].title, 'Käse & Würstchen');
});

// ── Store ──

test('Store: Persistenz-Roundtrip, defekte/fremde Cache-Datei wird ignoriert, atomares Schreiben', async () => {
  const dir = makeDir();
  const store = createEpgStore({ dir });
  const slots = new Map([['ZDF.de@HD', [{ start: NOW, stop: NOW + HOUR, title: 'A', desc: 'd' }]]]);
  store.setSource(URL_A, { fetchedAt: NOW, sourceIds: ['de'], channelSlots: slots });
  await store.save();
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'kein tmp-Rest');

  const again = createEpgStore({ dir });
  assert.equal(await again.load(), 1);
  assert.equal(again.find('zdf.de', NOW + 1).title, 'A');

  fs.writeFileSync(path.join(dir, 'epg-cache.json'), '{kaputt');
  assert.equal(await createEpgStore({ dir }).load(), 0, 'defekte Datei → leerer Cache, kein Wurf');
  fs.writeFileSync(path.join(dir, 'epg-cache.json'), JSON.stringify({ version: 99, sources: {} }));
  assert.equal(await createEpgStore({ dir }).load(), 0, 'fremde Version → ignoriert');
  assert.equal(await createEpgStore({ dir: makeDir() }).load(), 0, 'fehlende Datei → leer');
});

test('Store: range liefert überlappende Slots (Rand: stop == from / start == to ausgeschlossen), find nutzt [start, stop)', () => {
  const store = createEpgStore({ dir: makeDir() });
  const slots = new Map([
    ['ch', [
      { start: 1000, stop: 2000, title: 'A', desc: '' },
      { start: 2000, stop: 3000, title: 'B', desc: '' },
      { start: 3000, stop: 4000, title: 'C', desc: '' },
    ]],
  ]);
  store.setSource('u', { fetchedAt: 1, sourceIds: [], channelSlots: slots });
  assert.deepEqual(store.range('ch', 2000, 3000).map(s => s.title), ['B']);
  assert.deepEqual(store.range('ch', 1500, 3500).map(s => s.title), ['A', 'B', 'C']);
  assert.deepEqual(store.range('ch', 4000, 5000), []);
  assert.equal(store.find('ch', 2000).title, 'B');
  assert.equal(store.find('ch', 1999).title, 'A');
  assert.equal(store.find('ch', 4000), null);
  // Rückgabe ist eine Kopie: Mutation beeinflusst den Cache nicht
  store.range('ch', 0, 9999)[0].title = 'X';
  assert.equal(store.find('ch', 1000).title, 'A');
});

test('Parsing großer Dokumente: 438 Kanäle × 10 Tage ohne Gesamtstring (Streaming), Ergebnis vollständig', async () => {
  const channels = Array.from({ length: 60 }, (_, i) => `Kanal${i}.de`);
  const xml = buildXmltv({ channels, fromMs: NOW - DAY, toMs: NOW + 10 * DAY, slotMs: 2 * HOUR });
  const { service } = makeService({ xml });
  const [result] = await service.refresh({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.channels, 60);
  assert.equal(result.slots, 60 * 11 * 12);
  assert.ok(service.range('Kanal59.de', NOW, NOW + 7 * DAY).length >= 7 * 12);
});

test('autoRefresh=false (isolierte Testläufe): Cache wird geladen, aber nichts automatisch heruntergeladen', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + 10 * DAY });
  const first = makeService({ xml });
  await first.service.refresh({ force: true });
  const isolated = makeService({ dir: first.dir, xml, clock: { t: NOW + 3 * DAY }, autoRefresh: false });
  await isolated.service.start();
  assert.equal(await isolated.service.tick(), null);
  assert.equal(await isolated.service.tick({ atStart: true }), null);
  assert.equal(isolated.fetchFn.calls.length, 0, 'kein automatischer Download');
  assert.ok(isolated.service.find('ZDF.de', NOW + DAY), 'Cache trotzdem nutzbar');
  const [manual] = await isolated.service.refresh({ force: true });
  assert.equal(manual.ok, true, 'manueller Refresh funktioniert');
  isolated.service.stop();
});

test('Service: stop() bricht laufende Refreshes ab und ist wiederholbar', async () => {
  const { service } = makeService({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  await service.start();
  service.stop();
  service.stop();
});

// ── epg:changed (Etappe 3.1): onChanged feuert nach erfolgreichem Refresh ──

test('onChanged: feuert nach erfolgreichem Refresh (einmal je Refresh, nach dem Speichern), Abmelden geht', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + DAY });
  const { service, dir } = makeService({ xml });
  const events = [];
  const off = service.onChanged(payload => {
    // beim Event sind die neuen Daten bereits im Cache und auf der Platte
    events.push({ ...payload, slots: service.range('ZDF.de', NOW, NOW + HOUR).length, saved: fs.existsSync(path.join(dir, 'epg-cache.json')) });
  });
  await service.refresh({ force: true });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { at: NOW, urls: [URL_A], slots: 1, saved: true });
  // parallele Aufrufe teilen sich den Refresh → ein Event
  await Promise.all([service.refresh({ force: true }), service.refresh({ force: true })]);
  assert.equal(events.length, 2);
  off();
  await service.refresh({ force: true });
  assert.equal(events.length, 2, 'nach dem Abmelden kein Event mehr');
  assert.throws(() => service.onChanged('kein listener'), /Funktion/);
});

test('onChanged: kein Event bei Fehlschlag (Download, leeres XMLTV); alter Cache bleibt', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + DAY });
  let mode = 'ok';
  const { service, clock } = makeService({
    fetchImpl: async () => {
      if (mode === 'down') throw new Error('Netz weg');
      return responseFor(mode === 'empty' ? '<tv></tv>' : xml);
    },
  });
  let count = 0;
  service.onChanged(() => {
    count += 1;
  });
  await service.refresh({ force: true });
  assert.equal(count, 1);
  for (const m of ['down', 'empty']) {
    mode = m;
    clock.t += HOUR;
    const results = await service.refresh({ force: true });
    assert.equal(results[0].ok, false, m);
  }
  assert.equal(count, 1, 'Fehlschläge melden nichts');
  assert.equal(service.range('ZDF.de', NOW, NOW + HOUR).length, 1, 'alter Cache bleibt');
});

test('onChanged: feuert auch bei refreshForSource (Slip-Refresh), nicht ohne passende Quelle; Fehler im Listener stören nicht', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + DAY });
  const { service } = makeService({ xml, logger: { warn() {}, info() {} } });
  const urls = [];
  service.onChanged(() => {
    throw new Error('Listener kaputt');
  });
  service.onChanged(p => urls.push(...p.urls));
  const ok = await service.refreshForSource('de');
  assert.equal(ok.ok, true);
  assert.deepEqual(urls, [URL_A]);
  const none = await service.refreshForSource('gibtsnicht');
  assert.equal(none.ok, false);
  assert.deepEqual(urls, [URL_A], 'keine betroffene Quelle → kein Event');
});

test('onChanged: Takt-Refresh (tick) meldet ebenfalls, ein Tick ohne Fälligkeit nicht', async () => {
  const xml = buildXmltv({ channels: ['ZDF.de'], fromMs: NOW - DAY, toMs: NOW + 2 * DAY });
  const { service, clock } = makeService({ xml });
  let count = 0;
  service.onChanged(() => {
    count += 1;
  });
  await service.tick();
  assert.equal(count, 1);
  await service.tick();
  assert.equal(count, 1, 'nicht fällig');
  clock.t += 13 * HOUR;
  await service.tick();
  assert.equal(count, 2);
});
