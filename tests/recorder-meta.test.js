'use strict';

// Tests: Metadaten-Schema (Konzept §5) + Recorder-Pfade (Konzept §3.4)
// Karte t_17ee2ca5 (Aufnahme Phase 1b)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RECORDING_STATUSES,
  makeRecordingId,
  normalizeMeta,
  assertTransition,
  safeNamePart,
  buildRecordingFilename,
  withCollisionSuffix,
} = require('../lib/recorder/meta.js');
const {
  defaultRecordingsRoot,
  validateStorageRoot,
  jobDir,
  libraryDir,
} = require('../lib/recorder/paths.js');

test('Metadaten-Status-Maschine: erlaubte Übergänge (Konzept §5)', () => {
  assert.equal(assertTransition('recording', 'remux-pending'), true);
  assert.equal(assertTransition('recording', 'failed'), true);
  assert.equal(assertTransition('recording', 'aborted'), true);
  assert.equal(assertTransition('remux-pending', 'completed'), true);
  assert.equal(assertTransition('remux-pending', 'failed'), true);
  assert.equal(assertTransition('failed', 'completed'), true); // nachholender Remux
  // F-FB-08 (t_9372a4b3): Hard-Kill-Hinterlassenschaft (aborted + Zwischenform)
  // wird in der Recovery nachträglich remuxt → completed.
  assert.equal(assertTransition('aborted', 'completed'), true); // Recovery-Remux
});

test('Metadaten-Status-Maschine: verbotene Übergänge werfen', () => {
  assert.throws(() => assertTransition('completed', 'remux-pending'));
  assert.throws(() => assertTransition('aborted', 'failed'));
  assert.throws(() => assertTransition('aborted', 'recording'));
  assert.throws(() => assertTransition('aborted', 'remux-pending'));
  assert.throws(() => assertTransition('remux-pending', 'recording'));
  assert.throws(() => assertTransition('unbekannt', 'completed'));
  assert.ok(RECORDING_STATUSES.includes('remux-pending'));
});

test('makeRecordingId erzeugt eindeutige, schema-konforme IDs', () => {
  const a = makeRecordingId(new Date('2026-09-30T20:15:00+02:00'));
  const b = makeRecordingId(new Date('2026-09-30T20:15:01+02:00'));
  assert.match(a, /^rec_\d{8}_[a-z0-9]+-[a-z0-9]+$/);
  assert.notEqual(a, b);
  assert.match(a, /^rec_20260930_/); // lokale Zeit des Date-Objekts
});

test('normalizeMeta normiert auf das §5-Schema und lehnt Müll ab', () => {
  const meta = normalizeMeta({
    id: 'rec_20260930_x-y',
    channelId: 'das-erste',
    channelName: '  Das Erste  ',
    epgTitle: 'Tagesschau',
    startedAt: '2026-09-30T20:15:00+02:00',
    status: 'recording',
    sourceUrl: 'https://example.com/live.m3u8',
    extraFeld: 'wird verworfen',
  });
  assert.equal(meta.channelName, 'Das Erste');
  assert.equal(meta.epgDescription, null);
  assert.equal(meta.durationSec, null);
  assert.equal(meta.fileSizeBytes, null);
  assert.equal(meta.status, 'recording');
  assert.equal(meta.remuxInterrupted, false);
  assert.ok(!('extraFeld' in meta));
  assert.throws(() => normalizeMeta(null));
  assert.throws(() => normalizeMeta({}));
  assert.throws(() => normalizeMeta({ id: 'kein-schema', status: 'recording' }));
});

test('normalizeMeta: unbekannter Status fällt auf failed', () => {
  const meta = normalizeMeta({ id: 'rec_ok', status: 'kaputt' });
  assert.equal(meta.status, 'failed');
});

test('safeNamePart entfernt dateisystem-gefährliche Zeichen', () => {
  assert.equal(safeNamePart('Das Erste'), 'Das Erste');
  assert.equal(safeNamePart('A/B:C*D?'), 'ABCD');
  assert.equal(safeNamePart('  mehrere   Leerzeichen '), 'mehrere Leerzeichen');
  assert.equal(safeNamePart(''), 'Unbenannt');
  assert.equal(safeNamePart(null), 'Unbenannt');
  assert.equal(safeNamePart('Steuer\u0000zeichen\u001f'), 'Steuer zeichen');
});

