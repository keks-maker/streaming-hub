'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalHookAllowed } = require('../lib/test-hook-gate.js');

const F = 'STREAMING_HUB_EPG_IMAGE_LOCAL';

test('Hook wirkt nur mit userData-Hook, Flag 1 und ohne Paketierung', () => {
  assert.equal(isLocalHookAllowed({ STREAMING_HUB_USER_DATA: '/tmp/x', [F]: '1' }, false, F), true);
});

test('paketierte App ignoriert den Hook', () => {
  assert.equal(isLocalHookAllowed({ STREAMING_HUB_USER_DATA: '/tmp/x', [F]: '1' }, true, F), false);
});

test('ohne userData oder mit anderem Flag-Wert kein Hook', () => {
  assert.equal(isLocalHookAllowed({ [F]: '1' }, false, F), false);
  assert.equal(isLocalHookAllowed({ STREAMING_HUB_USER_DATA: '/tmp/x' }, false, F), false);
  assert.equal(isLocalHookAllowed({ STREAMING_HUB_USER_DATA: '/tmp/x', [F]: '0' }, false, F), false);
  assert.equal(isLocalHookAllowed(undefined, false, F), false);
});
