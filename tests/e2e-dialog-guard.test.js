'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isIsolatedTestRun, showErrorBoxGuarded } = require('../lib/e2e-dialog-guard.js');

const mk = () => {
  const shown = [];
  const logs = [];
  return {
    shown,
    logs,
    dialog: { showErrorBox: (t, c) => shown.push([t, c]) },
    logger: { warn: m => logs.push(m) },
  };
};

test('Testlauf: Dialog unterdrückt, geloggt und gezählt', () => {
  const m = mk();
  const store = {};
  const r = showErrorBoxGuarded({ dialog: m.dialog, env: { STREAMING_HUB_USER_DATA: '/x' }, logger: m.logger, store }, 'T', 'C');
  assert.equal(r, true);
  assert.equal(m.shown.length, 0);
  assert.equal(m.logs.length, 1);
  assert.deepEqual(store.suppressedDialogs, [{ title: 'T', content: 'C' }]);
});

test('Produktion: Dialog wird angezeigt', () => {
  const m = mk();
  const r = showErrorBoxGuarded({ dialog: m.dialog, env: {}, logger: m.logger, store: {} }, 'T', 'C');
  assert.equal(r, false);
  assert.deepEqual(m.shown, [['T', 'C']]);
  assert.equal(isIsolatedTestRun(undefined), false);
});
