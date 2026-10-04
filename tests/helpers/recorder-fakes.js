'use strict';

// Gemeinsame Test-Helfer für die Etappe-1-Recorder-Tests: Fake-ffmpeg/-ffprobe
// (gleiche CLI-Schnittstelle wie das echte ffmpeg, Muster aus
// recorder-service.test.js) und eine Service-Factory mit durchgereichten
// Test-Seams (Uhr, statfs, Tick, Retry-Timing).
//
// Hinweis: Dateien in tests/helpers sind KEINE Tests und stehen nicht in
// test:suite.

process.env.STREAMING_HUB_FFMPEG = 'bundled';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecorderService } = require('../../lib/recorder/RecorderService.js');

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

let counter = 0;

/**
 * Legt ein appRoot mit Fake-ffmpeg/-ffprobe an und baut einen RecorderService.
 * overrides: beliebige RecorderService-Optionen (now, freeBytes, sizeTickMs …).
 */
function makeFakeService(overrides = {}) {
  counter += 1;
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rec-e1-app-${process.pid}-${counter}-`));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rec-e1-store-${process.pid}-${counter}-`));
  fs.mkdirSync(path.join(appRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'bin', 'ffmpeg'), FAKE_FFMPEG, { mode: 0o755 });
  fs.writeFileSync(path.join(appRoot, 'bin', 'ffprobe'), FAKE_FFPROBE, { mode: 0o755 });
  const service = new RecorderService({ appRoot, storageRoot, segmentSec: 2, ...overrides });
  return { service, appRoot, storageRoot };
}

const REQUEST = {
  channelId: 'das-erste',
  channelName: 'Das Erste',
  epgTitle: 'Tagesschau',
  sourceUrl: 'https://stream.example/live.m3u8',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wartet auf ein Event des Emitters, dessen Payload `predicate` erfüllt.
 */
function waitForEvent(emitter, event, predicate = () => true, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`Event "${event}" kam nicht innerhalb ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = payload => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
      resolve(payload);
    };
    emitter.on(event, onEvent);
  });
}

/**
 * Wartet, bis die Nachbearbeitung (Remux bzw. Zurückstellen) einer Aufnahme
 * abgeschlossen ist ('recording:status' Phase 'done'), und liefert die dann
 * persistierte Meta. WICHTIG: vor dem auslösenden Schritt aufrufen (Promise
 * zuerst erzeugen), sonst geht das Event verloren.
 */
function waitForDone(service, recId, timeoutMs = 15000) {
  return waitForEvent(service, 'recording:status', p => p.recId === recId && p.phase === 'done', timeoutMs).then(() =>
    service.store.readMeta(recId),
  );
}

module.exports = { waitForDone, FAKE_FFMPEG, FAKE_FFPROBE, REQUEST, makeFakeService, sleep, waitForEvent };
