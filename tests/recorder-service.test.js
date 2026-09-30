'use strict';

// Tests: RecorderService — Duplikat-Schutz, Parallelitäts-Limit, Recovery,
// Dateinamen-Kollision, Remux-After-Stop (Karte t_17ee2ca5; Konzept §3.1/§4.4/§5)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecorderService } = require('../lib/recorder/RecorderService.js');
const { buildRecordingFilename, withCollisionSuffix } = require('../lib/recorder/meta.js');

const FAKE_DIR = path.join(os.tmpdir(), `recorder-svc-fake-${process.pid}`);

// Fake-ffmpeg: beherrscht Record-Modus (Segment + Playlist + SIGINT) und
// Remux-Modus (+faststart → MP4-artige Datei). Fake-ffprobe verifiziert.
const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('ffmpeg version 7.0.2-static'); process.exit(0); }
const out = args[args.length - 1];
if (args.includes('+faststart')) {
  // Remux-Modus: "konvertiert" die Zwischenplaylist in eine MP4-artige Datei
  const src = args[args.indexOf('-i') + 1];
  const data = fs.readFileSync(src, 'utf-8');
  fs.writeFileSync(out, 'FAKEMP4\\n' + data);
  process.exit(0);
}
if (args.includes('-f') && args.includes('hls')) {
  // Record-Modus: schreibt ein Segment + Playlist, dann SIGINT-Handler
  const segIdx = args.indexOf('-hls_segment_filename');
  const seg = args[segIdx + 1].replace('%05d', '00000');
  fs.writeFileSync(seg, Buffer.alloc(2048));
  let existing = '';
  try { existing = fs.readFileSync(out, 'utf-8'); } catch (_) {}
  fs.writeFileSync(out, existing + '#EXTINF:1.0,\\nseg_00000.ts\\n');
  process.on('SIGINT', () => {
    let raw = '';
    try { raw = fs.readFileSync(out, 'utf-8'); } catch (_) {}
    if (!raw.includes('#EXT-X-ENDLIST')) fs.appendFileSync(out, '#EXT-X-ENDLIST\\n');
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  return;
}
process.exit(1);
`;

const FAKE_FFPROBE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('ffprobe version 7.0.2-static'); process.exit(0); }
const file = args[args.length - 1];
const raw = fs.readFileSync(file, 'utf-8');
const segments = (raw.match(/#EXTINF/g) || []).length;
if (!raw.startsWith('FAKEMP4')) { console.error('not a fake mp4'); process.exit(1); }
process.stdout.write(JSON.stringify({
  streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }],
  format: { duration: String(segments), size: String(fs.statSync(file).size) },
}));
`;

function createFakeBinaries() {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const ffmpeg = path.join(FAKE_DIR, 'ffmpeg.js');
  const ffprobe = path.join(FAKE_DIR, 'ffprobe.js');
  fs.writeFileSync(ffmpeg, FAKE_FFMPEG, { mode: 0o755 });
  fs.writeFileSync(ffprobe, FAKE_FFPROBE, { mode: 0o755 });
  return { ffmpeg, ffprobe };
}

let svcCounter = 0;

function makeService(overrides = {}) {
  svcCounter += 1;
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rec-svc-app-${svcCounter}-`));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rec-svc-store-${svcCounter}-`));
  createFakeBinaries();
  // lib/ffmpeg.js-Layout im appRoot imitieren: <appRoot>/bin/ffmpeg (+ffprobe)
  fs.mkdirSync(path.join(appRoot, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(FAKE_DIR, 'ffmpeg.js'), path.join(appRoot, 'bin', 'ffmpeg'));
  fs.copyFileSync(path.join(FAKE_DIR, 'ffprobe.js'), path.join(appRoot, 'bin', 'ffprobe'));
  fs.chmodSync(path.join(appRoot, 'bin', 'ffmpeg'), 0o755);
  fs.chmodSync(path.join(appRoot, 'bin', 'ffprobe'), 0o755);
  const service = new RecorderService({
    appRoot,
    storageRoot,
    maxParallel: overrides.maxParallel ?? 3,
    segmentSec: 2,
  });
  return { service, appRoot, storageRoot };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const REQUEST = {
  channelId: 'das-erste',
  channelName: 'Das Erste',
  epgTitle: 'Tagesschau',
  sourceUrl: 'https://stream.example/live.m3u8',
};

test('start(): Validierung lehnt schlechte Anfragen ab', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.start({ ...REQUEST, sourceUrl: 'ftp://x' }), /http/);
  await assert.rejects(() => service.start({ ...REQUEST, channelId: 'böser/pfad!' }), /Kanal-ID/);
  await assert.rejects(() => service.start({ ...REQUEST, channelId: '', channelName: '' }), /channelId oder channelName/);
  await assert.rejects(() => service.start(null), /Anfrage/);
});

