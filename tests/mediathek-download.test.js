'use strict';

// Tests: resolveForDownload (service.js + download-info.js) je Quelle mit Fixtures nach Spike-Bericht; HTTP ist ein Ersatz
// (kein Netz): { getText(url) } liefert Fixtures je Adresse.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mediathek/index.js');
const { createMediathekService } = require('../lib/mediathek/service.js');
const { germanDateTime } = require('../lib/mediathek/download-info.js');

const ARTE_MASTER_URL = 'https://manifest-arte.akamaized.net/api/manifest/v1/Generate/abc/de/026377-000-A.m3u8';

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async getText(url) {
      calls.push(url);
      const route = Object.entries(routes).find(([key]) => url.includes(key));
      if (!route) throw Object.assign(new Error('Server antwortete mit HTTP 404'), { code: 'http', status: 404 });
      if (route[1] instanceof Error) throw route[1];
      return route[1];
    },
  };
}

test('ARD: nur Standardton als Varianten, Tonvarianten getrennt, nur WebVTT, Staffel/Folge/Datum', async () => {
  const http = fakeHttp({ '/pages/ard/item/ARDITEM': fixture('dl-ard-item') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'ARDITEM', title: 'Die Entführung (S01/E02)', sourceId: 'ard' });
  assert.equal(info.restriction, null); // Geo-Flag mit Streams ist nur ein Hinweis
  assert.deepEqual(info.variants.map(v => [v.kind, v.height]), [['progressive', 1080], ['progressive', 720], ['progressive', 360], ['hls', null]]);
  assert.equal(info.variants[0].url, 'https://cdn.example.invalid/_sendeton_1080.mp4'); // nicht die Audiodeskription-Datei
  assert.equal(info.variants[1].url, 'https://cdn.example.invalid/_sendeton_720.mp4'); // Schema // ergänzt
  assert.equal(info.variants[0].label, 'HD 1080p');
  assert.equal(info.variants[3].url, 'https://cdn.example.invalid/standard/master.m3u8');
  assert.deepEqual(info.audioTracks.map(t => [t.kind, t.isDefault]), [['main', true], ['audio-description', false], ['clear-speech', false]]);
  assert.equal(info.audioTracks[1].url, 'https://cdn.example.invalid/_audiodeskription_1080.mp4');
  assert.equal(info.audioTracks[1].hlsUrl, 'https://cdn.example.invalid/ad/master.m3u8');
  assert.equal(info.audioTracks[2].url, 'https://cdn.example.invalid/_klaresprache_720.mp4');
  assert.ok(!info.audioTracks.some(t => /sign/.test(t.url || ''))); // Gebärdensprache nie
  assert.deepEqual(info.subtitles.map(s => [s.kind, s.format]), [['normal', 'webvtt'], ['hearing-impaired', 'webvtt']]); // TTML-only-Spur entfällt
  assert.ok(info.subtitles.every(s => s.url.endsWith('.vtt')));
  assert.equal(info.season, 1);
  assert.equal(info.episode, 2);
  assert.equal(info.seriesTitle, 'Das Institut');
  assert.equal(info.availableUntil, '2027-03-19T22:59:00.000Z');
  assert.equal(info.broadcastDate, '2026-03-20'); // 23:30 UTC = 00:30 Berlin
  assert.equal(info.durationSeconds, 2040);
});

test('ARD: Audiodeskription zuerst gelistet ändert die Standardspur nicht', async () => {
  const root = { widgets: [{ type: 'player_ondemand', title: 'T', mediaCollection: { embedded: { streams: [{ kind: 'main', media: [{ mimeType: 'video/mp4', url: 'https://x.invalid/ad.mp4', maxVResolutionPx: 720, audios: [{ kind: 'audio-description' }] }, { mimeType: 'video/mp4', url: 'https://x.invalid/std.mp4', maxVResolutionPx: 540, audios: [{ kind: 'standard' }] }] }] } } }] };
  const info = await createMediathekService({ http: fakeHttp({ '/item/A': JSON.stringify(root) }) }).resolveForDownload({ id: 'A', title: 'T', sourceId: 'ard' });
  assert.deepEqual(info.variants.map(v => v.url), ['https://x.invalid/std.mp4']);
  assert.equal(info.audioTracks[0].kind, 'main');
});

test('ARD: FSK-Sperre -> restriction age mit Fenster, ohne Streams', async () => {
  const http = fakeHttp({ '/item/INST': fixture('ardItemInstitutFskBlocked') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'INST', title: 'Die Hölle wartet (S01/E07)', sourceId: 'ard' });
  assert.equal(info.restriction.code, 'age');
  assert.equal(info.restriction.rating, 'FSK16');
  assert.equal(info.restriction.window, '22 bis 6 Uhr');
  assert.match(info.restriction.message, /22 bis 6 Uhr/);
  assert.deepEqual(info.variants, []);
  assert.equal(info.availableUntil, '2027-09-24T21:59:00.000Z'); // availableTo der Sperrseite
  assert.equal(info.season, 1);
  assert.equal(info.episode, 7);
});

