'use strict';

// Tests: Download-Einstellungen (download-settings.js): Defaults, Clamp, Patch, Schema, Überschreibungen, Speicherort.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const s = require('../lib/download/download-settings.js');
const { createSettingsHolder } = require('../lib/download/settings-holder.js');

test('Defaults aus leerem/ungültigem Input', () => {
  for (const raw of [undefined, null, {}, [], 'x', 5]) {
    const { settings } = s.normalizeDownloadSettings(raw);
    assert.equal(settings.fileNameScheme, 'S{season2}E{episode2} - {title}');
    assert.equal(settings.container, 'mp4');
    assert.equal(settings.maxParallel, 2);
    assert.equal(settings.maxHeight, 'best');
    assert.equal(settings.audioMode, 'preferred');
    assert.deepEqual(settings.audioLanguages, ['deu']);
    assert.equal(settings.audioDescription, 'never');
    assert.equal(settings.subtitleMode, 'preferred');
    assert.equal(settings.subtitleDelivery, 'embedded');
    assert.equal(settings.bandwidthKBps, 0);
    assert.equal(settings.cleanupWatchedDays, 0);
    assert.equal(settings.notifyOnDone, true);
    assert.equal(settings.skipOptionsDialog, false);
    assert.equal(settings.showDownloads, true);
    assert.equal(settings.seriesFolders, true);
    assert.equal(settings.writeNfoCover, false);
    assert.equal(settings.storageRoot, null);
  }
});

test('Parallelität 1-5 wird geklemmt, Strings werden gelesen, Müll fällt auf Default', () => {
  const clamp = value => s.normalizeDownloadSettings({ maxParallel: value });
  assert.equal(clamp(0).settings.maxParallel, 1);
  assert.equal(clamp(9).settings.maxParallel, 5);
  assert.equal(clamp('3').settings.maxParallel, 3);
  assert.equal(clamp(2.9).settings.maxParallel, 2);
  assert.equal(clamp('abc').settings.maxParallel, 2);
  assert.equal(clamp(9).clamped.maxParallel, true);
  assert.equal(clamp(3).clamped.maxParallel, false);
});

test('Bandbreitenlimit und Aufräumtage: Grenzen', () => {
  const n = s.normalizeDownloadSettings({ bandwidthKBps: -5, cleanupWatchedDays: 99999 }).settings;
  assert.equal(n.bandwidthKBps, 0);
  assert.equal(n.cleanupWatchedDays, 3650);
  assert.equal(s.normalizeDownloadSettings({ bandwidthKBps: 500 }).settings.bandwidthKBps, 500);
});

test('Auswahlfelder: nur erlaubte Werte, sonst Default', () => {
  const n = s.normalizeDownloadSettings({ maxHeight: 720, container: 'avi', audioMode: 'x', audioDescription: 'immer', subtitleMode: 'alle', subtitleDelivery: 'zip', subtitleLanguage: 'orig' }).settings;
  assert.equal(n.maxHeight, '720'); // Zahl wird zu Text
  assert.equal(n.container, 'mp4');
  assert.equal(n.audioMode, 'preferred');
  assert.equal(n.audioDescription, 'never');
  assert.equal(n.subtitleMode, 'preferred');
  assert.equal(n.subtitleDelivery, 'embedded');
  assert.equal(n.subtitleLanguage, 'deu'); // "orig" ist für Untertitel keine Sprache
  assert.equal(s.normalizeDownloadSettings({ maxHeight: 999 }).settings.maxHeight, 'best');
});

test('Sprachreihenfolge: bekannte Codes, ohne Dubletten; leer -> Deutsch', () => {
  assert.deepEqual(s.normalizeDownloadSettings({ audioLanguages: ['orig', 'deu', 'orig', 'xx', 5] }).settings.audioLanguages, ['orig', 'deu']);
  assert.deepEqual(s.normalizeDownloadSettings({ audioLanguages: [] }).settings.audioLanguages, ['deu']);
  assert.deepEqual(s.normalizeDownloadSettings({ audioLanguages: 'deu' }).settings.audioLanguages, ['deu']);
});

