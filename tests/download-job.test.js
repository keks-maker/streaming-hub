'use strict';

// Tests: DownloadJob mit echtem ffmpeg/ffprobe (bin/) und Mini-Testmedien aus lavfi, ausgeliefert von einem lokalen Server.
// Ohne die Binaries werden die Tests übersprungen. Geprüft: HTTP-Modus mit Resume, Mux (MP4/MKV) mit Zweitton, Audiodeskription,
// Untertitel (eingebettet/extern), Dispositionen, Prüfung und atomares Umbenennen, Abbruch, abgelaufene Adresse.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DownloadJob } = require('../lib/download/DownloadJob.js');
const { buildPlan } = require('../lib/download/track-selection.js');
const { effectiveOptions, DEFAULTS } = require('../lib/download/download-settings.js');
const { binaries, makeMedia, probe, startServer } = require('./helpers/download-media.js');

const bins = binaries();
const skip = bins ? false : 'ffmpeg/ffprobe nicht verfügbar';
const PROTOCOLS = 'file,http,https,tcp,tls,crypto';

let shared = null;
async function env() {
  if (shared) return shared;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-job-'));
  const media = makeMedia(path.join(dir, 'media'));
  const server = await startServer(path.join(dir, 'media'));
  shared = { dir, media, server };
  return shared;
}

test.after(async () => {
  if (!shared) return;
  await shared.server.close();
  fs.rmSync(shared.dir, { recursive: true, force: true });
});

function target(dir, name, ext = 'mp4') {
  const folder = path.join(dir, name);
  const file = path.join(folder, `${name}.${ext}`);
  return { dir: folder, base: name, ext, file, partFile: `${file}.part` };
}

function makeJob(e, plan, name, extra = {}) {
  const tgt = target(e.dir, name, plan.container);
  const job = new DownloadJob({
    plan,
    target: tgt,
    meta: { title: 'Testfolge', show: 'Testserie', season: 1, episode: 2, date: '2026-03-19' },
    durationSec: 4,
    sourceId: 'ard',
    ffmpegPath: bins.ffmpeg,
    ffprobePath: bins.ffprobe,
    mediaHttp: { getText: async () => '' },
    assertUrl: async () => {},
    protocolWhitelist: PROTOCOLS,
    ...extra,
  });
  return { job, tgt };
}

function info(e, over = {}) {
  return {
    variants: [{ id: 'v720', kind: 'progressive', url: e.server.url('video.mp4'), width: 160, height: 90, bitrate: null, codec: 'h264', label: 'HD' }],
    audioTracks: [
      { id: 'main', kind: 'main', language: 'deu', label: 'Standard', isDefault: true, url: e.server.url('video.mp4'), hlsUrl: null, uri: null, groupId: null },
      { id: 'ad', kind: 'audio-description', language: 'deu', label: 'Audiodeskription', isDefault: false, url: e.server.url('ad.mp4'), hlsUrl: null, uri: null, groupId: null },
    ],
    subtitles: [{ id: 'sub', language: 'de', label: 'Untertitel', url: e.server.url('sub.vtt'), format: 'webvtt', kind: 'hearing-impaired' }],
    durationSeconds: 4,
    ...over,
  };
}

function planFor(e, overrides, infoOver) {
  const result = buildPlan(info(e, infoOver), effectiveOptions({ ...DEFAULTS }, overrides));
  assert.equal(result.ok, true);
  return result.plan;
}

test('HTTP-Modus: lädt, prüft per ffprobe und benennt atomar um', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { subtitleMode: 'none' });
  assert.equal(plan.mode, 'http');
  const progress = [];
  const { job, tgt } = makeJob(e, plan, 'http-voll', { onProgress: p => progress.push(p) });
  const result = await job.run();
  assert.equal(result.file, tgt.file);
  assert.equal(fs.existsSync(tgt.partFile), false);
  const streams = probe(result.file).streams.map(s => s.codec_type).sort();
  assert.deepEqual(streams, ['audio', 'video']);
  assert.ok(result.fileSize > 0 && result.durationSec > 3);
  assert.ok(progress.length > 0);
});

test('HTTP-Modus: vorhandene Teildatei wird fortgesetzt', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { subtitleMode: 'none' });
  const { job, tgt } = makeJob(e, plan, 'http-resume');
  fs.mkdirSync(tgt.dir, { recursive: true });
  fs.writeFileSync(tgt.partFile, fs.readFileSync(e.media.video).subarray(0, 3000));
  const before = e.server.requests.length;
  await job.run();
  assert.equal(e.server.requests[before].range, 'bytes=3000-');
  assert.ok(fs.readFileSync(tgt.file).equals(fs.readFileSync(e.media.video)));
});

