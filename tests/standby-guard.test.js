'use strict';

// Tests: Standby-Schutz (Etappe 2b; Konzept §3.5) mit Fake-powerSaveBlocker und
// injizierter Uhr: Lebenszyklus, Idempotenz, Lead-Zeit, Aufnahme läuft, Freigabe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { StandbyGuard, shouldBlockSuspension, LEAD_MS, BLOCKER_TYPE } = require('../lib/recorder/StandbyGuard.js');
const { makeClock, makeScheduler, input, MIN } = require('./helpers/schedule-fakes.js');

class FakeBlocker {
  constructor() {
    this.started = [];
    this.stopped = [];
    this.next = 1;
    this.failStart = false;
  }
  start(type) {
    if (this.failStart) throw new Error('nicht verfügbar');
    this.started.push(type);
    return this.next++;
  }
  stop(id) {
    this.stopped.push(id);
  }
  get live() {
    return this.started.length - this.stopped.length;
  }
}

function make({ active = 0, windows = [], t = 0, lead } = {}) {
  const blocker = new FakeBlocker();
  const s = { active, windows, t };
  const guard = new StandbyGuard({
    powerSaveBlocker: blocker,
    getActiveCount: () => s.active,
    getWindows: () => s.windows,
    now: () => s.t,
    leadMs: lead,
  });
  return { guard, blocker, s };
}

test('Entscheidung: laufende Aufnahme oder Start in ≤ 5 min, nie nach Fensterende', () => {
  const w = [{ startMs: 1000 * MIN, endMs: 1030 * MIN }];
  assert.equal(shouldBlockSuspension({ activeCount: 0, windows: w, nowMs: 994 * MIN }), false);
  assert.equal(shouldBlockSuspension({ activeCount: 0, windows: w, nowMs: 995 * MIN }), true, 'genau 5 min vorher');
  assert.equal(shouldBlockSuspension({ activeCount: 0, windows: w, nowMs: 1029 * MIN }), true);
  assert.equal(shouldBlockSuspension({ activeCount: 0, windows: w, nowMs: 1030 * MIN }), false, 'Fenster vorbei');
  assert.equal(shouldBlockSuspension({ activeCount: 1, windows: [], nowMs: 0 }), true);
  assert.equal(shouldBlockSuspension({ activeCount: 0, windows: [], nowMs: 0 }), false);
  assert.equal(LEAD_MS, 5 * MIN);
});

test('Lebenszyklus: aus → an (5 min vor Start) → Aufnahme läuft → aus nach Ende; kein Doppel-Start', () => {
  const { guard, blocker, s } = make({ windows: [{ startMs: 100 * MIN, endMs: 160 * MIN }], t: 0 });
  guard.sync();
  assert.equal(blocker.live, 0);
  s.t = 95 * MIN;
  guard.sync();
  guard.sync();
  guard.sync();
  assert.equal(blocker.started.length, 1, 'idempotent');
  assert.deepEqual(blocker.started, [BLOCKER_TYPE]);
  assert.equal(guard.active, true);
  // Job startet: der Eintrag ist kein „scheduled“ mehr, dafür läuft eine Aufnahme
  s.windows = [];
  s.active = 1;
  s.t = 101 * MIN;
  guard.sync();
  assert.equal(blocker.started.length, 1, 'kein zweiter Blocker beim Übergang');
  assert.equal(blocker.stopped.length, 0);
  // Aufnahme endet
  s.active = 0;
  guard.sync();
  assert.deepEqual(blocker.stopped, [1]);
  assert.equal(guard.active, false);
  guard.sync();
  assert.equal(blocker.stopped.length, 1, 'kein doppeltes Stop');
});

test('Start fehlgeschlagen/verpasst: nach Fensterende wird der Blocker freigegeben', () => {
  const { guard, blocker, s } = make({ windows: [{ startMs: 10 * MIN, endMs: 20 * MIN }], t: 6 * MIN });
  guard.sync();
  assert.equal(blocker.live, 1);
  s.t = 20 * MIN;
  guard.sync();
  assert.equal(blocker.live, 0);
});

