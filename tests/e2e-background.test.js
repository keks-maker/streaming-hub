'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBackgroundE2E, revealWindow } = require('../lib/e2e-background.js');

function fakeWin() {
  const calls = [];
  return { calls, show: () => calls.push('show'), focus: () => calls.push('focus'), showInactive: () => calls.push('showInactive') };
}

test('Hook nur zusammen mit STREAMING_HUB_USER_DATA wirksam', () => {
  assert.equal(isBackgroundE2E({ STREAMING_HUB_E2E_BACKGROUND: '1' }), false);
  assert.equal(isBackgroundE2E({ STREAMING_HUB_USER_DATA: '/tmp/x' }), false);
  assert.equal(isBackgroundE2E({ STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '0' }), false);
  assert.equal(isBackgroundE2E({ STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '1' }), true);
  assert.equal(isBackgroundE2E(undefined), false);
});

test('revealWindow: Produktion show+focus, Hook showInactive ohne focus', () => {
  const prod = fakeWin();
  revealWindow(prod, { STREAMING_HUB_E2E_BACKGROUND: '1' });
  assert.deepEqual(prod.calls, ['show', 'focus']);
  const hook = fakeWin();
  revealWindow(hook, { STREAMING_HUB_USER_DATA: '/tmp/x', STREAMING_HUB_E2E_BACKGROUND: '1' });
  assert.deepEqual(hook.calls, ['showInactive']);
});