test('Dateinamen-Schema: bekannte Platzhalter, keine Pfadtrenner, sonst Default', () => {
  assert.equal(s.normalizeScheme('{series} - S{season2}E{episode2}'), '{series} - S{season2}E{episode2}');
  assert.equal(s.normalizeScheme('{title} ({date})'), '{title} ({date})');
  assert.equal(s.normalizeScheme('../{title}'), s.DEFAULT_SCHEME);
  assert.equal(s.normalizeScheme('a/b'), s.DEFAULT_SCHEME);
  assert.equal(s.normalizeScheme('{unbekannt}'), s.DEFAULT_SCHEME);
  assert.equal(s.normalizeScheme('{title'), s.DEFAULT_SCHEME);
  assert.equal(s.normalizeScheme(''), s.DEFAULT_SCHEME);
  assert.equal(s.normalizeScheme('x'.repeat(500)), s.DEFAULT_SCHEME);
  assert.equal(s.normalizeScheme(42), s.DEFAULT_SCHEME);
});

test('Speicherort: nur absolute Pfade; Standard = <Aufnahmen>/Mediathek', () => {
  assert.equal(s.normalizeDownloadSettings({ storageRoot: 'relativ/pfad' }).settings.storageRoot, null);
  assert.equal(s.normalizeDownloadSettings({ storageRoot: '/Volumes/NAS/Mediathek' }).settings.storageRoot, '/Volumes/NAS/Mediathek');
  assert.equal(s.defaultDownloadRoot('/home/u/Videos/Streaming Hub'), path.join('/home/u/Videos/Streaming Hub', 'Mediathek'));
  assert.equal(s.resolveStorageRoot({ storageRoot: null }, '/rec'), path.join('/rec', 'Mediathek'));
  assert.equal(s.resolveStorageRoot({ storageRoot: '/x' }, '/rec'), '/x');
});

test('Patch: nur gelieferte Felder ändern, unbekannte verwerfen, clamped nur für den Patch', () => {
  const base = s.normalizeDownloadSettings({ container: 'mkv', maxParallel: 4 }).settings;
  const result = s.applyDownloadSettingsPatch(base, { maxParallel: 99, bogus: 1, notifyOnDone: false });
  assert.equal(result.settings.container, 'mkv');
  assert.equal(result.settings.maxParallel, 5);
  assert.equal(result.settings.notifyOnDone, false);
  assert.equal(result.settings.bogus, undefined);
  assert.deepEqual(result.clamped, { maxParallel: true });
});

test('Überschreibungen: nur Dialogfelder, normalisiert; globale Felder bleiben unverändert', () => {
  const overrides = s.normalizeOverrides({ container: 'mkv', maxHeight: '720', maxParallel: 5, storageRoot: '/x', audioDescription: 'kaputt' });
  assert.deepEqual(overrides, { container: 'mkv', maxHeight: '720', audioDescription: 'never' });
  const merged = s.effectiveOptions(s.normalizeDownloadSettings({ container: 'mp4', maxParallel: 3 }).settings, { container: 'mkv' });
  assert.equal(merged.container, 'mkv');
  assert.equal(merged.maxParallel, 3);
});

test('Antwort für die Oberfläche: wirksamer Speicherort, Gebärdensprache nie, Wertelisten', () => {
  const response = s.buildSettingsResponse(s.normalizeDownloadSettings({}), '/rec');
  assert.equal(response.effectiveStorageRoot, path.join('/rec', 'Mediathek'));
  assert.equal(response.isDefaultStorageRoot, true);
  assert.equal(response.signLanguage, 'never');
  assert.deepEqual(response.options.containers, ['mp4', 'mkv']);
});

test('Settings-Halter: lädt, speichert Patches, übersteht unlesbare Datei', () => {
  const written = [];
  let stored = { maxParallel: 4 };
  const holder = createSettingsHolder({ read: () => stored, write: value => { written.push(value); stored = value; }, getRecordingRoot: () => '/rec' });
  assert.equal(holder.get().maxParallel, 4);
  const result = holder.patch({ container: 'mkv' });
  assert.equal(holder.get().container, 'mkv');
  assert.equal(written.length, 1);
  assert.equal(holder.response(result).container, 'mkv');
  assert.equal(holder.defaults().maxParallel, 2);
  const broken = createSettingsHolder({ read: () => { throw new Error('kaputt'); }, write: () => {}, getRecordingRoot: () => '/rec' });
  assert.equal(broken.get().maxParallel, 2);
});
