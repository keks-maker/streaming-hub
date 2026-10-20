'use strict';

// Tests: Verdrahtung der Mediathek-Oberfläche (renderer.js, index.html, settings-view.js) – Muster epg-view-wiring.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isValidPage } = require('../settings-view.js');
const { normalizeRoute, persistableRoute } = require('../mediathek-hub-view.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Jede Stelle, die den Podcast-Bereich verlässt, verlässt auch den Mediathek-Bereich', () => {
  const renderer = read('renderer.js');
  const podcast = (renderer.match(/podcastHub\.hideArea\(\)/g) || []).length;
  const mediathek = (renderer.match(/mediathekHub\.hideArea\(\)/g) || []).length;
  assert.ok(mediathek >= podcast - 1, `podcastHub.hideArea ${podcast}x, mediathekHub.hideArea ${mediathek}x (renderDashboard blendet bedingt aus)`);
  assert.match(renderer, /mediathekHub\.showArea\(opts\.route\)/);
  assert.match(renderer, /mediathekHub\.getRoute\(\)/, 'Navigationsstapel speichert die Mediathek-Route');
});

test('Dashboard und Einstellungen: Container und Unterseiten sind vorhanden', () => {
  const html = read('index.html');
  assert.match(html, /id="mediathekDashboard"/);
  for (const page of ['mediathek-sources', 'mediathek-playback']) {
    assert.match(html, new RegExp(`data-settings-page="${page}"`));
    assert.ok(isValidPage(page), page);
  }
  assert.match(html, /id="settingsServiceListMediathek"/, 'Weblink-Verwaltung bleibt');
  assert.match(html, /id="settingsAddMediathekBtn"/);
});

test('Downloads-Chip ist vorgesehen, aber ausgeblendet', () => {
  const { DOWNLOADS_CHIP_ENABLED } = require('../mediathek-hub-model.js');
  assert.equal(DOWNLOADS_CHIP_ENABLED, false);
});

test('Route: Serie und Genre überstehen die Wiederherstellung, Unbekanntes führt zur Startansicht', () => {
  const series = { id: 's', title: 'T', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/g' };
  assert.deepEqual(normalizeRoute({ view: 'series', series }).series, series);
  assert.equal(normalizeRoute({ view: 'series', series: { id: 's' } }).view, 'home');
  assert.equal(normalizeRoute({ view: 'genre', genre: { id: 'DOR', title: 'Dokus', sourceId: 'arte' } }).genre.title, 'Dokus');
  assert.equal(normalizeRoute({ view: 'genre', genre: {} }).view, 'home');
  assert.equal(normalizeRoute('x').view, 'home');
  assert.equal(normalizeRoute(null).view, 'home');
  assert.equal(persistableRoute({ view: 'home' }), null);
  assert.equal(persistableRoute({ view: 'series', series }).view, 'series');
});
