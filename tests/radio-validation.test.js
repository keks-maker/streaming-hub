'use strict';

// Tests: Radio-Validierung (input-validation.js, ipc-validation.js) und Backup-Kompatibilität (backup.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  radioStreamUrlError,
  radioLogoUrlError,
  radioStation,
  radioStationUpdates,
  channelStreamUrlError,
  favoriteOrder,
} = require('../lib/input-validation.js');
const {
  validateRadioStationKey,
  validateRadioPlay,
  validateRadioVolume,
  validateRadioFavoriteFlag,
  normalizeRadioPlayerReport,
  validateNoPayload,
} = require('../lib/ipc-validation.js');
const { parseBackup, validateBackup } = require('../lib/backup.js');

test('radioStreamUrlError: http/https erlaubt, auch LAN und localhost (nutzereigene Quelle)', () => {
  for (const ok of ['http://example.test/live', 'https://example.test/live.mp3?x=1', 'http://192.168.1.20:8000/stream', 'http://localhost:8000/x', 'http://[::1]:8000/x', 'http://radio.local/stream']) {
    assert.equal(radioStreamUrlError(ok), null, ok);
  }
  assert.notEqual(channelStreamUrlError('http://192.168.1.20:8000/stream'), null, 'LiveTV bleibt strenger');
});

test('radioStreamUrlError: andere Protokolle, Zugangsdaten, Leerzeichen, Länge und Typfehler werden abgelehnt', () => {
  const bad = [
    'file:///etc/passwd',
    'ftp://x.test/a',
    'javascript:alert(1)',
    'data:audio/mpeg;base64,AAAA',
    '//x.test/a',
    'x.test/stream',
    'http://user:pw@x.test/a',
    'http://x.test/a b',
    'http://x.test/a\nb',
    '',
    `http://x.test/${'a'.repeat(2100)}`,
    null,
    undefined,
    42,
    {},
  ];
  for (const value of bad) assert.notEqual(radioStreamUrlError(value), null, String(value));
});

test('radioLogoUrlError: nur http/https', () => {
  assert.equal(radioLogoUrlError('https://logo.test/a.png'), null);
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AA', 'file:///a.png', '/relativ/a.png', 'http://u:p@x/a.png']) {
    assert.notEqual(radioLogoUrlError(bad), null, bad);
  }
});

test('radioStation: Pflichtfelder, Trimmen, optionale Felder, unbekannte Felder', () => {
  assert.deepEqual(radioStation({ name: '  Mein Sender ', streamUrl: 'http://x.test/s' }), { name: 'Mein Sender', streamUrl: 'http://x.test/s' });
  assert.deepEqual(radioStation({ name: 'A', streamUrl: 'https://x.test/s', logo: 'https://l.test/a.png', genre: ' Rock ' }), {
    name: 'A',
    streamUrl: 'https://x.test/s',
    logo: 'https://l.test/a.png',
    genre: 'Rock',
  });
  assert.throws(() => radioStation({ streamUrl: 'http://x.test/s' }), /Sendername/);
  assert.throws(() => radioStation({ name: '   ', streamUrl: 'http://x.test/s' }), /Sendername/);
  assert.throws(() => radioStation({ name: 'x'.repeat(201), streamUrl: 'http://x.test/s' }), /Sendername/);
  assert.throws(() => radioStation({ name: 'A', streamUrl: 'ftp://x.test/s' }), /http/);
  assert.throws(() => radioStation({ name: 'A', streamUrl: 'http://x.test/s', logo: 'javascript:1' }), /Logo-URL/);
  assert.throws(() => radioStation({ name: 'A\u0000', streamUrl: 'http://x.test/s' }), /Sendername/);
  assert.throws(() => radioStation({ name: 'A', streamUrl: 'http://x.test/s', id: 'custom-1' }), /Unbekanntes Feld: id/);
  for (const bad of [null, [], 'x', 5]) assert.throws(() => radioStation(bad), /Radiosender/);
});

