// Unit-Test: macOS-Info.plist-Zusätze (Freigabe "Lokales Netzwerk" für Dienste im Heimnetz).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('build.mac.extendInfo enthält NSLocalNetworkUsageDescription', () => {
  const info = pkg.build.mac.extendInfo;
  assert.equal(typeof info.NSLocalNetworkUsageDescription, 'string');
  assert.ok(info.NSLocalNetworkUsageDescription.length > 10);
});
