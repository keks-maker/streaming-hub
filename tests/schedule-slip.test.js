'use strict';

// Uhrzeit-Texte sind lokale Zeit: für reproduzierbare Läufe fest auf Berlin.
process.env.TZ = 'Europe/Berlin';

// Tests: Schedule-Slip (Etappe 2b; Konzept §3.4/§5). Echter EpgService gegen eine
// zur Laufzeit erzeugte XMLTV-Antwort (kein Netz), Scheduler mit injizierter Uhr.
// Entry „Tagesschau“ 20:00–20:15, Vorlauf 2 min → Start 19:58, Slip-Fenster ab 19:48.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EpgService } = require('../lib/epg/EpgService.js');
const { createScheduleStore } = require('../lib/recorder/ScheduleStore.js');
const { Scheduler, SLIP_WARN_PREFIX } = require('../lib/recorder/Scheduler.js');
const slip = require('../lib/recorder/schedule-slip.js');
const logic = require('../lib/recorder/schedule-logic.js');
const { makeClock, makeScheduler, input, MIN, FakeRecorder } = require('./helpers/schedule-fakes.js');

function xmltvTime(iso) {
  const d = new Date(Date.parse(iso));
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

function xmltv(programmes, channel = 'DasErste.de') {
  const body = programmes
    .map(p => `<programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${p.channel || channel}"><title>${p.title}</title></programme>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="${channel}"><display-name>X</display-name></channel>${body}</tv>`;
}

const TAGESSCHAU = { title: 'Tagesschau', start: '2026-10-05T20:00:00+02:00', stop: '2026-10-05T20:15:00+02:00' };
const FILLER = { title: 'Filler', start: '2026-10-05T23:00:00+02:00', stop: '2026-10-05T23:30:00+02:00' };

async function setup({ initial = [TAGESSCHAU, FILLER], at = '2026-10-05T19:00:00+02:00', schedulerOverrides = {}, sources } = {}) {
  const clock = makeClock(at);
  const xml = { value: xmltv(initial) };
  const fetched = [];
  const fail = { on: false };
  const epg = new EpgService({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'slip-epg-')),
    getSources: () => sources || [{ id: 'q1', name: 'Quelle', epgUrl: 'https://epg.example/q1.xml' }],
    fetchImpl: async url => {
      fetched.push(url);
      if (fail.on) throw new Error('Netz weg');
      return new Response(Buffer.from(xml.value), { status: 200 });
    },
    now: () => clock.t,
    autoRefresh: false,
  });
  await epg.refresh({ force: true });
  fetched.length = 0;
  const refreshCalls = [];
  const ctx = makeScheduler({
    clock,
    epgLookup: ({ key, atMs }) => epg.find(key, atMs),
    refreshEpg: async ({ entry }) => {
      refreshCalls.push(entry.id);
      return epg.refreshForSource(entry.sourceId);
    },
    epgRange: ({ key, fromMs, toMs }) => epg.range(key, fromMs, toMs),
    slipRetryMs: 3 * MIN,
    ...schedulerOverrides,
  });
  return { ...ctx, epg, xml, fetched, fail, refreshCalls };
}

function addTagesschau(ctx, over = {}) {
  const res = ctx.scheduler.addEntry(input(over));
  assert.equal(res.ok, true);
  return res.entry;
}

const kinds = events => events.filter(e => e[0] === 'notify').map(e => e[1].kind);

test('Slip: vor Fensterbeginn (19:48) keine Prüfung, kein Refresh', async () => {
  const ctx = await setup();
  addTagesschau(ctx);
  ctx.clock.set('2026-10-05T19:47:00+02:00');
  await ctx.scheduler.checkSlips();
  assert.deepEqual(ctx.refreshCalls, []);
  assert.equal(ctx.fetched.length, 0);
});

