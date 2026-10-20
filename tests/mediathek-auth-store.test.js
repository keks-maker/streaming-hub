'use strict';

// Tests: Konten-Speicher (store.js): nur verschlüsselt (safeStorage gemockt), atomares Schreiben, ohne Verschlüsselung nur im
// Arbeitsspeicher, nie Klartext auf der Platte, Abmelden entfernt den Datensatz.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthStore } = require('../lib/mediathek/auth/store.js');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: text => Buffer.from(`ENC:${Buffer.from(text, 'utf8').reverse().toString('latin1')}`, 'latin1'),
    decryptString: buffer => Buffer.from(buffer.toString('latin1').slice(4), 'latin1').reverse().toString('utf8'),
  };
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-auth-'));
  return { dir, file: path.join(dir, 'mediathek-auth.bin') };
}

const RECORD = { accessToken: 'ACCESS-SECRET', refreshToken: 'REFRESH-SECRET', expiresAt: 2000000000000, since: 1700000000000, state: 'ok', clientId: 'web' };

test('Speichern: Datei enthält weder Token noch PIN im Klartext, Neuladen liefert die Werte', () => {
  const { dir, file } = tmpFile();
  try {
    const safeStorage = fakeSafeStorage();
    const store = createAuthStore({ file, safeStorage });
    assert.equal(store.persistent, true);
    store.set('arte', RECORD);
    store.setPin('4711');
    store.setPinEnabled(true);
    const raw = fs.readFileSync(file, 'utf8');
    for (const secret of ['ACCESS-SECRET', 'REFRESH-SECRET', '4711', 'accessToken']) assert.ok(!raw.includes(secret), `Klartext ${secret}`);
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'nur Besitzer');
    const again = createAuthStore({ file, safeStorage });
    assert.deepEqual(again.get('arte'), RECORD);
    assert.equal(again.getPin(), '4711');
    assert.equal(again.getPinEnabled(), true);
    assert.deepEqual(fs.readdirSync(dir), ['mediathek-auth.bin'], 'keine Temp-Reste');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Ohne safeStorage: nichts auf der Platte, Werte nur im Arbeitsspeicher', () => {
  for (const safeStorage of [null, fakeSafeStorage(false)]) {
    const { dir, file } = tmpFile();
    try {
      const store = createAuthStore({ file, safeStorage });
      assert.equal(store.persistent, false);
      store.set('ard', RECORD);
      store.setPin('1234');
      assert.equal(store.get('ard').accessToken, 'ACCESS-SECRET');
      assert.deepEqual(fs.readdirSync(dir), [], 'keine Datei');
      assert.equal(createAuthStore({ file, safeStorage }).get('ard'), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Abmelden entfernt den Datensatz, die leere Datei wird gelöscht', () => {
  const { dir, file } = tmpFile();
  try {
    const safeStorage = fakeSafeStorage();
    const store = createAuthStore({ file, safeStorage });
    store.set('arte', RECORD);
    store.set('ard', { ...RECORD, clientId: null });
    store.remove('arte');
    assert.equal(createAuthStore({ file, safeStorage }).get('arte'), null);
    assert.ok(createAuthStore({ file, safeStorage }).get('ard'));
    store.remove('ard');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Beschädigte oder fremd verschlüsselte Datei: abgemeldet, kein Absturz, Log ohne Inhalt', () => {
  const { dir, file } = tmpFile();
  try {
    const warnings = [];
    fs.writeFileSync(file, '{"v":1,"enc":"%%%"}');
    const store = createAuthStore({ file, safeStorage: fakeSafeStorage(), logger: { warn: (...args) => warnings.push(args.join(' ')) } });
    assert.equal(store.get('arte'), null);
    fs.writeFileSync(file, 'kein json');
    assert.equal(createAuthStore({ file, safeStorage: fakeSafeStorage() }).get('ard'), null);
    assert.ok(warnings.length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Validierung: unbekannter Sender, ungültiger Datensatz, ungültige PIN', () => {
  const store = createAuthStore({ file: null, safeStorage: null });
  assert.throws(() => store.set('zdf', RECORD), /Unbekannter Sender/);
  assert.throws(() => store.set('arte', { accessToken: '' }), /Ungültig/);
  assert.throws(() => store.setPin('12a4'), /vier Ziffern/);
  assert.throws(() => store.setPin('123'), /vier Ziffern/);
});

test('Schreibfehler: kein Absturz, Temp-Datei aufgeräumt, Warnung ohne Token', () => {
  const { dir, file } = tmpFile();
  try {
    const warnings = [];
    const failingFs = { ...fs, renameSync: () => { throw new Error('EACCES ACCESS-SECRET'); } };
    const store = createAuthStore({ file, safeStorage: fakeSafeStorage(), fs: failingFs, logger: { warn: m => warnings.push(m) } });
    store.set('arte', RECORD);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('SECRET'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Verschlüsselungsfehler beim Speichern: kein Absturz, nichts auf der Platte, Warnung ohne Werte, Werte bleiben im Speicher', () => {
  const { dir, file } = tmpFile();
  try {
    const warnings = [];
    const storage = { ...fakeSafeStorage(), encryptString: () => { throw new Error('keychain locked ACCESS-SECRET'); } };
    const store = createAuthStore({ file, safeStorage: storage, logger: { warn: m => warnings.push(m) } });
    assert.doesNotThrow(() => store.set('arte', RECORD));
    assert.doesNotThrow(() => store.setPin('1234'));
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(m => !m.includes('SECRET') && !m.includes('1234')));
    assert.equal(store.get('arte').accessToken, 'ACCESS-SECRET');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
