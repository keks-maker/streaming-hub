'use strict';

// Tests: UI-Modell der Serien-Abos (mediathek-subscriptions-model.js): Store mit Ereignissen, Beschriftungen der Ansicht „Abos“,
// Meldungen der Aktionen, Einstellungen (Felder und Hinweise zu begrenzten Werten) und Dialog-Hilfen.

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../mediathek-subscriptions-model.js');
const settingsModel = require('../settings-mediathek-downloads-model.js');
const { changedOverrides, startForm } = require('../mediathek-subscription-dialogs-view.js');
const dl = require('../lib/download/download-settings.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const SERIES = { id: 'SER1', title: 'Serie', sourceId: 'ard' };

const view = (over = {}) => ({ id: 'sub_abcd1234', sourceId: 'ard', seriesId: 'SER1', title: 'Serie', imageUrl: null, series: SERIES, enabled: true, createdAt: '2026-10-20T10:00:00.000Z', lastCheckAt: null, lastResult: null, overrides: {}, knownCount: 3, note: null, ...over });
const payload = (over = {}) => ({ ok: true, items: [view()], checking: false, enabled: true, intervalHours: 6, nextCheckAt: new Date(NOW + 3 * 3600 * 1000).toISOString(), ...over });

test('relativeTime/untilTime: Beschriftungen', () => {
  assert.equal(m.relativeTime(new Date(NOW - 20000).toISOString(), NOW), 'gerade eben');
  assert.equal(m.relativeTime(new Date(NOW - 5 * 60000).toISOString(), NOW), 'vor 5 Min.');
  assert.equal(m.relativeTime(new Date(NOW - 3 * 3600000).toISOString(), NOW), 'vor 3 Std.');
  assert.equal(m.relativeTime('2026-10-01T10:00:00Z', NOW), '01.10.2026, 12:00 Uhr');
  assert.equal(m.relativeTime(null, NOW), null);
  assert.equal(m.untilTime(new Date(NOW + 30000).toISOString(), NOW), 'in Kürze');
  assert.equal(m.untilTime(new Date(NOW + 20 * 60000).toISOString(), NOW), 'in 20 Min.');
  assert.equal(m.untilTime(new Date(NOW + 3 * 3600000).toISOString(), NOW), 'in 3 Std.');
  assert.equal(m.untilTime('x', NOW), null);
});

test('overridesSummary: Standard oder die abweichenden Optionen', () => {
  assert.equal(m.overridesSummary({}), 'Standard (globale Download-Einstellungen)');
  assert.equal(m.overridesSummary({ maxHeight: '720', container: 'mkv', audioMode: 'all', subtitleMode: 'none' }), 'Bis 720p, MKV, alle Tonspuren, ohne Untertitel');
  assert.equal(m.overridesSummary({ audioDescription: 'additional' }), 'mit Audiodeskription');
});

test('describeSubscription: Ergebnis, Ton, Hinweise, Pause und globaler Schalter', () => {
  const fresh = m.describeSubscription(view(), { nowMs: NOW });
  assert.equal(fresh.checkedText, 'Zuletzt geprüft: noch nie');
  assert.equal(fresh.resultText, 'Noch nicht geprüft.');
  const ok = m.describeSubscription(view({ lastCheckAt: new Date(NOW - 600000).toISOString(), lastResult: { status: 'ok', message: '2 neue Folgen werden geladen.', note: 'Hinweis A' }, note: 'Hinweis B' }), { nowMs: NOW });
  assert.equal(ok.checkedText, 'Zuletzt geprüft: vor 10 Min.');
  assert.equal(ok.resultText, '2 neue Folgen werden geladen.');
  assert.deepEqual(ok.notes, ['Hinweis A', 'Hinweis B']);
  assert.equal(m.describeSubscription(view({ lastResult: { status: 'offline', message: 'x' } })).tone, 'warn');
  assert.equal(m.describeSubscription(view({ lastResult: { status: 'storage', message: 'x' } })).tone, 'error');
  const paused = m.describeSubscription(view({ enabled: false }));
  assert.equal(paused.enabled, false);
  assert.match(paused.resultText, /Pausiert/);
  assert.match(m.describeSubscription(view(), { globalEnabled: false }).notes[0], /ausgeschaltet/);
});

test('headline: ausgeschaltet, prüft gerade, keine aktiven, nächste Prüfung', () => {
  assert.match(m.headline({ ...payload({ enabled: false }) }, { nowMs: NOW }), /ausgeschaltet/);
  assert.match(m.headline(payload({ checking: true }), { nowMs: NOW }), /gerade geprüft/);
  assert.equal(m.headline(payload({ items: [view({ enabled: false })] }), { nowMs: NOW }), 'Keine aktiven Abos.');
  assert.equal(m.headline(payload(), { nowMs: NOW }), '1 aktives Abo · Prüfung alle 6 Stunden · nächste in 3 Std. · Die App muss dafür laufen');
  assert.match(m.headline(payload({ intervalHours: 1, items: [view(), view({ id: 'sub_zzzz9999' })] }), { nowMs: NOW }), /2 aktive Abos · Prüfung jede Stunde/);
});

test('Meldungen der Aktionen', () => {
  assert.equal(m.addResultText({ ok: true }, 'Serie'), 'Neue Folgen von Serie werden automatisch geladen.');
  assert.equal(m.addResultText({ ok: false, message: 'Kein Netz' }, 'Serie'), 'Das Abo konnte nicht angelegt werden: Kein Netz');
  assert.equal(m.checkResultText({ ok: true, checked: 1, added: 0 }), 'Keine neuen Folgen.');
  assert.equal(m.checkResultText({ ok: true, checked: 3, added: 0 }), '3 Abos geprüft, keine neuen Folgen.');
  assert.equal(m.checkResultText({ ok: true, checked: 3, added: 1 }), '1 neue Folge wird geladen.');
  assert.equal(m.checkResultText({ ok: true, checked: 3, added: 4 }), '4 neue Folgen werden geladen.');
  assert.equal(m.checkResultText({ ok: false, message: 'Es läuft bereits eine Prüfung.' }), 'Prüfung nicht möglich: Es läuft bereits eine Prüfung.');
});

test('Store: Laden, Ereignis, Suche nach Serie, Aktionen werfen nie', async () => {
  const calls = [];
  const api = {
    list: async () => payload(),
    add: async input => (calls.push(['add', input]), { ok: true }),
    update: async input => (calls.push(['update', input]), { ok: true }),
    remove: async id => (calls.push(['remove', id]), { ok: true }),
    checkNow: async id => (calls.push(['checkNow', id]), { ok: true, checked: 1, added: 0 }),
  };
  const store = m.createSubscriptionsStore({ api });
  let changes = 0;
  store.subscribe(() => (changes += 1));
  assert.equal(store.snapshot().loaded, false);
  await store.load();
  assert.equal(store.snapshot().loaded, true);
  assert.equal(store.isSubscribed(SERIES), true);
  assert.equal(store.isSubscribed({ id: 'SER1', sourceId: 'zdf' }), false);
  assert.equal(store.find(SERIES).id, 'sub_abcd1234');
  assert.equal(store.activeCount(), 1);
  store.applyEvent(payload({ items: [], checking: true }));
  assert.equal(store.isSubscribed(SERIES), false);
  assert.equal(store.snapshot().checking, true);
  assert.equal(changes, 2);
  await store.add({ series: SERIES });
  await store.update({ id: 'x', enabled: false });
  await store.remove('x');
  await store.checkNow();
  assert.deepEqual(calls.map(c => c[0]), ['add', 'update', 'remove', 'checkNow']);
  const broken = m.createSubscriptionsStore({ api: { list: async () => { throw new Error('kaputt'); }, add: async () => { throw new Error('nein'); } } });
  await broken.load();
  assert.equal(broken.snapshot().error, 'kaputt');
  assert.deepEqual(await broken.add({}), { ok: false, error: 'nein', code: 'error' });
});

test('Store: eine ältere Ladeantwort überschreibt kein neueres Ereignis', async () => {
  let release;
  const store = m.createSubscriptionsStore({ api: { list: () => new Promise(resolve => (release = resolve)) } });
  const loading = store.load();
  store.applyEvent(payload({ items: [view({ title: 'Neu' })] }));
  release(payload({ items: [view({ title: 'Alt' })] }));
  await loading;
  assert.equal(store.all()[0].title, 'Neu');
});

test('Einstellungen: Felder für Abos auf der Steuerungsseite, Hinweise bei begrenzten Werten', () => {
  const keys = settingsModel.PAGES.control.fields.map(item => item.key);
  for (const key of ['autoDownloadEnabled', 'autoCheckIntervalHours', 'maxPerCheck']) assert.ok(keys.includes(key), key);
  const result = dl.applyDownloadSettingsPatch({}, { autoCheckIntervalHours: 99, maxPerCheck: 0 });
  const messages = settingsModel.clampMessages({ ...result.settings, clamped: result.clamped });
  assert.equal(result.settings.autoCheckIntervalHours, 24);
  assert.equal(result.settings.maxPerCheck, 1);
  assert.equal(messages.autoCheckIntervalHours, 'Auf 24 Stunden begrenzt (erlaubt: 1 bis 24).');
  assert.equal(messages.maxPerCheck, 'Auf 1 begrenzt (erlaubt: 1 bis 100).');
});

test('Dialog-Hilfen: Optionen weichen nur ab, wenn sie von den globalen Einstellungen abweichen', () => {
  const settings = { maxHeight: 'best', container: 'mp4', audioMode: 'preferred', audioLanguages: ['deu'], audioDescription: 'never', subtitleMode: 'preferred', subtitleLanguage: 'deu', subtitleDelivery: 'embedded' };
  const form = startForm(settings, { maxHeight: '720' });
  assert.equal(form.maxHeight, '720');
  assert.equal(form.container, 'mp4');
  assert.deepEqual(changedOverrides(settings, form), { maxHeight: '720' });
  assert.deepEqual(changedOverrides(settings, startForm(settings, {})), {});
  form.audioLanguages = ['eng', 'deu'];
  assert.deepEqual(changedOverrides(settings, form), { maxHeight: '720', audioLanguages: ['eng', 'deu'] });
});

test('Standard-Einstellungen für Abos', () => {
  const s = dl.normalizeDownloadSettings({}).settings;
  assert.equal(s.autoDownloadEnabled, true);
  assert.equal(s.autoCheckIntervalHours, 6);
  assert.equal(s.maxPerCheck, 10);
  assert.equal(dl.normalizeDownloadSettings({ autoDownloadEnabled: 'ja' }).settings.autoDownloadEnabled, true);
});
