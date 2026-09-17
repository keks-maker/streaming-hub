'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserStorage } = require('../lib/user-storage.js');

function makeStorage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-storage-'));
  const bundle = path.join(root, 'bundle');
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(bundle);
  return { root, storage: createUserStorage({ userDataPath: userData, bundlePath: bundle }), bundle, userData };
}

test('reads bundled defaults without writing into the bundle', () => {
  const fixture = makeStorage();
  fs.writeFileSync(path.join(fixture.bundle, 'services.json'), '[{"id":"default"}]');
  assert.deepEqual(fixture.storage.readJson('services', []), [{ id: 'default' }]);
  assert.equal(fs.existsSync(path.join(fixture.userData, 'services.json')), false);
  assert.equal(fs.readFileSync(path.join(fixture.bundle, 'services.json'), 'utf8'), '[{"id":"default"}]');
});

test('writes user data atomically below the user-data directory', () => {
  const fixture = makeStorage();
  fixture.storage.writeJson('history', [{ title: 'Test' }]);
  assert.deepEqual(fixture.storage.readJson('history', []), [{ title: 'Test' }]);
  assert.deepEqual(fs.readdirSync(fixture.userData), ['history.json']);
});

test('reports malformed user data instead of silently overwriting it', () => {
  const fixture = makeStorage();
  fs.mkdirSync(fixture.userData, { recursive: true });
  fs.writeFileSync(path.join(fixture.userData, 'services.json'), '{broken');
  assert.throws(() => fixture.storage.readJson('services', []), /services konnte nicht gelesen werden/);
});

test('batch restores all files or rolls back', () => {
  const fixture = makeStorage();
  fixture.storage.writeJsonBatch({ services: [{ id: 'old' }], history: [{ title: 'old' }] });
  const original = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    if (++calls === 4) throw new Error('simulated failure');
    return original(...args);
  };
  try {
    assert.throws(
      () => fixture.storage.writeJsonBatch({ services: [{ id: 'new' }], history: [{ title: 'new' }] }),
      /Backup konnte nicht gespeichert werden/,
    );
  } finally {
    fs.renameSync = original;
  }
  assert.deepEqual(fixture.storage.readJson('services', []), [{ id: 'old' }]);
  assert.deepEqual(fixture.storage.readJson('history', []), [{ title: 'old' }]);
  assert.equal(fs.readdirSync(fixture.userData).some(name => name.endsWith('.tmp') || name.endsWith('.bak')), false);
});
