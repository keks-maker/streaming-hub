// Fix-Set 9 (Karte t_0fa7efdf) — DVR-Seek-Planung + Drei-Optionen-Dialog:
// 1. computeDvrSeek: segmentgenaue Übersetzung des DVR-Rückstands
//    (Root-Cause User-Befund B: „Anfang nicht erreichbar" bei 60-min-
//    Rückstand auf ARD (2-h-Fenster) war FALSCH — der HLS-Demuxer kann vom
//    Live-Edge aus nicht zurückseeken, vom frühesten Segment aus schon).
// 2. RecordJob-Integration: Attempt 1 baut -live_start_index + Rest--ss
//    VOR -i; Fetch-Fehler → Legacy-`-ss` (Degrade-Detektor bleibt Netz).
// Reine Node-Tests (kein Electron-Modul im Sandbox-Test-Lauf).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeDvrSeek, dvrSeekArgs } = require('../lib/recorder/dvr-seek.js');
const { RecordJob } = require('../lib/recorder/RecordJob.js');

// ARD-ähnliches 2-h-Fenster: 720 Segmente à 10 s (20004 = 60 min Rückstand
// liegt mitten im Fenster — User-Befund-Szenario).
function fixturePlaylist(segCount, segSec) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + Math.ceil(segSec), '#EXT-X-MEDIA-SEQUENCE:1000'];
  for (let i = 0; i < segCount; i++) {
    lines.push('#EXTINF:' + segSec.toFixed(3) + ',');
    lines.push('seg_' + i + '.ts');
  }
  return lines.join('\n') + '\n';
}

// ── computeDvrSeek ──

test('Fix-Set 9: 60-min-Rückstand im 2-h-Fenster → withinWindow, Start mitten im Fenster', () => {
  const plan = computeDvrSeek(fixturePlaylist(720, 10), 3600);
  assert.ok(plan, 'Plan gebaut');
  assert.equal(plan.mode, 'segments');
  assert.equal(plan.withinWindow, true);
  assert.equal(plan.windowDepthSec, 7200);
  // Zielpunkt = 7200 - 3600 = 3600 → Segment 360 (genaue Segmentgrenze)
  assert.equal(plan.segmentIndex, 360);
  assert.equal(plan.liveStartIndex, 360 - 720);
  assert.equal(plan.residualSec, 0);
  // Residual ≤ Segmentdauer (der kleine Seek ist verlässlich)
  assert.ok(plan.residualSec <= 10);
});

test('Fix-Set 9: Off-Grid-Zielpunkt → residual innerhalb des Zielsegments', () => {
  // Fenster 720×10 s = 7200 s; Offset 3625 s → Zielpunkt 3575 → Segment 357
  // startet bei 3570, residual = 5 s
  const plan = computeDvrSeek(fixturePlaylist(720, 10), 3625);
  assert.equal(plan.segmentIndex, 357);
  assert.equal(plan.residualSec, 5);
  assert.equal(plan.liveStartIndex, 357 - 720);
});

test('Fix-Set 9: Offset über Fenster (ARTE 0,5 h, Offset 40 min) → außerhalb markiert', () => {
  const plan = computeDvrSeek(fixturePlaylist(180, 10), 2400);
  assert.equal(plan.withinWindow, false);
  // graceful: trotzdem ältestes Segment als Start (Klemmen bei 0)
  assert.equal(plan.segmentIndex, 0);
});

test('Fix-Set 9: Master-Playlist / ungültige Eingabe → null (Legacy-Pfad)', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n720p.m3u8\n';
  assert.equal(computeDvrSeek(master, 3600), null);
  assert.equal(computeDvrSeek('<html>nope</html>', 3600), null);
  assert.equal(computeDvrSeek(fixturePlaylist(10, 10), 0), null);
  assert.equal(computeDvrSeek(fixturePlaylist(10, 10), -5), null);
  assert.equal(computeDvrSeek(fixturePlaylist(0, 10), 60), null);
});

// ── dvrSeekArgs ──

test('Fix-Set 9: dvrSeekArgs baut -live_start_index (+ Rest--ss) VOR -i', () => {
  const plan = computeDvrSeek(fixturePlaylist(720, 10), 3625);
  const args = dvrSeekArgs(plan, 3625);
  assert.deepEqual(args, ['-live_start_index', '-363', '-ss', '5']);
  // Segmentgrenze exakt → kein -ss
  const planEdge = computeDvrSeek(fixturePlaylist(720, 10), 3600);
  assert.deepEqual(dvrSeekArgs(planEdge, 3600), ['-live_start_index', '-360']);
  // Kein Plan → Legacy
  assert.deepEqual(dvrSeekArgs(null, 120), ['-ss', '120']);
  assert.deepEqual(dvrSeekArgs(null, 0), []);
});

// ── RecordJob-Integration ──

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't-0fa7efdf-'));
}

function baseMeta(overrides = {}) {
  return {
    id: 'rec_20261002_fixset9',
    channelId: 'ch-test',
    channelName: 'TestSender',
    epgTitle: 'Nachrichten',
    startedAt: new Date().toISOString(),
    sourceUrl: 'http://example.com/live.m3u8',
    status: 'recording',
    ...overrides,
  };
}

