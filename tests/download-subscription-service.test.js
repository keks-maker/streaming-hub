'use strict';

// Tests: SubscriptionService (Serien-Abos): Anlegen mit Baseline, Prüfung (neue Folgen, Obergrenze, Duplikate, Region, Offline,
// Fehler, Platzreserve, Speicherort), gebündelte Benachrichtigung und Scheduler (Start verzögert, Intervall, Offline-Wiederholung,
// Einstellungen) mit Fake-Timern. Kein Netz, kein Dateisystem, keine echten Downloads.

const test = require('node:test');
const assert = require('node:assert/strict');
const { SubscriptionService, MESSAGES, START_DELAY_MS, OFFLINE_RETRY_MS } = require('../lib/download/subscriptions/SubscriptionService.js');

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-20T12:00:00Z');

const SERIES = { id: 'SER1', title: 'Testserie', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/SER1?embedded=true' };
const SERIES2 = { ...SERIES, id: 'SER2', title: 'Zweite Serie', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/SER2?embedded=true' };

const entry = (id, over = {}) => ({ id, title: `Folge ${id}`, sourceId: 'ard', season: 1, episode: Number(id.replace(/\D/g, '')) || 1, airedAt: null, availableUntil: null, regionRestricted: false, originalVersionId: null, audioDescriptionId: null, ...over });

function fakeClock() {
  const clock = { now: T0, timers: [], seq: 0 };
  clock.setTimer = (fn, ms) => {
    const timer = { fn, at: clock.now + ms, id: (clock.seq += 1), unref() {} };
    clock.timers.push(timer);
    return timer;
  };
  clock.clearTimer = timer => {
    clock.timers = clock.timers.filter(item => item !== timer);
  };
  /** Zeit vorstellen und fällige Timer nacheinander ausführen (mit Mikrotask-Pausen für asynchrone Prüfungen). */
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
  };
  clock.advance = async ms => {
    const target = clock.now + ms;
    await settle(); // laufende asynchrone Prüfungen erst bis zu ihrem nächsten Timer kommen lassen
    for (;;) {
      const due = clock.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.timers = clock.timers.filter(timer => timer !== due);
      clock.now = Math.max(clock.now, due.at);
      due.fn();
      await settle();
    }
    clock.now = target;
  };
  return clock;
}

function setup(over = {}) {
  const clock = fakeClock();
  const saved = [];
  const notes = [];
  const calls = { fetch: [], enqueue: [] };
  const state = {
    episodes: { SER1: [entry('E1'), entry('E2'), entry('E3')], SER2: [entry('F1')] },
    fetchError: null,
    duplicates: new Set(),
    space: { freeBytes: 100e9, reserveBytes: 1e9, low: false },
    enqueueFail: null,
    downloadViews: [],
  };
  const settings = { autoDownloadEnabled: true, autoCheckIntervalHours: 6, maxPerCheck: 10, notifyOnDone: true, ...over.settings };
  const service = new SubscriptionService({
    store: { load: () => over.stored || [], save: list => saved.push(list.map(sub => ({ ...sub, knownEntryIds: [...sub.knownEntryIds] }))) },
    mediathek: {
      fetchEpisodes: async series => {
        calls.fetch.push(series.id);
        if (state.fetchError) throw state.fetchError;
        return state.episodes[series.id] || [];
      },
    },
    downloads: {
      findDuplicate: e => (state.duplicates.has(e.id) ? { id: 'dl_x' } : null),
      spaceStatus: () => state.space,
      list: () => state.downloadViews,
      enqueueMany: input => {
        calls.enqueue.push({ series: input.series.id, ids: input.entries.map(e => e.id), overrides: input.overrides });
        if (state.enqueueFail) return { ok: false, code: 'storage', message: state.enqueueFail, results: [], added: 0 };
        return { ok: true, results: input.entries.map(e => ({ entryId: e.id, ok: true, id: `dl_${e.id}` })), added: input.entries.length };
      },
    },
    getSettings: () => settings,
    notifier: { notify: (title, body) => notes.push({ title, body }) },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    gapMs: 0,
    ...over.options,
  });
  return { service, clock, saved, notes, calls, state, settings };
}

const only = list => list.items[0];

test('add (Standard „künftige Folgen“): vorhandene Folgen gelten als bekannt, nichts wird geladen', async () => {
  const { service, calls, saved } = setup();
  service.start();
  const result = await service.add({ series: SERIES });
  assert.equal(result.ok, true);
  assert.equal(calls.enqueue.length, 0);
  assert.deepEqual(saved.at(-1)[0].knownEntryIds, ['E1', 'E2', 'E3']);
  assert.equal(service.list().items.length, 1);
  assert.equal(service.isSubscribed('ard', 'SER1'), true);
});

test('add: doppeltes Abo wird abgelehnt; Fehler beim Holen der Folgen legt kein Abo an', async () => {
  const { service, state } = setup();
  service.start();
  assert.equal((await service.add({ series: SERIES })).ok, true);
  assert.equal((await service.add({ series: SERIES })).code, 'exists');
  state.fetchError = Object.assign(new Error('offline'), { code: 'network' });
  const failed = await service.add({ series: SERIES2 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'network');
  assert.equal(service.list().items.length, 1);
});

test('add mit Optionen: Überschreibungen werden bereinigt gespeichert und beim Einreihen übergeben', async () => {
  const { service, state, calls } = setup();
  service.start();
  const added = await service.add({ series: SERIES, overrides: { maxHeight: '720', evil: 'x' } });
  assert.deepEqual(added.item.overrides, { maxHeight: '720' });
  state.episodes.SER1.push(entry('E4'));
  await service.checkNow();
  assert.deepEqual(calls.enqueue[0], { series: 'SER1', ids: ['E4'], overrides: { maxHeight: '720' } });
});

test('Prüfung: neue Folge wird eingereiht, als bekannt vermerkt und einmal gemeldet; Wiederholung lädt nichts doppelt', async () => {
  const { service, state, calls, notes } = setup();
  service.start();
  await service.add({ series: SERIES });
  state.episodes.SER1.push(entry('E4'));
  const result = await service.checkNow();
  assert.deepEqual(result, { ok: true, checked: 1, added: 1 });
  assert.deepEqual(calls.enqueue.map(c => c.ids), [['E4']]);
  assert.equal(only(service.list()).lastResult.status, 'ok');
  assert.match(only(service.list()).lastResult.message, /1 neue Folge wird geladen/);
  assert.deepEqual(notes, [{ title: 'Neue Folgen', body: '1 neue Folge von Testserie wird geladen.' }]);
  await service.checkNow();
  assert.equal(calls.enqueue.length, 1);
  assert.equal(notes.length, 1);
  assert.equal(only(service.list()).lastResult.message, MESSAGES.none);
});

test('Benachrichtigung: gebündelt je Prüfung (nie je Folge); mehrere Serien -> eine Meldung; aus mit notifyOnDone=false', async () => {
  const { service, state, notes, settings } = setup();
  service.start();
  await service.add({ series: SERIES });
  await service.add({ series: SERIES2 });
  state.episodes.SER1.push(entry('E4'), entry('E5'), entry('E6'));
  state.episodes.SER2.push(entry('F2'));
  await service.checkNow();
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^4 neue Folgen aus 2 Serien werden geladen: /);
  settings.notifyOnDone = false;
  state.episodes.SER1.push(entry('E7'));
  await service.checkNow();
  assert.equal(notes.length, 1);
});

test('Obergrenze je Prüfung: Rest folgt bei der nächsten Prüfung', async () => {
  const { service, state, calls, settings } = setup();
  service.start();
  await service.add({ series: SERIES });
  settings.maxPerCheck = 2;
  for (let i = 4; i <= 8; i += 1) state.episodes.SER1.push(entry(`E${i}`));
  await service.checkNow();
  assert.deepEqual(calls.enqueue[0].ids, ['E4', 'E5']);
  assert.match(only(service.list()).lastResult.message, /3 weitere folgen bei der nächsten Prüfung/);
  assert.equal(only(service.list()).lastResult.pending, 3);
  await service.checkNow();
  assert.deepEqual(calls.enqueue[1].ids, ['E6', 'E7']);
  await service.checkNow();
  assert.deepEqual(calls.enqueue[2].ids, ['E8']);
});

test('Duplikate: Folgen im Download-Index werden nicht erneut eingereiht', async () => {
  const { service, state, calls } = setup();
  service.start();
  await service.add({ series: SERIES });
  state.episodes.SER1.push(entry('E4'), entry('E5'));
  state.duplicates.add('E4');
  await service.checkNow();
  assert.deepEqual(calls.enqueue[0].ids, ['E5']);
  state.duplicates.clear();
  await service.checkNow();
  assert.equal(calls.enqueue.length, 1, 'E4 gilt als bekannt');
});

test('Region: gesperrte Folge wird nicht eingereiht, Hinweis im Abo, keine Wiederholung', async () => {
  const { service, state, calls } = setup();
  service.start();
  await service.add({ series: SERIES });
  state.episodes.SER1.push(entry('E4', { regionRestricted: true }));
  await service.checkNow();
  assert.equal(calls.enqueue.length, 0);
  assert.equal(only(service.list()).lastResult.note, '1 Folge in deiner Region nicht abrufbar');
  await service.checkNow();
  assert.equal(calls.enqueue.length, 0);
});

test('Hinweis aus gescheiterten Downloads der Serie (Geo, DRM, nicht mehr verfügbar) steht in der Ansicht', async () => {
  const { service, state } = setup();
  service.start();
  await service.add({ series: SERIES });
  const view = (errorCode, seriesId = 'SER1') => ({ status: 'failed', errorCode, seriesId, sourceId: 'ard' });
  state.downloadViews = [view('geo'), view('geo'), view('unsupported'), view('expired'), view('unavailable'), view('geo', 'ANDERE'), { ...view('network') }];
  assert.equal(only(service.list()).note, '2 Folgen in deiner Region nicht abrufbar, 1 Folge nicht unterstützt (z. B. DRM), 2 Folgen nicht mehr verfügbar');
});

test('Offline: leise, kein Dauer-Fehler; lastCheckAt bleibt; Wiederholung nach 30 Minuten, keine Meldung', async () => {
  const { service, state, clock, notes } = setup();
  service.start();
  await service.add({ series: SERIES });
  const before = only(service.list()).lastCheckAt;
  state.fetchError = Object.assign(new Error('x'), { code: 'network' });
  const result = await service.checkNow();
  assert.equal(result.ok, true);
  const sub = only(service.list());
  assert.equal(sub.lastResult.status, 'offline');
  assert.equal(sub.lastResult.message, MESSAGES.offline);
  assert.equal(sub.lastCheckAt, before);
  assert.equal(notes.length, 0);
  assert.equal(service.nextCheckAt, clock.now + OFFLINE_RETRY_MS);
  // Netz ist zurück: die Wiederholung findet die neue Folge
  state.fetchError = null;
  state.episodes.SER1.push(entry('E4'));
  await clock.advance(OFFLINE_RETRY_MS);
  assert.equal(only(service.list()).lastResult.status, 'ok');
  assert.equal(notes.length, 1);
});

test('Server-Fehler 503 zählt als vorübergehend, 404 als dauerhafter Fehler (regulärer Abstand)', async () => {
  const { service, state, clock } = setup();
  service.start();
  await service.add({ series: SERIES });
  state.fetchError = Object.assign(new Error('x'), { code: 'http', status: 503 });
  await service.checkNow();
  assert.equal(only(service.list()).lastResult.status, 'offline');
  state.fetchError = Object.assign(new Error('x'), { code: 'http', status: 404 });
  await service.checkNow();
  assert.equal(only(service.list()).lastResult.status, 'error');
  assert.equal(only(service.list()).lastResult.message, MESSAGES.error);
  assert.equal(service.nextCheckAt, clock.now + 6 * HOUR);
});

test('Platzreserve: bei zu wenig Platz wird nichts eingereiht (Hinweis), danach holt die nächste Prüfung alles nach', async () => {
  const { service, state, calls } = setup();
  service.start();
  await service.add({ series: SERIES });
  state.episodes.SER1.push(entry('E4'));
  state.space = { freeBytes: 0.5e9, reserveBytes: 1e9, low: true };
  await service.checkNow();
  assert.equal(calls.enqueue.length, 0);
  assert.equal(only(service.list()).lastResult.status, 'space');
  assert.equal(only(service.list()).lastResult.pending, 1);
  assert.equal(only(service.list()).lastResult.message, MESSAGES.space);
  state.space = { freeBytes: 50e9, reserveBytes: 1e9, low: false };
  await service.checkNow();
  assert.deepEqual(calls.enqueue[0].ids, ['E4']);
  assert.equal(only(service.list()).lastResult.status, 'ok');
});

test('Speicherort nicht nutzbar: Hinweis, Folgen bleiben für die nächste Prüfung unbekannt', async () => {
  const { service, state, calls } = setup();
  service.start();
  await service.add({ series: SERIES });
  state.episodes.SER1.push(entry('E4'));
  state.enqueueFail = 'Speicherort nicht nutzbar: weg';
  await service.checkNow();
  assert.equal(only(service.list()).lastResult.status, 'storage');
  assert.equal(only(service.list()).lastResult.message, 'Speicherort nicht nutzbar: weg');
  state.enqueueFail = null;
  await service.checkNow();
  assert.deepEqual(calls.enqueue.at(-1).ids, ['E4']);
});

test('add mode „all“: alle Folgen sind neu und werden sofort (verzögerungsfrei) bis zur Obergrenze geladen', async () => {
  const { service, clock, calls, settings } = setup();
  service.start();
  settings.maxPerCheck = 2;
  const added = await service.add({ series: SERIES, mode: 'all' });
  assert.equal(added.ok, true);
  await clock.advance(0);
  assert.deepEqual(calls.enqueue[0].ids, ['E1', 'E2']);
});

test('checkNow: ausgeschaltet, unbekannt, beschäftigt', async () => {
  const { service, settings, state } = setup();
  service.start();
  const added = await service.add({ series: SERIES });
  settings.autoDownloadEnabled = false;
  assert.equal((await service.checkNow()).code, 'disabled');
  settings.autoDownloadEnabled = true;
  assert.equal((await service.checkNow('sub_nope0001')).code, 'unknown');
  let release;
  state.episodes.SER1 = new Promise(resolve => {
    release = resolve;
  });
  service.mediathek.fetchEpisodes = async () => state.episodes.SER1;
  const first = service.checkNow(added.item.id);
  assert.equal((await service.checkNow()).code, 'busy');
  assert.equal(service.list().checking, true);
  release([entry('E1')]);
  await first;
  assert.equal(service.list().checking, false);
});

test('Pausierte Abos werden nicht geprüft; update/remove speichern und melden Änderungen', async () => {
  const { service, saved, calls } = setup();
  service.start();
  const added = await service.add({ series: SERIES });
  const events = [];
  service.on('changed', payload => events.push(payload));
  assert.equal(service.update(added.item.id, { enabled: false }).ok, true);
  assert.equal((await service.checkNow()).checked, 0);
  assert.equal(calls.fetch.length, 1, 'nur der Abruf beim Anlegen');
  assert.equal(service.update(added.item.id, { overrides: { maxHeight: '540', evil: 1 } }).item.overrides.maxHeight, '540');
  assert.equal(saved.at(-1)[0].enabled, false);
  assert.equal(service.update('sub_nope0001', { enabled: true }).code, 'unknown');
  assert.equal(service.remove(added.item.id).ok, true);
  assert.equal(service.remove(added.item.id).code, 'unknown');
  assert.equal(service.list().items.length, 0);
  assert.ok(events.length >= 3);
});

// ── Scheduler ──

test('Scheduler: erste Prüfung verzögert nach dem Start, danach im eingestellten Intervall; stop() hält alles an', async () => {
  const { service, clock, calls, state } = setup({ stored: [{ id: 'sub_abcd1234', sourceId: 'ard', seriesId: 'SER1', title: 'Testserie', imageUrl: null, description: null, groupingURL: SERIES.groupingURL, createdAt: '2026-10-20T10:00:00.000Z', knownEntryIds: ['E1', 'E2', 'E3'], lastCheckAt: null, lastResult: null, overrides: {}, enabled: true }] });
  service.start();
  assert.equal(service.nextCheckAt, T0 + START_DELAY_MS);
  await clock.advance(START_DELAY_MS - 1);
  assert.equal(calls.fetch.length, 0, 'blockiert den Start nicht');
  await clock.advance(1);
  assert.equal(calls.fetch.length, 1);
  assert.equal(service.nextCheckAt, clock.now + 6 * HOUR);
  state.episodes.SER1.push(entry('E4'));
  await clock.advance(6 * HOUR);
  assert.equal(calls.fetch.length, 2);
  assert.deepEqual(calls.enqueue.map(c => c.ids), [['E4']]);
  service.stop();
  assert.equal(clock.timers.length, 0);
  await clock.advance(24 * HOUR);
  assert.equal(calls.fetch.length, 2);
});

test('Scheduler: ohne aktive Abos oder bei ausgeschaltetem Laden ruht der Timer; reschedule übernimmt Einstellungen', async () => {
  const stored = [{ id: 'sub_abcd1234', sourceId: 'ard', seriesId: 'SER1', title: 'Testserie', groupingURL: SERIES.groupingURL, createdAt: '2026-10-20T10:00:00.000Z', knownEntryIds: ['E1', 'E2', 'E3'], enabled: true }];
  const { service, clock, settings, calls } = setup({ stored });
  service.start();
  assert.equal(clock.timers.length, 1);
  settings.autoCheckIntervalHours = 2;
  service.reschedule();
  assert.equal(service.nextCheckAt, T0 + START_DELAY_MS, 'die kürzere Wartezeit bleibt');
  await clock.advance(START_DELAY_MS);
  assert.equal(service.nextCheckAt, clock.now + 2 * HOUR);
  settings.autoDownloadEnabled = false;
  service.reschedule();
  assert.equal(clock.timers.length, 0);
  assert.equal(service.list().enabled, false);
  assert.equal(service.nextCheckAt, null);
  settings.autoDownloadEnabled = true;
  service.update('sub_abcd1234', { enabled: false });
  assert.equal(clock.timers.length, 0, 'kein aktives Abo');
  service.update('sub_abcd1234', { enabled: true });
  assert.equal(clock.timers.length, 1);
  assert.equal(calls.fetch.length, 1);
});

test('Scheduler: läuft der Timer bei ausgeschaltetem Laden ab, wird nicht geprüft', async () => {
  const stored = [{ id: 'sub_abcd1234', sourceId: 'ard', seriesId: 'SER1', title: 'Testserie', groupingURL: SERIES.groupingURL, createdAt: '2026-10-20T10:00:00.000Z', knownEntryIds: [], enabled: true }];
  const { service, clock, settings, calls } = setup({ stored });
  service.start();
  settings.autoDownloadEnabled = false;
  await clock.advance(START_DELAY_MS);
  assert.equal(calls.fetch.length, 0);
  assert.equal(clock.timers.length, 0);
});

test('Serien werden nacheinander und mit Pause geprüft; ohne Netz bricht der Durchlauf nach der ersten Serie ab', async () => {
  const stored = ['SER1', 'SER2'].map((id, index) => ({ id: `sub_abcd123${index}`, sourceId: 'ard', seriesId: id, title: id, groupingURL: `https://api.ardmediathek.de/page-gateway/pages/ard/grouping/${id}?embedded=true`, createdAt: `2026-10-20T10:0${index}:00.000Z`, knownEntryIds: [], enabled: true }));
  const { service, clock, calls, state } = setup({ stored, options: { gapMs: 2000 } });
  service.start();
  const running = service.checkNow();
  await clock.advance(0);
  assert.equal(calls.fetch.length, 1, 'zweite Serie erst nach der Pause');
  await clock.advance(2000);
  await running;
  assert.equal(calls.fetch.length, 2);
  state.fetchError = Object.assign(new Error('x'), { code: 'network' });
  const offline = service.checkNow();
  await clock.advance(0);
  await offline;
  assert.equal(calls.fetch.length, 3, 'nur eine weitere Anfrage, dann Abbruch');
});

test('DownloadService.spaceStatus: unter der Reserve ist „low“, laufende Aufnahmen verdoppeln die Reserve, unbekannter Platz ist nie „low“', () => {
  const { DownloadService } = require('../lib/download/DownloadService.js');
  const make = (freeBytes, recording = 0) =>
    new DownloadService({ store: { load: () => [], save() {} }, resolver: {}, getSettings: () => ({ storageRoot: null }), getRecordingRoot: () => '/nonexistent-root', getReserveBytes: () => 1000, getRecordingActive: () => recording, freeBytes: () => freeBytes });
  assert.deepEqual(make(5000).spaceStatus(), { freeBytes: 5000, reserveBytes: 1000, low: false });
  assert.equal(make(900).spaceStatus().low, true);
  assert.equal(make(1500, 1).spaceStatus().low, true);
  assert.equal(make(null).spaceStatus().low, false);
});