test('Slip nach hinten: Zeiten werden übernommen, Hinweis + Benachrichtigung, Start folgt der neuen Zeit', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.xml.value = xmltv([{ ...TAGESSCHAU, start: '2026-10-05T20:10:00+02:00', stop: '2026-10-05T20:25:00+02:00' }, FILLER]);
  ctx.clock.set('2026-10-05T19:48:30+02:00');
  await ctx.scheduler.checkSlips();
  const updated = ctx.store.get(entry.id);
  assert.equal(logic.parseIsoWithOffset(updated.epgStart), Date.parse('2026-10-05T20:10:00+02:00'));
  assert.equal(logic.parseIsoWithOffset(updated.epgStop), Date.parse('2026-10-05T20:25:00+02:00'));
  assert.ok(updated.lastSlipCheck);
  assert.match(updated.note, /20:00–20:15 → 20:10–20:25/);
  assert.deepEqual(kinds(ctx.events), ['slip']);
  const changed = ctx.events.find(e => e[0] === 'changed' && e[1].reason === 'slipped');
  assert.equal(changed[1].notice.kind, 'slip');
  // zur alten Startzeit passiert nichts, zur neuen schon
  ctx.clock.set('2026-10-05T19:59:00+02:00');
  await ctx.scheduler.tick();
  assert.equal(ctx.recorder.startCalls.length, 0);
  ctx.clock.set('2026-10-05T20:08:00+02:00');
  await ctx.scheduler.tick();
  assert.equal(ctx.recorder.startCalls.length, 1);
  assert.equal(ctx.recorder.startCalls[0].request.stopAt, Date.parse('2026-10-05T20:30:00+02:00'));
});

test('Slip nach vorne: früherer Beginn wird übernommen, solange der Start nicht erreicht ist', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.xml.value = xmltv([{ ...TAGESSCHAU, start: '2026-10-05T19:55:00+02:00', stop: '2026-10-05T20:10:00+02:00' }, FILLER]);
  ctx.clock.set('2026-10-05T19:50:00+02:00');
  await ctx.scheduler.checkSlips();
  const updated = ctx.store.get(entry.id);
  assert.equal(logic.parseIsoWithOffset(updated.epgStart), Date.parse('2026-10-05T19:55:00+02:00'));
  assert.deepEqual(kinds(ctx.events), ['slip']);
});

test('Slip: ist der Start erreicht, wird nichts mehr übernommen (und kein Refresh ausgelöst)', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.xml.value = xmltv([{ ...TAGESSCHAU, start: '2026-10-05T20:10:00+02:00', stop: '2026-10-05T20:25:00+02:00' }, FILLER]);
  ctx.clock.set('2026-10-05T19:58:00+02:00');
  await ctx.scheduler.checkSlips();
  assert.deepEqual(ctx.refreshCalls, []);
  assert.equal(ctx.store.get(entry.id).epgStart, entry.epgStart);
});

test('Slip: Sendung aus dem EPG entfernt → Eintrag BLEIBT (scheduled), Warnung statt Löschen', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.xml.value = xmltv([FILLER]);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await ctx.scheduler.checkSlips();
  const kept = ctx.store.get(entry.id);
  assert.equal(kept.state, 'scheduled');
  assert.equal(kept.epgStart, entry.epgStart);
  assert.ok(kept.note.startsWith(SLIP_WARN_PREFIX));
  assert.deepEqual(kinds(ctx.events), ['slip-removed']);
  // Der Eintrag startet trotzdem zur geplanten Zeit
  ctx.clock.set('2026-10-05T19:58:10+02:00');
  await ctx.scheduler.tick();
  assert.equal(ctx.recorder.startCalls.length, 1);
});

test('Slip: geänderter Titel gilt als „nicht mehr im EPG“; größere Verschiebung als 3 h ebenfalls', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.xml.value = xmltv([{ ...TAGESSCHAU, title: 'Brennpunkt' }, FILLER]);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await ctx.scheduler.checkSlips();
  assert.ok(ctx.store.get(entry.id).note.startsWith(SLIP_WARN_PREFIX));
  assert.equal(slip.evaluateSlip({ ...entry }, [{ title: 'Tagesschau', start: Date.parse('2026-10-05T23:30:00+02:00'), stop: Date.parse('2026-10-05T23:45:00+02:00') }]).kind, 'removed');
});

test('Slip: Wiederauftauchen der Sendung räumt die Warnung ab', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.xml.value = xmltv([FILLER]);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await ctx.scheduler.checkSlips();
  assert.ok(ctx.store.get(entry.id).note);
  // Fenster-Neuöffnung simulieren: Prüfzeit liegt vor der Fensteröffnung
  ctx.store.update(entry.id, { lastSlipCheck: '2026-10-05T10:00:00.000Z' });
  ctx.xml.value = xmltv([TAGESSCHAU, FILLER]);
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.store.get(entry.id).note, null);
});

