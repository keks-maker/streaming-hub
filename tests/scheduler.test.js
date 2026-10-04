'use strict';

// Uhrzeit-Texte („ab 20:07“) sind lokale Zeit: für reproduzierbare Läufe fest auf Berlin.
process.env.TZ = 'Europe/Berlin';

// Tests: Scheduler-Zeitlogik mit injizierter Uhr (Etappe 2a; Konzept §3.4/§5):
// Start bei Vorlauf, Stopp via stopAt, Spätstart an/aus, Missed, Resume nach
// Standby, Platzmangel, Kanal fehlt, Engine-Fehler, kein stilles Wiederholen,
// Soft-Limit, Persistenz/Neustart, Anlegen/Ändern/Absagen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduleStore } = require('../lib/recorder/ScheduleStore.js');
const { Scheduler } = require('../lib/recorder/Scheduler.js');
const { MIN, makeClock, FakeRecorder, makeScheduler, input } = require('./helpers/schedule-fakes.js');

const T = iso => Date.parse(iso);

test('Start bei now ≥ epgStart − Vorlauf; stopAt = epgStop + Nachlauf; frische URL; EPG-Text übergeben', async () => {
  const { scheduler, recorder, clock, store, resolveCalls } = makeScheduler();
  const added = scheduler.addEntry(input());
  assert.equal(added.ok, true);
  assert.equal(added.entry.bufferBeforeSec, 120, 'Default-Vorlauf aus den Settings');
  assert.equal(added.entry.bufferAfterSec, 300);

  // 19:57:59 → noch zu früh (Start 19:58:00)
  clock.set('2026-10-05T19:57:59+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 0);

  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 1);
  const { request, force } = recorder.startCalls[0];
  assert.equal(request.sourceUrl, 'https://fresh.example/das-erste.m3u8', 'URL frisch aufgelöst, nicht der Snapshot');
  assert.equal(request.stopAt, T('2026-10-05T20:20:00+02:00'), 'stopAt = epgStop + Nachlauf');
  assert.equal(request.epgTitle, 'Tagesschau');
  assert.equal(request.epgDescription, 'Nachrichten');
  assert.equal(request.channelId, 'das-erste');
  assert.equal(force, false);
  assert.equal(resolveCalls.length, 1);
  const e = store.get(added.entry.id);
  assert.equal(e.state, 'recording');
  assert.match(e.recId, /^rec_fake/);
  assert.equal(e.note, null, 'pünktlicher Start ohne Spätstart-Hinweis');

  // weitere Ticks starten nichts doppelt
  clock.advance(30 * 1000);
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 1);
});

test('Aufnahme endet (Sendungsende) → Eintrag done; manueller Stopp ebenso', async () => {
  const { scheduler, recorder, clock, store } = makeScheduler();
  await scheduler.start(); // hängt die Recorder-Events an
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  const recId = store.get(a.id).recId;
  recorder.finish(recId, { stopReason: 'stop-at' });
  assert.equal(store.get(a.id).state, 'done', 'Reconcile über recording:changed, ohne auf den nächsten Tick zu warten');
});

test('Spätstart aktiv: Start verpasst, Sendung läuft → sofort ab jetzt, Hinweis „ab hh:mm“ + Benachrichtigung', async () => {
  const { scheduler, recorder, clock, store, events } = makeScheduler();
  const a = scheduler.addEntry(input({ epgStop: '2026-10-05T20:30:00+02:00' })).entry;
  clock.set('2026-10-05T20:07:00+02:00'); // App war aus/Standby
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 1);
  assert.equal(recorder.startCalls[0].request.stopAt, T('2026-10-05T20:35:00+02:00'));
  const e = store.get(a.id);
  assert.equal(e.state, 'recording');
  assert.match(e.note, /Spätstart: Aufnahme ab 20:07/);
  const notify = events.find(([k, p]) => k === 'notify' && p.kind === 'late-start');
  assert.ok(notify, 'Benachrichtigung für Spätstart');
  assert.match(notify[1].message, /ab 20:07/);
  const changed = events.find(([k, p]) => k === 'changed' && p.reason === 'started');
  assert.equal(changed[1].notice.kind, 'late-start');
});

