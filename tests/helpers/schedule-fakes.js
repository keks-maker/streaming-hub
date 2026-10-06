'use strict';

// Test-Helfer für die Planung (Etappe 2a): steuerbare Uhr, Recorder-Attrappe
// (gleiche Oberfläche wie RecorderService für den Scheduler) und Factory.
// Dateien in tests/helpers sind KEINE Tests und stehen nicht in test:suite.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createScheduleStore } = require('../../lib/recorder/ScheduleStore.js');
const { Scheduler } = require('../../lib/recorder/Scheduler.js');
const { RecorderLimitError } = require('../../lib/recorder/RecorderService.js');

const MIN = 60 * 1000;

function makeClock(startIso = '2026-10-05T19:00:00+02:00') {
  const clock = {
    t: Date.parse(startIso),
    now: () => clock.t,
    advance(ms) {
      clock.t += ms;
    },
    set(iso) {
      clock.t = Date.parse(iso);
    },
  };
  return clock;
}

class FakeRecorder extends EventEmitter {
  constructor({ maxParallel = 3, now = () => Date.now() } = {}) {
    super();
    this.now = now; // injizierte Test-Uhr; startedAt darf nie von der echten Uhr abhängen
    this.maxParallel = maxParallel;
    this.reserveBytes = 1024 * 1024 * 1024;
    this.free = null; // null = nicht ermittelbar
    this.startCalls = [];
    this.startError = null;
    this.jobs = new Map(); // recId → { meta, stopAt }
    this.metas = new Map(); // recId → meta (für store.readMeta)
    this.counter = 0;
    this.store = { readMeta: id => this.metas.get(id) || null };
  }

  getFreeBytes() {
    return this.free;
  }

  async start(request, { force = false } = {}) {
    this.startCalls.push({ request, force });
    if (this.startError) throw this.startError;
    if (this.jobs.size >= this.maxParallel && !force) throw new RecorderLimitError(this.maxParallel, this.jobs.size);
    this.counter += 1;
    const recId = `rec_fake${this.counter}`;
    const meta = {
      id: recId,
      status: 'recording',
      channelId: request.channelId,
      channelName: request.channelName,
      epgTitle: request.epgTitle,
      startedAt: new Date(this.now()).toISOString(),
    };
    this.metas.set(recId, meta);
    this.jobs.set(recId, { meta, stopAt: request.stopAt || null, recId });
    return { recId, meta };
  }

  getJob(recId) {
    return this.jobs.get(recId) || null;
  }

  findJobByChannel(channelId, channelName) {
    for (const job of this.jobs.values()) {
      if (channelId && job.meta.channelId === channelId) return job;
      if (!channelId && channelName && job.meta.channelName === channelName) return job;
    }
    return null;
  }

  status() {
    return {
      active: [...this.jobs.values()].map(j => ({
        recId: j.recId,
        channelId: j.meta.channelId,
        channelName: j.meta.channelName,
        startedAt: j.meta.startedAt,
        stopAt: j.stopAt,
      })),
      remuxing: [],
    };
  }

  /** Aufnahme endet regulär (Sendungsende / Nutzer-Stopp). */
  finish(recId, patch = {}) {
    const job = this.jobs.get(recId);
    this.jobs.delete(recId);
    const meta = { ...(job ? job.meta : this.metas.get(recId)), status: 'completed', ...patch };
    this.metas.set(recId, meta);
    this.emit('recording:changed', { recId, meta });
    return meta;
  }
}

/** Standard-Resolver: findet jeden Kanal und liefert eine frische URL. */
function okResolver(calls = []) {
  return async ref => {
    calls.push(ref);
    return { ok: true, url: `https://fresh.example/${encodeURIComponent(ref.channelId || ref.channelName)}.m3u8`, channelName: ref.channelName };
  };
}

function makeScheduler(overrides = {}) {
  const dir = overrides.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  const clock = overrides.clock || makeClock();
  const recorder = overrides.recorder || new FakeRecorder({ now: clock.now, ...overrides.recorderOptions });
  const settings = { bufferBeforeMin: 2, bufferAfterMin: 5, lateStart: true, ...(overrides.settings || {}) };
  const store = overrides.store || createScheduleStore({ dir, now: clock.now });
  const resolveCalls = [];
  const logs = [];
  const scheduler = new Scheduler({
    store,
    recorder,
    resolveStream: overrides.resolveStream || okResolver(resolveCalls),
    getSettings: () => settings,
    epgLookup: overrides.epgLookup === undefined ? null : overrides.epgLookup,
    refreshEpg: overrides.refreshEpg || null,
    epgRange: overrides.epgRange || null,
    slipRetryMs: overrides.slipRetryMs,
    now: clock.now,
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    logger: { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) },
  });
  const events = [];
  scheduler.on('schedule:changed', p => events.push(['changed', p]));
  scheduler.on('schedule:notify', p => events.push(['notify', p]));
  return { scheduler, recorder, clock, store, settings, dir, resolveCalls, logs, events };
}

/** Eingabe wie nach der IPC-Validierung. */
function input(over = {}) {
  return {
    channelId: 'das-erste',
    channelName: 'Das Erste',
    tvgId: 'DasErste.de',
    sourceId: 'q1',
    sourceUrlSnapshot: 'https://old.example/das-erste.m3u8',
    title: 'Tagesschau',
    description: 'Nachrichten',
    epgStart: '2026-10-05T20:00:00+02:00',
    epgStop: '2026-10-05T20:15:00+02:00',
    ...over,
  };
}

module.exports = { MIN, makeClock, FakeRecorder, okResolver, makeScheduler, input };
