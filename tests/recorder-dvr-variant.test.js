// Fix-Set 10 (Karte t_28a3bff2): Master-Playlist → Variant-Auflösung für die
// DVR-Seek-Planung. Beweist: iptv-org-Kanäle (sourceUrl = master.m3u8)
// liefern jetzt einen segmentgenauen Plan statt Legacy-`-ss` (das am echten
// ARD-Stream empirisch mit „could not seek to position“ scheitert).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeDvrSeek, firstVariantUrl } = require('../lib/recorder/dvr-seek.js');

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=80000,URI="iframe.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360',
  'master360p1200.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
  'master1080p5000.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="mp4a.40.2"',
  'masteraudio1.m3u8',
].join('\n');

test('firstVariantUrl: erste Video-Variante, absolut aufgelöst, I-FRAME ignoriert', () => {
  const url = firstVariantUrl(MASTER, 'https://daserste-live.ard-mcdn.de/daserste/live/hls/int/master.m3u8');
  assert.strictEqual(url, 'https://daserste-live.ard-mcdn.de/daserste/live/hls/int/master360p1200.m3u8');
});

test('firstVariantUrl: absolute URI bleibt absolut', () => {
  const url = firstVariantUrl(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://example.com/v.m3u8\n',
    'https://cdn.example.com/live/master.m3u8',
  );
  assert.strictEqual(url, 'https://example.com/v.m3u8');
});

test('firstVariantUrl: Master mit nur I-FRAME-Stream-INF → null', () => {
  const url = firstVariantUrl(
    '#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="i.m3u8"\n',
    'https://cdn.example.com/live/master.m3u8',
  );
  assert.strictEqual(url, null);
});

test('firstVariantUrl: STREAM-INF ohne folgende URI → null; keine Master-Playlist → null', () => {
  assert.strictEqual(firstVariantUrl('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', 'https://a.example.com/m.m3u8'), null);
  assert.strictEqual(firstVariantUrl('#EXTM3U\n#EXTINF:2,\nseg.ts\n', 'https://a.example.com/m.m3u8'), null);
  assert.strictEqual(firstVariantUrl(null, 'https://a.example.com/m.m3u8'), null);
});

test('End-to-End (offline): master-Text → Variant-Auflösung → segmentgenauer Plan für 60-min-Offset', () => {
  // Fake-Master + Fake-Variant (2-s-Segmente, 2-h-Fenster wie ARD real)
  const variant = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:308313']
    .concat(Array.from({ length: 3600 }, (_, i) => `#EXTINF:2,\nseg_${String(i).padStart(5, '0')}.ts`))
    .join('\n');
  const baseUrl = 'https://cdn.example.com/live/master.m3u8';
  const variantUrl = firstVariantUrl(MASTER, baseUrl);
  assert.ok(variantUrl);
  const plan = computeDvrSeek(variant, 3600);
  assert.ok(plan, 'Plan muss auf der VARIANT-Playlist baubar sein (Root-Cause des Befunds)');
  assert.strictEqual(plan.mode, 'segments');
  assert.strictEqual(plan.withinWindow, true);
  assert.strictEqual(plan.windowDepthSec, 7200);
  assert.strictEqual(plan.liveStartIndex, -1800); // 60 min zurück = Segment 1800 von 3600
  assert.strictEqual(plan.residualSec, 0);
});

test('Legacy-Fallback unverändert: Master-Text direkt in computeDvrSeek → null (veraltetes Verhalten dokumentiert)', () => {
  assert.strictEqual(computeDvrSeek(MASTER, 3600), null);
});
