'use strict';

// Tests: Parallel-Limit als Soft-Limit (Etappe 1, Befund L2).
// Ohne force ein unterscheidbarer Fehler (code PARALLEL_LIMIT), mit force wird
// bewusst überschritten; IPC liefert das Ergebnis als Objekt (invoke reicht nur
// Message-Strings durch). Limit ist zur Laufzeit einstellbar und geklemmt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecorderLimitError } = require('../lib/recorder/RecorderService.js');
const { registerRecorderIpc } = require('../lib/recorder/ipc.js');
const { makeFakeService, REQUEST } = require('./helpers/recorder-fakes.js');

const ZDF = { ...REQUEST, channelId: 'zdf', channelName: 'ZDF' };
const ARTE = { ...REQUEST, channelId: 'arte', channelName: 'Arte' };

test('Soft-Limit: ohne force RecorderLimitError (code PARALLEL_LIMIT) mit limit/active', async () => {
  const { service } = makeFakeService({ maxParallel: 1 });
  const first = await service.start(REQUEST);
  await assert.rejects(
    () => service.start(ZDF),
    err => {
      assert.ok(err instanceof RecorderLimitError);
      assert.equal(err.code, 'PARALLEL_LIMIT');
      assert.equal(err.limit, 1);
      assert.equal(err.active, 1);
      assert.match(err.message, /paralleler Aufnahmen/);
      return true;
    },
  );
  assert.equal(service.activeJobs().length, 1, 'abgelehnter Start hinterlässt keinen Job');
  await service.stop(first.recId);
});

test('Soft-Limit: force überschreitet das Limit; Duplikat-Schutz bleibt hart', async () => {
  const { service } = makeFakeService({ maxParallel: 1 });
  const first = await service.start(REQUEST);
  const second = await service.start(ZDF, { force: true });
  assert.equal(service.activeJobs().length, 2);
  // Duplikat pro Kanal wird auch mit force abgelehnt
  await assert.rejects(() => service.start(ZDF, { force: true }), /Duplikat/);
  // force: false/undefined verhält sich wie ohne
  await assert.rejects(() => service.start(ARTE, { force: false }), err => err.code === 'PARALLEL_LIMIT');
  await service.stop(second.recId);
  await service.stop(first.recId);
});

test('Soft-Limit: Limit ist zur Laufzeit änderbar und wird geklemmt (1..10)', async () => {
  const { service } = makeFakeService({ maxParallel: 1 });
  const first = await service.start(REQUEST);
  assert.equal(service.setLimits({ maxParallel: 2 }).maxParallel, 2);
  const second = await service.start(ZDF); // jetzt ohne force möglich
  await assert.rejects(() => service.start(ARTE), err => err.code === 'PARALLEL_LIMIT');
  assert.equal(service.setLimits({ maxParallel: 0 }).maxParallel, 1);
  assert.equal(service.setLimits({ maxParallel: 999 }).maxParallel, 10);
  assert.equal(makeFakeService({}).service.maxParallel, 3, 'Default 3');
  await service.stop(second.recId);
  await service.stop(first.recId);
});

function makeIpcHarness(service) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const webContents = { send: () => {} };
  const mainWindow = { webContents };
  registerRecorderIpc({ ipcMain, recorder: service, mainWindow });
  const event = { sender: webContents };
  return { call: (channel, ...args) => handlers.get(channel)(event, ...args), handlers };
}

test('IPC recording:start: Limit kommt als unterscheidbares Ergebnis, force startet', async () => {
  const { service } = makeFakeService({ maxParallel: 1 });
  const ipc = makeIpcHarness(service);
  const first = await ipc.call('recording:start', REQUEST);
  assert.ok(first.recId);

  const limited = await ipc.call('recording:start', ZDF);
  assert.equal(limited.code, 'PARALLEL_LIMIT');
  assert.equal(limited.limit, 1);
  assert.equal(limited.active, 1);
  assert.equal(limited.recId, undefined);

  const forced = await ipc.call('recording:start', { ...ZDF, force: true });
  assert.ok(forced.recId, 'force=true startet trotz Limit');
  // andere Fehler werden weiterhin geworfen
  await assert.rejects(() => ipc.call('recording:start', { ...ZDF, force: true }), /Duplikat/);
  // Fremder Sender → abgelehnt
  await assert.rejects(
    () => ipc.handlers.get('recording:start')({ sender: {} }, REQUEST),
    /nicht autorisiert/,
  );
  await service.stop(forced.recId);
  await service.stop(first.recId);
});
