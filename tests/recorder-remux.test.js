'use strict';

// Tests: Remux-Progress-Berechnung + out_time-Parsing + ENDLIST-Sicherung
// (Karte t_17ee2ca5; Konzept §2.3 „Fortschritt via -progress")

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensureEndlist,
  parseOutTimeSeconds,
  computeRemuxProgress,
} = require('../lib/recorder/RemuxJob.js');

function tmpPlaylist(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-test-'));
  const file = path.join(dir, 'index.m3u8');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

test('ensureEndlist hängt fehlende ENDLIST an (Probe-Befund: Remux hängt sonst)', () => {
  const file = tmpPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg_00000.ts\n');
  assert.equal(ensureEndlist(file), true);
  const raw = fs.readFileSync(file, 'utf-8');
  assert.ok(raw.includes('#EXT-X-ENDLIST'));
  assert.ok(raw.indexOf('seg_00000.ts') < raw.indexOf('#EXT-X-ENDLIST'));
});

test('ensureEndlist ist idempotent', () => {
  const file = tmpPlaylist('#EXTM3U\n#EXTINF:2.0,\nseg_00000.ts\n#EXT-X-ENDLIST\n');
  assert.equal(ensureEndlist(file), false);
  const raw = fs.readFileSync(file, 'utf-8');
  assert.equal(raw.match(/#EXT-X-ENDLIST/g).length, 1);
});

test('ensureEndlist behandelt Playlist ohne Zeilenende am Schluss', () => {
  const file = tmpPlaylist('#EXTM3U\n#EXTINF:2.0,\nseg_00000.ts');
  assert.equal(ensureEndlist(file), true);
  const raw = fs.readFileSync(file, 'utf-8');
  assert.ok(raw.endsWith('#EXT-X-ENDLIST\n'));
});

test('parseOutTimeSeconds: HH:MM:SS.micro-Format', () => {
  assert.equal(parseOutTimeSeconds({ out_time: '00:00:05.250000' }), 5.25);
  assert.equal(parseOutTimeSeconds({ out_time: '00:01:30.000000' }), 90);
  assert.equal(parseOutTimeSeconds({ out_time: '01:00:00.000000' }), 3600);
  assert.equal(parseOutTimeSeconds({ out_time: 'N/A' }), null);
  assert.equal(parseOutTimeSeconds({}), null);
});

test('parseOutTimeSeconds: out_time_ms/µs sind Mikrosekunden (Namensfalle)', () => {
  assert.equal(parseOutTimeSeconds({ out_time_ms: '5250000' }), 5.25);
  assert.equal(parseOutTimeSeconds({ out_time_us: '5250000' }), 5.25);
  assert.equal(parseOutTimeSeconds({ out_time_ms: '-1' }), null); // ffmpeg sendet -1 am Ende
  assert.equal(parseOutTimeSeconds({ out_time_ms: '0' }), null);
});

test('computeRemuxProgress: Prozent + Restdauer', () => {
  const half = computeRemuxProgress({ outTimeSec: 30, expectedDurationSec: 60 });
  assert.equal(half.percent, 50);
  assert.equal(half.remainingSec, 30);

  const done = computeRemuxProgress({ outTimeSec: 60, expectedDurationSec: 60 });
  assert.equal(done.percent, 100);
  assert.equal(done.remainingSec, 0);

  const over = computeRemuxProgress({ outTimeSec: 90, expectedDurationSec: 60 });
  assert.equal(over.percent, 100); // geclamped
  assert.equal(over.remainingSec, 0);

  const unknown = computeRemuxProgress({ outTimeSec: null, expectedDurationSec: 60 });
  assert.equal(unknown.percent, null);
  assert.equal(unknown.remainingSec, null);

  const noExpectation = computeRemuxProgress({ outTimeSec: 10, expectedDurationSec: null });
  assert.equal(noExpectation.percent, null);
});

test('computeRemuxProgress: Playlists mit Lücken/Duplikaten werden linear behandelt', () => {
  // Reconnect-Naht kann doppelte Inhalte enthalten; Progress bleibt linear
  // auf die erwartete (EXTINF-)Gesamtdauer bezogen — kein Crash, kein >100 %.
  const p = computeRemuxProgress({ outTimeSec: 12, expectedDurationSec: 15.957 });
  assert.ok(Math.abs(p.percent - 75.2) < 0.5);
  assert.ok(p.remainingSec > 0 && p.remainingSec < 4);
});