test('Spätstart deaktiviert: verpasster Start → missed mit Meldung, keine Aufnahme', async () => {
  const { scheduler, recorder, clock, store, settings, events } = makeScheduler();
  settings.lateStart = false;
  const a = scheduler.addEntry(input({ epgStop: '2026-10-05T20:30:00+02:00' })).entry;
  clock.set('2026-10-05T20:07:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 0);
  const e = store.get(a.id);
  assert.equal(e.state, 'missed');
  assert.match(e.note, /Spätstart ist deaktiviert/);
  assert.ok(events.some(([k, p]) => k === 'notify' && p.kind === 'missed'));
});

test('Spätstart-Flag wird zur Laufzeit gelesen (Umschalten wirkt ohne Neustart)', async () => {
  const { scheduler, recorder, clock, settings } = makeScheduler();
  scheduler.addEntry(input({ epgStop: '2026-10-05T20:30:00+02:00' }));
  settings.lateStart = false;
  settings.lateStart = true;
  clock.set('2026-10-05T20:07:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 1);
});

test('Sendungsende liegt auch zurück → missed (unabhängig vom Spätstart-Flag), Meldung in Liste + Notification', async () => {
  const { scheduler, recorder, clock, store, events } = makeScheduler();
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T20:15:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 0);
  const e = store.get(a.id);
  assert.equal(e.state, 'missed');
  assert.match(e.note, /Verpasst/);
  assert.ok(events.some(([k, p]) => k === 'notify' && p.kind === 'missed'));
});

test('Resume nach Standby: onResume() bewertet sofort neu (Spätstart / missed)', async () => {
  const { scheduler, recorder, clock, store } = makeScheduler();
  const running = scheduler.addEntry(input({ epgStop: '2026-10-05T20:30:00+02:00' })).entry;
  const gone = scheduler.addEntry(input({
    channelId: 'zdf', channelName: 'ZDF', tvgId: 'ZDF.de', title: 'heute',
    epgStart: '2026-10-05T19:30:00+02:00', epgStop: '2026-10-05T19:45:00+02:00',
  })).entry;
  clock.set('2026-10-05T20:10:00+02:00'); // Rechner schlief bis jetzt
  await scheduler.onResume();
  assert.equal(store.get(running.id).state, 'recording');
  assert.equal(store.get(gone.id).state, 'missed');
  assert.equal(recorder.startCalls.length, 1);
});

test('Platzmangel: nicht starten, failed „Speicher knapp“ + Notification', async () => {
  const { scheduler, recorder, clock, store, events } = makeScheduler();
  recorder.free = 100 * 1024 * 1024; // 100 MB < Reserve 1 GB
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 0, 'bei Mangel wird NICHT gestartet');
  const e = store.get(a.id);
  assert.equal(e.state, 'failed');
  assert.match(e.note, /Speicher knapp/);
  const n = events.find(([k, p]) => k === 'notify' && p.kind === 'low-space');
  assert.ok(n);
  // Genügend Platz / nicht ermittelbar: normaler Start
  const second = makeScheduler();
  second.recorder.free = 5 * 1024 * 1024 * 1024;
  second.scheduler.addEntry(input());
  second.clock.set('2026-10-05T19:58:00+02:00');
  await second.scheduler.tick();
  assert.equal(second.recorder.startCalls.length, 1);
});

test('Kanal fehlt in der Senderliste → failed mit lesbarer Meldung, kein Start, kein Wiederholen', async () => {
  const resolveStream = async ref => ({ ok: false, message: `„${ref.channelName}“ ist nicht mehr in der Senderliste.` });
  const { scheduler, recorder, clock, store } = makeScheduler({ resolveStream });
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  clock.advance(MIN);
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 0);
  const e = store.get(a.id);
  assert.equal(e.state, 'failed');
  assert.equal(e.note, '„Das Erste“ ist nicht mehr in der Senderliste.');
});

test('Resolver wirft → failed mit lesbarer Meldung', async () => {
  const { scheduler, clock, store } = makeScheduler({ resolveStream: async () => { throw new Error('Netz weg'); } });
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  assert.match(store.get(a.id).note, /Netz weg/);
  assert.equal(store.get(a.id).state, 'failed');
});

