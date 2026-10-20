'use strict';

// Tests: Wiedergabe-Logik (mediathek-player-model.js), Anzeige-Texte (mediathek-format.js) und Detail-Inhalt
// (mediathek-detail-model.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../mediathek-player-model.js');
const f = require('../mediathek-format.js');
const d = require('../mediathek-detail-model.js');

test('Stream-Art und erlaubte Adressen', () => {
  assert.equal(p.streamKind('https://x.akamaihd.net/i/a/master.m3u8?__b__=200'), 'hls');
  assert.equal(p.streamKind('https://x.example/video.mp4'), 'mp4');
  assert.equal(p.streamKind('kaputt'), 'mp4');
  assert.equal(p.isPlayableUrl('https://x.example/a.mp4'), true);
  assert.equal(p.isPlayableUrl('http://x.example/a.mp4'), false);
  assert.equal(p.isPlayableUrl('javascript:alert(1)'), false);
  assert.equal(p.isPlayableUrl(null), false);
});

test('Qualitätsstufe: höchste Stufe bis zur gewünschten Höhe, sonst die niedrigste', () => {
  const levels = [{ height: 360 }, { height: 720 }, { height: 1080 }, { height: 540 }];
  assert.equal(p.pickLevel(levels, 'auto'), -1);
  assert.equal(p.pickLevel(levels, '1080'), 2);
  assert.equal(p.pickLevel(levels, '720'), 1);
  assert.equal(p.pickLevel(levels, '540'), 3);
  assert.equal(p.pickLevel([{ height: 720 }, { height: 1080 }], '540'), 0, 'nichts darunter: niedrigste Stufe');
  assert.equal(p.pickLevel([], '720'), -1);
  assert.equal(p.pickLevel(undefined, '720'), -1);
});

test('Tonspur nach Sprachwunsch, Audiodeskription wird nie automatisch gewählt', () => {
  const tracks = [
    { name: 'Audiodeskription', lang: 'de' },
    { name: 'Deutsch', lang: 'de' },
    { name: 'Original (Französisch)', lang: 'fr' },
  ];
  assert.equal(p.pickAudioTrack(tracks, 'de'), 1);
  assert.equal(p.pickAudioTrack(tracks, 'original'), 2);
  assert.equal(p.pickAudioTrack([{ name: 'Deutsch', lang: 'de' }], 'original'), -1, 'eine Spur: nichts umzustellen');
  assert.equal(p.pickAudioTrack([{ name: 'English', lang: 'en' }, { name: 'Español', lang: 'es' }], 'de'), -1);
  assert.equal(p.pickAudioTrack([{ name: 'English', lang: 'en' }, { name: 'Deutsch', lang: 'de' }], 'original'), 0);
});

test('Untertitel: aus / Deutsch / Original', () => {
  const tracks = [
    { name: 'Deutsch (hörgeschädigt)', lang: 'de' },
    { name: 'Deutsch', lang: 'de' },
    { name: 'Français', lang: 'fr' },
    { name: 'Deutsch forced', lang: 'de' },
  ];
  assert.equal(p.pickSubtitleTrack(tracks, 'off'), -1);
  assert.equal(p.pickSubtitleTrack(tracks, 'de'), 1);
  assert.equal(p.pickSubtitleTrack(tracks, 'original', 'de'), 2);
  assert.equal(p.pickSubtitleTrack([{ name: 'Deutsch', lang: 'de' }], 'original', 'de'), -1);
  assert.equal(p.pickSubtitleTrack([], 'de'), -1);
  assert.equal(p.pickSubtitleTrack(undefined, 'de'), -1);
  assert.equal(p.trackLabel({ name: 'Deutsch', lang: 'de' }, 0), 'Deutsch');
  assert.equal(p.trackLabel({ lang: 'fr' }, 1), 'fr');
  assert.equal(p.trackLabel({}, 2), 'Spur 3');
});

test('Startposition aus dem Ergebnis von resolve-playback', () => {
  assert.equal(p.startPosition({ startPosition: 125.5 }), 125.5);
  assert.equal(p.startPosition({ startPosition: null }), 0);
  assert.equal(p.startPosition({ startPosition: -3 }), 0);
  assert.equal(p.startPosition(null), 0);
});

test('Fortschritt wird gedrosselt gespeichert, flush schreibt sofort', () => {
  let clock = 1000000;
  const saved = [];
  const saver = p.createProgressSaver({ save: payload => saved.push(payload), intervalMs: 10000, now: () => clock });
  saver.tick(5, 100); // erster Tick schreibt sofort
  assert.deepEqual(saved, [{ position: 5, duration: 100 }]);
  clock += 3000;
  saver.tick(8, 100);
  clock += 3000;
  saver.tick(11, 100);
  assert.equal(saved.length, 1, 'innerhalb des Intervalls nicht erneut');
  saver.flush();
  assert.deepEqual(saved[1], { position: 11, duration: 100 });
  saver.flush();
  assert.equal(saved.length, 2, 'ohne neue Werte nichts doppelt');
  clock += 20000;
  saver.tick(40, 100);
  assert.equal(saved.length, 3);
  saver.tick(NaN, 100);
  saver.tick(5, 0);
  saver.tick(5, Infinity);
  saver.flush();
  assert.equal(saved.length, 3, 'ungültige Werte werden ignoriert');
  saver.tick(120, 100);
  saver.flush();
  assert.equal(saved[3].position, 100, 'Position wird auf die Dauer begrenzt');
});

