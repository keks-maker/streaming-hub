const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SETTINGS_NAV, DEFAULT_PAGE, isValidPage, resolvePage } = require('../settings-view.js');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('resolvePage: gewünscht > gemerkt > Allgemein', () => {
  assert.equal(resolvePage('streaming', 'mediathek'), 'streaming');
  assert.equal(resolvePage(undefined, 'mediathek'), 'mediathek');
  assert.equal(resolvePage('unbekannt', 'unsinn'), DEFAULT_PAGE);
  assert.equal(resolvePage(), 'general');
});

test('Jede Seite der Navigation hat genau ein Seiten-Element im Markup', () => {
  const pages = SETTINGS_NAV.flatMap(e => e.children || [e]).map(e => e.page);
  assert.ok(pages.length >= 8);
  for (const page of pages) {
    assert.ok(isValidPage(page));
    const count = indexHtml.split(`data-settings-page="${page}"`).length - 1;
    assert.equal(count, 1, `Seite ${page} muss genau einmal vorkommen`);
  }
});

test('Bestehende Einstellungs-IDs bleiben erhalten', () => {
  for (const id of [
    'backupBtn', 'restoreBtn', 'settingsTvSourcesBtn', 'settingsTvChannelsBtn', 'settingsEpgRefreshBtn',
    'recPathInput', 'recPathPickBtn', 'recPathSaveBtn', 'recPathResetBtn', 'recPathHint', 'recPathWarn',
    'recFfmpegStatus', 'settingsAddDienstBtn', 'settingsAddForm', 'settingsServiceListStreaming',
    'settingsServiceListMediathek', 'settingsStatus',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `${id} fehlt`);
  }
  assert.equal(indexHtml.split('name="tvMode"').length - 1, 2);
});