test('Engine-Fehler beim Start → failed mit Engine-Text; KEIN stilles Wiederholen', async () => {
  const { scheduler, recorder, clock, store, events } = makeScheduler();
  recorder.startError = new Error('ffmpeg/ffprobe fehlen oder sind defekt — Aufnahme nicht verfügbar (siehe App-Log)');
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  for (let i = 0; i < 5; i += 1) {
    clock.advance(30 * 1000);
    await scheduler.tick();
  }
  assert.equal(recorder.startCalls.length, 1, 'genau ein Startversuch');
  const e = store.get(a.id);
  assert.equal(e.state, 'failed');
  assert.match(e.note, /ffmpeg\/ffprobe fehlen/);
  assert.ok(events.some(([k, p]) => k === 'notify' && p.kind === 'failed'));
});

test('Aufnahme schlägt zur Laufzeit fehl (Engine-Event) → Eintrag failed mit lastError', async () => {
  const { scheduler, recorder, clock, store } = makeScheduler();
  await scheduler.start(); // hängt die Recorder-Events an
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  const recId = store.get(a.id).recId;
  recorder.finish(recId, { status: 'failed', lastError: 'Stream nicht erreichbar (HTTP 404)' });
  const e = store.get(a.id);
  assert.equal(e.state, 'failed');
  assert.equal(e.note, 'Stream nicht erreichbar (HTTP 404)');
  // später kein erneuter Start
  clock.advance(MIN);
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 1);
});

test('Speicher voll während der Aufnahme (stopReason) → failed mit Hinweis, Aufnahme bleibt abspielbar', async () => {
  const { scheduler, recorder, clock, store } = makeScheduler();
  await scheduler.start(); // hängt die Recorder-Events an
  const a = scheduler.addEntry(input()).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  recorder.finish(store.get(a.id).recId, { stopReason: 'disk-full' });
  assert.match(store.get(a.id).note, /Speicher voll/);
  assert.equal(store.get(a.id).state, 'failed');
});

test('Soft-Limit: ohne bestätigte Überschreitung failed; mit allowOverLimit startet der Scheduler mit force:true', async () => {
  const strict = makeScheduler({ recorderOptions: { maxParallel: 1 } });
  await strict.recorder.start({ channelId: 'x', channelName: 'X', sourceUrl: 'https://x.example/a.m3u8' });
  // Beim Anlegen wird der Konflikt gemeldet (laufende Aufnahme „offen“)
  const res = strict.scheduler.addEntry(input());
  assert.equal(res.ok, false);
  assert.equal(res.code, 'CONFLICT');
  assert.equal(res.conflict.exceeds, true);
  assert.equal(strict.store.list().length, 0, 'ohne Bestätigung wird nichts gespeichert');

  // Bestätigt: wird angelegt und zur Laufzeit mit force gestartet
  const ok = strict.scheduler.addEntry(input({ allowOverLimit: true }));
  assert.equal(ok.ok, true);
  strict.clock.set('2026-10-05T19:58:00+02:00');
  await strict.scheduler.tick();
  const call = strict.recorder.startCalls.at(-1);
  assert.equal(call.force, true);
  assert.equal(strict.store.get(ok.entry.id).state, 'recording');

  // Eintrag ohne Bestätigung (z. B. später durch andere Aufnahmen belegt): failed mit Meldung
  const lazy = makeScheduler({ recorderOptions: { maxParallel: 1 } });
  const entry = lazy.scheduler.addEntry(input()).entry;
  await lazy.recorder.start({ channelId: 'x', channelName: 'X', sourceUrl: 'https://x.example/a.m3u8' });
  lazy.clock.set('2026-10-05T19:58:00+02:00');
  await lazy.scheduler.tick();
  const e = lazy.store.get(entry.id);
  assert.equal(e.state, 'failed');
  assert.match(e.note, /Parallel-Limit erreicht/);
  assert.equal(lazy.recorder.startCalls.filter(c => c.request.channelId === 'das-erste').length, 1, 'nicht erneut versucht');
});

test('Duplikat-Schutz: läuft der Kanal schon, failed ohne Endlosschleife', async () => {
  const { scheduler, recorder, clock, store } = makeScheduler();
  await recorder.start({ channelId: 'das-erste', channelName: 'Das Erste', sourceUrl: 'https://x.example/a.m3u8' }); // manuell, ohne stopAt
  const a = scheduler.addEntry(input({ allowOverLimit: true })).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  const e = store.get(a.id);
  assert.equal(e.state, 'failed');
  assert.match(e.note, /Duplikat-Schutz/);
  const startsBefore = recorder.startCalls.length;
  clock.advance(5 * MIN);
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, startsBefore, 'kein erneuter Versuch');
});

