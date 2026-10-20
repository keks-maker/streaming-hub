'use strict';

// Tests: Download-Ansicht-Modell (Warteschlange/Bibliothek, Beschriftungen, Zustand je Folge, Store, Indikator).

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../mediathek-downloads-model.js');
const { downloadIcon } = require('../mediathek-download-icons.js');

const view = (over = {}) => ({
  id: 'dl_a1b2c3', key: 'ard:E1', sourceId: 'ard', entryId: 'E1', title: 'Folge 1', seriesTitle: 'Serie', seriesId: 'S', season: 1, episode: 2, imageUrl: null,
  status: 'queued', error: null, errorCode: null, progress: { percent: null, bytes: null, totalBytes: null, speed: null, etaSec: null }, estimatedBytes: null, fileSize: null,
  durationSec: 1800, availableUntil: null, sourceExpired: false, retryAt: null, container: 'mp4', createdAt: '2026-10-20T10:00:00.000Z', finishedAt: null, watchedAt: null, fileMissing: false, warnings: [], ...over,
});

test('Formate: Größe, Tempo, Restzeit, Datum (deutsch, Berliner Zeit)', () => {
  assert.equal(m.formatBytes(1234567890), '1,2 GB');
  assert.equal(m.formatBytes(340e6), '340 MB');
  assert.equal(m.formatBytes(12e3), '12 kB');
  assert.equal(m.formatBytes(null), null);
  assert.equal(m.formatBytes(-1), null);
  assert.equal(m.formatSpeed(3.2e6), '3,2 MB/s');
  assert.equal(m.formatSpeed(0), null);
  assert.equal(m.formatEta(30), 'noch 30 Sek.');
  assert.equal(m.formatEta(240), 'noch 4 Min.');
  assert.equal(m.formatEta(3900), 'noch 1 Std. 5 Min.');
  assert.equal(m.formatEta(NaN), null);
  assert.equal(m.formatDateTime('2026-10-20T20:00:00Z'), '20.10.2026, 22:00 Uhr');
  assert.equal(m.formatDateTime('kaputt'), null);
});

test('Warteschlange: laufende zuerst, dann wartend, zurückgestellt, angehalten, Fehler; Fertige gehören in die Bibliothek', () => {
  const items = [
    view({ id: 'dl_f', status: 'failed', createdAt: '2026-10-20T09:00:00Z' }),
    view({ id: 'dl_q2', status: 'queued', createdAt: '2026-10-20T10:05:00Z' }),
    view({ id: 'dl_d', status: 'downloading', createdAt: '2026-10-20T10:10:00Z' }),
    view({ id: 'dl_q1', status: 'queued', createdAt: '2026-10-20T10:00:00Z' }),
    view({ id: 'dl_p', status: 'paused' }),
    view({ id: 'dl_s', status: 'scheduled' }),
    view({ id: 'dl_ok', status: 'done', finishedAt: '2026-10-20T11:00:00Z' }),
    view({ id: 'dl_ok2', status: 'done', finishedAt: '2026-10-20T12:00:00Z' }),
  ];
  assert.deepEqual(m.queueItems(items).map(item => item.id), ['dl_d', 'dl_q1', 'dl_q2', 'dl_s', 'dl_p', 'dl_f']);
  assert.deepEqual(m.libraryItems(items).map(item => item.id), ['dl_ok2', 'dl_ok']);
});

test('Zeile der Warteschlange: Fortschritt, Tempo, Restzeit; Fehler und Freigabezeit als Meldung', () => {
  const running = m.describeQueueItem(view({ status: 'downloading', progress: { percent: 42.4, bytes: 420e6, totalBytes: 1e9, speed: 3.2e6, etaSec: 240 } }));
  assert.equal(running.percent, 42);
  assert.equal(running.detail, '42 % · 3,2 MB/s · noch 4 Min. · 420 MB von 1 GB');
  assert.deepEqual(running.actions, ['pause', 'cancel']);
  assert.equal(running.subtitle, 'Serie · Staffel 1 · Folge 2 · ARD');
  const unknown = m.describeQueueItem(view({ status: 'downloading' }));
  assert.equal(unknown.indeterminate, true);
  assert.equal(unknown.percent, null);
  const failed = m.describeQueueItem(view({ status: 'failed', error: 'Quelle nicht erreichbar.' }));
  assert.equal(failed.message, 'Quelle nicht erreichbar.');
  assert.equal(failed.tone, 'error');
  assert.deepEqual(failed.actions, ['retry', 'remove']);
  const scheduled = m.describeQueueItem(view({ status: 'scheduled', error: 'Altersfreigabe ab 22 Uhr.', retryAt: '2026-10-20T20:00:00Z' }));
  assert.equal(scheduled.message, 'Altersfreigabe ab 22 Uhr. Start automatisch ab 20.10.2026, 22:00 Uhr.');
  assert.equal(scheduled.tone, 'warn');
  assert.deepEqual(m.describeQueueItem(view({ status: 'paused', progress: { percent: 10 } })).actions, ['resume', 'cancel']);
  assert.equal(m.describeQueueItem(view({ status: 'queued', estimatedBytes: 5e8 })).detail, 'ca. 500 MB');
});

