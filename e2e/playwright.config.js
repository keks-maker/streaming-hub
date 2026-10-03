'use strict';

// Playwright-Konfiguration für den E2E-Smoke-Test (Electron, kein Browser-Download).
// Start: `npm run test:e2e`. Läuft bewusst NICHT in `npm test`.
const path = require('path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  outputDir: path.join(__dirname, '..', 'test-results'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Eine Electron-Instanz zur Zeit: gemeinsamer GPU-/Widevine-Zustand, kein Parallelstart.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
