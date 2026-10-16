// Unit-Tests: eindeutige Mach-O-UUID fuer das Mac-Paket (scripts/macho-uuid.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveUuid, setMachoUuid, applyUniqueUuids } = require('../scripts/macho-uuid.js');

function fakeMacho(uuidByte) {
  // Header (32 Byte) + LC_BUILD_VERSION-Platzhalter (16 Byte) + LC_UUID (24 Byte)
  const b = Buffer.alloc(32 + 16 + 24);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(2, 16);
  b.writeUInt32LE(0x32, 32);
  b.writeUInt32LE(16, 36);
  b.writeUInt32LE(0x1b, 48);
  b.writeUInt32LE(24, 52);
  b.fill(uuidByte, 56, 72);
  return b;
}

test('deriveUuid ist stabil, 16 Byte und seedabhaengig', () => {
  assert.strictEqual(deriveUuid('a').length, 16);
  assert.ok(deriveUuid('a').equals(deriveUuid('a')));
  assert.ok(!deriveUuid('a').equals(deriveUuid('b')));
});

test('setMachoUuid ersetzt LC_UUID, zweiter Lauf aendert nichts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uuid-'));
  const f = path.join(dir, 'bin');
  fs.writeFileSync(f, fakeMacho(7));
  const u = deriveUuid('x');
  assert.strictEqual(setMachoUuid(f, u), true);
  assert.ok(fs.readFileSync(f).subarray(56, 72).equals(u));
  assert.strictEqual(setMachoUuid(f, u), false);
});

test('setMachoUuid lehnt Nicht-Mach-O ab', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uuid-'));
  const f = path.join(dir, 'txt');
  fs.writeFileSync(f, Buffer.alloc(80, 1));
  assert.throws(() => setMachoUuid(f, deriveUuid('x')), /thin 64-Bit-Mach-O/);
});

test('applyUniqueUuids setzt Hauptprogramm und Helper unterschiedlich', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'uuid-app-'));
  const main = path.join(app, 'Contents', 'MacOS', 'Hub');
  const helper = path.join(app, 'Contents', 'Frameworks', 'Hub Helper.app', 'Contents', 'MacOS', 'Hub Helper');
  for (const f of [main, helper]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, fakeMacho(7));
  }
  fs.mkdirSync(path.join(app, 'Contents', 'Frameworks', 'X.framework'));
  assert.strictEqual(applyUniqueUuids(app, 'Hub', 'com.test').length, 2);
  assert.ok(!fs.readFileSync(main).subarray(56, 72).equals(fs.readFileSync(helper).subarray(56, 72)));
});