test('Mux MP4: Standardton + Audiodeskription + eingebetteter Untertitel (mov_text) mit Dispositionen und Metadaten', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { audioDescription: 'additional', subtitleMode: 'preferred' });
  assert.equal(plan.mode, 'ffmpeg');
  const { job } = makeJob(e, plan, 'mux-mp4');
  const result = await job.run();
  const probed = probe(result.file);
  const video = probed.streams.filter(s => s.codec_type === 'video');
  const audio = probed.streams.filter(s => s.codec_type === 'audio');
  const subs = probed.streams.filter(s => s.codec_type === 'subtitle');
  assert.equal(video.length, 1);
  assert.equal(audio.length, 2);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].codec_name, 'mov_text');
  assert.equal(subs[0].disposition.hearing_impaired, 1);
  assert.equal(audio[0].disposition.default, 1);
  assert.equal(audio[1].disposition.visual_impaired, 1);
  assert.equal(audio[0].tags.language, 'deu');
  assert.equal(probed.format.tags.title, 'Testfolge');
  assert.equal(probed.format.tags.show, 'Testserie');
  assert.equal(fs.existsSync(`${result.file}.part`), false);
});

test('Mux MKV: Untertitel als srt, Titel der Tonspuren bleiben', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { container: 'mkv', audioDescription: 'additional' });
  assert.equal(plan.container, 'mkv');
  const { job } = makeJob(e, plan, 'mux-mkv');
  const result = await job.run();
  assert.match(result.file, /\.mkv$/);
  const probed = probe(result.file);
  const subs = probed.streams.filter(s => s.codec_type === 'subtitle');
  assert.equal(subs[0].codec_name, 'subrip');
  assert.equal(probed.streams.filter(s => s.codec_type === 'audio')[1].tags.title, 'Audiodeskription');
});

test('Externe Untertitel: .srt neben der Datei, kein Untertitel im Video', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { subtitleDelivery: 'external' });
  assert.equal(plan.mode, 'http'); // externer Untertitel verhindert den Direktdownload nicht
  const { job, tgt } = makeJob(e, plan, 'extern');
  const result = await job.run();
  const srt = path.join(tgt.dir, 'extern.deu.sdh.srt');
  assert.ok(fs.existsSync(srt));
  assert.match(fs.readFileSync(srt, 'utf8'), /Hallo Welt/);
  assert.equal(probe(result.file).streams.filter(s => s.codec_type === 'subtitle').length, 0);
  assert.deepEqual(job.subtitleFiles, [srt]);
});

test('Prüfung: zu kurze Datei (erwartet 100 s) wird verworfen, .part gelöscht', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { subtitleMode: 'none' });
  const { job, tgt } = makeJob(e, plan, 'zu-kurz', { durationSec: 100 });
  await assert.rejects(job.run(), error => error.code === 'verify');
  assert.equal(fs.existsSync(tgt.file), false);
  assert.equal(fs.existsSync(tgt.partFile), false);
});

test('Abgelaufene Adresse (404) im Mux-Lauf -> Code expired, keine Adresse in der Meldung', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { audioDescription: 'additional' });
  plan.inputs[1] = { url: e.server.url('gibt-es-nicht.mp4') };
  const { job, tgt } = makeJob(e, plan, 'abgelaufen');
  await assert.rejects(job.run(), error => {
    assert.equal(error.code, 'expired');
    assert.ok(!/127\.0\.0\.1|gibt-es-nicht/.test(error.message));
    return true;
  });
  assert.equal(fs.existsSync(tgt.partFile), false);
});