test('Mittelpunkt-Regel zur Laufzeit: B wartet auf den endenden Vorgänger statt am Duplikat-Schutz zu scheitern', async () => {
  const { scheduler, recorder, clock, store } = makeScheduler();
  const a = scheduler.addEntry(input()).entry; // 20:00–20:15
  const b = scheduler.addEntry(input({ title: 'Tagesthemen', epgStart: '2026-10-05T20:15:00+02:00', epgStop: '2026-10-05T20:45:00+02:00' })).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  const startA = recorder.startCalls[0].request;
  assert.equal(startA.stopAt, T('2026-10-05T20:15:00+02:00'), 'A endet an der Grenze (Mitte, auf epgStop geklemmt)');
  // 20:15:00 — A läuft noch (stopAt wird erst jetzt wirksam) → B wartet
  clock.set('2026-10-05T20:15:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 1);
  assert.equal(store.get(b.id).state, 'scheduled', 'wartet, nicht failed');
  // A beendet sich, B startet im nächsten Tick
  recorder.finish(store.get(a.id).recId);
  clock.advance(30 * 1000);
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 2);
  assert.equal(recorder.startCalls[1].request.epgTitle, 'Tagesthemen');
  assert.equal(store.get(b.id).state, 'recording');
});

test('Vorgänger endet nicht (länger als 2 min Wartezeit) → B failed mit Duplikat-Meldung', async () => {
  const { scheduler, recorder, clock, store } = makeScheduler();
  scheduler.addEntry(input());
  const b = scheduler.addEntry(input({ title: 'B', epgStart: '2026-10-05T20:15:00+02:00', epgStop: '2026-10-05T20:45:00+02:00' })).entry;
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  clock.set('2026-10-05T20:15:00+02:00');
  await scheduler.tick();
  clock.set('2026-10-05T20:17:30+02:00');
  await scheduler.tick();
  assert.equal(store.get(b.id).state, 'failed');
  assert.match(store.get(b.id).note, /Duplikat-Schutz/);
  assert.equal(recorder.startCalls.length, 1);
});

test('Neustart-Simulation: scheduled bleibt erhalten und startet nach Neustart; recording ohne Job wird aufgelöst', async () => {
  const first = makeScheduler();
  const pending = first.scheduler.addEntry(input()).entry;
  const hung = first.scheduler.addEntry(input({
    channelId: 'zdf', channelName: 'ZDF', tvgId: 'ZDF.de', title: 'heute-journal',
    epgStart: '2026-10-05T21:45:00+02:00', epgStop: '2026-10-05T22:15:00+02:00',
  })).entry;
  first.store.update(hung.id, { state: 'recording', recId: 'rec_zombie1' });
  const gone = first.scheduler.addEntry(input({
    channelId: 'arte', channelName: 'Arte', tvgId: 'Arte.de', title: 'Doku',
    epgStart: '2026-10-05T22:30:00+02:00', epgStop: '2026-10-05T23:00:00+02:00',
  })).entry;
  first.store.update(gone.id, { state: 'recording', recId: 'rec_verschwunden' });
  const finished = first.scheduler.addEntry(input({
    channelId: '3sat', channelName: '3sat', tvgId: '3sat.de', title: 'Kultur',
    epgStart: '2026-10-05T23:30:00+02:00', epgStop: '2026-10-05T23:59:00+02:00',
  })).entry;
  first.store.update(finished.id, { state: 'recording', recId: 'rec_fertig' });

  // „App neu gestartet“: neue Instanzen auf demselben Verzeichnis, neuer Recorder ohne Jobs
  const clock = makeClock('2026-10-05T19:00:00+02:00');
  const recorder = new FakeRecorder();
  recorder.metas.set('rec_zombie1', { id: 'rec_zombie1', status: 'aborted' }); // recover() hat den Zombie auf aborted gesetzt
  recorder.metas.set('rec_fertig', { id: 'rec_fertig', status: 'completed', stopReason: 'stop-at' });
  const store = createScheduleStore({ dir: first.dir, now: clock.now });
  const scheduler = new Scheduler({
    store, recorder, now: clock.now,
    resolveStream: async ref => ({ ok: true, url: 'https://fresh.example/x.m3u8', channelName: ref.channelName }),
    getSettings: () => ({ lateStart: true, bufferBeforeMin: 2, bufferAfterMin: 5 }),
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
  });
  await scheduler.start();
  assert.equal(store.get(pending.id).state, 'scheduled', 'Plan geht beim Neustart nicht verloren');
  assert.equal(store.get(hung.id).state, 'failed');
  assert.match(store.get(hung.id).note, /unterbrochen/);
  assert.equal(store.get(gone.id).state, 'failed');
  assert.match(store.get(gone.id).note, /nicht mehr vorhanden/);
  assert.equal(store.get(finished.id).state, 'done');

  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 1);
  assert.equal(store.get(pending.id).state, 'recording');
  scheduler.stop();
});

