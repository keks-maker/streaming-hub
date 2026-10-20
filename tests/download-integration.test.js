'use strict';

// Integrationstest: DownloadService + echter DownloadJob + ffmpeg/ffprobe (bin/) + lokaler HTTP-Server mit Mini-Testmedien.
// Prüft den Weg Einreihen -> Auflösen -> Mux -> Prüfung -> Ablage (Serienordner, NFO, Cover, .srt) und die Wiederaufnahme nach dem
// Beenden per Range-Resume. Ohne Binaries übersprungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DownloadService } = require('../lib/download/DownloadService.js');
const { createDownloadStore } = require('../lib/download/DownloadStore.js');
const { createCoverFetcher } = require('../lib/download/cover.js');
const { normalizeDownloadSettings } = require('../lib/download/download-settings.js');
const { binaries, makeMedia, probe, startServer } = require('./helpers/download-media.js');

const bins = binaries();
const skip = bins ? false : 'ffmpeg/ffprobe nicht verfügbar';

async function waitFor(condition, label, timeoutMs = 20000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Zeitüberschreitung: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const ENTRY = { id: 'E1', title: 'Die Entführung (S01/E02)', subtitle: null, description: 'Kurzbeschreibung', imageUrl: 'https://img.ardmediathek.de/x.jpg', duration: 4, sourceId: 'ard', airedAt: '2026-03-19T20:15:00.000Z', partner: 'ard', season: 1, episode: 2, regionRestricted: false, originalVersionId: null, audioDescriptionId: null, availableUntil: null };
const SERIES = { id: 'SER', title: 'Das Institut', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/SER?embedded=true' };

function infoFor(server, media = 'video.mp4') {
  return {
    source: 'ard',
    variants: [{ id: 'v', kind: 'progressive', url: server.url(media), width: 160, height: 90, bitrate: null, codec: 'h264', label: 'HD' }],
    audioTracks: [
      { id: 'main', kind: 'main', language: 'deu', label: 'Standard', isDefault: true, url: server.url(media), hlsUrl: null, uri: null, groupId: null },
      { id: 'ad', kind: 'audio-description', language: 'deu', label: 'Audiodeskription', isDefault: false, url: server.url('ad.mp4'), hlsUrl: null, uri: null, groupId: null },
    ],
    subtitles: [{ id: 'sub', language: 'de', label: 'Untertitel', url: server.url('sub.vtt'), format: 'webvtt', kind: 'normal' }],
    restriction: null,
    availableUntil: null,
    season: 1,
    episode: 2,
    broadcastDate: '2026-03-20',
    seriesTitle: 'Das Institut',
    title: 'Die Entführung (S01/E02)',
    durationSeconds: 4,
    isExtra: false,
  };
}

function makeService(dir, server, settings, over = {}) {
  const recRoot = path.join(dir, 'rec');
  fs.mkdirSync(recRoot, { recursive: true });
  return new DownloadService({
    store: createDownloadStore({ file: path.join(dir, 'downloads.json') }),
    resolver: { resolveForDownload: async () => infoFor(server) },
    getSettings: () => normalizeDownloadSettings(settings).settings,
    getRecordingRoot: () => recRoot,
    getReserveBytes: () => 1024 * 1024,
    ffmpegPath: bins.ffmpeg,
    ffprobePath: bins.ffprobe,
    mediaHttp: { getText: async () => '' },
    assertUrl: async () => {},
    protocolWhitelist: 'file,http,https,tcp,tls,crypto',
    coverFetcher: async () => ({ ext: 'jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }),
    notifier: null,
    ...over,
  });
}

test('Ende-zu-Ende: Mux mit Audiodeskription und Untertitel, Serienordner, NFO, Serienposter', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-int-'));
  const media = makeMedia(path.join(dir, 'media'));
  void media;
  const server = await startServer(path.join(dir, 'media'));
  const service = makeService(dir, server, { audioDescription: 'additional', writeNfoCover: true, container: 'mkv' });
  try {
    service.start();
    const result = service.enqueue({ entry: ENTRY, series: SERIES });
    assert.equal(result.ok, true);
    await waitFor(() => ['done', 'failed'].includes(service.get(result.id).status), 'Fertigstellung');
    const record = service.get(result.id);
    assert.equal(record.status, 'done', record.error);
    const expectedDir = path.join(dir, 'rec', 'Mediathek', 'ARD', 'Das Institut');
    assert.equal(record.file, path.join(expectedDir, 'S01E02 - Die Entführung.mkv'));
    assert.ok(fs.existsSync(path.join(expectedDir, 'S01E02 - Die Entführung.nfo')));
    assert.match(fs.readFileSync(path.join(expectedDir, 'S01E02 - Die Entführung.nfo'), 'utf8'), /<showtitle>Das Institut<\/showtitle>/);
    assert.ok(fs.existsSync(path.join(expectedDir, 'poster.jpg')));
    const streams = probe(record.file).streams;
    assert.equal(streams.filter(s => s.codec_type === 'audio').length, 2);
    assert.equal(streams.filter(s => s.codec_type === 'subtitle').length, 1);
    assert.deepEqual(fs.readdirSync(expectedDir).filter(name => name.endsWith('.part')), []);
    assert.equal(service.findDuplicate(ENTRY).id, result.id);
  } finally {
    service.stop();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wiederaufnahme nach dem Beenden: HTTP-Teildatei wird per Range fortgesetzt', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-int-'));
  makeMedia(path.join(dir, 'media'));
  const server = await startServer(path.join(dir, 'media'), { slowChunkMs: 120, etag: '"v1"' });
  const settings = { subtitleMode: 'none', bandwidthKBps: 0 };
  let service = makeService(dir, server, settings);
  try {
    service.start();
    const result = service.enqueue({ entry: ENTRY, series: SERIES });
    await waitFor(() => service.get(result.id).status === 'downloading' && (service.get(result.id).progress.bytes || 0) > 4096, 'erste Daten');
    service.quitSweep(); // App wird beendet
    await new Promise(resolve => setTimeout(resolve, 100));
    const partial = service.get(result.id).target.partFile;
    assert.ok(fs.existsSync(partial), 'Teildatei bleibt für den Resume');
    const partialSize = fs.statSync(partial).size;
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'downloads.json'), 'utf8')).items[0].status, 'queued');
    // Neustart
    service = makeService(dir, server, settings);
    const before = server.requests.length;
    service.start();
    await waitFor(() => ['done', 'failed'].includes(service.get(result.id).status), 'Fertigstellung nach Neustart');
    assert.equal(service.get(result.id).status, 'done', service.get(result.id).error);
    const resumed = server.requests.slice(before).find(request => request.name === 'video.mp4');
    assert.match(resumed.range, /^bytes=\d+-$/);
    assert.ok(Number(/\d+/.exec(resumed.range)[0]) >= partialSize - 1);
    assert.ok(fs.readFileSync(service.get(result.id).file).equals(fs.readFileSync(path.join(dir, 'media', 'video.mp4'))));
  } finally {
    service.stop();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Externe Untertitel und Abbruch über den Dienst: nach dem Abbruch bleibt nichts liegen', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-int-'));
  makeMedia(path.join(dir, 'media'));
  const server = await startServer(path.join(dir, 'media'));
  const slow = await startServer(path.join(dir, 'media'), { slowChunkMs: 80 });
  try {
    let service = makeService(dir, server, { subtitleDelivery: 'external' });
    service.start();
    const a = service.enqueue({ entry: ENTRY, series: SERIES });
    await waitFor(() => ['done', 'failed'].includes(service.get(a.id).status), 'Fertigstellung');
    assert.equal(service.get(a.id).status, 'done', service.get(a.id).error);
    const folder = path.dirname(service.get(a.id).file);
    assert.ok(fs.existsSync(path.join(folder, 'S01E02 - Die Entführung.deu.srt')));
    assert.equal(service.get(a.id).sidecars.length, 1);
    service.remove(a.id, { deleteFile: true });
    assert.equal(fs.existsSync(folder), false);
    service.stop();
    // Abbruch eines laufenden Mux-Downloads
    service = makeService(dir, slow, { audioDescription: 'additional' }, { resolver: { resolveForDownload: async () => infoFor(slow) } });
    service.start();
    const b = service.enqueue({ entry: { ...ENTRY, id: 'E2' }, series: SERIES });
    await waitFor(() => service.get(b.id).status === 'downloading', 'Download läuft');
    await new Promise(resolve => setTimeout(resolve, 400));
    service.cancel(b.id);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(service.get(b.id).status, 'canceled');
    const leftovers = [];
    const walk = current => {
      for (const item of fs.readdirSync(current, { withFileTypes: true })) {
        if (item.isDirectory()) walk(path.join(current, item.name));
        else leftovers.push(item.name);
      }
    };
    walk(path.join(dir, 'rec'));
    assert.deepEqual(leftovers, []);
    service.stop();
  } finally {
    await server.close();
    await slow.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cover-Abruf: Allowlist, Dateikennung, Größenlimit', async () => {
  const { imageExtension } = require('../lib/download/cover.js');
  assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'jpg');
  assert.equal(imageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.equal(imageExtension(Buffer.from('<html>')), null);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  const respond = (status, body) => ({ status, headers: { get: () => null }, body: new Response(body).body, arrayBuffer: async () => body });
  let requested = null;
  const fetchCover = createCoverFetcher({ fetchImpl: async url => { requested = url; return respond(200, jpeg); }, lookup: undefined });
  assert.deepEqual((await fetchCover('https://img.ardmediathek.de/x.jpg', 'ard')).ext, 'jpg');
  assert.equal(requested, 'https://img.ardmediathek.de/x.jpg');
  requested = null;
  assert.equal(await fetchCover('https://evil.example.com/x.jpg', 'ard'), null);
  assert.equal(requested, null);
  const html = createCoverFetcher({ fetchImpl: async () => respond(200, Buffer.from('<html>nope</html>')) });
  assert.equal(await html('https://img.ardmediathek.de/x.jpg', 'ard'), null);
  const big = createCoverFetcher({ fetchImpl: async () => respond(200, Buffer.concat([jpeg, Buffer.alloc(3000)])), maxBytes: 1000 });
  assert.equal(await big('https://img.ardmediathek.de/x.jpg', 'ard'), null);
  const missing = createCoverFetcher({ fetchImpl: async () => respond(404, Buffer.alloc(0)) });
  assert.equal(await missing('https://img.ardmediathek.de/x.jpg', 'ard'), null);
});