test('Zeile der Bibliothek: Größe, Datum, „Quelle läuft ab am“, abgelaufen, Gesehen, fehlende Datei', () => {
  const info = m.describeLibraryItem(
    view({ status: 'done', fileSize: 1.5e9, finishedAt: '2026-10-20T11:00:00Z', availableUntil: '2026-12-01T00:00:00Z', watched: true }),
    { nowMs: Date.parse('2026-10-21T00:00:00Z') },
  );
  assert.deepEqual(info.meta, ['1,5 GB', 'geladen am 20.10.2026', 'Quelle läuft ab am 01.12.2026']);
  assert.equal(info.watched, true);
  assert.deepEqual(info.actions, ['play', 'reveal', 'remove']);
  const expired = m.describeLibraryItem(view({ status: 'done', availableUntil: '2026-10-01T00:00:00Z', sourceExpired: true }), { nowMs: Date.parse('2026-10-21T00:00:00Z') });
  assert.ok(expired.meta.includes('Quelle abgelaufen am 01.10.2026'));
  assert.equal(expired.expired, true);
  const missing = m.describeLibraryItem(view({ status: 'done', fileMissing: true }));
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.actions, ['remove']);
  assert.equal(m.describeLibraryItem(view({ status: 'done', watchedAt: '2026-10-20T11:00:00Z' })).watched, true);
});

test('Summenzeile mit freiem Platz; leer', () => {
  assert.equal(m.summaryLine({ active: 1, queued: 2, done: 3, failed: 1 }, 50e9), '1 lädt · 2 wartend · 1 fehlgeschlagen · 3 fertig · Frei: 50 GB');
  assert.equal(m.summaryLine({ active: 2 }, null), '2 laden');
  assert.equal(m.summaryLine({}, 1.2e9), 'Keine Downloads · Frei: 1,2 GB');
});

test('Zustand → Symbol: nicht geladen, Warteschlange, läuft x %, fertig, Fehler (abgebrochen = wieder ladbar)', () => {
  const state = status => m.stateOfView(view({ status, progress: { percent: 37.6 } })).state;
  assert.equal(m.stateOfView(null).state, 'none');
  assert.equal(state('queued'), 'queued');
  assert.equal(state('downloading'), 'running');
  assert.equal(state('resolving'), 'running');
  assert.equal(state('paused'), 'paused');
  assert.equal(state('scheduled'), 'scheduled');
  assert.equal(state('done'), 'done');
  assert.equal(state('failed'), 'failed');
  assert.equal(state('canceled'), 'none');
  assert.equal(m.stateOfView(view({ status: 'downloading', progress: { percent: 37.6 } })).percent, 38);
  assert.equal(m.stateOfView(view({ status: 'done', fileMissing: true })).state, 'none');
  assert.equal(m.stateLabel({ state: 'running', percent: 38 }), 'Wird geladen, 38 Prozent');
  assert.equal(m.stateLabel({ state: 'done', percent: null }), 'Heruntergeladen');
  assert.equal(m.stateLabel({ state: 'none', percent: null }), 'Herunterladen');
});

test('Symbole: jedes Zustandssymbol ist ein SVG, der Ring trägt den Fortschritt', () => {
  for (const state of ['none', 'queued', 'running', 'paused', 'scheduled', 'done', 'failed']) assert.match(downloadIcon(state, 50), /^<svg /, state);
  assert.match(downloadIcon('running', 50), /stroke-dasharray="25\.14 50\.27"/);
  assert.match(downloadIcon('running', null), /is-spinning/);
  assert.equal(downloadIcon('unbekannt'), downloadIcon('none'));
});

