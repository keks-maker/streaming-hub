'use strict';

// Tests: Spurwahl (track-selection.js) als Matrix über beide Mechanismen: ARD/ZDF (getrennte Ton-Dateien) und arte (HLS-Gruppen);
// plus ffmpeg-Argumente (ffmpeg-args.js). Eingaben aus resolveForDownload mit den Fixtures (kein Netz) oder synthetisch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const ts = require('../lib/download/track-selection.js');
const { buildMuxArgs, buildSrtArgs, readRateFor, createProgressParser } = require('../lib/download/ffmpeg-args.js');
const { effectiveOptions, DEFAULTS } = require('../lib/download/download-settings.js');

const ARTE_MASTER_URL = 'https://manifest-arte.akamaized.net/api/manifest/v1/Generate/abc/de/026377-000-A.m3u8';
const http = {
  async getText(url) {
    const routes = { '/pages/ard/item/ARDITEM': 'dl-ard-item', '/document/zdfdoc': 'dl-zdf-document', '/player/v2/config/de/026377-000-A': 'dl-arte-player' };
    const key = Object.keys(routes).find(route => url.includes(route));
    if (key) return fixture(routes[key]);
    if (url === ARTE_MASTER_URL) return fixture('dl-arte-master.m3u8');
    throw Object.assign(new Error('HTTP 404'), { code: 'http', status: 404 });
  },
};
const service = createMediathekService({ http });
const opts = over => effectiveOptions({ ...DEFAULTS }, over);
const plan = (info, over) => {
  const result = ts.buildPlan(info, opts(over));
  assert.equal(result.ok, true, result.message);
  return result.plan;
};
const ard = () => service.resolveForDownload({ id: 'ARDITEM', title: 'Die Entführung (S01/E02)', sourceId: 'ard' });
const zdf = () => service.resolveForDownload({ id: 'zdfdoc', title: 'Folge', sourceId: 'zdf' });
const arte = () => service.resolveForDownload({ id: '026377-000-A', title: 'Occupied', sourceId: 'arte' });

const track = (id, kind, language, over = {}) => ({ id, kind, language, label: id, isDefault: kind === 'main', url: `https://x.invalid/${id}.mp4`, hlsUrl: null, uri: null, groupId: null, ...over });
const variant = (height, over = {}) => ({ id: `v${height}`, kind: 'progressive', url: `https://x.invalid/v${height}.mp4`, width: null, height, bitrate: null, codec: 'h264', label: `${height}p`, ...over });
const sub = (id, language, kind, over = {}) => ({ id, language, label: id, url: `https://x.invalid/${id}.vtt`, format: 'webvtt', kind, ...over });
const base = over => ({ variants: [variant(1080), variant(720), variant(360)], audioTracks: [track('main', 'main', 'deu')], subtitles: [], durationSeconds: 3600, ...over });

// ── Videostufe ──

test('Auflösung: höchste Stufe bis zur Grenze; best = höchste; Grenze unter dem Minimum = niedrigste mit Hinweis', () => {
  assert.equal(plan(base(), { maxHeight: 'best' }).video.height, 1080);
  assert.equal(plan(base(), { maxHeight: '1080' }).video.height, 1080);
  assert.equal(plan(base(), { maxHeight: '720' }).video.height, 720);
  assert.equal(plan(base(), { maxHeight: '540' }).video.height, 360);
  const tooLow = plan(base({ variants: [variant(720), variant(480)] }), { maxHeight: '360' });
  assert.equal(tooLow.video.height, 480);
  assert.ok(tooLow.warnings.some(text => /Obergrenze/.test(text)));
});

test('Progressiv vor HLS bei gleicher Höhe, H.264 vor H.265, HLS "Auto" ohne Höhe nur als letzter Ausweg', () => {
  const mixed = base({ variants: [variant(720, { kind: 'hls', url: 'https://x.invalid/m.m3u8' }), variant(720), variant(null, { kind: 'hls', url: 'https://x.invalid/auto.m3u8', id: 'auto' })] });
  assert.equal(plan(mixed, {}).video.kind, 'progressive');
  const codecs = base({ variants: [variant(720, { codec: 'h265', id: 'h265' }), variant(720, { codec: 'h264', id: 'h264' })] });
  assert.equal(plan(codecs, {}).video.codec, 'h264');
  const onlyAuto = base({ variants: [variant(null, { kind: 'hls', url: 'https://x.invalid/auto.m3u8', id: 'auto' })] });
  const p = plan(onlyAuto, { subtitleMode: 'none' });
  assert.equal(p.video.needsMaster, true);
  assert.equal(p.mode, 'ffmpeg');
  assert.equal(p.inputs[0].needsMaster, true);
});

