'use strict';

// Tests nutzen Fake-Bundles unter <appRoot>/bin — System-ffmpeg-Präferenz aus.
process.env.STREAMING_HUB_FFMPEG = 'bundled';

// E2E-Interrupt-Beweis (Akzeptanz Karte t_695bf150): hart gequitteter Job
// (finalizeForQuit) → RecorderService.Recovery remuxt die Nachholaufnahme
// beim nächsten Start → MP4 + completed + Index sauber (F-FB-10).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecordJob } = require('../lib/recorder/RecordJob.js');
const { RecorderService } = require('../lib/recorder/RecorderService.js');
const { createRecordingStore } = require('../lib/recorder/RecordingStore.js');

const FAKE_DIR = path.join(os.tmpdir(), `recorder-quit-fake2-${process.pid}`);

const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('ffmpeg version 7.0.2-static'); process.exit(0); }
const out = args[args.length - 1];
if (args.includes('+faststart')) {
  const src = args[args.indexOf('-i') + 1];
  const data = fs.readFileSync(src, 'utf-8');
  fs.writeFileSync(out, 'FAKEMP4\\n' + data);
  process.exit(0);
}
if (args.includes('-f') && args.includes('hls')) {
  const segIdx = args.indexOf('-hls_segment_filename');
  const seg = args[segIdx + 1].replace('%05d', '00000');
  fs.writeFileSync(seg, Buffer.alloc(2048));
  let existing = '';
  try { existing = fs.readFileSync(out, 'utf-8'); } catch (_) {}
  fs.writeFileSync(out, existing + '#EXTINF:1.0,\\nseg_00000.ts\\n');
  process.on('SIGINT', () => process.exit(0));
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('E2E-Recovery: hart gequitteter Job (quitSweep) → Remux beim nächsten Start → completed + Index', async () => {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const ffmpegPath = path.join(FAKE_DIR, `fake-${process.pid}-run.js`);
  fs.writeFileSync(ffmpegPath, FAKE_FFMPEG, { mode: 0o755 });
  const ffprobePath = path.join(FAKE_DIR, `fake-${process.pid}-probe.js`);
  fs.writeFileSync(ffprobePath, FAKE_FFPROBE, { mode: 0o755 });

  // Upstream-Verhalten erzwingen: RecorderService liest die Binaries über
  // ffmpegLib.binaryPath('ffmpeg', appRoot) — appRoot auf ein Fake-Bundle
  // mit bin/-Layout mappen.
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-fg-ap-'));
  fs.mkdirSync(path.join(appRoot, 'bin'), { recursive: true });
  fs.copyFileSync(ffmpegPath, path.join(appRoot, 'bin', 'ffmpeg'));
  fs.copyFileSync(ffprobePath, path.join(appRoot, 'bin', 'ffprobe'));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-fg-store-'));
  const store = createRecordingStore({ root: storageRoot, logger: console });

  // ── Phase 1: Aufnahme läuft, Quit-Sweep (App-Beenden) ──
  const recId = `rec_20261002_fg1${process.pid}`;
  const jobDir = path.join(store.library, recId);
  fs.mkdirSync(jobDir, { recursive: true });
  const job = new RecordJob({
    recId,
    sourceUrl: 'https://stream.example/live.m3u8',
    dir: jobDir,
    ffmpegPath,
    meta: {
      id: recId,
      channelId: 'ard',
      channelName: 'ARD',
      epgTitle: 'Tagesschau',
      startedAt: null,
      status: 'recording',
      sourceUrl: 'https://stream.example/live.m3u8',
    },
  });
  const startedP = new Promise(resolve => job.once('started', resolve));
  job.start();
  await startedP;
  await sleep(400);
  store.writeMeta(job.meta);
  store.upsertIndex(job.meta);

  // Beenden, wie es der before-quit-Hook tut
  const sweep = { pid: job.ffmpegPid(), alreadyFinalized: false };
  assert.equal(typeof sweep.pid, 'number');
  job.on('meta', m => {
    store.writeMeta(m.meta);
  });
  store.writeMeta(job.meta); // Vorherige Aufnahme-Meta (recording)
  job.finalizeForQuit();
  store.writeMeta(job.meta); // meta-Event-Persistenz (im Produkt: _forwardJobEvents)
  const metaAfterQuit = store.readMeta(recId);
  assert.equal(metaAfterQuit.status, 'aborted', 'Meta nach Quit: aborted');
  const playlist = fs.readFileSync(path.join(jobDir, 'index.m3u8'), 'utf-8');
  assert.ok(playlist.includes('#EXT-X-ENDLIST'), 'ENDLIST nach Quit gesichert');

  // ── Phase 2: "App-Neustart" — Recovery remuxt die Nachholaufnahme ──
  const { RecorderService } = require('../lib/recorder/RecorderService.js');
  // ffmpegLib gibt die mit appRoot verknüpften Binary-Pfade zurück — aber
  // __dirname-Kopplung verhindert Injektion; für den Test mal eben den
  // Fake-Bundle-Link nutzen:
  const svc = new RecorderServiceWithStaticRoot({ appRoot, storageRoot });
  const { reaped, recovered } = await svc.recover({});
  assert.equal(reaped.length, 0, 'kein Zombie zu reapen (Meta ist schon aborted)');
  assert.equal(recovered.length, 1, 'Remux nachgeholt (F-FB-10)');

  // MP4 + Index sauber
  const lib = store.library;
  const mp4s = fs.readdirSync(lib).filter(n => n.endsWith('.mp4'));
  assert.equal(mp4s.length, 1, 'MP4 liegt im Bibliotheksverzeichnis');
  const metaFinal = store.readMeta(recId);
  assert.equal(metaFinal.status, 'completed', 'Status completed nach Recovery-Remux');
  assert.ok(metaFinal.outputFile && fs.existsSync(metaFinal.outputFile), 'outputFile verlinkt');
  const idx = store.readIndex();
  assert.ok(idx.some(e => e.id === recId && e.status === 'completed'), 'Index-Eintrag completed');
});

/**
 * Test-Wrapper: RecorderService mit wiederverwendbaren Fake-Binaries — nutzt
 * intern die echten ffmpegLib-Binaries, aber der Fake-Pfad-Provider schreibt
 * die Binary-Pfade der Tests vor. Nur hier, nicht in der Produktion.
 */
class RecorderServiceWithStaticRoot extends RecorderService {
  constructor({ appRoot, storageRoot }) {
    super({ appRoot, storageRoot });
  }

  async recover(opts) {
    // Die lib/ffmpeg.js API ist binanz-bound — die Fake-Binaries liegen unter
    // appRoot/bin: binaryPath('ffmpeg', appRoot) = appRoot/bin/ffmpeg. Der
    // echte Konstruktor riecht den appRoot: direkt durchreichen.
    return super.recover(opts);
  }
}
