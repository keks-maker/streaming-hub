'use strict';

// Tests: IPC-Validierung und -Handler der Planung (Etappe 2a; Konzept §3.8).
// Fremder Sender wird abgelehnt, epgStart ≤ jetzt wird im MAIN abgelehnt,
// Puffer > 30 min, zu lange Texte, ISO ohne Offset, nur Whitelist-Felder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const validation = require('../lib/ipc-validation.js');
const { registerScheduleIpc } = require('../lib/recorder/ipc-schedule.js');
const { makeScheduler, input } = require('./helpers/schedule-fakes.js');

const NOW = Date.parse('2026-10-05T19:00:00+02:00');
const v = (over = {}) => validation.validateScheduleInput(input(over), { nowMs: NOW });

test('Validierung: gültige Eingabe wird normalisiert übernommen', () => {
  const out = v({ bufferBeforeSec: 0, bufferAfterSec: 1800, allowOverLimit: true });
  assert.equal(out.channelId, 'das-erste');
  assert.equal(out.bufferBeforeSec, 0);
  assert.equal(out.bufferAfterSec, 1800);
  assert.equal(out.allowOverLimit, true);
  assert.equal(out.epgStart, '2026-10-05T20:00:00+02:00');
  // Kanal-IDs mit Leerzeichen/@ sind (wie bei recording:start) erlaubt
  assert.equal(v({ channelId: 'DasErste.de@HD', channelName: 'Kanal 21' }).channelId, 'DasErste.de@HD');
});

test('Validierung: ID per Regex', () => {
  assert.equal(validation.validateScheduleId('sch_abc-1.2_X'), 'sch_abc-1.2_X');
  for (const bad of ['rec_1', 'sch_', 'sch_a b', '../etc', 'sch_a/b', '', null, 5, 'sch_' + 'a'.repeat(200)]) {
    assert.throws(() => validation.validateScheduleId(bad), /Ungültige Planungs-ID/);
  }
});

test('Validierung: Zeiten strikt (ISO mit Offset), Stopp nach Start, max. 24 h, Plausibilitätsgrenzen', () => {
  for (const bad of ['2026-10-05T20:00:00', '05.10.2026 20:00', 'morgen', '2026-02-30T20:00:00Z', 1790000000000, '', null]) {
    assert.throws(() => v({ epgStart: bad }), /Startzeit/);
    assert.throws(() => v({ epgStop: bad }), /Endzeit/);
  }
  assert.throws(() => v({ epgStop: '2026-10-05T20:00:00+02:00' }), /Ende der Sendung muss nach dem Start/);
  assert.throws(() => v({ epgStop: '2026-10-05T19:00:00+02:00' }), /Ende der Sendung muss nach dem Start/);
  assert.throws(() => v({ epgStop: '2026-10-06T20:00:01+02:00' }), /höchstens 24 Stunden/);
  assert.doesNotThrow(() => v({ epgStop: '2026-10-06T20:00:00+02:00' }));
  assert.throws(() => v({ epgStart: '2027-10-05T20:00:00+02:00', epgStop: '2027-10-05T21:00:00+02:00' }), /außerhalb des planbaren Bereichs/);
  assert.throws(() => v({ epgStart: '2020-10-05T20:00:00+02:00', epgStop: '2020-10-05T21:00:00+02:00' }), /außerhalb des planbaren Bereichs/);
});

test('Validierung: Puffer 0–30 min, ganzzahlige Sekunden', () => {
  assert.throws(() => v({ bufferBeforeSec: 1801 }), /Vorlauf/);
  assert.throws(() => v({ bufferAfterSec: 31 * 60 }), /Nachlauf/);
  assert.throws(() => v({ bufferBeforeSec: -1 }), /Vorlauf/);
  assert.throws(() => v({ bufferBeforeSec: 1.5 }), /Vorlauf/);
  assert.throws(() => v({ bufferBeforeSec: '120' }), /Vorlauf/);
  assert.doesNotThrow(() => v({ bufferBeforeSec: 1800, bufferAfterSec: 0 }));
});