test('Kein ladbarer Stream -> ok false mit lesbarer Meldung', () => {
  const result = ts.buildPlan({ variants: [], audioTracks: [], subtitles: [] }, opts({}));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-video');
  assert.match(result.message, /kein ladbarer Stream/);
});

// ── Modus ──

test('Modus http: eine progressive Datei, MP4, ohne eingebettete Untertitel; sonst ffmpeg', () => {
  assert.equal(plan(base(), { subtitleMode: 'none' }).mode, 'http');
  assert.equal(plan(base({ subtitles: [sub('s', 'deu', 'normal')] }), { subtitleDelivery: 'external' }).mode, 'http');
  assert.equal(plan(base({ subtitles: [sub('s', 'deu', 'normal')] }), {}).mode, 'ffmpeg');
  assert.equal(plan(base(), { subtitleMode: 'none', container: 'mkv' }).mode, 'ffmpeg');
  assert.equal(plan(base({ audioTracks: [track('main', 'main', 'deu'), track('ad', 'audio-description', 'deu')] }), { subtitleMode: 'none', audioDescription: 'additional' }).mode, 'ffmpeg');
});

// ── Tonspuren ──

test('Ton "nur bevorzugte": eine Spur nach Sprachreihenfolge, Standardton als Rückfall mit Hinweis', () => {
  const tracks = [track('de', 'main', 'deu'), track('fr', 'main', 'fra', { isDefault: false }), track('orig', 'original', 'ita', { isDefault: false })];
  const p = plan(base({ audioTracks: tracks }), { audioLanguages: ['fra', 'deu'], subtitleMode: 'none' });
  assert.deepEqual(p.audio.map(a => [a.id, a.language]), [['fr', 'fra']]);
  const original = plan(base({ audioTracks: tracks }), { audioLanguages: ['orig', 'deu'], subtitleMode: 'none' });
  assert.deepEqual(original.audio.map(a => [a.id, a.language]), [['orig', 'ita']]);
  const fallback = plan(base({ audioTracks: tracks }), { audioLanguages: ['spa'], subtitleMode: 'none' });
  assert.deepEqual(fallback.audio.map(a => a.id), ['de']);
  assert.ok(fallback.warnings.some(text => /Standardton/.test(text)));
});

test('Ton "alle": alle normalen Spuren in Sprachreihenfolge, Klare Sprache dabei, Audiodeskription nicht ohne Wunsch', () => {
  const tracks = [track('de', 'main', 'deu'), track('fr', 'main', 'fra', { isDefault: false }), track('klar', 'clear-speech', 'deu'), track('ad', 'audio-description', 'deu')];
  const p = plan(base({ audioTracks: tracks }), { audioMode: 'all', audioLanguages: ['fra', 'deu'], subtitleMode: 'none' });
  assert.deepEqual(p.audio.map(a => a.id), ['fr', 'de', 'klar']);
  assert.equal(p.audio[0].disposition, 'default');
  assert.equal(p.audio[1].disposition, '0');
});

test('Audiodeskription: nie / zusätzlich (als visual_impaired) / ersatzweise', () => {
  const tracks = [track('de', 'main', 'deu'), track('ad', 'audio-description', 'deu')];
  assert.deepEqual(plan(base({ audioTracks: tracks }), { audioDescription: 'never', subtitleMode: 'none' }).audio.map(a => a.id), ['de']);
  const extra = plan(base({ audioTracks: tracks }), { audioDescription: 'additional', subtitleMode: 'none' });
  assert.deepEqual(extra.audio.map(a => [a.id, a.disposition]), [['de', 'default'], ['ad', 'visual_impaired']]);
  assert.deepEqual(plan(base({ audioTracks: tracks }), { audioDescription: 'fallback', subtitleMode: 'none' }).audio.map(a => a.id), ['de']);
});

