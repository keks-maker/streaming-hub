'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBackup, validateBackup } = require('../lib/backup.js');

const valid = {
  services: [{ id: 'youtube', name: 'YouTube', url: 'https://youtube.com' }],
  tvsources: [{ id: 'tv', name: 'TV', url: 'https://example.test/list.m3u' }],
  history: [],
};

test('validates a complete backup', () => {
  assert.equal(validateBackup(valid).ok, true);
  assert.deepEqual(parseBackup(JSON.stringify(valid)), valid);
});

test('rejects malformed backup collections before writing', () => {
  assert.throws(() => parseBackup(JSON.stringify({ services: {}, tvsources: [] })), /services und tvsources/);
  assert.throws(() => parseBackup(JSON.stringify({ ...valid, history: {} })), /ungültigen Verlauf/);
  assert.throws(() => parseBackup(JSON.stringify({ ...valid, services: [{ id: 1 }] })), /ungültigen Dienst/);
});

test('rejects private and unsupported backup URLs', () => {
  assert.throws(
    () =>
      parseBackup(JSON.stringify({ ...valid, services: [{ ...valid.services[0], url: 'http://127.0.0.1/admin' }] })),
    /ungültige URL-Daten/,
  );
  assert.throws(
    () =>
      parseBackup(JSON.stringify({ ...valid, tvsources: [{ ...valid.tvsources[0], epgUrl: 'file:///etc/passwd' }] })),
    /ungültige URL-Daten/,
  );
});

test('accepts legacy tvsources key and normalizes it', () => {
  const result = parseBackup(JSON.stringify(valid));
  assert.deepEqual(result.tvsources, valid.tvsources);
  assert.deepEqual(result.history, []);
});