test('Abbruch während des Muxens: Prozess beendet, .part gelöscht, Fehlercode aborted', { skip }, async () => {
  const e = await env();
  const slow = await startServer(path.join(e.dir, 'media'), { slowChunkMs: 60 });
  try {
    const plan = planFor(e, { audioDescription: 'additional' }, {
      variants: [{ id: 'v', kind: 'progressive', url: slow.url('video.mp4'), width: 160, height: 90, bitrate: null, codec: 'h264', label: 'HD' }],
      audioTracks: [
        { id: 'main', kind: 'main', language: 'deu', label: 'Standard', isDefault: true, url: slow.url('video.mp4'), hlsUrl: null, uri: null, groupId: null },
        { id: 'ad', kind: 'audio-description', language: 'deu', label: 'Audiodeskription', isDefault: false, url: slow.url('ad.mp4'), hlsUrl: null, uri: null, groupId: null },
      ],
    });
    const children = [];
    const { job, tgt } = makeJob(e, plan, 'abbruch', { onChild: child => children.push(child) });
    const pending = job.run();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok(children.length >= 1, 'ffmpeg sollte laufen');
    job.cancel();
    await assert.rejects(pending, error => error.code === 'aborted');
    assert.equal(fs.existsSync(tgt.partFile), false);
    assert.equal(fs.existsSync(tgt.file), false);
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'Prozess muss beendet sein');
  } finally {
    await slow.close();
  }
});

test('Pause im HTTP-Modus behält die Teildatei für den Resume', { skip }, async () => {
  const e = await env();
  const slow = await startServer(path.join(e.dir, 'media'), { slowChunkMs: 40 });
  try {
    const httpPlan = planFor(e, { subtitleMode: 'none' }, { variants: [{ id: 'v', kind: 'progressive', url: slow.url('video.mp4'), width: 160, height: 90, bitrate: null, codec: 'h264', label: 'HD' }], audioTracks: [{ id: 'main', kind: 'main', language: 'deu', label: 'Standard', isDefault: true, url: slow.url('video.mp4'), hlsUrl: null, uri: null, groupId: null }] });
    const http = makeJob(e, httpPlan, 'pause-http', { onProgress: () => {} });
    const pending = http.job.run();
    await new Promise(resolve => setTimeout(resolve, 300));
    http.job.pause();
    await assert.rejects(pending, error => error.code === 'aborted');
    assert.ok(fs.existsSync(http.tgt.partFile));
  } finally {
    await slow.close();
  }
});

test('Host-Prüfung (assertUrl) verhindert den Start', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { subtitleMode: 'none' });
  const { job, tgt } = makeJob(e, plan, 'verboten', { assertUrl: async () => { throw Object.assign(new Error('Adresse nicht erlaubt'), { code: 'forbidden-host' }); } });
  await assert.rejects(job.run(), error => error.code === 'forbidden-host');
  assert.equal(fs.existsSync(tgt.partFile), false);
});

