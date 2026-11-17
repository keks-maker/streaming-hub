const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SETTINGS_NAV, DEFAULT_PAGE, isValidPage, resolvePage } = require('../settings-view.js');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('resolvePage: gewünscht > gemerkt > Allgemein', () => {
  assert.equal(resolvePage('streaming', 'mediathek-sources'), 'streaming');
  assert.equal(resolvePage(undefined, 'mediathek-sources'), 'mediathek-sources');
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
    'backupBtn', 'restoreBtn', 'settingsTvChannelsList', 'settingsTvChannelsSearch', 'settingsTvChannelsViewFav', 'settingsEpgRefreshBtn',
    'recPathInput', 'recPathPickBtn', 'recPathSaveBtn', 'recPathResetBtn', 'recPathHint', 'recPathWarn',
    'recFfmpegStatus', 'settingsAddDienstBtn', 'settingsAddForm', 'settingsServiceListStreaming',
    'settingsServiceListMediathek', 'settingsStatus', 'settingsTvSourceList', 'settingsTvSourceAdd',
    'settingsEpgSourceList', 'settingsEpgStatus',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `${id} fehlt`);
  }
  assert.equal(indexHtml.split('name="tvMode"').length - 1, 2);
});

test('Seitenleiste: Gruppen mit Überschrift, Einträge ohne Gruppenpräfix, Seiten-IDs unverändert', () => {
  assert.deepEqual(SETTINGS_NAV.map(g => g.label), ['Allgemein', 'LiveTV', 'Radio', 'Podcasts', 'Streaming', 'Mediatheken']);
  for (const group of SETTINGS_NAV) {
    assert.ok(Array.isArray(group.children) && group.children.length >= 1, `${group.label} hat Einträge`);
    for (const child of group.children) {
      assert.ok(!child.label.startsWith(`${group.label}:`), `${child.label} ohne Gruppenpräfix`);
    }
  }
  const pages = SETTINGS_NAV.flatMap(g => g.children.map(c => c.page));
  assert.deepEqual(pages.slice(0, 6), ['general', 'livetv-sources', 'livetv-channels', 'livetv-epg', 'livetv-playback', 'livetv-recordings']);
  for (const page of ['radio-stations', 'podcast-subs', 'streaming', 'mediathek-sources', 'mediathek-dl-notes']) assert.ok(pages.includes(page), page);
});

test('Seitentitel im Markup tragen keine Gruppenpräfixe mehr', () => {
  assert.doesNotMatch(indexHtml, /settings-page-title">(LiveTV|Radio|Podcasts|Mediatheken): /);
});