test('radioStationUpdates: Teiländerungen, null entfernt Logo/Genre, Pflichtfelder bleiben gültig', () => {
  assert.deepEqual(radioStationUpdates({ name: ' Neu ' }), { name: 'Neu' });
  assert.deepEqual(radioStationUpdates({ logo: '', genre: '' }), { logo: null, genre: null });
  assert.deepEqual(radioStationUpdates({ streamUrl: 'http://192.168.0.2/s' }), { streamUrl: 'http://192.168.0.2/s' });
  assert.throws(() => radioStationUpdates({}), /leer/);
  assert.throws(() => radioStationUpdates({ name: '' }), /Sendername/);
  assert.throws(() => radioStationUpdates({ streamUrl: '' }), /Stream-URL/);
  assert.throws(() => radioStationUpdates({ streamUrl: 'file:///x' }), /http/);
  assert.throws(() => radioStationUpdates({ id: 'x' }), /Unbekanntes Feld/);
  assert.throws(() => radioStationUpdates(null), /Radiosender-Änderung/);
});

test('Favoriten-Reihenfolge nutzt das gemeinsame Format { sourceId, id }', () => {
  assert.deepEqual(favoriteOrder([{ sourceId: 's', id: 'a', extra: 1 }]), [{ sourceId: 's', id: 'a' }]);
  assert.throws(() => favoriteOrder([{ sourceId: 's' }]), /ungültig/);
});

test('IPC: Sender-Schlüssel, Play-Argument, Lautstärke, Favoriten-Flag', () => {
  assert.deepEqual(validateRadioStationKey({ sourceId: 's', stationId: 'a' }), { sourceId: 's', stationId: 'a' });
  for (const bad of [null, [], 'a', {}, { sourceId: 's' }, { sourceId: '', stationId: 'a' }, { sourceId: 's', stationId: 1 }, { sourceId: 's', stationId: 'a', x: 1 }, { sourceId: 's', stationId: 'a\n' }, { sourceId: 'x'.repeat(201), stationId: 'a' }]) {
    assert.throws(() => validateRadioStationKey(bad), /ungültig|Unbekanntes/, JSON.stringify(bad));
  }
  assert.equal(validateRadioPlay(undefined), null);
  assert.equal(validateRadioPlay(null), null);
  assert.deepEqual(validateRadioPlay({ sourceId: 's', stationId: 'a' }), { sourceId: 's', stationId: 'a' });
  assert.throws(() => validateRadioPlay('a'), /ungültig/);
  for (const ok of [0, 0.5, 1]) assert.equal(validateRadioVolume(ok), ok);
  for (const bad of [-0.1, 1.1, NaN, Infinity, '0.5', null, undefined]) assert.throws(() => validateRadioVolume(bad), /Lautstärke/);
  assert.equal(validateRadioFavoriteFlag(true), true);
  assert.throws(() => validateRadioFavoriteFlag('ja'), /ungültig/);
  assert.doesNotThrow(() => validateNoPayload([]));
  assert.throws(() => validateNoPayload(['x']), /Unerwartete/);
});

test('Player-Nachrichten: Whitelist, Typen und Längen werden normalisiert', () => {
  assert.deepEqual(normalizeRadioPlayerReport({ t: 'ready' }), { t: 'ready' });
  assert.deepEqual(normalizeRadioPlayerReport({ t: 'playing', seq: 3, evil: 'x' }), { t: 'playing', seq: 3 });
  assert.deepEqual(normalizeRadioPlayerReport({ t: 'error', seq: 2, code: 4, message: 'm'.repeat(500) }), {
    t: 'error',
    seq: 2,
    code: 4,
    fatal: true,
    message: 'm'.repeat(200),
  });
  assert.deepEqual(normalizeRadioPlayerReport({ t: 'error', code: 'x', message: 5 }), { t: 'error', code: 0, fatal: true, message: '' });
  assert.deepEqual(normalizeRadioPlayerReport({ t: 'action', action: 'nexttrack' }), { t: 'action', action: 'nexttrack' });
  assert.equal(normalizeRadioPlayerReport({ t: 'action', action: 'seekto' }), null);
  assert.equal(normalizeRadioPlayerReport({ t: 'action' }), null);
  assert.equal(normalizeRadioPlayerReport({ t: 'tick' }), null);
  assert.equal(normalizeRadioPlayerReport({ t: 'playing', seq: -1 }).seq, undefined);
  for (const bad of [null, undefined, 'ready', [], 5, {}]) assert.equal(normalizeRadioPlayerReport(bad), null);
});