test('ARD: Geo ohne Stream -> geo, ohne Medien -> unavailable', async () => {
  const geo = { widgets: [{ mediaCollection: { embedded: { isGeoBlocked: true, streams: [] } } }] };
  const service = createMediathekService({ http: fakeHttp({ '/item/G': JSON.stringify(geo), '/item/N': fixture('ardItemNoMedia') }) });
  assert.equal((await service.resolveForDownload({ id: 'G', title: 'x', sourceId: 'ard' })).restriction.code, 'geo');
  assert.equal((await service.resolveForDownload({ id: 'N', title: 'x', sourceId: 'ard' })).restriction.code, 'unavailable');
});

test('ZDF: formitaeten main/ad, Mirror-Duplikate zusammengefasst, nur WebVTT, Staffel < 1900', async () => {
  const http = fakeHttp({ '/document/zdfdoc': fixture('dl-zdf-document') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'zdfdoc', title: 'Der Bergdoktor - Folge 1', sourceId: 'zdf' });
  assert.equal(info.restriction, null);
  assert.deepEqual(info.variants.map(v => [v.kind, v.label, v.codec]), [['progressive', 'uhd', 'h265'], ['progressive', 'fhd', 'h264'], ['progressive', 'hd', 'h264'], ['progressive', 'low', 'h264'], ['hls', 'auto', 'h264']]);
  assert.equal(info.variants.find(v => v.label === 'hd').url, 'https://nrodlzdf-a.akamaihd.net/none/zdf/26/03/x/1/x_3328k_p15v17.mp4'); // erster Host, nicht der Mirror
  assert.equal(info.variants.find(v => v.label === 'fhd').bitrate, 6628000);
  assert.equal(info.variants.find(v => v.label === 'fhd').height, 1080);
  assert.deepEqual(info.audioTracks.map(t => [t.id, t.kind, t.label]), [['zdf-main', 'main', 'TV Ton'], ['zdf-ad', 'audio-description', 'Audiodeskription']]);
  assert.equal(info.audioTracks[0].url, 'https://nrodlzdf-a.akamaihd.net/none/zdf/26/03/x/1/x_6628k_p15v17.mp4'); // beste H.264-Stufe
  assert.equal(info.audioTracks[1].url, 'https://nrodlzdf-a.akamaihd.net/none/zdf/26/03/x/1/x_ad_3328k_p15v17.mp4');
  assert.equal(info.audioTracks[1].hlsUrl, 'https://zdfvod.akamaized.net/x/master.m3u8?audiotrack=1');
  assert.deepEqual(info.subtitles.map(s => [s.url, s.kind]), [['https://utstreaming.zdf.de/mtt/x.vtt', 'hearing-impaired']]);
  assert.equal(info.season, 17);
  assert.equal(info.episode, 1);
  assert.equal(info.seriesTitle, 'Der Bergdoktor');
  assert.equal(info.broadcastDate, '2026-03-19');
  assert.equal(info.availableUntil, '2027-03-15T09:00:00.000Z');
  assert.equal(info.isExtra, false);
});

test('ZDF: Staffelnummer > 1900 ist ein Jahr -> keine Staffel/Folge; timetolive als Berliner Ortszeit', async () => {
  const http = fakeHttp({ '/document/mag': fixture('dl-zdf-magazine') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'mag', title: 'heute journal', sourceId: 'zdf' });
  assert.equal(info.season, null);
  assert.equal(info.episode, null);
  assert.equal(info.broadcastDate, '2026-03-19');
  assert.equal(info.availableUntil, '2027-03-15T09:00:00.000Z');
});

test('ZDF: FSK -> restriction unsupported mit Meldung', async () => {
  const http = fakeHttp({ '/document/fsk': fixture('zdfDocumentFskBlocked') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'fsk', title: 'x', sourceId: 'zdf' });
  assert.equal(info.restriction.code, 'unsupported');
  assert.match(info.restriction.message, /FSK/);
  assert.equal(info.restriction.window, '22 bis 6 Uhr');
  assert.deepEqual(info.variants, []);
  const none = await createMediathekService({ http: fakeHttp({ '/document/x': fixture('zdfDocumentNoFormats') }) }).resolveForDownload({ id: 'x', title: 'x', sourceId: 'zdf' });
  assert.equal(none.restriction.code, 'unavailable');
});

test('ZDF: Clips sind Extras', async () => {
  const doc = { document: { contentType: 'clip', formitaeten: [{ type: 'h264_aac_mp4_http_na_na', quality: 'high', class: 'main', url: 'https://x.invalid/a.mp4' }] } };
  const info = await createMediathekService({ http: fakeHttp({ '/document/c': JSON.stringify(doc) }) }).resolveForDownload({ id: 'c', title: 'Clip', sourceId: 'zdf' });
  assert.equal(info.isExtra, true);
});