test('Validierung: Titel ≤ 300, Beschreibung ≤ 2000, Kanal ≤ 200, Steuerzeichen verboten, tvgId/sourceId begrenzt', () => {
  assert.throws(() => v({ title: 'x'.repeat(301) }), /Titel ist zu lang/);
  assert.throws(() => v({ title: '   ' }), /Titel fehlt/);
  assert.throws(() => v({ title: undefined }), /Titel fehlt/);
  assert.doesNotThrow(() => v({ title: 'x'.repeat(300) }));
  assert.throws(() => v({ description: 'x'.repeat(2001) }), /Beschreibung ist zu lang/);
  assert.doesNotThrow(() => v({ description: 'x'.repeat(2000) }));
  assert.throws(() => v({ channelName: 'x'.repeat(201) }), /Kanalname/);
  assert.throws(() => v({ channelId: 'a\u0000b' }), /Steuerzeichen/);
  assert.throws(() => v({ channelName: 'a\nb' }), /Steuerzeichen/);
  assert.throws(() => v({ tvgId: 'x'.repeat(201) }), /tvg-id/);
  assert.throws(() => v({ sourceId: 'q\u001f' }), /Steuerzeichen/);
  assert.throws(() => v({ channelId: '', channelName: '' }), /channelId oder channelName/);
  assert.throws(() => v({ sourceUrlSnapshot: 'file:///etc/passwd' }), /http\/https/);
  assert.throws(() => v({ allowOverLimit: 'yes' }), /Boolean/);
  assert.throws(() => v({ mergeWithId: '../x' }), /Planungs-ID/);
  assert.throws(() => validation.validateScheduleInput(null, { nowMs: NOW }), /Ungültige Planungs-Anfrage/);
  assert.throws(() => validation.validateScheduleInput([], { nowMs: NOW }), /Ungültige Planungs-Anfrage/);
});

test('Validierung: unbekannte Felder werden verworfen (kein Durchreichen, z. B. state/recId/Pfade)', () => {
  const out = v({ state: 'done', recId: 'rec_x', id: 'sch_x', outputPath: '/etc', command: 'rm -rf' });
  for (const key of ['state', 'recId', 'id', 'outputPath', 'command']) assert.equal(out[key], undefined);
});

test('Update-Validierung: nur Whitelist-Felder; Zeiten nur gemeinsam', () => {
  assert.deepEqual(validation.validateScheduleUpdate('sch_a', { bufferBeforeSec: 60 }, { nowMs: NOW }), { bufferBeforeSec: 60 });
  assert.throws(() => validation.validateScheduleUpdate('sch_a', { state: 'done' }, { nowMs: NOW }), /darf nicht geändert werden/);
  assert.throws(() => validation.validateScheduleUpdate('sch_a', { title: 'x' }, { nowMs: NOW }), /darf nicht geändert werden/);
  assert.throws(() => validation.validateScheduleUpdate('sch_a', { epgStart: '2026-10-05T20:00:00+02:00' }, { nowMs: NOW }), /gemeinsam/);
  assert.throws(() => validation.validateScheduleUpdate('sch_a', { bufferAfterSec: 99999 }, { nowMs: NOW }), /Nachlauf/);
  assert.throws(() => validation.validateScheduleUpdate('x', {}, { nowMs: NOW }), /Planungs-ID/);
});

// ── Handler ──