test('Fortschritt: Fehler beim Speichern stören die Wiedergabe nicht', async () => {
  const saver = p.createProgressSaver({ save: () => Promise.reject(new Error('nein')), now: () => 1e9 });
  saver.tick(30, 100);
  const throwing = p.createProgressSaver({ save: () => { throw new Error('nein'); }, now: () => 1e9 });
  throwing.tick(30, 100);
  await new Promise(resolve => setImmediate(resolve));
});

test('Texte: Minuten, Untertitel, Datum, Verfügbarkeit, Bild-Adresse, Platzhalter', () => {
  assert.equal(f.minutesText(2640), '44 Min.');
  assert.equal(f.minutesText(10), '1 Min.');
  assert.equal(f.minutesText(0), null);
  assert.equal(f.minutesText(null), null);
  assert.equal(f.subtitleText({ season: 2, episode: 3, subtitle: 'Die Akte' }), 'Staffel 2 · Folge 3 · Die Akte');
  assert.equal(f.subtitleText({ season: null, episode: null, subtitle: 'ONE' }), 'ONE');
  assert.equal(f.subtitleText({ season: null, episode: null, subtitle: null }), null);
  assert.equal(f.germanDate('2026-11-27T22:59:00Z'), '27.11.2026');
  assert.equal(f.germanDate('2026-11-27T23:30:00Z'), '28.11.2026', 'Kalendertag in Europe/Berlin');
  assert.equal(f.germanDate('kein Datum'), null);
  assert.equal(f.availableUntilText({ availableUntil: '2026-12-04T10:00:00Z' }), 'Verfügbar bis 04.12.2026');
  assert.equal(f.availableUntilText({ availableUntil: null }), null);
  assert.equal(f.imageSrc('https://x.example/{width}/a.jpg', 480), 'https://x.example/480/a.jpg');
  assert.equal(f.imageSrc('http://x.example/a.jpg'), null);
  assert.equal(f.imageSrc('javascript:alert(1)'), null);
  assert.equal(f.imageSrc(null), null);
  assert.equal(f.initials('Das Institut'), 'DI');
  assert.equal(f.initials('Tatort: Nachtschicht'), 'TN');
  assert.equal(f.initials('«x» y'), 'XY');
  assert.equal(typeof f.placeholderHue('Titel'), 'number');
  assert.equal(f.placeholderHue('Titel'), f.placeholderHue('Titel'));
  assert.equal(f.sourceBadge('arte'), 'arte');
  assert.equal(f.sourceLabel('ard'), 'ARD');
  assert.equal(f.clockText(3725), '1:02:05');
  assert.equal(f.clockText(65), '1:05');
});

test('Detail-Inhalt: Kopfzeile, Meta, Verfügbarkeit, Geo- und FSK-Hinweise', () => {
  const entry = { id: 'e', title: 'Folge 1', sourceId: 'ard', season: 2, episode: 1, subtitle: 'Ankunft', duration: 2640, availableUntil: '2026-11-27T22:59:00Z', description: '  Text  ', regionRestricted: true };
  const info = d.detailInfo(entry, { series: { id: 's' } });
  assert.equal(info.kicker, 'ARD · NUR IN DEUTSCHLAND');
  assert.deepEqual(info.meta, ['Staffel 2 · Folge 1 · Ankunft', 'Dauer 44 Min.']);
  assert.equal(info.availability, 'Verfügbar bis 27.11.2026');
  assert.equal(info.description, 'Text');
  assert.deepEqual(info.hints, [{ kind: 'geo', text: 'Nur in Deutschland abrufbar.' }]);
  assert.equal(info.canPlay, true);
  assert.equal(info.canFavorite, true);

  const blocked = d.detailInfo({ id: 'x', title: 'Film', sourceId: 'zdf' }, { blocked: { reason: 'ageRestricted', message: 'Nur zwischen 22 und 6 Uhr (FSK 16).' } });
  assert.equal(blocked.canPlay, false);
  assert.equal(blocked.canFavorite, false);
  assert.deepEqual(blocked.hints, [{ kind: 'fsk', text: 'Nur zwischen 22 und 6 Uhr (FSK 16).' }]);
  assert.equal(blocked.availability, null);
  assert.equal(blocked.description, null);
  assert.equal(d.detailInfo({ id: 'y', title: 'z', sourceId: 'ard' }, { blocked: { reason: 'geoBlocked', message: 'Geoblock' } }).hints[0].kind, 'geo');
});

test('Sperrmeldung aus resolve-playback', () => {
  assert.equal(d.blockedFromResolution({ ok: true, resolution: { kind: 'playable', url: 'https://x' } }), null);
  assert.deepEqual(d.blockedFromResolution({ ok: true, resolution: { kind: 'geoBlocked' }, message: 'Geoblock' }), { reason: 'geoBlocked', message: 'Geoblock' });
  assert.equal(d.blockedFromResolution({ ok: true, resolution: { kind: 'ageRestricted' }, message: 'FSK' }).reason, 'ageRestricted');
  assert.equal(d.blockedFromResolution({ ok: true, resolution: { kind: 'unavailable' } }).reason, 'unavailable');
  assert.equal(d.blockedFromResolution({ ok: false, error: 'offline' }).message, 'offline');
});
