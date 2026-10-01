'use strict';

// Tests: F-FB-09 (t_9372a4b3) — Retry-Loop/Playlist-Dedup
//
// QA-Befund: 66460s MP4-Dauer bei ~282s Wandzeit. Ursache (Code-Analyse):
// Jeder Reconnect-Spawn liest ffmpeg das LIVE-Fenster der Quelle von vorn und
// schreibt die Playlist mit append_list fort — die Segment-Dateinamen starten
// dabei WIEDER bei seg_00000.ts und ÜBERSCHREIBEN alte Segmente. Die
// #EXTINF-Zeilen der alten Runde bleiben in der Playlist stehen und zählen
// doppelt/triplt: durationSec = Summe(EXTINF) wächst pro Attempt um die
// erneute Wiedergabe des Leading-Edge-Fensters — der aufgedunsene Meta-Wert.
//
// Fix (RecordJob): Segment-Dateinamen werden pro Attempt nummeriert
// (seg_a<N>_%05d.ts mit N = Attempt-Index), damit eine neue Runde alte
// Segmente nie überschreibt; die Dauer bleibt die Summe der tatsächlich
// gesammelten Segmente. Zusätzlich dedupliziert playlistDurationSec
// wiederholte Segment-Einträge (gleicher Dateiname > 1× in einer Playlist
// zählt einmal) — Schutz auch für Bestands-Playlists (Recovery-Pfad).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { playlistDurationSec } = require('../lib/recorder/RecordJob.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recjob-dedup-'));
}

test('playlistDurationSec zählt jeden Segment-Dateinamen nur einmal (Dedup)', () => {
  const dir = tmpDir();
  const playlist = path.join(dir, 'index.m3u8');
  fs.writeFileSync(
    playlist,
    [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXTINF:2.000,',
      'seg_00000.ts',
      '#EXTINF:2.000,',
      'seg_00001.ts',
      // Retry-Runde: dieselben Dateinamen erneut in der Playlist (alter
      // Defekt-Mechanismus) — 2× leading-edge-Fenster doppelt gezählt.
      '#EXTINF:2.000,',
      'seg_00000.ts',
      '#EXTINF:2.000,',
      'seg_00001.ts',
      '#EXTINF:2.000,',
      'seg_00002.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    'utf-8',
  );
  // Dedup: 3 unique Segmente × 2s = 6s (ohne Dedup: 10s)
  assert.equal(playlistDurationSec(playlist), 6);
});

test('playlistDurationSec ohne Duplikate bleibt exakt (Summe der EXTINF)', () => {
  const dir = tmpDir();
  const playlist = path.join(dir, 'index.m3u8');
  fs.writeFileSync(
    playlist,
    [
      '#EXTM3U',
      '#EXTINF:1.5,',
      'seg_00000.ts',
      '#EXTINF:2.25,',
      'seg_00001.ts',
      '#EXTINF:3.125,',
      'seg_00002.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    'utf-8',
  );
  assert.equal(playlistDurationSec(playlist), 6.875);
});

test('Retry-Attempt schreibt Segmente mit attempt-eigenem Präfix (kein Überschreiben)', async () => {
  const dir = tmpDir();
  const { RecordJob } = require('../lib/recorder/RecordJob.js');
  const fakeFfmpeg = path.join(dir, 'ffmpeg-fake.sh');
  // Fake-ffmpeg: zeichnet die Argumente auf und beendet sich sofort wieder
  // (Attempt endet → Retry-Loop). Der FIRST_ATTEMPT_MIN_RUN_MS-Guard (5s)
  // wird über die injizierte Uhr umgangen: jeder now()-Call springt +6s,
  // damit der 1. Attempt als "gelaufen" zählt.
  fs.writeFileSync(
    fakeFfmpeg,
    [
      '#!/bin/sh',
      'echo "$@" > "$PWD/args-$(date +%s%N).txt"',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );

  const meta = {
    id: 'rec_20261001_retrytest',
    channelId: 'qa.alpha',
    channelName: 'QA Alpha',
    epgTitle: null,
    epgDescription: null,
    startedAt: null,
    stoppedAt: null,
    durationSec: null,
    fileSizeBytes: null,
    sourceUrl: 'https://qa.example/stream.m3u8',
    status: 'recording',
    outputFile: null,
    lastError: null,
    remuxInterrupted: false,
  };

  // Künstliche Uhr: +6s pro Aufruf → ranMs beim Attempt-Close = 6000 > 5000
  let fakeNow = 1_700_000_000_000;
  const now = () => new Date((fakeNow += 6000));

  const job = new RecordJob({
    recId: meta.id,
    sourceUrl: meta.sourceUrl,
    dir,
    ffmpegPath: fakeFfmpeg,
    meta,
    expectedSegmentSec: 2,
    now,
  });

  // Attempt 1 starten; fake-ffmpeg endet sofort → waiting-retry →
  // 'reconnecting' feuert nach dem 2s-Retry-Timer für Attempt 2.
  job.start();
  const attemptEvents = [];
  job.on('reconnecting', payload => attemptEvents.push(payload));
  await new Promise(resolve => {
    (function poll() {
      if (attemptEvents.length >= 2) return resolve(); // Attempt 2 + 3 gelaufen
      setTimeout(poll, 200);
    })();
    setTimeout(resolve, 15000);
  });
  await new Promise(r => setTimeout(r, 300)); // Spawn/args-Write von Attempt 3
  const argsFiles = fs.readdirSync(dir).filter(n => n.startsWith('args-'));
  assert.ok(argsFiles.length >= 2, `zwei Attempt-Argumente aufgezeichnet (gefunden: ${argsFiles.length})`);
  const args1 = fs.readFileSync(path.join(dir, argsFiles[0]), 'utf-8');
  const args2 = fs.readFileSync(path.join(dir, argsFiles[1]), 'utf-8');

  const segPattern1 = args1.match(/seg[^'"\s]*%05d\.ts/);
  const segPattern2 = args2.match(/seg[^'"\s]*%05d\.ts/);
  assert.ok(segPattern1, 'Attempt 1 hat ein Segment-Muster');
  assert.ok(segPattern2, 'Attempt 2 hat ein Segment-Muster');
  assert.notEqual(
    segPattern1[0],
    segPattern2[0],
    'Retry-Attempt nutzt ein EIGENES Segment-Präfix (alte Segmente bleiben erhalten)',
  );

  job.stop({ reason: 'abort' }).catch(() => {});
});