test('HLS-Master (ARD/ZDF-Rückfall): Variante wird gewählt, Eingänge werden einzeln übergeben', { skip }, async () => {
  const e = await env();
  // Master mit zwei Stufen, beide zeigen auf dieselbe Testdatei (ffmpeg liest sie über HTTP als MP4)
  const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\n${e.server.url('video.mp4')}\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n${e.server.url('video.mp4')}\n`;
  const plan = planFor(e, { subtitleMode: 'none', container: 'mkv' }, {
    variants: [{ id: 'hls', kind: 'hls', url: 'https://example.invalid/master.m3u8', width: null, height: null, bitrate: null, codec: 'h264', label: 'Auto' }],
    audioTracks: [{ id: 'main', kind: 'main', language: 'deu', label: 'Standard', isDefault: true, url: null, hlsUrl: 'https://example.invalid/master.m3u8', uri: null, groupId: null }],
  });
  assert.equal(plan.inputs[0].needsMaster, true);
  const seen = [];
  const { job } = makeJob(e, plan, 'hls-master', { maxHeight: '360', mediaHttp: { getText: async (url) => { seen.push(url); return master; } } });
  const result = await job.run();
  assert.deepEqual(seen, ['https://example.invalid/master.m3u8']);
  assert.ok(probe(result.file).streams.some(s => s.codec_type === 'video'));
});

test('Bandbreitenlimit im Mux-Modus: -readrate wird gesetzt und von ffmpeg akzeptiert', { skip }, async () => {
  const e = await env();
  const plan = planFor(e, { audioDescription: 'additional', subtitleMode: 'none' });
  const calls = [];
  const { job } = makeJob(e, plan, 'readrate', { bytesPerSecond: 600000, spawnImpl: (file, args, options) => { calls.push(args); return spawn(file, args, options); } });
  const result = await job.run();
  assert.ok(fs.existsSync(result.file));
  const args = calls[0];
  assert.ok(args.includes('-readrate'), 'readrate fehlt');
  assert.ok(Number(args[args.indexOf('-readrate') + 1]) > 0);
});

test('Beenden der App (killForQuit): ffmpeg-Prozess weg, Mux-Teildatei gelöscht', { skip }, async () => {
  const e = await env();
  const slow = await startServer(path.join(e.dir, 'media'), { slowChunkMs: 60 });
  try {
    const plan = planFor(e, { audioDescription: 'additional', subtitleMode: 'none' }, {
      variants: [{ id: 'v', kind: 'progressive', url: slow.url('video.mp4'), width: 160, height: 90, bitrate: null, codec: 'h264', label: 'HD' }],
      audioTracks: [
        { id: 'main', kind: 'main', language: 'deu', label: 'Standard', isDefault: true, url: slow.url('video.mp4'), hlsUrl: null, uri: null, groupId: null },
        { id: 'ad', kind: 'audio-description', language: 'deu', label: 'AD', isDefault: false, url: slow.url('ad.mp4'), hlsUrl: null, uri: null, groupId: null },
      ],
    });
    const children = [];
    const { job, tgt } = makeJob(e, plan, 'quit', { onChild: child => children.push(child) });
    const pending = job.run();
    await new Promise(resolve => setTimeout(resolve, 500));
    job.killForQuit();
    await assert.rejects(pending, error => error.code === 'aborted');
    assert.equal(fs.existsSync(tgt.partFile), false);
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  } finally {
    await slow.close();
  }
});

test('arte-Mechanismus über echtes HLS: Video-, Audio- und Untertitel-Playlist als getrennte Eingänge (reconnect-Optionen an HLS)', { skip }, async () => {
  const e = await env();
  const hlsDir = path.join(e.dir, 'hls');
  fs.mkdirSync(hlsDir, { recursive: true });
  const run = args => {
    const result = spawnSync(bins.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  run(['-i', e.media.video, '-map', '0:v', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hlsDir, 'v%d.ts'), path.join(hlsDir, 'v.m3u8')]);
  run(['-i', e.media.video, '-map', '0:a', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hlsDir, 'a%d.ts'), path.join(hlsDir, 'a.m3u8')]);
  run(['-i', e.media.ad, '-map', '0:a', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hlsDir, 'd%d.ts'), path.join(hlsDir, 'd.m3u8')]);
  fs.copyFileSync(e.media.vtt, path.join(hlsDir, 'sub.vtt'));
  fs.writeFileSync(path.join(hlsDir, 's.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.0,\nsub.vtt\n#EXT-X-ENDLIST\n');
  const server = await startServer(hlsDir);
  try {
    const hlsInfo = {
      variants: [{ id: 'arte-90', kind: 'hls', url: server.url('v.m3u8'), width: 160, height: 90, bitrate: 600000, codec: 'h264', label: '90p', audioGroup: 'audio_0' }],
      audioTracks: [
        { id: 'a-de', kind: 'main', language: 'de', label: 'Deutsch', isDefault: true, url: null, hlsUrl: null, uri: server.url('a.m3u8'), groupId: 'audio_0' },
        { id: 'a-ad', kind: 'audio-description', language: 'de', label: 'Audiodeskription', isDefault: false, url: null, hlsUrl: null, uri: server.url('d.m3u8'), groupId: 'audio_0' },
      ],
      subtitles: [{ id: 's-sdh', language: 'de', label: 'Deutsch (Hörgeschädigte)', url: server.url('s.m3u8'), format: 'webvtt', kind: 'hearing-impaired' }],
      durationSeconds: 4,
    };
    for (const container of ['mp4', 'mkv']) {
      const planned = buildPlan(hlsInfo, effectiveOptions({ ...DEFAULTS }, { audioDescription: 'additional', container }));
      assert.equal(planned.plan.mode, 'ffmpeg');
      assert.deepEqual(planned.plan.inputs.map(input => path.basename(input.url)), ['v.m3u8', 'a.m3u8', 'd.m3u8', 's.m3u8']);
      const { job } = makeJob(e, planned.plan, `arte-${container}`);
      const result = await job.run();
      const streams = probe(result.file).streams;
      assert.equal(streams.filter(s => s.codec_type === 'video').length, 1);
      const audio = streams.filter(s => s.codec_type === 'audio');
      assert.equal(audio.length, 2);
      assert.equal(audio[0].disposition.default, 1);
      assert.equal(audio[1].disposition.visual_impaired, 1);
      const subs = streams.filter(s => s.codec_type === 'subtitle');
      assert.equal(subs.length, 1);
      assert.equal(subs[0].codec_name, container === 'mp4' ? 'mov_text' : 'subrip');
      assert.equal(subs[0].disposition.hearing_impaired, 1);
    }
  } finally {
    await server.close();
  }
});