// ── Backup ──

const legacy = {
  services: [{ id: 'youtube', name: 'YouTube', url: 'https://youtube.com' }],
  tvsources: [{ id: 'tv', name: 'TV', url: 'https://example.test/list.m3u' }],
  history: [],
};
const radio = [
  {
    id: 'eigene-radiosender',
    name: 'Eigene Sender',
    type: 'user',
    stations: [{ id: 'custom-1', name: 'LAN-Radio', streamUrl: 'http://192.168.1.5:8000/live', logo: 'https://l.test/a.png' }],
    favorites: ['custom-1'],
    favoriteRank: { 'custom-1': 0 },
  },
];

test('Backup ohne Radio (ältere Sicherung) bleibt gültig und unverändert', () => {
  const result = validateBackup(legacy);
  assert.equal(result.ok, true);
  assert.equal('radioSources' in result.value, false);
  assert.equal('radioSettings' in result.value, false);
  assert.deepEqual(parseBackup(JSON.stringify(legacy)), legacy);
});

test('Backup mit Radio: Quellen und Einstellungen werden übernommen, LAN-Streams erlaubt', () => {
  const settings = { volume: 0.4, lastStation: { sourceId: 's', id: 'a' }, evil: true };
  const value = parseBackup(JSON.stringify({ ...legacy, radioSources: radio, radioSettings: settings }));
  assert.deepEqual(value.radioSources, radio);
  assert.deepEqual(value.radioSettings, { volume: 0.4, lastStation: { sourceId: 's', id: 'a' }, resumeOnStart: false, pauseOnTv: true, keepPlayingWhenClosed: true, trayDisplay: 'station-title' });
});

test('Backup akzeptiert den Schlüssel "radiosources" und normalisiert ihn zu radioSources', () => {
  const value = parseBackup(JSON.stringify({ ...legacy, radiosources: radio }));
  assert.deepEqual(value.radioSources, radio);
  assert.equal('radiosources' in value, false);
});

test('Backup lehnt ungültige Radio-Daten ab, bevor etwas geschrieben wird', () => {
  const cases = [
    [{ radioSources: {} }, /Radio-Quellen/],
    [{ radioSources: [{ id: 1, name: 'x' }] }, /Radio-Quelle/],
    [{ radioSources: [{ id: 's', name: 'x', stations: {} }] }, /Radiosender/],
    [{ radioSources: [{ id: 's', name: 'x', stations: [{ id: 'a', name: 'A', streamUrl: 'file:///etc/passwd' }] }] }, /Radiosender/],
    [{ radioSources: [{ id: 's', name: 'x', stations: [{ id: 'a', name: 'A', streamUrl: 'http://x.test/s', logo: 'javascript:1' }] }] }, /Logo/],
    [{ radioSources: [{ id: 's', name: 'x', stations: [{ id: 'a', streamUrl: 'http://x.test/s' }] }] }, /Radiosender/],
    [{ radioSources: [{ id: 's', name: 'x', favorites: 'a' }] }, /Favoriten/],
  ];
  for (const [extra, pattern] of cases) {
    const result = validateBackup({ ...legacy, ...extra });
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.match(result.error, pattern, JSON.stringify(extra));
  }
});

test('Backup: bestehende Prüfungen (LiveTV) gelten weiter', () => {
  assert.equal(validateBackup({ ...legacy, tvsources: [{ id: 'tv', name: 'TV', url: 'http://127.0.0.1/x.m3u' }], radioSources: radio }).ok, false);
});