test('start()/stop(): Takt wird gesetzt und beendet (Timer sauber), Recorder-Listener entfernt', async () => {
  const cleared = [];
  const clock = makeClock();
  const recorder = new FakeRecorder();
  const handle = { unref() {} };
  const { dir } = makeScheduler();
  const scheduler = new Scheduler({
    store: createScheduleStore({ dir }), recorder, now: clock.now,
    resolveStream: async () => ({ ok: false, message: 'x' }),
    getSettings: () => ({ lateStart: true }),
    timers: { setInterval: (fn, ms) => { handle.ms = ms; return handle; }, clearInterval: h => cleared.push(h) },
  });
  await scheduler.start();
  assert.equal(handle.ms, 30 * 1000, '30-s-Tick');
  assert.ok(recorder.listenerCount('recording:changed') > 0);
  scheduler.stop();
  assert.deepEqual(cleared, [handle]);
  assert.equal(recorder.listenerCount('recording:changed'), 0);
});

test('hasPendingSchedules: nur scheduled mit Ende in der Zukunft (window-all-closed)', async () => {
  const { scheduler, clock, store } = makeScheduler();
  assert.equal(scheduler.hasPendingSchedules(), false);
  const a = scheduler.addEntry(input()).entry;
  assert.equal(scheduler.hasPendingSchedules(), true);
  clock.set('2026-10-05T20:30:00+02:00');
  assert.equal(scheduler.hasPendingSchedules(), false, 'Ende vorbei');
  clock.set('2026-10-05T19:00:00+02:00');
  scheduler.cancelEntry(a.id);
  assert.equal(scheduler.hasPendingSchedules(), false, 'abgesagt');
  assert.equal(store.get(a.id).state, 'cancelled');
});

// ── Anlegen / Ändern / Absagen ──

test('addEntry: Zukunfts-Regel mit den Meldungen aus §3.7; Grenzfall Start < Vorlaufpuffer bleibt planbar', () => {
  const { scheduler, clock } = makeScheduler();
  clock.set('2026-10-05T20:05:00+02:00');
  assert.throws(() => scheduler.addEntry(input()), err => err.code === 'RUNNING' && /läuft bereits und kann nicht mehr geplant werden\. Zum Aufnehmen der laufenden Sendung nutze den Aufnahme-Button im Player\./.test(err.message));
  clock.set('2026-10-05T20:15:00+02:00');
  assert.throws(() => scheduler.addEntry(input()), err => err.code === 'PAST' && err.message === 'Diese Sendung ist bereits vorbei und kann nicht aufgenommen werden.');
  // genau jetzt (epgStart == now) zählt als „läuft“ (≤ jetzt)
  clock.set('2026-10-05T20:00:00+02:00');
  assert.throws(() => scheduler.addEntry(input()), err => err.code === 'RUNNING');
  // 1 min vor Start (Vorlauf 2 min): planbar, startet beim nächsten Tick sofort
  clock.set('2026-10-05T19:59:00+02:00');
  const ok = scheduler.addEntry(input());
  assert.equal(ok.ok, true);
});