test('Audiodeskription ersatzweise: ohne normale Spur trägt die AD-Datei Bild und Ton', () => {
  const info = base({ variants: [], audioTracks: [track('ad', 'audio-description', 'deu')] });
  const p = plan(info, { audioDescription: 'fallback', subtitleMode: 'none' });
  assert.deepEqual(p.audio.map(a => [a.id, a.input, a.disposition]), [['ad', 0, 'visual_impaired']]);
  assert.equal(p.video.url, 'https://x.invalid/ad.mp4');
  assert.ok(p.warnings.some(text => /Auflösung/.test(text)));
  // "never" ohne normale Spur: es bleibt trotzdem eine Spur (nie ein Video ohne Ton)
  const never = plan(info, { audioDescription: 'never', subtitleMode: 'none' });
  assert.equal(never.audio.length, 1);
});

test('Gebärdensprache wird nie gewählt', () => {
  const info = base({ audioTracks: [track('sign', 'sign-language', 'deu'), track('de', 'main', 'deu')] });
  assert.deepEqual(plan(info, { audioMode: 'all', subtitleMode: 'none' }).audio.map(a => a.id), ['de']);
});

test('ARD/ZDF: zusätzliche Tonspur kommt aus ihrer eigenen Datei (nur der Ton), HLS-Spur als Master', () => {
  const tracks = [track('de', 'main', 'deu'), track('ad', 'audio-description', 'deu', { url: null, hlsUrl: 'https://x.invalid/ad.m3u8' })];
  const p = plan(base({ audioTracks: tracks }), { audioDescription: 'additional', subtitleMode: 'none' });
  assert.equal(p.inputs.length, 2);
  assert.deepEqual(p.inputs[1], { url: 'https://x.invalid/ad.m3u8', needsMaster: true });
  assert.deepEqual(p.audio.map(a => a.input), [0, 1]);
});

// ── Untertitel ──

test('Untertitel: keine / bevorzugte Sprache (normal vor Hörgeschädigte, ohne erzwungene) / alle', () => {
  const subs = [sub('sdh', 'deu', 'hearing-impaired'), sub('de', 'deu', 'normal'), sub('forced', 'deu', 'forced'), sub('fr', 'fra', 'normal'), sub('ttml', 'deu', 'normal', { format: 'ttml' })];
  assert.deepEqual(plan(base({ subtitles: subs }), { subtitleMode: 'none' }).subtitles, []);
  assert.deepEqual(plan(base({ subtitles: subs }), { subtitleMode: 'preferred' }).subtitles.map(s => s.id), ['de']);
  assert.deepEqual(plan(base({ subtitles: [subs[0], subs[2]] }), { subtitleMode: 'preferred' }).subtitles.map(s => s.id), ['sdh']);
  assert.deepEqual(plan(base({ subtitles: subs }), { subtitleMode: 'preferred', subtitleLanguage: 'fra' }).subtitles.map(s => s.id), ['fr']);
  assert.deepEqual(plan(base({ subtitles: subs }), { subtitleMode: 'preferred', subtitleLanguage: 'spa' }).subtitles, []);
  const all = plan(base({ subtitles: subs }), { subtitleMode: 'all' });
  assert.deepEqual(all.subtitles.map(s => s.id), ['sdh', 'de', 'forced', 'fr']); // TTML entfällt
  assert.deepEqual(all.subtitles.map(s => s.disposition), ['hearing_impaired', '0', 'forced', '0']);
});

test('Untertitel eingebettet vs. extern (.srt daneben)', () => {
  const info = base({ subtitles: [sub('de', 'de', 'normal')] });
  const embedded = plan(info, { subtitleDelivery: 'embedded' });
  assert.deepEqual(embedded.subtitles.map(s => [s.external, s.input, s.language]), [[false, 1, 'deu']]);
  const external = plan(info, { subtitleDelivery: 'external' });
  assert.deepEqual(external.subtitles.map(s => [s.external, s.input]), [[true, null]]);
  assert.equal(external.inputs.length, 0); // http-Modus: keine Eingänge
});

// ── Quellen mit Fixtures ──

