'use strict';

// Tests: IPC der Downloads (ipc.js, validation.js): Hauptfenster-Pflicht, Schema-Prüfung, Kanäle, Serien-Batch über die Mediathek,
// Drosselung des Ereignisses downloads:changed, play-info/reveal nur aus dem eigenen Index.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerDownloadIpc } = require('../lib/download/ipc.js');
const v = require('../lib/download/validation.js');

const ENTRY = { id: 'E1', title: 'Folge 1', sourceId: 'ard', season: 1, episode: 1 };
const SERIES = { id: 'SER1', title: 'Serie', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/SER1?embedded=true' };
const ID = 'dl_abcd1234';

function setup(over = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const sent = [];
  const calls = [];
  const service = Object.assign(new EventEmitter(), {
    summary: () => ({ queued: 0, active: 0, paused: 0, scheduled: 0, done: 0, failed: 0 }),
    storageRoot: () => '/root/Mediathek',
    freeBytes: () => 123,
    list: () => [{ id: ID }],
    preview: async input => (calls.push(['preview', input]), { ok: true }),
    enqueue: input => (calls.push(['enqueue', input]), { ok: true, id: ID, status: 'resolving' }),
    enqueueMany: input => (calls.push(['enqueueMany', input]), { ok: true, results: input.entries.map(e => ({ entryId: e.id, ok: true, id: ID })), added: input.entries.length }),
    pause: id => (calls.push(['pause', id]), { ok: true }),
    resume: id => (calls.push(['resume', id]), { ok: true }),
    cancel: id => (calls.push(['cancel', id]), { ok: true }),
    retry: id => (calls.push(['retry', id]), { ok: true }),
    remove: (id, options) => (calls.push(['remove', id, options]), { ok: true }),
    fileInfo: id => (id === ID ? { path: '/root/Mediathek/ARD/Serie/S01E01.mp4', record: { title: 'Folge', entry: { title: 'Folge 1', sourceId: 'ard', id: 'E1' }, seriesTitle: 'Serie', durationSec: 1800 } } : null),
  });
  const settings = {
    response: result => ({ container: 'mp4', ...(result ? { patched: true } : {}) }),
    defaults: () => ({ container: 'mp4', defaults: true }),
    patch: patch => (calls.push(['patch', patch]), { settings: patch, clamped: {} }),
  };
  const timers = [];
  let nowMs = 1000;
  const main = {};
  registerDownloadIpc({
    ipcMain,
    service,
    settings,
    mediathek: { fetchEpisodes: async () => [ENTRY, { ...ENTRY, id: 'E2' }, { ...ENTRY, id: 'E3' }] },
    requireMainRenderer: event => {
      if (event !== main) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
    sendToMain: (channel, payload) => sent.push({ channel, payload }),
    validateRoot: root => (root.startsWith('/ok') ? { ok: true, error: null, freeBytes: 99 } : { ok: false, error: 'nicht beschreibbar', freeBytes: null }),
    showItemInFolder: file => calls.push(['reveal', file]),
    getProgress: () => ({ start: 42 }),
    isNetworkPath: root => root.startsWith('/Volumes'),
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    now: () => nowMs,
    ...over,
  });
  const invoke = (channel, ...args) => handlers.get(channel)(main, ...args);
  return { handlers, invoke, service, sent, calls, timers, setNow: ms => { nowMs = ms; }, main };
}

test('Alle Kanäle registriert und nur für das Hauptfenster', async () => {
  const env = setup();
  const channels = ['settings-get', 'settings-set', 'settings-defaults', 'validate-root', 'pick-folder', 'plan', 'enqueue', 'enqueue-many', 'list', 'pause', 'resume', 'cancel', 'retry', 'remove', 'reveal', 'play-info'].map(name => `downloads:${name}`);
  assert.deepEqual([...env.handlers.keys()].sort(), channels.sort());
  for (const channel of channels) assert.throws(() => env.handlers.get(channel)({}, {}), /nicht autorisiert/, channel);
});

test('Einstellungen: lesen, Standard, Patch mit Prüfung des Speicherorts', async () => {
  const env = setup();
  assert.equal(env.invoke('downloads:settings-get').container, 'mp4');
  assert.equal(env.invoke('downloads:settings-defaults').defaults, true);
  assert.deepEqual(env.invoke('downloads:settings-set', { storageRoot: '/nope/x' }), { ok: false, error: 'nicht beschreibbar' });
  assert.equal(env.calls.filter(call => call[0] === 'patch').length, 0);
  const ok = env.invoke('downloads:settings-set', { storageRoot: '/ok/dir', container: 'mkv' });
  assert.equal(ok.ok, true);
  assert.deepEqual(env.calls.find(call => call[0] === 'patch')[1], { storageRoot: '/ok/dir', container: 'mkv' });
  assert.equal(env.invoke('downloads:settings-set', { storageRoot: null }).ok, true); // zurück auf Standard
  assert.throws(() => env.invoke('downloads:settings-set', { unbekannt: 1 }), /Unbekanntes Feld/);
  assert.throws(() => env.invoke('downloads:settings-set', 'x'), /ungültig/);
  assert.throws(() => env.invoke('downloads:settings-get', { x: 1 }));
});

test('validate-root: Prüfergebnis plus Netzwerkpfad-Hinweis', () => {
  const env = setup();
  assert.deepEqual(env.invoke('downloads:validate-root', { root: '/ok/a' }), { ok: true, error: null, freeBytes: 99, network: false });
  assert.deepEqual(env.invoke('downloads:validate-root', { root: '/Volumes/NAS' }), { ok: false, error: 'nicht beschreibbar', freeBytes: null, network: true });
  assert.throws(() => env.invoke('downloads:validate-root', { root: '' }), /ungültig/);
  assert.throws(() => env.invoke('downloads:validate-root', { root: 'x'.repeat(2000) }), /ungültig/);
});

test('plan/enqueue: Folge und Serie werden geprüft, Überschreibungen normalisiert, unbekannte Felder abgelehnt', async () => {
  const env = setup();
  await env.invoke('downloads:plan', { entry: ENTRY, series: SERIES, overrides: { container: 'mkv', maxHeight: 720, audioDescription: 'kaputt' } });
  const preview = env.calls.find(call => call[0] === 'preview')[1];
  assert.equal(preview.entry.id, 'E1');
  assert.equal(preview.entry.streamUrl, null);
  assert.deepEqual(preview.overrides, { container: 'mkv', maxHeight: '720', audioDescription: 'never' });
  assert.deepEqual(env.invoke('downloads:enqueue', { entry: ENTRY }), { ok: true, id: ID, status: 'resolving' });
  assert.equal(env.calls.find(call => call[0] === 'enqueue')[1].series, null);
  assert.throws(() => env.invoke('downloads:enqueue', { entry: { ...ENTRY, streamUrl: 'https://x' } }), /Unbekanntes Feld: streamUrl/);
  assert.throws(() => env.invoke('downloads:enqueue', { entry: ENTRY, overrides: { maxParallel: 5 } }), /Unbekanntes Feld: maxParallel/);
  assert.throws(() => env.invoke('downloads:enqueue', { entry: { ...ENTRY, sourceId: 'evil' } }), /ungültig/);
  assert.throws(() => env.invoke('downloads:enqueue', { entry: ENTRY, series: { ...SERIES, extra: 1 } }), /Unbekanntes Feld/);
  assert.throws(() => env.invoke('downloads:enqueue', { entry: ENTRY, zusatz: 1 }), /Unbekanntes Feld/);
  assert.throws(() => env.invoke('downloads:enqueue'), /ungültig/);
});

test('plan: Fehler des Dienstes werden zum Ergebnis, nicht zur Exception', async () => {
  const env = setup();
  env.service.preview = async () => { throw Object.assign(new Error('kaputt'), { code: 'x' }); };
  assert.deepEqual(await env.invoke('downloads:plan', { entry: ENTRY }), { ok: false, code: 'x', message: 'kaputt' });
});

test('enqueue-many: Folgen kommen aus der Serie, unbekannte IDs werden gemeldet', async () => {
  const env = setup();
  const result = await env.invoke('downloads:enqueue-many', { series: SERIES, entryIds: ['E3', 'E1', 'XX', 'E1'] });
  const call = env.calls.find(entry => entry[0] === 'enqueueMany')[1];
  assert.deepEqual(call.entries.map(entry => entry.id), ['E1', 'E3']);
  assert.equal(result.added, 2);
  assert.deepEqual(result.results.at(-1), { entryId: 'XX', ok: false, code: 'unknown-entry', id: null, message: 'Folge nicht in der Serie gefunden.' });
  await assert.rejects(env.invoke('downloads:enqueue-many', { series: SERIES, entryIds: [] }), /ungültig/);
  await assert.rejects(env.invoke('downloads:enqueue-many', { series: SERIES, entryIds: Array.from({ length: 501 }, (_, i) => `E${i}`) }), /ungültig/);
  await assert.rejects(env.invoke('downloads:enqueue-many', { series: SERIES, entryIds: [5] }), /ungültig/);
});

test('enqueue-many: Serie nicht ladbar -> Fehlerergebnis', async () => {
  const env = setup({ mediathek: { fetchEpisodes: async () => { throw Object.assign(new Error('x'), { code: 'fetchFailed' }); } } });
  const result = await env.invoke('downloads:enqueue-many', { series: SERIES, entryIds: ['E1'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'fetchFailed');
  assert.equal(result.added, 0);
});

test('list, Steuerung und Löschen mit validierter ID', async () => {
  const env = setup();
  assert.deepEqual(env.invoke('downloads:list'), { ok: true, items: [{ id: ID }], summary: env.service.summary(), root: '/root/Mediathek', freeBytes: 123 });
  for (const action of ['pause', 'resume', 'cancel', 'retry']) assert.deepEqual(env.invoke(`downloads:${action}`, { id: ID }), { ok: true });
  assert.deepEqual(env.calls.filter(call => ['pause', 'resume', 'cancel', 'retry'].includes(call[0])).map(call => call[0]), ['pause', 'resume', 'cancel', 'retry']);
  env.invoke('downloads:remove', { id: ID, deleteFile: true });
  env.invoke('downloads:remove', { id: ID });
  assert.deepEqual(env.calls.filter(call => call[0] === 'remove').map(call => call[2]), [{ deleteFile: true }, { deleteFile: false }]);
  for (const bad of ['../x', 'dl_', 5, null, undefined, { id: '../../etc' }]) assert.throws(() => env.invoke('downloads:pause', bad && bad.id ? bad : { id: bad }), /Download-ID|ungültig/);
  assert.throws(() => env.invoke('downloads:remove', { id: ID, deleteFile: 'ja' }), /deleteFile/);
});

test('reveal/play-info: nur Dateien aus dem eigenen Index', () => {
  const env = setup();
  assert.deepEqual(env.invoke('downloads:reveal', { id: ID }), { ok: true });
  assert.deepEqual(env.calls.find(call => call[0] === 'reveal'), ['reveal', '/root/Mediathek/ARD/Serie/S01E01.mp4']);
  assert.equal(env.invoke('downloads:reveal', { id: 'dl_unknown99' }).code, 'missing');
  const info = env.invoke('downloads:play-info', { id: ID });
  assert.deepEqual(info, { ok: true, url: `dl://local/${ID}.mp4`, container: 'mp4', title: 'Folge', historyTitle: 'Folge 1', seriesTitle: 'Serie', sourceId: 'ard', entryId: 'E1', durationSec: 1800, start: 42 });
  assert.equal(env.invoke('downloads:play-info', { id: 'dl_unknown99' }).ok, false);
});

test('Ereignis downloads:changed: Zustandswechsel sofort, Fortschritt höchstens 4 je Sekunde, Löschen gemeldet', () => {
  const env = setup();
  const view = (id, status, percent) => ({ id, status, progress: { percent } });
  env.setNow(1000);
  env.service.emit('changed', { reason: 'state', view: view(ID, 'downloading', null) });
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].channel, 'downloads:changed');
  assert.deepEqual(env.sent[0].payload.items.map(item => item.status), ['downloading']);
  assert.ok(env.sent[0].payload.summary);
  // Fortschritt kurz danach: gebündelt, Timer
  env.setNow(1100);
  env.service.emit('changed', { reason: 'progress', view: view(ID, 'downloading', 10) });
  env.service.emit('changed', { reason: 'progress', view: view(ID, 'downloading', 11) });
  env.service.emit('changed', { reason: 'progress', view: view('dl_other1234', 'downloading', 5) });
  assert.equal(env.sent.length, 1);
  assert.equal(env.timers.length, 1);
  assert.ok(env.timers[0].ms <= 250 && env.timers[0].ms > 0);
  env.setNow(1260);
  env.timers[0].fn();
  assert.equal(env.sent.length, 2);
  assert.deepEqual(env.sent[1].payload.items.map(item => [item.id, item.progress.percent]), [[ID, 11], ['dl_other1234', 5]]);
  // nach Ablauf des Intervalls sofort
  env.setNow(1600);
  env.service.emit('changed', { reason: 'progress', view: view(ID, 'downloading', 20) });
  assert.equal(env.sent.length, 3);
  // Zustandswechsel unterbricht die Drosselung
  env.setNow(1650);
  env.service.emit('changed', { reason: 'state', view: view(ID, 'done', 100) });
  assert.equal(env.sent.length, 4);
  env.service.emit('removed', { id: ID });
  assert.deepEqual(env.sent.at(-1).payload.removed, [ID]);
});

test('Validierung: Einstellungs-Patch kennt nur Einstellungsfelder', () => {
  assert.doesNotThrow(() => v.validateSettingsPatch({ container: 'mkv', maxParallel: 3 }));
  assert.throws(() => v.validateSettingsPatch({ ffmpegPath: '/bin/sh' }), /Unbekanntes Feld/);
  assert.throws(() => v.validateSettingsPatch([]), /ungültig/);
});