test('start(): ffmpeg-Health-Gate (defekte Binaries → Fehler)', async () => {
  const { service } = makeService();
  fs.writeFileSync(path.join(service.appRoot, 'bin', 'ffmpeg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(() => service.start(REQUEST), /ffmpeg/);
});

test('start(): Duplikat-Schutz pro Kanal (Konzept §3.1)', async () => {
  const { service } = makeService();
  const started = await service.start(REQUEST);
  await assert.rejects(() => service.start(REQUEST), /Duplikat/);
  // Anderer Kanal läuft (Limit 3 erlaubt das)
  const second = await service.start({ ...REQUEST, channelId: 'zdf', channelName: 'ZDF' });
  await service.stop(second.recId);
  await service.stop(started.recId);
});

test('start(): Parallelitäts-Limit (Konzept §4.4)', async () => {
  const { service } = makeService({ maxParallel: 1 });
  const first = await service.start(REQUEST);
  await assert.rejects(() => service.start({ ...REQUEST, channelId: 'zdf', channelName: 'ZDF' }), /paralleler Aufnahmen/);
  await service.stop(first.recId);
  // Nach Stop ist der Slot wieder frei
  const again = await service.start(REQUEST);
  await service.stop(again.recId);
});

test('stop(): Remux läuft, Status completed, Zwischenform weg, Meta-Datei bleibt', async () => {
  const { service, storageRoot } = makeService();
  const events = [];
  service.on('recording:status', s => events.push(s));

  const started = await service.start(REQUEST);
  await sleep(300);
  const finalMeta = await service.stop(started.recId);

  assert.equal(finalMeta.status, 'completed');
  assert.ok(finalMeta.outputFile.endsWith('.mp4'));
  assert.ok(fs.existsSync(finalMeta.outputFile));
  assert.ok(finalMeta.durationSec >= 1);
  assert.ok(finalMeta.fileSizeBytes > 0);
  // Zwischenform geräumt, Meta-Datei bleibt (Konzept §2.3: nur .ts + Playlist löschen)
  const jobDir = path.join(storageRoot, 'Aufnahmen', started.recId);
  assert.ok(!fs.existsSync(path.join(jobDir, 'index.m3u8')));
  assert.ok(fs.existsSync(path.join(jobDir, `${started.recId}.recording.json`)));
  const entry = service.store.listAll().find(e => e.id === started.recId);
  assert.ok(entry, 'Index-Eintrag vorhanden');
  assert.equal(entry.status, 'completed');
  // Status-Events: REMUXING + DONE kamen
  const phases = events.map(e => e.phase);
  assert.ok(phases.includes('remuxing'));
  assert.ok(phases.includes('done'));
});

test('Dateinamen-Kollision: -2/-3 Suffix (Konzept §5)', () => {
  const { service } = makeService();
  const meta = { channelName: 'Das Erste', epgTitle: 'Tagesschau', startedAt: '2026-09-30T20:15:00' };
  const base = buildRecordingFilename(meta);
  const lib = service.store.library;

  fs.writeFileSync(path.join(lib, base), 'x');
  assert.equal(service._uniqueLibraryFilename(meta), withCollisionSuffix(base, 2));
  fs.writeFileSync(path.join(lib, withCollisionSuffix(base, 2)), 'x');
  assert.equal(service._uniqueLibraryFilename(meta), withCollisionSuffix(base, 3));
  fs.writeFileSync(path.join(lib, withCollisionSuffix(base, 3)), 'x');
  assert.equal(service._uniqueLibraryFilename(meta), withCollisionSuffix(base, 4));
});

test('Recovery: remux-pending wird beim Start nachgeholt (Konzept §2.3)', async () => {
  const { service, storageRoot } = makeService();
  const recId = 'rec_20260930_recov1';
  const jobDir = path.join(storageRoot, 'Aufnahmen', recId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, 'index.m3u8'),
    '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:2.0,\nseg_00000.ts\n#EXTINF:1.9,\nseg_00001.ts\n',
  );
  fs.writeFileSync(path.join(jobDir, 'seg_00000.ts'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(jobDir, 'seg_00001.ts'), Buffer.alloc(1024));
  const meta = {
    id: recId,
    channelId: 'zdf',
    channelName: 'ZDF',
    epgTitle: 'heute',
    startedAt: '2026-09-30T19:00:00',
    stoppedAt: '2026-09-30T19:03:53',
    status: 'remux-pending',
    sourceUrl: 'https://stream.example/live.m3u8',
  };
  service.store.writeMeta(meta);
  service.store.upsertIndex(meta);

  let afterRemuxMeta = null;
  const result = await service.recover({ afterRemux: async ({ meta: m }) => (afterRemuxMeta = m) });
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].status, 'completed');
  assert.ok(afterRemuxMeta);
  assert.equal(afterRemuxMeta.id, recId);
  assert.ok(fs.existsSync(afterRemuxMeta.outputFile));
  assert.ok(!fs.existsSync(path.join(jobDir, 'index.m3u8')), 'Zwischenform nach Recovery-Remux weg');
});