test('entryState: Schlüssel quelle:id, OV-/AD-Variante zählt als dieselbe Folge, bester Treffer gewinnt', () => {
  const entry = { id: 'E1', sourceId: 'ard', originalVersionId: 'E1-ov' };
  assert.equal(m.entryState(entry, []).state, 'none');
  assert.equal(m.entryState(entry, [view({ key: 'ard:E1', status: 'queued' })]).state, 'queued');
  assert.equal(m.entryState(entry, [view({ key: 'ard:E1-ov', status: 'done' })]).state, 'done');
  assert.equal(m.entryState(entry, [view({ key: 'zdf:E1', status: 'done' })]).state, 'none', 'andere Quelle');
  assert.equal(m.entryState(entry, [view({ id: 'dl_a', key: 'ard:E1', status: 'failed' }), view({ id: 'dl_b', key: 'ard:E1', status: 'downloading' })]).state, 'running');
});

test('Store: Laden, Ereignisse (Änderung/Entfernen/Summe), veraltete Ladeantwort, Zähler', async () => {
  let resolveList;
  const calls = [];
  const api = {
    list: () => new Promise(resolve => (resolveList = resolve)),
    pause: async id => (calls.push(['pause', id]), { ok: true }),
    remove: async (id, options) => (calls.push(['remove', id, options]), { ok: true }),
    cancel: async () => {
      throw new Error('kaputt');
    },
  };
  const store = m.createDownloadsStore({ api });
  let changes = 0;
  store.subscribe(() => (changes += 1));
  const loading = store.load();
  // Ereignis kommt vor der Ladeantwort an: die ältere Antwort darf es nicht überschreiben
  store.applyEvent({ items: [view({ id: 'dl_new', key: 'ard:N', status: 'downloading' })], removed: [], summary: { active: 1 } });
  resolveList({ ok: true, items: [view({ id: 'dl_old', status: 'queued' })], summary: { queued: 1 }, freeBytes: 5e10, root: '/r' });
  await loading;
  assert.deepEqual(store.all().map(item => item.id), ['dl_new']);
  assert.equal(store.activeCount(), 1);
  assert.equal(store.runningCount(), 1);
  const second = store.load();
  resolveList({ ok: true, items: [view({ id: 'dl_a', status: 'done', seriesId: 'S', finishedAt: '2026-10-20T10:00:00Z' }), view({ id: 'dl_b', key: 'ard:E2', status: 'queued', seriesId: 'S' })], summary: { done: 1, queued: 1 }, freeBytes: 5e10, root: '/r' });
  await second;
  assert.equal(store.snapshot().freeBytes, 5e10);
  assert.equal(store.downloadedCount({ id: 'S', sourceId: 'ard' }), 1);
  assert.equal(store.downloadedCount({ id: 'X', sourceId: 'ard' }), 0);
  assert.equal(store.activeCount(), 1);
  assert.equal(store.runningCount(), 0);
  store.applyEvent({ items: [], removed: ['dl_a'], summary: { queued: 1 } });
  assert.deepEqual(store.library(), []);
  assert.deepEqual(store.snapshot().summary, { queued: 1 });
  assert.deepEqual(await store.pause('dl_b'), { ok: true });
  assert.deepEqual(await store.remove('dl_b', { deleteFile: true }), { ok: true });
  assert.deepEqual(calls, [['pause', 'dl_b'], ['remove', 'dl_b', { deleteFile: true }]]);
  const failed = await store.cancel('dl_b');
  assert.equal(failed.ok, false, 'IPC-Fehler werden zu { ok: false }, nicht zur Ausnahme');
  assert.equal(changes, 3, "Ereignis, zweite Ladeantwort, Entfernen; die veraltete Antwort löst nichts aus");
});

test('Store: Ladefehler wird sichtbar gemacht', async () => {
  const store = m.createDownloadsStore({ api: { list: async () => ({ ok: false, message: 'Downloads nicht verfügbar' }) } });
  await store.load();
  assert.equal(store.snapshot().loaded, true);
  assert.equal(store.snapshot().error, 'Downloads nicht verfügbar');
});

test('Indikator-Beschriftung für die Navigationsleiste', () => {
  assert.equal(m.indicatorLabel(0, 0), null);
  assert.equal(m.indicatorLabel(1, 1), 'Ein Download läuft');
  assert.equal(m.indicatorLabel(3, 2), '3 Downloads laufen');
  assert.equal(m.indicatorLabel(2, 0), '2 Downloads warten');
});
