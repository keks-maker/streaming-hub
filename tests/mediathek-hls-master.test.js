'use strict';

// Tests: HLS-Master-Parser (lib/mediathek/hls-master.js) mit dem arte-Master-Fixture (CMAF, getrennte Audio-/Untertitelgruppen).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const { parseHlsMaster, parseAttributes, sortVariants, videoCodecOf } = require('../lib/mediathek/hls-master.js');

const BASE = 'https://manifest-arte.akamaized.net/api/manifest/v1/Generate/abc/de/026377-000-A.m3u8';

test('Attribute: Quotes mit Kommas, unquotierte Werte, Großschreibung der Schlüssel', () => {
  assert.deepEqual(parseAttributes('BANDWIDTH=123,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=1280x720'), { BANDWIDTH: '123', CODECS: 'avc1.64001e,mp4a.40.2', RESOLUTION: '1280x720' });
});

test('Master: Varianten mit Auflösung, Codec, Bandbreiten und absoluten URIs', () => {
  const master = parseHlsMaster(fixture('dl-arte-master.m3u8'), BASE);
  assert.equal(master.isMaster, true);
  assert.equal(master.encrypted, false);
  assert.equal(master.variants.length, 4);
  const h265 = master.variants.find(v => v.codec === 'h265');
  assert.equal(h265.height, 720);
  assert.equal(h265.width, 1280);
  assert.equal(h265.bandwidth, 2500000);
  assert.equal(h265.averageBandwidth, 2200000);
  assert.equal(h265.frameRate, 25);
  assert.equal(h265.audio, 'audio_0');
  assert.equal(h265.uri, 'https://manifest-arte.akamaized.net/api/manifest/v1/Generate/abc/de/video/720-h265.m3u8');
  assert.equal(master.variants.find(v => v.height === 432).averageBandwidth, 1200000);
});

test('Master: EXT-X-MEDIA Audio und Untertitel mit Eigenschaften', () => {
  const { media } = parseHlsMaster(fixture('dl-arte-master.m3u8'), BASE);
  const audio = media.filter(m => m.type === 'AUDIO');
  const subtitles = media.filter(m => m.type === 'SUBTITLES');
  assert.deepEqual(audio.map(m => [m.name, m.language, m.isDefault]), [['Deutsch', 'de', true], ['Audiodeskription', 'de', false], ['Italienisch', 'it', false]]);
  assert.ok(audio[1].characteristics.includes('describes-video'));
  assert.equal(audio[0].uri, 'https://manifest-arte.akamaized.net/api/manifest/v1/Generate/abc/de/audio/de.m3u8');
  assert.equal(subtitles.length, 2);
  assert.equal(subtitles[1].forced, true);
  assert.equal(subtitles[0].forced, false);
});

test('sortVariants: Höhe absteigend, H.264 vor H.265 bei gleicher Höhe', () => {
  const { variants } = parseHlsMaster(fixture('dl-arte-master.m3u8'), BASE);
  assert.deepEqual(sortVariants(variants).map(v => `${v.height}-${v.codec}`), ['1080-h264', '720-h264', '720-h265', '432-h264']);
});

test('Master: Medien-Playlist ist kein Master, Verschlüsselung wird erkannt, Müll ist harmlos', () => {
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n';
  assert.equal(parseHlsMaster(media, BASE).isMaster, false);
  const encrypted = '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="k"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';
  assert.equal(parseHlsMaster(encrypted, BASE).encrypted, true);
  const clear = '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=NONE\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';
  assert.equal(parseHlsMaster(clear, BASE).encrypted, false);
  assert.deepEqual(parseHlsMaster('', BASE).variants, []);
  assert.deepEqual(parseHlsMaster(null, BASE).media, []);
  // Kommentar zwischen Tag und URI, fehlende URI am Dateiende
  const odd = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=640x360\n# Kommentar\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9\n';
  const parsed = parseHlsMaster(odd, BASE);
  assert.equal(parsed.variants.length, 1);
  assert.ok(parsed.variants[0].uri.endsWith('/low.m3u8'));
});

test('Codec-Erkennung', () => {
  assert.equal(videoCodecOf('avc1.640028,mp4a.40.2'), 'h264');
  assert.equal(videoCodecOf('hvc1.1.6.L93.B0,mp4a.40.2'), 'h265');
  assert.equal(videoCodecOf('av01.0.05M.08'), 'av1');
  assert.equal(videoCodecOf(''), null);
});
