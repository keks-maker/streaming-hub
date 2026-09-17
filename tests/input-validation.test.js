'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { httpUrl, parseBackup, service, tvSource } = {
  ...require('../lib/input-validation.js'),
  parseBackup: require('../lib/backup.js').parseBackup,
};

test('accepts HTTP(S) URLs and rejects executable schemes', () => {
  assert.equal(httpUrl('https://example.test/list.m3u', 'URL'), 'https://example.test/list.m3u');
  assert.throws(() => httpUrl('file:///etc/passwd', 'URL'), /HTTP oder HTTPS/);
  assert.throws(() => httpUrl('javascript:alert(1)', 'URL'), /HTTP oder HTTPS/);
  assert.throws(() => httpUrl('https://user:pass@example.test', 'URL'), /Zugangsdaten/);
});

test('normalizes and validates service and TV source inputs', () => {
  assert.deepEqual(service({ name: ' YouTube ', url: 'https://youtube.com', icon: 'youtube.png' }), {
    name: 'YouTube',
    url: 'https://youtube.com/',
    icon: 'youtube.png',
    color: undefined,
    group: undefined,
  });
  assert.equal(tvSource({ name: 'TV', url: 'https://example.test/a.m3u' }).url, 'https://example.test/a.m3u');
  assert.throws(() => service({ name: '<script>', url: 'file:///tmp/x' }), /Dienst-URL/);
  assert.throws(() => tvSource({ name: 'TV', url: 'file:///etc/passwd' }), /M3U-URL/);
});

test('backup parser remains available for boundary tests', () => {
  assert.throws(() => parseBackup('{}'), /services und tvsources/);
});