test('buildRecordingFilename: Schema <Kanal>_<Titel>_<YYYY-MM-DD_HHMM>.mp4', () => {
  // Naiver Zeitstempel (ohne Offset) wird als lokale Zeit geparst und mit
  // lokalen Gettern wieder formatiert → Round-Trip in jeder TZ deterministisch.
  const name = buildRecordingFilename(
    { channelName: 'Das Erste', epgTitle: 'Tagesschau', startedAt: '2026-09-30T20:15:00' },
    new Date('2026-09-30T20:15:00'),
  );
  assert.match(name, /^Das Erste_Tagesschau_\d{4}-\d{2}-\d{2}_\d{4}\.mp4$/);
  assert.equal(name, 'Das Erste_Tagesschau_2026-09-30_2015.mp4');
});

test('buildRecordingFilename: ohne startedAt wird now genutzt, ohne Titel Aufnahme', () => {
  const name = buildRecordingFilename({ channelName: 'ZDF' }, new Date('2026-01-05T07:09:00'));
  assert.equal(name, 'ZDF_Aufnahme_2026-01-05_0709.mp4');
});

test('withCollisionSuffix: Suffix -2/-3 vor der Extension', () => {
  assert.equal(withCollisionSuffix('Das Erste_Tagesschau_2026-09-30_2015.mp4', 2), 'Das Erste_Tagesschau_2026-09-30_2015-2.mp4');
  assert.equal(withCollisionSuffix('X.mp4', 3), 'X-3.mp4');
  assert.throws(() => withCollisionSuffix('X.mp4', 1)); // Basisname ist Suffix 1
});

// ── paths.js ──

test('defaultRecordingsRoot: ~/Videos/Streaming Hub', () => {
  assert.equal(defaultRecordingsRoot('/home/test'), path.join('/home/test', 'Videos', 'Streaming Hub'));
});

test('validateStorageRoot: legt fehlendes Verzeichnis an und meldet Platz', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-paths-')), 'Videos', 'Streaming Hub');
  const result = validateStorageRoot(root);
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(root));
  assert.ok(result.freeBytes === null || result.freeBytes > 0);
});

test('validateStorageRoot: lehnt Datei als Speicherort ab', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-paths-')), 'datei.txt');
  fs.writeFileSync(file, 'x');
  const result = validateStorageRoot(file);
  assert.equal(result.ok, false);
  assert.match(result.error, /kein Verzeichnis/);
});

test('validateStorageRoot: lehnt leere/ungültige Eingabe ab', () => {
  assert.equal(validateStorageRoot('').ok, false);
  assert.equal(validateStorageRoot(null).ok, false);
  assert.equal(validateStorageRoot('   ').ok, false);
});

test('validateStorageRoot: schreibgeschützter Ort wird abgelehnt', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-paths-ro-'));
  const root = path.join(base, 'locked');
  fs.mkdirSync(root);
  fs.chmodSync(root, 0o500);
  try {
    const result = validateStorageRoot(root);
    if (process.getuid && process.getuid() === 0) {
      assert.equal(result.ok, true); // root ignoriert Dateirechte
    } else {
      assert.equal(result.ok, false);
      assert.match(result.error, /beschreibbar/);
    }
  } finally {
    fs.chmodSync(root, 0o700);
  }
});

test('jobDir/libraryDir: Verzeichnislayout <root>/Aufnahmen/<recId>', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-paths-layout-'));
  const dir = jobDir(root, 'rec_20260930_a-b');
  assert.equal(dir, path.join(root, 'Aufnahmen', 'rec_20260930_a-b'));
  assert.ok(fs.existsSync(dir));
  const lib = libraryDir(root);
  assert.equal(lib, path.join(root, 'Aufnahmen'));
  assert.ok(fs.existsSync(lib));
  assert.throws(() => jobDir(root, '../../etc'));
});
