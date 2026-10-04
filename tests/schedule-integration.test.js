'use strict';

// Uhrzeit-Texte („ab 20:07“) sind lokale Zeit: für reproduzierbare Läufe fest auf Berlin.
process.env.TZ = 'Europe/Berlin';

// Integration: geplante Aufnahme startet/stoppt OHNE Fenster (reines Node, kein
// Renderer/BrowserWindow) gegen den echten RecorderService mit Fake-ffmpeg
// (tests/helpers/recorder-fakes.js), injizierter Uhr und lokaler XMLTV-Fixture
// statt Netz (tests/fixtures/epg-schedule.xml).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EpgService } = require('../lib/epg/EpgService.js');
const { createScheduleStore } = require('../lib/recorder/ScheduleStore.js');
const { Scheduler } = require('../lib/recorder/Scheduler.js');
const { makeFakeService, sleep, waitForDone } = require('./helpers/recorder-fakes.js');
const { makeClock, input } = require('./helpers/schedule-fakes.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'epg-schedule.xml');

async function setup() {
  const clock = makeClock('2026-10-05T19:00:00+02:00');
  const { service } = makeFakeService({ now: () => new Date(clock.t), freeBytes: () => 500 * 1024 ** 3 });
  const epgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-epg-'));
  const epg = new EpgService({
    dir: epgDir,
    getSources: () => [{ id: 'q1', name: 'Quelle', epgUrl: 'https://epg.example/epg.xml' }],
    fetchImpl: async () => new Response(fs.readFileSync(FIXTURE), { status: 200 }),
    now: () => clock.t,
    autoRefresh: false,
  });
  await epg.refresh({ force: true });
  const store = createScheduleStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sched-int-')), now: clock.now });
  const resolved = [];
  const scheduler = new Scheduler({
    store,
    recorder: service,
    now: clock.now,
    resolveStream: async ref => {
      resolved.push(ref);
      return { ok: true, url: 'https://stream.example/live.m3u8', channelName: ref.channelName };
    },
    getSettings: () => ({ bufferBeforeMin: 2, bufferAfterMin: 5, lateStart: true }),
    epgLookup: ({ key, atMs }) => epg.find(key, atMs),
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
  });
  await scheduler.start();
  return { clock, service, epg, store, scheduler, resolved };
}

test('Fixture: der Main-EPG-Cache liefert die Slots aus der lokalen XMLTV-Datei (kein Netz)', async () => {
  const { epg } = await setup();
  const slot = epg.find('DasErste.de', Date.parse('2026-10-05T20:05:00+02:00'));
  assert.equal(slot.title, 'Tagesschau');
  assert.equal(slot.start, Date.parse('2026-10-05T20:00:00+02:00'));
  assert.equal(epg.find('Unbekannt.de', Date.parse('2026-10-05T20:05:00+02:00')), null);
});

test('Geplante Aufnahme startet zum Vorlauf und stoppt per stopAt — ohne Fenster, Eintrag wird done', async () => {
  const { clock, service, store, scheduler, resolved } = await setup();
  const { entry } = scheduler.addEntry(input());

  clock.set('2026-10-05T19:57:00+02:00');
  await scheduler.tick();
  assert.equal(service.activeJobs().length, 0, 'vor dem Vorlauf läuft nichts');

  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  assert.equal(service.activeJobs().length, 1);
  const stored = store.get(entry.id);
  assert.equal(stored.state, 'recording');
  assert.equal(resolved.length, 1);
  const job = service.getJob(stored.recId);
  assert.equal(job.stopAt, Date.parse('2026-10-05T20:20:00+02:00'), 'stopAt = Sendungsende + Nachlauf, gesetzt im Main');
  assert.equal(job.meta.epgTitle, 'Tagesschau');
  await sleep(300); // Fake-ffmpeg schreibt Segment + Playlist

  clock.set('2026-10-05T20:19:00+02:00');
  assert.equal(job.checkLimits(), null);
  const doneP = waitForDone(service, stored.recId);
  clock.set('2026-10-05T20:20:01+02:00');
  assert.equal(job.checkLimits(), 'stop-at');
  const meta = await doneP;
  assert.equal(meta.status, 'completed');
  assert.equal(meta.stopReason, 'stop-at');
  assert.ok(fs.existsSync(meta.outputFile));
  assert.equal(store.get(entry.id).state, 'done', 'Scheduler löst den Eintrag über die Recorder-Events auf');
  scheduler.stop();
});

test('Zwei Sendungen direkt hintereinander (Mittelpunkt-Regel) laufen nacheinander ohne Duplikat-Fehler', async () => {
  const { clock, service, store, scheduler } = await setup();
  const a = scheduler.addEntry(input()).entry;
  const b = scheduler.addEntry(input({ title: 'Tagesthemen', epgStart: '2026-10-05T20:15:00+02:00', epgStop: '2026-10-05T20:45:00+02:00' })).entry;

  clock.set('2026-10-05T19:58:00+02:00');
  await scheduler.tick();
  const recA = store.get(a.id).recId;
  const jobA = service.getJob(recA);
  assert.equal(jobA.stopAt, Date.parse('2026-10-05T20:15:00+02:00'), 'A endet an der Grenze');
  await sleep(300);

  clock.set('2026-10-05T20:15:00+02:00');
  await scheduler.tick(); // A läuft noch, B wartet statt zu scheitern
  assert.equal(store.get(b.id).state, 'scheduled');
  const doneA = waitForDone(service, recA);
  assert.equal(jobA.checkLimits(), 'stop-at');
  await doneA;
  assert.equal(store.get(a.id).state, 'done');

  clock.advance(30 * 1000);
  await scheduler.tick();
  const stateB = store.get(b.id);
  assert.equal(stateB.state, 'recording');
  assert.equal(service.getJob(stateB.recId).stopAt, Date.parse('2026-10-05T20:50:00+02:00'));
  assert.equal(service.getJob(stateB.recId).meta.epgTitle, 'Tagesthemen');
  await sleep(300);
  await service.stop(stateB.recId);
  assert.equal(store.get(b.id).state, 'done');
  scheduler.stop();
});

test('Spätstart gegen echten Recorder: Hinweis „ab hh:mm“, stopAt bleibt Sendungsende + Nachlauf', async () => {
  const { clock, service, store, scheduler } = await setup();
  const { entry } = scheduler.addEntry(input({ epgStart: '2026-10-05T20:00:00+02:00', epgStop: '2026-10-05T20:15:00+02:00' }));
  clock.set('2026-10-05T20:06:00+02:00'); // App war aus
  await scheduler.tick();
  const e = store.get(entry.id);
  assert.equal(e.state, 'recording');
  assert.match(e.note, /Spätstart: Aufnahme ab 20:06/);
  assert.equal(service.getJob(e.recId).stopAt, Date.parse('2026-10-05T20:20:00+02:00'));
  await sleep(300);
  await service.stop(e.recId);
  scheduler.stop();
});
