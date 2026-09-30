'use strict';

// Tests: Aufnahme-UI-Modell (Phase 1c, Karte t_bafa7928)
// formatDuration, currentEpgStopMs, isProbablyNetworkPath — reine Logik,
// kein Electron-Zugriff.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration,
  currentEpgStopMs,
  isProbablyNetworkPath,
} = require('../lib/recorder/ui-model.js');

// ── formatDuration ──

test('formatDuration: MM:SS unter einer Stunde', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(59), '00:59');
  assert.equal(formatDuration(754), '12:34'); // Konzept-Beispiel
});

test('formatDuration: H:MM:SS ab einer Stunde', () => {
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(7325), '2:02:05');
});

test('formatDuration: nicht-endliche/negative Werte → 00:00', () => {
  assert.equal(formatDuration(NaN), '00:00');
  assert.equal(formatDuration(-5), '00:00');
  assert.equal(formatDuration(Infinity), '00:00');
  assert.equal(formatDuration(null), '00:00');
  assert.equal(formatDuration(undefined), '00:00');
});

// ── currentEpgStopMs ──

const EPG = [
  { title: 'Früher Film', start: '20260930180000 +0200', stop: '20260930194500 +0200' },
  { title: 'Tagesschau', start: '20260930200000 +0200', stop: '20260930201500 +0200' },
  { title: 'Talk', start: '20260930201500 +0200', stop: '20260930220000 +0200' },
];

test('currentEpgStopMs: Ende der laufenden Sendung', () => {
  // 20:05 CEST = 18:05 UTC → Tagesschau läuft, Ende 18:15 UTC
  const now = Date.UTC(2026, 8, 30, 18, 5, 0);
  const stop = currentEpgStopMs(EPG, now);
  assert.equal(stop, Date.UTC(2026, 8, 30, 18, 15, 0));
});

test('currentEpgStopMs: null außerhalb der Sendungen', () => {
  // Lücke: „Früher Film“ endet 17:45 UTC, „Tagesschau“ beginnt 18:00 UTC
  const now = Date.UTC(2026, 8, 30, 17, 50, 0);
  assert.equal(currentEpgStopMs(EPG, now), null);
  assert.equal(currentEpgStopMs([], Date.now()), null);
  assert.equal(currentEpgStopMs(null, Date.now()), null);
  assert.equal(currentEpgStopMs(undefined, Date.now()), null);
});

test('currentEpgStopMs: ungültige Einträge werden ignoriert', () => {
  const entries = [
    { title: 'kaputt', start: 'xyz', stop: 'auch kaputt' },
    { title: 'ok', start: '20260930200000 +0200', stop: '20260930201500 +0200' },
  ];
  const now = Date.UTC(2026, 8, 30, 18, 5, 0);
  assert.equal(currentEpgStopMs(entries, now), Date.UTC(2026, 8, 30, 18, 15, 0));
});

test('currentEpgStopMs: Default now = Date.now() nutzt Live-Referenz', () => {
  // Kein fester Zeitpunkt: Funktion darf nicht werfen und liefert null oder ms
  const result = currentEpgStopMs(EPG);
  assert.ok(result === null || Number.isFinite(result));
});

// ── isProbablyNetworkPath ──

test('isProbablyNetworkPath: UNC/URI-Formen erkannt', () => {
  assert.equal(isProbablyNetworkPath('\\\\NAS\\media'), true);
  assert.equal(isProbablyNetworkPath('smb://nas/media'), true);
  assert.equal(isProbablyNetworkPath('nfs://host/export'), true);
  assert.equal(isProbablyNetworkPath('afp://host/Volumes'), true);
  assert.equal(isProbablyNetworkPath('cifs://host/share'), true);
});

test('isProbablyNetworkPath: typische Mountpunkte erkannt', () => {
  assert.equal(isProbablyNetworkPath('/mnt/nas/aufnahmen'), true);
  assert.equal(isProbablyNetworkPath('/media/user/nas'), true);
  assert.equal(isProbablyNetworkPath('/Volumes/MediaServer/Aufnahmen'), true);
});

test('isProbablyNetworkPath: lokale Pfade nicht geflagged', () => {
  assert.equal(isProbablyNetworkPath('/home/user/Videos'), false);
  assert.equal(isProbablyNetworkPath('C:\\Users\\user\\Videos'), false);
  assert.equal(isProbablyNetworkPath('/Users/keks/Movies'), false);
  assert.equal(isProbablyNetworkPath(''), false);
  assert.equal(isProbablyNetworkPath(null), false);
  assert.equal(isProbablyNetworkPath(undefined), false);
});