test('Slip ist idempotent: einmal pro Eintrag/Fenster, auch nach Neustart (lastSlipCheck)', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await ctx.scheduler.checkSlips();
  await ctx.scheduler.checkSlips();
  ctx.clock.set('2026-10-05T19:53:00+02:00');
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.refreshCalls.length, 1);
  assert.equal(ctx.events.filter(e => e[0] === 'notify').length, 0, 'unverändert → keine Meldung');
  assert.ok(ctx.store.get(entry.id).lastSlipCheck);
  // „Neustart“: neuer Store + neuer Scheduler auf derselben Datei
  const store2 = createScheduleStore({ dir: ctx.dir, now: ctx.clock.now });
  store2.load();
  const calls = [];
  const scheduler2 = new Scheduler({
    store: store2,
    recorder: new FakeRecorder(),
    resolveStream: async () => ({ ok: true, url: 'https://x/y.m3u8' }),
    getSettings: () => ctx.settings,
    now: ctx.clock.now,
    refreshEpg: async () => {
      calls.push(1);
      return { ok: true };
    },
    epgRange: () => [],
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
  });
  await scheduler2.checkSlips();
  assert.equal(calls.length, 0);
});

test('Slip nach Verschiebung nach hinten: das neue Fenster prüft ein zweites Mal', async () => {
  const ctx = await setup();
  addTagesschau(ctx);
  ctx.xml.value = xmltv([{ ...TAGESSCHAU, start: '2026-10-05T20:10:00+02:00', stop: '2026-10-05T20:25:00+02:00' }, FILLER]);
  ctx.clock.set('2026-10-05T19:48:30+02:00');
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.refreshCalls.length, 1);
  ctx.clock.set('2026-10-05T19:55:00+02:00'); // neues Fenster öffnet erst 19:58
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.refreshCalls.length, 1);
  ctx.clock.set('2026-10-05T20:00:30+02:00'); // neues Fenster [20:00, 20:08)
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.refreshCalls.length, 2);
});

test('Refresh-Fehler: alter Cache bleibt, Eintrag unverändert, kein Absturz; Wiederholung erst nach Wartezeit', async () => {
  const ctx = await setup();
  const entry = addTagesschau(ctx);
  ctx.fail.on = true;
  ctx.xml.value = xmltv([FILLER]);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.store.get(entry.id).lastSlipCheck, null);
  assert.equal(ctx.store.get(entry.id).note, null);
  assert.equal(ctx.events.filter(e => e[0] === 'notify').length, 0);
  assert.ok(ctx.epg.find('DasErste.de', Date.parse('2026-10-05T20:05:00+02:00')), 'alter EPG-Cache bleibt');
  ctx.clock.advance(MIN);
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.refreshCalls.length, 1, 'innerhalb der Wartezeit kein weiterer Versuch');
  ctx.fail.on = false;
  ctx.clock.advance(3 * MIN);
  await ctx.scheduler.checkSlips();
  assert.equal(ctx.refreshCalls.length, 2);
  assert.ok(ctx.store.get(entry.id).note.startsWith(SLIP_WARN_PREFIX));
});

test('Refresh wirft: wird abgefangen (kein unbehandelter Fehler)', async () => {
  const ctx = await setup({
    schedulerOverrides: {
      refreshEpg: async () => {
        throw new Error('boom');
      },
    },
  });
  addTagesschau(ctx);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await assert.doesNotReject(ctx.scheduler.checkSlips());
  assert.ok(ctx.logs.some(l => /Refresh fehlgeschlagen/.test(l)));
});