test('addEntry: Grenzen (8 Tage voraus, 24 h Dauer), Duplikat, EPG-Plausibilisierung', () => {
  const lookups = [];
  const slot = { start: T('2026-10-05T20:00:00+02:00'), stop: T('2026-10-05T20:15:00+02:00'), title: 'Tagesschau', desc: '' };
  const { scheduler } = makeScheduler({ epgLookup: ({ key, atMs }) => { lookups.push([key, atMs]); return key === 'DasErste.de' ? slot : null; } });
  assert.throws(() => scheduler.addEntry(input({ epgStart: '2026-10-20T20:00:00+02:00', epgStop: '2026-10-20T20:15:00+02:00' })), /8 Tage/);
  assert.throws(() => scheduler.addEntry(input({ epgStop: '2026-10-06T21:00:00+02:00' })), /24 Stunden/);
  // Kein Slot im Main-Cache → planen verhindert
  assert.throws(() => scheduler.addEntry(input({ tvgId: 'Unbekannt.de' })), err => err.code === 'NO_EPG' && /kein planbares EPG im Cache/.test(err.message));
  // Slot weicht stark ab
  assert.throws(() => scheduler.addEntry(input({ epgStart: '2026-10-05T20:30:00+02:00', epgStop: '2026-10-05T20:45:00+02:00' })), err => err.code === 'EPG_MISMATCH');
  const ok = scheduler.addEntry(input());
  assert.equal(ok.ok, true);
  assert.deepEqual(lookups.at(-1), ['DasErste.de', T('2026-10-05T20:00:00+02:00')]);
  assert.throws(() => scheduler.addEntry(input()), err => err.code === 'DUPLICATE');
});

test('addEntry: Puffer aus der Eingabe überschreiben die Defaults; Settings-Änderung wirkt nur auf NEUE Einträge', () => {
  const { scheduler, settings } = makeScheduler();
  const a = scheduler.addEntry(input({ bufferBeforeSec: 0, bufferAfterSec: 600 })).entry;
  assert.equal(a.bufferBeforeSec, 0);
  assert.equal(a.bufferAfterSec, 600);
  settings.bufferBeforeMin = 10;
  settings.bufferAfterMin = 15;
  const b = scheduler.addEntry(input({ title: 'B', epgStart: '2026-10-05T21:00:00+02:00', epgStop: '2026-10-05T21:30:00+02:00' })).entry;
  assert.equal(b.bufferBeforeSec, 600);
  assert.equal(b.bufferAfterSec, 900);
  assert.equal(scheduler.list().find(e => e.id === a.id).bufferBeforeSec, 0, 'bestehender Eintrag behält seine Puffer');
});

test('addEntry: Zusammenlegen („eine durchgehende Aufnahme“) verlängert den benachbarten Eintrag', () => {
  const { scheduler, store } = makeScheduler();
  const a = scheduler.addEntry(input({ title: 'Tagesschau' })).entry;
  const b = input({ title: 'Tagesthemen', epgStart: '2026-10-05T20:15:00+02:00', epgStop: '2026-10-05T20:45:00+02:00' });
  const preview = scheduler.checkConflicts(b);
  assert.equal(preview.adjacency.entryId, a.id);
  assert.equal(preview.adjacency.canMerge, true);
  assert.equal(preview.adjacency.merged.title, 'Tagesschau + Tagesthemen');
  const res = scheduler.addEntry({ ...b, mergeWithId: a.id });
  assert.equal(res.ok, true);
  assert.equal(res.merged, true);
  assert.equal(store.list().length, 1, 'kein zweiter Eintrag');
  const e = store.get(a.id);
  assert.equal(e.title, 'Tagesschau + Tagesthemen');
  assert.equal(e.epgStart, '2026-10-05T20:00:00+02:00');
  assert.equal(e.epgStop, '2026-10-05T20:45:00+02:00');
  // Ungültiges Merge-Ziel
  assert.throws(() => scheduler.addEntry({ ...b, epgStart: '2026-10-05T22:00:00+02:00', epgStop: '2026-10-05T22:30:00+02:00', mergeWithId: a.id }), err => err.code === 'MERGE_INVALID');
});

test('updateEntry: nur scheduled, Puffer ändern; laufende/abgeschlossene werden abgelehnt', async () => {
  const { scheduler, clock, store } = makeScheduler();
  const a = scheduler.addEntry(input()).entry;
  const res = scheduler.updateEntry(a.id, { bufferBeforeSec: 600, bufferAfterSec: 0 });
  assert.equal(res.ok, true);
  assert.equal(store.get(a.id).bufferBeforeSec, 600);
  assert.equal(store.get(a.id).bufferAfterSec, 0);
  assert.throws(() => scheduler.updateEntry('sch_unbekannt', { bufferBeforeSec: 1 }), err => err.code === 'NOT_FOUND');
  // Zeiten nur mit Zukunfts-Regel
  assert.throws(() => scheduler.updateEntry(a.id, { epgStart: '2026-10-05T18:00:00+02:00', epgStop: '2026-10-05T18:30:00+02:00' }), err => err.code === 'PAST');
  clock.set('2026-10-05T19:50:00+02:00'); // Start − 10 min = 19:50 → Vorlauf 600 s erreicht
  await scheduler.tick();
  assert.equal(store.get(a.id).state, 'recording');
  assert.throws(() => scheduler.updateEntry(a.id, { bufferBeforeSec: 0 }), err => err.code === 'NOT_SCHEDULED');
});

