'use strict';

// Tests: Planungs-Settings (Etappe 2a; Konzept §3.6): Defaults, Migration von
// Altdaten ohne die neuen Felder, Clamp im Main, Patch/Antwort.

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/recorder/recording-settings.js');

test('Defaults: Puffer 2/5 min, Spätstart an', () => {
  assert.equal(s.DEFAULT_BUFFER_BEFORE_MIN, 2);
  assert.equal(s.DEFAULT_BUFFER_AFTER_MIN, 5);
  assert.equal(s.DEFAULT_LATE_START, true);
  assert.equal(s.MAX_BUFFER_MIN, 30);
});

test('Migration: Altdaten ohne Planungsfelder laden mit Defaults, alte Felder bleiben', () => {
  const { settings } = s.normalizeRecordingSettings({ storageRoot: '/x', maxParallel: 4, maxDurationHours: 8, reserveMB: 2048 });
  assert.equal(settings.maxParallel, 4);
  assert.equal(settings.reserveMB, 2048);
  assert.equal(settings.storageRoot, '/x');
  assert.equal(settings.bufferBeforeMin, 2);
  assert.equal(settings.bufferAfterMin, 5);
  assert.equal(settings.lateStart, true);
  for (const raw of [null, undefined, 'x', 7, [], {}]) {
    const r = s.normalizeRecordingSettings(raw).settings;
    assert.deepEqual([r.bufferBeforeMin, r.bufferAfterMin, r.lateStart], [2, 5, true]);
  }
});

test('Clamp im Main: 0–30, Nachkommastellen abgeschnitten, Müll → Default', () => {
  const norm = raw => s.normalizeRecordingSettings(raw).settings;
  assert.equal(norm({ bufferBeforeMin: -4 }).bufferBeforeMin, 0);
  assert.equal(norm({ bufferBeforeMin: 31 }).bufferBeforeMin, 30);
  assert.equal(norm({ bufferAfterMin: 9999 }).bufferAfterMin, 30);
  assert.equal(norm({ bufferAfterMin: '12' }).bufferAfterMin, 12);
  assert.equal(norm({ bufferAfterMin: 7.9 }).bufferAfterMin, 7);
  assert.equal(norm({ bufferAfterMin: 'abc' }).bufferAfterMin, 5);
  assert.equal(norm({ bufferBeforeMin: 0 }).bufferBeforeMin, 0, '0 ist erlaubt und wird nicht zum Default');
  const flags = s.normalizeRecordingSettings({ bufferBeforeMin: 99, bufferAfterMin: 5 }).clamped;
  assert.equal(flags.bufferBeforeMin, true);
  assert.equal(flags.bufferAfterMin, false);
});

test('lateStart: nur echte Booleans zählen, sonst Default true', () => {
  const norm = raw => s.normalizeRecordingSettings(raw).settings.lateStart;
  assert.equal(norm({ lateStart: false }), false);
  assert.equal(norm({ lateStart: true }), true);
  assert.equal(norm({ lateStart: 'false' }), true);
  assert.equal(norm({ lateStart: 0 }), true);
  assert.equal(norm({}), true);
});

test('Patch: Felder einzeln änderbar, übrige bleiben; Clamp auch beim Patch; Antwort enthält die neuen Felder', () => {
  const stored = { maxParallel: 5, bufferBeforeMin: 3, bufferAfterMin: 8, lateStart: true };
  const r1 = s.applyRecordingSettingsPatch(stored, { bufferAfterMin: '45', lateStart: false });
  assert.equal(r1.settings.bufferAfterMin, 30);
  assert.equal(r1.settings.bufferBeforeMin, 3, 'nicht gesendetes Feld bleibt');
  assert.equal(r1.settings.lateStart, false);
  assert.equal(r1.settings.maxParallel, 5);
  assert.equal(r1.clamped.bufferAfterMin, true);
  const res = s.buildSettingsResponse(r1);
  assert.equal(res.bufferBeforeMin, 3);
  assert.equal(res.bufferAfterMin, 30);
  assert.equal(res.lateStart, false);
  // Patch ohne Planungsfelder lässt sie unverändert
  const r2 = s.applyRecordingSettingsPatch(r1.settings, { maxParallel: 2 });
  assert.deepEqual([r2.settings.bufferBeforeMin, r2.settings.bufferAfterMin, r2.settings.lateStart], [3, 30, false]);
  // Nicht-Boolean im Patch ändert den Wert nicht auf Müll
  const r3 = s.applyRecordingSettingsPatch(r1.settings, { lateStart: 'ja' });
  assert.equal(r3.settings.lateStart, true, 'Müll → Default (true), kein Truthy-Durchreichen');
});

test('Patch: unbekannte Felder werden weiterhin ignoriert', () => {
  const r = s.applyRecordingSettingsPatch(null, { evil: 1, bufferBeforeMin: 1 });
  assert.equal(r.settings.evil, undefined);
  assert.equal(r.settings.bufferBeforeMin, 1);
});