test('arte: HLS-Master wird geladen, H.264 vor H.265, Audio-/Untertitelgruppen, Staffel/Folge aus Titel', async () => {
  const http = fakeHttp({ '/player/v2/config/de/026377-000-A': fixture('dl-arte-player'), [ARTE_MASTER_URL]: fixture('dl-arte-master.m3u8') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: '026377-000-A', title: 'Occupied - Die Besatzung', sourceId: 'arte' });
  assert.equal(info.restriction, null);
  assert.deepEqual(info.variants.map(v => `${v.height}-${v.codec}`), ['1080-h264', '720-h264', '720-h265', '432-h264']);
  assert.equal(info.variants[0].bitrate, 4000000);
  assert.ok(info.variants.every(v => v.kind === 'hls' && v.url.startsWith('https://manifest-arte.akamaized.net/')));
  assert.deepEqual(info.audioTracks.map(t => [t.label, t.kind, t.language, t.isDefault]), [['Deutsch', 'main', 'de', true], ['Audiodeskription', 'audio-description', 'de', false], ['Italienisch', 'original', 'it', false]]);
  assert.ok(info.audioTracks.every(t => t.uri.endsWith('.m3u8')));
  assert.deepEqual(info.subtitles.map(s => [s.kind, s.format]), [['hearing-impaired', 'webvtt'], ['forced', 'webvtt']]);
  assert.equal(info.season, 2);
  assert.equal(info.episode, 3);
  assert.equal(info.availableUntil, '2027-03-18T23:59:00.000Z');
  assert.equal(info.broadcastDate, '2026-03-19');
  assert.equal(info.durationSeconds, 2700);
});

test('arte: Staffel aus Entry (Sammlung) hat Vorrang; verschlüsselter Master -> unsupported', async () => {
  const encrypted = '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="k"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nv.m3u8\n';
  const http = fakeHttp({ '/player/v2/config/de/E': fixture('dl-arte-player'), [ARTE_MASTER_URL]: encrypted });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'E', title: 'x', sourceId: 'arte', season: 5, episode: null });
  assert.equal(info.season, 5);
  assert.equal(info.restriction.code, 'unsupported');
  assert.deepEqual(info.variants, []);
});

test('arte: Altersgrenze mit Zeitfenster (retryAt), ohne Master-Abruf', async () => {
  const http = fakeHttp({ '/config/de/AGE': fixture('dl-arte-age') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'AGE', title: 'Nachtfilm', sourceId: 'arte' });
  assert.equal(info.restriction.code, 'age');
  assert.equal(info.restriction.rating, 'FSK16');
  assert.equal(info.restriction.retryAt, '2026-10-20T20:00:00.000Z');
  assert.equal(info.restriction.window, '22 bis 6 Uhr');
  assert.equal(http.calls.length, 1);
});

test('arte: Master nicht ladbar -> unavailable statt Absturz', async () => {
  const http = fakeHttp({ '/config/de/M': fixture('dl-arte-player') });
  const info = await createMediathekService({ http }).resolveForDownload({ id: 'M', title: 'x', sourceId: 'arte' });
  assert.equal(info.restriction.code, 'unavailable');
});

test('Fehlerfälle: HTTP-Fehler -> unavailable, Netzwerkfehler werden geworfen, unbekannte Quelle', async () => {
  const service404 = createMediathekService({ http: fakeHttp({}) });
  const info = await service404.resolveForDownload({ id: 'x', title: 'T', sourceId: 'ard' });
  assert.equal(info.restriction.code, 'unavailable');
  assert.deepEqual([info.variants, info.audioTracks, info.subtitles], [[], [], []]);
  const failing = createMediathekService({ http: fakeHttp({ '/item/N': Object.assign(new Error('Server nicht gefunden'), { code: 'network' }) }) });
  await assert.rejects(failing.resolveForDownload({ id: 'N', title: 'T', sourceId: 'ard' }), { code: 'network' });
  const unknown = await service404.resolveForDownload({ id: 'x', title: 'T', sourceId: 'rtl' });
  assert.equal(unknown.restriction.code, 'unavailable');
  const garbage = createMediathekService({ http: fakeHttp({ '/document/g': '<html>' }) });
  assert.equal((await garbage.resolveForDownload({ id: 'g', title: 'T', sourceId: 'zdf' })).restriction.code, 'unavailable');
});

test('Deutsches Datum: Sommer-/Winterzeit', () => {
  assert.deepEqual(germanDateTime('19.03.2026 01:00'), { iso: '2026-03-19T00:00:00.000Z', day: '2026-03-19' });
  assert.deepEqual(germanDateTime('15.07.2026 10:00'), { iso: '2026-07-15T08:00:00.000Z', day: '2026-07-15' });
  assert.equal(germanDateTime('morgen'), null);
});