test('ARD-Fixture: 1080p-Standardton, AD nur auf Wunsch, Untertitel normal vor SDH', async () => {
  const info = await ard();
  const p = plan(info, {});
  assert.equal(p.video.height, 1080);
  assert.deepEqual(p.audio.map(a => a.kind), ['main']);
  assert.deepEqual(p.subtitles.map(s => s.kind), ['normal']);
  const withAd = plan(info, { audioDescription: 'additional', maxHeight: '720' });
  assert.equal(withAd.video.height, 720);
  assert.deepEqual(withAd.audio.map(a => a.disposition), ['default', 'visual_impaired']);
  assert.equal(withAd.inputs[1].url, 'https://cdn.example.invalid/_audiodeskription_1080.mp4');
  const direct = plan(info, { subtitleMode: 'none' });
  assert.equal(direct.mode, 'http');
  assert.equal(direct.video.url, 'https://cdn.example.invalid/_sendeton_1080.mp4');
});

test('ZDF-Fixture: UHD nur bei "best", sonst H.264; HEVC im MP4 mit hvc1', async () => {
  const info = await zdf();
  assert.equal(plan(info, { maxHeight: 'best' }).video.codec, 'h265');
  const limited = plan(info, { maxHeight: '1080' });
  assert.equal(limited.video.height, 1080);
  assert.equal(limited.video.codec, 'h264');
  const best = plan(info, { maxHeight: 'best', audioDescription: 'additional', subtitleMode: 'none' });
  const args = buildMuxArgs({ plan: best, inputUrls: best.inputs.map(i => i.url), outFile: '/tmp/x.mp4.part' });
  assert.deepEqual(args.slice(args.indexOf('-tag:v'), args.indexOf('-tag:v') + 2), ['-tag:v', 'hvc1']);
  const mkv = plan(info, { maxHeight: 'best', container: 'mkv', subtitleMode: 'none' });
  assert.ok(!buildMuxArgs({ plan: mkv, inputUrls: mkv.inputs.map(i => i.url), outFile: '/tmp/x.mkv.part' }).includes('hvc1'));
});

test('arte-Fixture: H.264 vor H.265 bei 720p, Tonspuren der Gruppe, Original als orig, SDH-Untertitel', async () => {
  const info = await arte();
  const p = plan(info, { maxHeight: '720', subtitleMode: 'all' });
  assert.equal(p.video.height, 720);
  assert.equal(p.video.codec, 'h264');
  assert.deepEqual(p.audio.map(a => [a.label, a.input, a.language]), [['Deutsch', 1, 'deu']]);
  assert.deepEqual(p.subtitles.map(s => [s.kind, s.disposition]), [['hearing-impaired', 'hearing_impaired'], ['forced', 'forced']]);
  assert.equal(p.mode, 'ffmpeg');
  const orig = plan(info, { audioLanguages: ['orig', 'deu'], audioDescription: 'additional', subtitleMode: 'none' });
  assert.deepEqual(orig.audio.map(a => [a.language, a.kind]), [['ita', 'original'], ['deu', 'audio-description']]);
  assert.equal(orig.audio[0].disposition, 'default');
  assert.equal(orig.audio[1].disposition, 'visual_impaired');
});

test('Größenschätzung: Datenrate aus der Quelle oder Tabelle mal Dauer; ohne Dauer null', () => {
  const withBitrate = plan(base({ variants: [variant(720, { bitrate: 2000000 })] }), { subtitleMode: 'none' });
  assert.equal(withBitrate.estimatedBytes, Math.round((2000000 / 8) * 3600));
  const table = plan(base({ variants: [variant(1080)] }), { subtitleMode: 'none' });
  assert.equal(table.estimatedBytes, Math.round((ts.HEIGHT_BPS[1080] / 8) * 3600));
  assert.equal(plan(base({ durationSeconds: null }), {}).estimatedBytes, null);
});

// ── ffmpeg-Argumente ──

function muxArgs(over, planOver = {}) {
  const info = base({ audioTracks: [track('de', 'main', 'deu'), track('ad', 'audio-description', 'deu')], subtitles: [sub('sdh', 'deu', 'hearing-impaired')] });
  const p = plan(info, { audioDescription: 'additional', ...over });
  return { p, args: buildMuxArgs({ plan: p, inputUrls: p.inputs.map(i => i.url), outFile: '/tmp/a.mp4.part', meta: { title: 'T', show: 'S', season: 1, episode: 2, date: '2026-03-19' }, userAgent: 'UA/1', ...planOver }) };
}