function setup() {
  const ctx = makeScheduler();
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const mainSender = { id: 'main' };
  const requireMainRenderer = event => {
    if (event?.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
  };
  const broadcasts = [];
  registerScheduleIpc({
    ipcMain, scheduler: ctx.scheduler, requireMainRenderer, now: ctx.clock.now,
    broadcast: (channel, payload) => broadcasts.push([channel, payload]),
  });
  const call = async (channel, ...args) => handlers.get(channel)({ sender: mainSender }, ...args);
  return { ...ctx, handlers, call, broadcasts, mainSender };
}

test('Handler: genau die erwarteten Kanäle sind registriert', () => {
  const { handlers } = setup();
  assert.deepEqual([...handlers.keys()].sort(), [
    'schedule:add', 'schedule:check-conflicts', 'schedule:list', 'schedule:remove', 'schedule:update',
  ]);
});

test('Handler: fremder Sender (auch Webview/anderes Fenster) wird bei jedem Kanal abgelehnt', () => {
  const { handlers, scheduler } = setup();
  for (const [channel, fn] of handlers) {
    assert.throws(() => fn({ sender: { id: 'fremd' } }, input(), input()), /nicht autorisiertem Renderer/, channel);
    assert.throws(() => fn({}, 'sch_x'), /nicht autorisiertem Renderer/, channel);
    assert.throws(() => fn(undefined), /nicht autorisiertem Renderer/, channel);
  }
  assert.equal(scheduler.list().length, 0, 'nichts angelegt');
});

test('Handler: add/list/update/remove-Ablauf; Broadcast schedule:changed bei jeder Änderung', async () => {
  const { call, broadcasts } = setup();
  const added = await call('schedule:add', input());
  assert.equal(added.ok, true);
  assert.equal((await call('schedule:list')).length, 1);
  const upd = await call('schedule:update', added.entry.id, { bufferAfterSec: 60 });
  assert.equal(upd.entry.bufferAfterSec, 60);
  const removed = await call('schedule:remove', added.entry.id);
  assert.equal(removed.entry.state, 'cancelled');
  assert.deepEqual(broadcasts.map(([c, p]) => `${c}:${p.reason}`), [
    'schedule:changed:added', 'schedule:changed:updated', 'schedule:changed:cancelled',
  ]);
});

test('Handler: epgStart ≤ jetzt wird im MAIN abgelehnt (laufend/vorbei, Meldungen aus §3.7)', async () => {
  const { call, clock, scheduler } = setup();
  clock.set('2026-10-05T20:05:00+02:00');
  await assert.rejects(() => call('schedule:add', input()), /läuft bereits und kann nicht mehr geplant werden/);
  clock.set('2026-10-05T20:30:00+02:00');
  await assert.rejects(() => call('schedule:add', input()), /bereits vorbei und kann nicht aufgenommen werden/);
  await assert.rejects(() => call('schedule:check-conflicts', input()), /bereits vorbei/);
  assert.equal(scheduler.list().length, 0);
});

test('Handler: Puffer > 30 min, zu lange Titel, Zeiten ohne Offset werden abgelehnt', async () => {
  const { call, scheduler } = setup();
  await assert.rejects(() => call('schedule:add', input({ bufferBeforeSec: 1801 })), /Vorlauf/);
  await assert.rejects(() => call('schedule:add', input({ bufferAfterSec: 3600 })), /Nachlauf/);
  await assert.rejects(() => call('schedule:add', input({ title: 'T'.repeat(301) })), /Titel ist zu lang/);
  await assert.rejects(() => call('schedule:add', input({ epgStart: '2026-10-05T20:00:00' })), /Zeitzonen-Offset/);
  await assert.rejects(() => call('schedule:update', 'sch_x', { bufferBeforeSec: 5000 }), /Vorlauf/);
  await assert.rejects(() => call('schedule:remove', '../../etc'), /Planungs-ID/);
  assert.equal(scheduler.list().length, 0);
});

test('Handler: Konflikt kommt als Ergebnisobjekt (kein Wurf), allowOverLimit bestätigt', async () => {
  const ctx = makeScheduler({ recorderOptions: { maxParallel: 1 } });
  const handlers = new Map();
  const sender = {};
  registerScheduleIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, scheduler: ctx.scheduler, now: ctx.clock.now,
    requireMainRenderer: e => { if (e.sender !== sender) throw new Error('x'); },
  });
  const call = (c, ...a) => handlers.get(c)({ sender }, ...a);
  await call('schedule:add', input());
  const other = input({ channelId: 'zdf', channelName: 'ZDF', tvgId: 'ZDF.de' });
  const conflict = await call('schedule:add', other);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CONFLICT');
  assert.equal(conflict.conflict.limit, 1);
  const forced = await call('schedule:add', { ...other, allowOverLimit: true });
  assert.equal(forced.ok, true);
});

test('Quelltext: main.js registriert die Planungs-IPC hinter requireMainRenderer; preload exponiert nur die Whitelist', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /registerScheduleIpc\(\{[\s\S]*?requireMainRenderer/);
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  for (const name of ['addSchedule', 'updateSchedule', 'removeSchedule', 'listSchedules', 'checkScheduleConflicts', 'onScheduleChanged']) {
    assert.match(preload, new RegExp(`${name}:`));
  }
  // nichts Generisches: keine Weitergabe frei wählbarer Kanalnamen im Planungsblock
  const block = preload.slice(preload.indexOf('Planung geplanter Aufnahmen'), preload.indexOf('// Autoupdate'));
  assert.ok(!/ipcRenderer\.(send|invoke)\([a-zA-Z]/.test(block), 'nur feste Kanalnamen als Literale');
  assert.equal((block.match(/ipcRenderer\.invoke\('schedule:/g) || []).length, 5);
});

test('Titel/Beschreibung: Steuerzeichen werden zu Leerzeichen normalisiert, Grenzen exakt 300/2000', () => {
  const out = v({ title: '  Tag\u0000es\tschau\n\nSpezial  ', description: 'a\u0007b\r\nc' });
  assert.equal(out.title, 'Tag es schau Spezial');
  assert.equal(out.description, 'a b c');
  assert.equal(v({ title: 'x'.repeat(300) }).title.length, 300);
  assert.throws(() => v({ title: 'x'.repeat(301) }), /zu lang/);
  assert.equal(v({ description: 'y'.repeat(2000) }).description.length, 2000);
  assert.throws(() => v({ description: 'y'.repeat(2001) }), /zu lang/);
  assert.throws(() => v({ title: '\u0000\u0001' }), /Titel fehlt/);
});
