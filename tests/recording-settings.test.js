'use strict';

// Tests: Aufnahme-Settings — Defaults, Rückwärtskompatibilität, Clamp
// (Etappe 1; Konzept §3.6/§3.9). Reserve-Minimum gilt im Main, nicht nur in der UI.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_MAX_DURATION_HOURS,
  DEFAULT_RESERVE_MB,
  MIN_RESERVE_MB,
  RESERVE_MIN_WARNING,
  clampReserveMB,
  clampMaxParallel,
  clampMaxDurationHours,
  normalizeRecordingSettings,
  applyRecordingSettingsPatch,
} = require('../lib/recorder/recording-settings.js');

test('Defaults: 3 parallel, 6 h Höchstdauer, 1 GB Reserve, Minimum 512 MB', () => {
  assert.equal(DEFAULT_MAX_PARALLEL, 3);
  assert.equal(DEFAULT_MAX_DURATION_HOURS, 6);
  assert.equal(DEFAULT_RESERVE_MB, 1024);
  assert.equal(MIN_RESERVE_MB, 512);
  assert.equal(RESERVE_MIN_WARNING, 'Mindestens 512 MB, sonst kann die Aufnahme nicht sauber beendet werden');
});

test('Altdaten ohne neue Felder laden mit Defaults (Rückwärtskompatibilität)', () => {
  const { settings, clamped } = normalizeRecordingSettings({ storageRoot: '/Volumes/NAS/Aufnahmen' });
  assert.deepEqual(settings, {
    storageRoot: '/Volumes/NAS/Aufnahmen',
    maxParallel: 3,
    maxDurationHours: 6,
    reserveMB: 1024,
  });
  assert.deepEqual(clamped, { maxParallel: false, maxDurationHours: false, reserveMB: false });
  // null/undefined/Müll → ebenfalls Defaults, kein Wurf
  for (const raw of [null, undefined, 'x', 42, [], {}]) {
    const r = normalizeRecordingSettings(raw).settings;
    assert.equal(r.maxParallel, 3);
    assert.equal(r.reserveMB, 1024);
    assert.equal(r.storageRoot, undefined);
  }
});

test('Reserve unter Minimum wird auf 512 MB geklemmt (belowMinimum=true)', () => {
  for (const input of [0, 1, 100, 511, '300', -5]) {
    const r = clampReserveMB(input);
    assert.equal(r.value, 512, `Eingabe ${input}`);
    assert.equal(r.belowMinimum, true);
    assert.equal(r.clamped, true);
  }
  const exact = clampReserveMB(512);
  assert.equal(exact.value, 512);
  assert.equal(exact.belowMinimum, false);
  assert.equal(clampReserveMB(2048).value, 2048);
  assert.equal(clampReserveMB('2048').value, 2048);
  assert.equal(clampReserveMB(1e9).value, 100 * 1024); // Obergrenze
  assert.equal(clampReserveMB('abc').value, 1024);
  assert.equal(clampReserveMB(undefined).value, 1024);
});

test('Clamp greift auch beim Laden gespeicherter Werte', () => {
  const { settings, clamped, reserveBelowMinimum } = normalizeRecordingSettings({
    reserveMB: 100,
    maxParallel: 99,
    maxDurationHours: 0,
  });
  assert.equal(settings.reserveMB, 512);
  assert.equal(settings.maxParallel, 10);
  assert.equal(settings.maxDurationHours, 1);
  assert.equal(clamped.reserveMB, true);
  assert.equal(reserveBelowMinimum, true);
});

test('Parallel-Limit und Höchstdauer: Grenzen und Rundung', () => {
  assert.equal(clampMaxParallel(0).value, 1);
  assert.equal(clampMaxParallel(2.9).value, 2);
  assert.equal(clampMaxParallel('4').value, 4);
  assert.equal(clampMaxParallel(NaN).value, 3);
  assert.equal(clampMaxDurationHours(100).value, 24);
  assert.equal(clampMaxDurationHours(0.2).value, 1);
  assert.equal(clampMaxDurationHours(8).value, 8);
});

test('Patch: Reserve unter Minimum → Minimum gespeichert + Hinweis; Rest bleibt erhalten', () => {
  const raw = { storageRoot: '/data/rec', maxParallel: 2, reserveMB: 4096 };
  const result = applyRecordingSettingsPatch(raw, { reserveMB: 200 });
  assert.equal(result.settings.reserveMB, 512);
  assert.equal(result.reserveBelowMinimum, true);
  assert.equal(result.settings.maxParallel, 2, 'nicht gepatchte Felder bleiben');
  assert.equal(result.settings.storageRoot, '/data/rec');
  assert.equal(result.settings.maxDurationHours, 6);

  const ok = applyRecordingSettingsPatch(raw, { maxParallel: 5 });
  assert.equal(ok.settings.maxParallel, 5);
  assert.equal(ok.settings.reserveMB, 4096);
  assert.equal(ok.reserveBelowMinimum, false);
});

test('Patch: unbekannte Felder werden ignoriert (kein Durchreichen aus IPC)', () => {
  const result = applyRecordingSettingsPatch(null, { evil: 'x', storageRoot: '/etc', maxParallel: 3 });
  assert.equal(result.settings.evil, undefined);
  assert.equal(result.settings.storageRoot, undefined, 'storageRoot ist nicht per Patch setzbar');
});