test('Mux-Argumente MP4: Eingänge einzeln, Maps, mov_text, faststart, Container explizit, Metadaten, kein Master', () => {
  const { args } = muxArgs({});
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === '-i'), ['https://x.invalid/v1080.mp4', 'https://x.invalid/ad.mp4', 'https://x.invalid/sdh.vtt']);
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === '-map'), ['0:v:0', '0:a:0', '1:a:0', '2:s:0']);
  assert.deepEqual(args.slice(args.indexOf('-c:s'), args.indexOf('-c:s') + 2), ['-c:s', 'mov_text']);
  assert.ok(args.includes('+faststart'));
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'mp4']);
  assert.ok(args.includes('-disposition:a:1') && args[args.indexOf('-disposition:a:1') + 1] === 'visual_impaired');
  assert.equal(args[args.indexOf('-disposition:s:0') + 1], 'hearing_impaired');
  assert.ok(args.includes('title=T') && args.includes('show=S') && args.includes('season_number=1') && args.includes('episode_sort=2') && args.includes('date=2026-03-19'));
  assert.ok(args.includes('-nostdin') && args.at(-1) === '/tmp/a.mp4.part' && args.includes('-progress'));
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,https,tcp,tls,crypto');
  assert.equal(args.filter(arg => arg === '-user_agent').length, 3);
  assert.ok(!args.includes('-tag:v')); // H.264
});

test('Mux-Argumente MKV: srt, kein faststart, matroska', () => {
  const { args } = muxArgs({ container: 'mkv' });
  assert.equal(args[args.indexOf('-c:s') + 1], 'srt');
  assert.ok(!args.includes('+faststart'));
  assert.equal(args[args.indexOf('-f') + 1], 'matroska');
});

test('Mux-Argumente: Dateieingänge ohne Netzoptionen; Eingänge müssen zum Plan passen; optionales Audio mit ?', () => {
  const info = base({ audioTracks: [] });
  const p = plan(info, { subtitleMode: 'none', container: 'mkv' });
  const args = buildMuxArgs({ plan: p, inputUrls: ['/tmp/video.mp4'], outFile: '/tmp/a.mkv.part', userAgent: 'UA', protocolWhitelist: 'file' });
  assert.ok(!args.includes('-user_agent') && !args.includes('-reconnect'));
  assert.ok(args.includes('0:a:0?'));
  assert.throws(() => buildMuxArgs({ plan: p, inputUrls: [], outFile: 'x' }), /Eingänge/);
});

test('SRT-Konvertierung: ein Eingang, srt-Ausgabe', () => {
  const args = buildSrtArgs({ url: 'https://x.invalid/s.vtt', outFile: '/tmp/s.srt' });
  assert.deepEqual(args.slice(-7, -1), ['-map', '0:s:0', '-c:s', 'srt', '-f', 'srt']);
  assert.equal(args.at(-1), '/tmp/s.srt');
  assert.equal(args[args.indexOf('-c:s') + 1], 'srt');
});

test('readrate aus Bandbreitenlimit', () => {
  assert.equal(readRateFor(0, 2000000), null);
  assert.equal(readRateFor(500, null), null);
  assert.equal(readRateFor(250, 2000000), 1); // 250 kB/s = 2 Mbit/s
  assert.equal(readRateFor(125, 2000000), 0.5);
  assert.equal(readRateFor(100000, 2000000), null); // weit über der Datenrate
  assert.equal(readRateFor(1, 8000000), 0.05);
});

test('Fortschrittsparser: Blöcke aus key=value-Zeilen, auch in Teilstücken', () => {
  const blocks = [];
  const feed = createProgressParser(block => blocks.push(block));
  feed('out_time=00:00:02.500000\ntotal_size=1');
  feed('234\nprogress=continue\nout_time_us=4000000\ntotal_size=2000\nprogress=end\n');
  assert.deepEqual(blocks, [{ timeSec: 2.5, totalSize: 1234, done: false }, { timeSec: 4, totalSize: 2000, done: true }]);
});