test('Nur laufende Aufnahme (ohne Planung) schützt ebenfalls', () => {
  const { guard, blocker, s } = make({ active: 2 });
  guard.sync();
  assert.equal(blocker.live, 1);
  s.active = 0;
  guard.sync();
  assert.equal(blocker.live, 0);
});

test('release(): gibt frei, keine weiteren Starts, Listener entfernt; mehrfach aufrufbar', () => {
  const { guard, blocker, s } = make({ active: 1 });
  const scheduler = new EventEmitter();
  const recorder = new EventEmitter();
  guard.attach({ scheduler, recorder });
  assert.equal(blocker.live, 1);
  guard.release();
  guard.release();
  assert.equal(blocker.live, 0);
  s.active = 3;
  scheduler.emit('schedule:tick');
  guard.sync();
  assert.equal(blocker.started.length, 1);
  assert.equal(scheduler.listenerCount('schedule:tick'), 0);
  assert.equal(recorder.listenerCount('recording:changed'), 0);
});

test('Fehler: powerSaveBlocker nicht schaltbar oder Bedarf nicht ermittelbar → kein Wurf, kein Leak', () => {
  const { guard, blocker } = make({ active: 1 });
  blocker.failStart = true;
  assert.doesNotThrow(() => guard.sync());
  assert.equal(guard.active, false);
  blocker.failStart = false;
  guard.sync();
  assert.equal(guard.active, true);
  const broken = new StandbyGuard({
    powerSaveBlocker: new FakeBlocker(),
    getActiveCount: () => {
      throw new Error('kaputt');
    },
    getWindows: () => [],
  });
  assert.doesNotThrow(() => broken.sync());
  assert.throws(() => new StandbyGuard({}), /powerSaveBlocker/);
});

test('Zusammenspiel mit dem Scheduler: Blocker ab 5 min vor Start (Start − Vorlauf), Resume bewertet neu', async () => {
  const clock = makeClock('2026-10-05T19:00:00+02:00');
  const ctx = makeScheduler({ clock });
  const { scheduler, recorder } = ctx;
  // Tagesschau 20:00, Vorlauf 2 min → Aufnahmestart 19:58 → Blocker ab 19:53
  scheduler.addEntry(input());
  const blocker = new FakeBlocker();
  const guard = new StandbyGuard({
    powerSaveBlocker: blocker,
    getActiveCount: () => recorder.status().active.length,
    getWindows: () => scheduler.upcomingWindows(),
    now: clock.now,
  });
  guard.attach({ scheduler, recorder });
  clock.set('2026-10-05T19:52:30+02:00');
  await scheduler.tick();
  assert.equal(blocker.live, 0);
  clock.set('2026-10-05T19:53:30+02:00');
  await scheduler.tick(); // schedule:tick → sync
  assert.equal(blocker.live, 1);
  clock.set('2026-10-05T19:58:10+02:00');
  await scheduler.tick(); // Aufnahme startet → bleibt an (läuft)
  assert.equal(recorder.startCalls.length, 1);
  assert.equal(blocker.started.length, 1);
  // Sendungsende + Nachlauf: Job endet → Blocker frei
  const recId = [...recorder.jobs.keys()][0];
  recorder.finish(recId);
  assert.equal(blocker.live, 0);
});

test('Resume nach Standby mitten im Fenster: Blocker + Spätstart', async () => {
  const clock = makeClock('2026-10-05T19:00:00+02:00');
  const ctx = makeScheduler({ clock });
  const { scheduler, recorder } = ctx;
  scheduler.addEntry(input());
  const blocker = new FakeBlocker();
  const guard = new StandbyGuard({
    powerSaveBlocker: blocker,
    getActiveCount: () => recorder.status().active.length,
    getWindows: () => scheduler.upcomingWindows(),
    now: clock.now,
  });
  guard.attach({ scheduler, recorder });
  clock.set('2026-10-05T20:05:00+02:00'); // Rechner wacht nach dem Start auf
  await scheduler.onResume();
  assert.equal(recorder.startCalls.length, 1, 'Spätstart');
  assert.equal(blocker.live, 1);
});