test('Fix-Set 9: RecordJob Attempt 1 nutzt Segment-Plan (-live_start_index + Rest--ss vor -i)', async () => {
  const root = makeTempRoot();
  const dir = path.join(root, 'job');
  fs.mkdirSync(dir, { recursive: true });
  const fakeFfmpeg = path.join(root, 'fake-ffmpeg.sh');
  fs.writeFileSync(
    fakeFfmpeg,
    '#!/bin/sh\nprintf "%s\\n" "$@" > ' + path.join(root, 'args.txt') + '\nsleep 0.3\n',
    { mode: 0o755 },
  );
  const job = new RecordJob({
    recId: 'rec_20261002_plan',
    sourceUrl: 'http://example.com/live.m3u8',
    dir,
    ffmpegPath: fakeFfmpeg,
    meta: baseMeta(),
    startOffsetSec: 3625,
    fetchPlaylist: async () => fixturePlaylist(720, 10),
  });
  const startedPromise = new Promise(resolve => job.on('started', resolve));
  job.start();
  const payload = await startedPromise;
  assert.equal(payload.startOffsetSec, 3625);
  assert.equal(payload.degraded, false);
  assert.equal(payload.seekPlan.segmentIndex, 357);
  // Fake-ffmpeg braucht einen Moment, bevor es args.txt schreibt (Kill-Race)
  await new Promise(r => setTimeout(r, 400));
  await job.stop({ reason: 'abort' }).catch(() => {});
  const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8').trim().split('\n');
  const lsiIdx = args.indexOf('-live_start_index');
  const ssIdx = args.indexOf('-ss');
  const iIdx = args.indexOf('-i');
  assert.ok(lsiIdx !== -1 && ssIdx !== -1 && iIdx !== -1, 'alle Seek-Flags vorhanden');
  assert.ok(lsiIdx < ssIdx && ssIdx < iIdx, '-live_start_index und -ss kommen VOR -i');
  assert.equal(args[lsiIdx + 1], '-363');
  assert.equal(args[ssIdx + 1], '5');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Fix-Set 9: Fetch-Fehler → Legacy--ss-Pfad (kein Abbruch, Degrade-Netz bleibt)', async () => {
  const root = makeTempRoot();
  const dir = path.join(root, 'job');
  fs.mkdirSync(dir, { recursive: true });
  const fakeFfmpeg = path.join(root, 'fake-ffmpeg-legacy.sh');
  fs.writeFileSync(
    fakeFfmpeg,
    '#!/bin/sh\nprintf "%s\\n" "$@" > ' + path.join(root, 'args.txt') + '\nsleep 0.3\n',
    { mode: 0o755 },
  );
  const job = new RecordJob({
    recId: 'rec_20261002_legacy',
    sourceUrl: 'http://example.com/live.m3u8',
    dir,
    ffmpegPath: fakeFfmpeg,
    meta: baseMeta(),
    startOffsetSec: 3600,
    fetchPlaylist: async () => { throw new Error('offline (Test)'); },
  });
  const startedPromise = new Promise(resolve => job.on('started', resolve));
  job.start();
  const payload = await startedPromise;
  assert.equal(payload.seekPlan, null, 'kein Plan → Legacy');
  // Fake-ffmpeg braucht einen Moment, bevor es args.txt schreibt (Kill-Race)
  await new Promise(r => setTimeout(r, 400));
  await job.stop({ reason: 'abort' }).catch(() => {});
  const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8').trim().split('\n');
  const ssIdx = args.indexOf('-ss');
  const iIdx = args.indexOf('-i');
  assert.ok(ssIdx !== -1 && iIdx !== -1 && ssIdx < iIdx, 'Legacy: -ss VOR -i');
  assert.equal(args[ssIdx + 1], '3600');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Fix-Set 9: startOffsetSec=0 → kein Seek-Args, kein Playlist-Fetch (Bestandsverhalten)', async () => {
  const root = makeTempRoot();
  const dir = path.join(root, 'job');
  fs.mkdirSync(dir, { recursive: true });
  const fakeFfmpeg = path.join(root, 'fake-ffmpeg-live.sh');
  fs.writeFileSync(
    fakeFfmpeg,
    '#!/bin/sh\nprintf "%s\\n" "$@" > ' + path.join(root, 'args.txt') + '\nsleep 0.3\n',
    { mode: 0o755 },
  );
  let fetched = false;
  const job = new RecordJob({
    recId: 'rec_20261002_live',
    sourceUrl: 'http://example.com/live.m3u8',
    dir,
    ffmpegPath: fakeFfmpeg,
    meta: baseMeta(),
    startOffsetSec: 0,
    fetchPlaylist: async () => { fetched = true; return fixturePlaylist(720, 10); },
  });
  const startedPromise = new Promise(resolve => job.on('started', resolve));
  job.start();
  await startedPromise;
  // Fake-ffmpeg braucht einen Moment, bevor es args.txt schreibt (Kill-Race)
  await new Promise(r => setTimeout(r, 400));
  await job.stop({ reason: 'abort' }).catch(() => {});
  assert.equal(fetched, false, 'ohne Offset wird die Quelle-Playlist NICHT gelesen');
  const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8').trim().split('\n');
  assert.equal(args.indexOf('-ss'), -1, 'kein -ss');
  assert.equal(args.indexOf('-live_start_index'), -1, 'kein -live_start_index');
  fs.rmSync(root, { recursive: true, force: true });
});