test('Konflikt nach Slip: Eintrag wird verschoben, Warnung (slip-conflict) wegen Parallel-Limit', async () => {
  const ctx = await setup({ schedulerOverrides: { recorderOptions: { maxParallel: 1 } } });
  const entry = addTagesschau(ctx);
  // Anderer Sender 20:30–20:50 (Puffer 2/5): kollidiert erst nach der Verschiebung (Fenster bis 20:30)
  ctx.store.add({
    ...input({ channelId: 'zdf', channelName: 'ZDF', tvgId: 'ZDF.de', title: 'Krimi', epgStart: '2026-10-05T20:30:00+02:00', epgStop: '2026-10-05T20:50:00+02:00' }),
    bufferBeforeSec: 120,
    bufferAfterSec: 300,
    state: 'scheduled',
  });
  ctx.xml.value = xmltv([{ ...TAGESSCHAU, start: '2026-10-05T20:10:00+02:00', stop: '2026-10-05T20:25:00+02:00' }, FILLER]);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await ctx.scheduler.checkSlips();
  const updated = ctx.store.get(entry.id);
  assert.equal(logic.parseIsoWithOffset(updated.epgStart), Date.parse('2026-10-05T20:10:00+02:00'));
  assert.match(updated.note, /Parallel-Limit|gleichzeitig/);
  assert.deepEqual(kinds(ctx.events), ['slip-conflict']);
});

test('Zusammengelegte Einträge („A + B“) sind vom Slip ausgenommen (kein falscher „entfernt“-Alarm)', async () => {
  const ctx = await setup({
    initial: [
      TAGESSCHAU,
      { title: 'Tagesthemen', start: '2026-10-05T20:15:00+02:00', stop: '2026-10-05T20:45:00+02:00' },
      FILLER,
    ],
  });
  const a = addTagesschau(ctx);
  const b = ctx.scheduler.addEntry(
    input({ title: 'Tagesthemen', epgStart: '2026-10-05T20:15:00+02:00', epgStop: '2026-10-05T20:45:00+02:00', mergeWithId: a.id }),
  );
  assert.equal(b.ok, true);
  assert.equal(b.merged, true);
  assert.equal(ctx.store.get(a.id).merged, true);
  ctx.clock.set('2026-10-05T19:49:00+02:00');
  await ctx.scheduler.checkSlips();
  assert.deepEqual(ctx.refreshCalls, []);
  assert.equal(ctx.store.get(a.id).note, 'Zwei Sendungen zu einer durchgehenden Aufnahme zusammengelegt');
});

test('Mittelpunkt-Regel bleibt nach Slip konsistent (zwei Einträge desselben Kanals, Fenster überlappen nicht)', async () => {
  const ctx = await setup({
    initial: [TAGESSCHAU, { title: 'Tagesthemen', start: '2026-10-05T20:15:00+02:00', stop: '2026-10-05T20:45:00+02:00' }, FILLER],
  });
  const a = addTagesschau(ctx);
  const b = ctx.scheduler.addEntry(input({ title: 'Tagesthemen', epgStart: '2026-10-05T20:15:00+02:00', epgStop: '2026-10-05T20:45:00+02:00' }));
  assert.equal(b.ok, true);
  assert.equal(b.merged, false);
  ctx.xml.value = xmltv([
    { ...TAGESSCHAU, start: '2026-10-05T20:05:00+02:00', stop: '2026-10-05T20:20:00+02:00' },
    { title: 'Tagesthemen', start: '2026-10-05T20:20:00+02:00', stop: '2026-10-05T20:50:00+02:00' },
    FILLER,
  ]);
  ctx.clock.set('2026-10-05T19:55:00+02:00');
  await ctx.scheduler.checkSlips();
  const win = ctx.scheduler.upcomingWindows();
  const wa = win.find(w => w.id === a.id);
  const wb = win.find(w => w.id === b.entry.id);
  assert.ok(wa.endMs <= wb.startMs, 'Fenster überlappen nicht (abgeleitete Mittelpunkt-Grenze)');
  assert.equal(wa.epgStopMs, Date.parse('2026-10-05T20:20:00+02:00'));
});

test('Der Takt wartet nicht auf den Refresh: ein langsamer Download verzögert keinen Start', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const ctx = await setup({
    schedulerOverrides: {
      refreshEpg: async () => {
        await gate;
        return { ok: true };
      },
    },
  });
  addTagesschau(ctx);
  ctx.store.add({
    ...input({ channelId: 'zdf', channelName: 'ZDF', tvgId: 'ZDF.de', title: 'Krimi', epgStart: '2026-10-05T19:50:00+02:00', epgStop: '2026-10-05T20:50:00+02:00' }),
    bufferBeforeSec: 0,
    bufferAfterSec: 0,
    state: 'scheduled',
  });
  ctx.clock.set('2026-10-05T19:50:30+02:00');
  await ctx.scheduler.tick();
  assert.equal(ctx.recorder.startCalls.length, 1, 'ZDF startet trotz hängendem Refresh');
  release();
  await ctx.scheduler.checkSlips();
});