test('Recovery: Zombie (recording ohne Job) wird zu aborted', async () => {
  const { service } = makeService();
  const recId = 'rec_20260930_zombie1';
  const meta = {
    id: recId,
    channelId: 'ard',
    channelName: 'ARD',
    startedAt: '2026-09-30T19:00:00',
    status: 'recording',
    sourceUrl: 'https://stream.example/live.m3u8',
  };
  service.store.writeMeta(meta);
  service.store.upsertIndex(meta);
  const result = await service.recover();
  assert.equal(result.reaped.length, 1);
  assert.equal(result.reaped[0].id, recId);
  assert.equal(service.store.readMeta(recId).status, 'aborted');
});

test('Recovery: Remux-Fehler lässt remux-pending bestehen (nächster Start retry)', async () => {
  const { service, storageRoot } = makeService();
  const recId = 'rec_20260930_broken1';
  const jobDir = path.join(storageRoot, 'Aufnahmen', recId);
  fs.mkdirSync(jobDir, { recursive: true });
  // Leere Playlist → Fake-Remux schreibt Datei ohne EXTINF → ffprobe-Dauer 0
  // → RemuxJob verwirft (keine gültige Dauer) → Retry-Pfad
  fs.writeFileSync(path.join(jobDir, 'index.m3u8'), '#EXTM3U\n');
  const meta = {
    id: recId,
    channelName: 'ZDF',
    startedAt: '2026-09-30T19:00:00',
    status: 'remux-pending',
    sourceUrl: 'https://stream.example/live.m3u8',
  };
  service.store.writeMeta(meta);
  service.store.upsertIndex(meta);
  // recover() schluckt Einzelfehler bewusst (eine kaputte Aufnahme darf die
  // Recovery nicht abbrechen) — die Meta bleibt remux-pending für den
  // nächsten Start.
  const result = await service.recover({ afterRemux: async () => {} });
  assert.deepEqual(result.recovered, []);
  const after = service.store.readMeta(recId);
  assert.equal(after.status, 'remux-pending', 'bleibt remux-pending für nächsten Retry');
  assert.ok(after.lastError);
  assert.ok(fs.existsSync(path.join(jobDir, 'index.m3u8')), 'Zwischenstände bleiben für Retry');
});

test.after(() => {
  try {
    fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  } catch (_) {}
});