test('updateEntry: Konflikt-Meldung statt Speichern, allowOverLimit bestätigt', () => {
  const { scheduler } = makeScheduler({ recorderOptions: { maxParallel: 1 } });
  scheduler.addEntry(input());
  const b = scheduler.addEntry(input({ channelId: 'zdf', channelName: 'ZDF', tvgId: 'ZDF.de', title: 'B', epgStart: '2026-10-05T21:00:00+02:00', epgStop: '2026-10-05T21:30:00+02:00' })).entry;
  const bad = scheduler.updateEntry(b.id, { epgStart: '2026-10-05T20:05:00+02:00', epgStop: '2026-10-05T20:30:00+02:00' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'CONFLICT');
  assert.equal(scheduler.list().find(e => e.id === b.id).epgStart, '2026-10-05T21:00:00+02:00', 'nichts gespeichert');
  const ok = scheduler.updateEntry(b.id, { epgStart: '2026-10-05T20:05:00+02:00', epgStop: '2026-10-05T20:30:00+02:00', allowOverLimit: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.allowOverLimit, true);
});

test('Absagen (cancelEntry): scheduled → cancelled; Verlauf wird entfernt; laufender Eintrag wird NICHT angefasst', async () => {
  const { scheduler, recorder, clock, store, events } = makeScheduler();
  const a = scheduler.addEntry(input()).entry;
  const res = scheduler.cancelEntry(a.id);
  assert.deepEqual([res.ok, res.removed, res.entry.state], [true, false, 'cancelled']);
  assert.ok(events.some(([k, p]) => k === 'changed' && p.reason === 'cancelled'));
  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  assert.equal(recorder.startCalls.length, 0, 'abgesagt → startet nie');
  // Verlauf entfernen
  const r2 = scheduler.cancelEntry(a.id);
  assert.deepEqual([r2.removed, store.get(a.id)], [true, null]);
  // Laufender Eintrag: Absage wird abgelehnt, Aufnahme läuft weiter
  clock.set('2026-10-05T19:00:00+02:00');
  const b = scheduler.addEntry(input({ title: 'B', epgStart: '2026-10-05T19:30:00+02:00', epgStop: '2026-10-05T19:45:00+02:00' })).entry;
  clock.set('2026-10-05T19:28:00+02:00');
  await scheduler.tick();
  assert.equal(store.get(b.id).state, 'recording');
  assert.throws(() => scheduler.cancelEntry(b.id), err => err.code === 'RUNNING' && /nicht abgebrochen/.test(err.message));
  assert.ok(recorder.getJob(store.get(b.id).recId), 'laufende Aufnahme bleibt unberührt');
  assert.throws(() => scheduler.cancelEntry('sch_unbekannt'), err => err.code === 'NOT_FOUND');
});

test('checkConflicts: meldet Überschreitung ohne zu speichern, liefert Puffer-Defaults', () => {
  const { scheduler, store } = makeScheduler({ recorderOptions: { maxParallel: 1 } });
  scheduler.addEntry(input());
  const res = scheduler.checkConflicts(input({ channelId: 'zdf', channelName: 'ZDF', tvgId: 'ZDF.de', title: 'B' }));
  assert.equal(res.conflict.exceeds, true);
  assert.deepEqual(res.defaults, { bufferBeforeSec: 120, bufferAfterSec: 300 });
  assert.equal(store.list().length, 1);
});

test('Tick ist re-entrant-sicher: gleichzeitige Ticks starten nicht doppelt', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { scheduler, recorder, clock } = makeScheduler({
    resolveStream: async ref => { await gate; return { ok: true, url: 'https://fresh.example/x.m3u8', channelName: ref.channelName }; },
  });
  scheduler.addEntry(input());
  clock.set('2026-10-05T19:58:00+02:00');
  const t1 = scheduler.tick();
  const t2 = scheduler.tick();
  release();
  await Promise.all([t1, t2]);
  assert.equal(recorder.startCalls.length, 1);
});