test('EpgService.refreshForSource lädt nur die EPG-URL der betroffenen Quelle; ohne Quelle ok:false', async () => {
  const clock = makeClock();
  const fetched = [];
  const epg = new EpgService({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'slip-epg2-')),
    getSources: () => [
      { id: 'q1', epgUrl: 'https://epg.example/q1.xml' },
      { id: 'q2', epgUrl: 'https://epg.example/q2.xml' },
    ],
    fetchImpl: async url => {
      fetched.push(url);
      return new Response(Buffer.from(xmltv([TAGESSCHAU, FILLER])), { status: 200 });
    },
    now: clock.now,
    autoRefresh: false,
  });
  const ok = await epg.refreshForSource('q2');
  assert.equal(ok.ok, true);
  assert.deepEqual(fetched, ['https://epg.example/q2.xml']);
  const none = await epg.refreshForSource('gibtsnicht');
  assert.equal(none.ok, false);
  assert.equal(fetched.length, 1);
});

test('schedule-slip: Titel-Normalisierung, nächster Treffer gewinnt, Fälligkeit', () => {
  assert.equal(slip.normalizeTitle('  Tages\u0007schau  '), 'tages schau');
  const entry = { title: 'Serie', epgStart: '2026-10-05T20:00:00+02:00', epgStop: '2026-10-05T21:00:00+02:00', bufferBeforeSec: 120, bufferAfterSec: 300, state: 'scheduled', lastSlipCheck: null };
  const t = iso => Date.parse(iso);
  const slots = [
    { title: 'Serie', start: t('2026-10-05T17:30:00+02:00'), stop: t('2026-10-05T18:30:00+02:00') },
    { title: 'serie', start: t('2026-10-05T20:10:00+02:00'), stop: t('2026-10-05T21:10:00+02:00') },
  ];
  const v = slip.evaluateSlip(entry, slots);
  assert.equal(v.kind, 'moved');
  assert.equal(v.startMs, t('2026-10-05T20:10:00+02:00'));
  assert.equal(slip.evaluateSlip(entry, [{ title: 'Serie', start: t(entry.epgStart), stop: t(entry.epgStop) }]).kind, 'unchanged');
  const lead = 10 * MIN;
  assert.equal(slip.isSlipDue(entry, t('2026-10-05T19:47:59+02:00'), lead), false);
  assert.equal(slip.isSlipDue(entry, t('2026-10-05T19:48:00+02:00'), lead), true);
  assert.equal(slip.isSlipDue(entry, t('2026-10-05T19:57:59+02:00'), lead), true);
  assert.equal(slip.isSlipDue(entry, t('2026-10-05T19:58:00+02:00'), lead), false);
  assert.equal(slip.isSlipDue({ ...entry, state: 'cancelled' }, t('2026-10-05T19:50:00+02:00'), lead), false);
});

test('Store behält `merged` über den Neustart; die Statuszeile „Geplant“ zeigt Slip-Hinweise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slip-store-'));
  const store = createScheduleStore({ dir });
  const e = store.add({ ...input(), bufferBeforeSec: 0, bufferAfterSec: 0, merged: true, note: 'Hinweis' });
  const reloaded = createScheduleStore({ dir });
  reloaded.load();
  assert.equal(reloaded.get(e.id).merged, true);
  assert.equal(createScheduleStore({ dir }).load() >= 1, true);
  const ui = require('../lib/recorder/schedule-ui-model.js');
  assert.equal(ui.scheduleStatusText({ state: 'scheduled', note: 'Sendezeit geändert' }), 'Geplant — Sendezeit geändert');
  assert.equal(ui.scheduleStatusText({ state: 'scheduled', note: null }), 'Geplant');
  assert.equal(ui.scheduleStatusText({ state: 'scheduled', merged: true, note: 'Zwei Sendungen zusammengelegt' }), 'Geplant');
});
