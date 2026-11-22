'use strict';

// iCloud-Abgleich (lib/icloud-sync.js) gegen einen Fake-Helfer (tests/fixtures/fake-sync-helper.js). Keine echte iCloud.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createICloudSync } = require('../lib/icloud-sync.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-sync-helper.js');
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const D = 'ddddddddddd';
const NOW = 1763800000;

function setup(env = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-test-'));
  const log = path.join(dir, 'log.txt');
  const spawned = [];
  const spawnImpl = (file, args, opts) => {
    const child = spawn(file, args, { ...opts, env: { ...process.env, FAKE_LOG: log, FAKE_COUNTER: path.join(dir, 'counter'), ...env } });
    spawned.push(child);
    return child;
  };
  const local = { progress: [{ id: A, position: 30, duration: 600, updated: NOW - 100 }], queue: [], stored: null };
  const applied = { progress: [], queue: [] };
  const statuses = [];
  const sync = createICloudSync({
    platform: 'darwin',
    enabled: true,
    helperDir: dir,
    command: { file: process.execPath, args: [FAKE] },
    spawnImpl,
    now: () => NOW,
    stateStore: { read: () => local.stored, write: state => { local.stored = JSON.parse(JSON.stringify(state)); } },
    adapter: {
      readProgress: () => local.progress,
      readQueue: () => local.queue,
      applyProgress: change => { applied.progress.push(change); },
      applyQueue: items => { applied.queue.push(items); local.queue = items; },
    },
    onStatus: status => statuses.push(status.state),
    timing: { debounceMs: 30, helloTimeoutMs: 1500, requestTimeoutMs: 1500, syncTimeoutMs: 1500, retryAfterFailureMs: 60000, restartDelaysMs: [20, 20], stopGraceMs: 1500 },
    ...options,
  });
  const commands = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  const cleanup = async () => { await sync.stop(); spawned.forEach(child => child.kill('SIGKILL')); };
  return { sync, local, applied, statuses, commands, cleanup, dir };
}

async function until(fn, label, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(`Zeitüberschreitung: ${label}`);
}

test('Handshake, erster Abgleich liefert alle lokalen Records, kein pending', async () => {
  const t = setup();
  try {
    t.sync.start();
    await until(() => t.commands().some(c => c.cmd === 'sync'), 'sync');
    const [hello, sync] = t.commands();
    assert.equal(hello.cmd, 'hello');
    assert.equal(hello.protocol, 1);
    assert.deepEqual(sync.pending, []);
    assert.deepEqual(sync.local.map(r => r.name), [`p:${A}`]);
    assert.equal(sync.local[0].modified, NOW - 100);
    assert.equal(sync.local[0].kind, 'Progress');
    await until(() => t.sync.getStatus().state === 'active' && t.local.stored && t.local.stored.initialized, 'aktiv');
    assert.equal(t.sync.getStatus().lastSync, 1763800000);
  } finally { await t.cleanup(); }
});

test('sync: apply (Progress, Löschmarke, Warteschlange) und remove werden lokal übernommen', async () => {
  const items = JSON.stringify([{ id: B, title: 'Fern' }]);
  const result = {
    apply: [
      { name: `p:${B}`, kind: 'Progress', modified: NOW - 10, fields: { id: B, position: 50, duration: 900, x: 1 } },
      { name: `p:${A}`, kind: 'Progress', modified: NOW - 5, deleted: true, fields: { id: A, position: 0, duration: 600 } },
      { name: 'queue', kind: 'Queue', modified: NOW - 1, fields: { items } },
      { name: 'r:ccccccccccc', kind: 'Recent', modified: NOW, fields: {} },
    ],
    remove: [`p:${D}`],
  };
  const t = setup({ FAKE_RESULT: JSON.stringify(result) });
  t.local.progress.push({ id: D, position: 0, duration: 100, updated: NOW - 40 * 86400, done: true });
  try {
    t.sync.start();
    await until(() => t.applied.progress.length > 0, 'apply');
    const change = t.applied.progress[0];
    assert.deepEqual(change.upsert.map(e => e.id).sort(), [A, B].sort());
    const b = change.upsert.find(e => e.id === B);
    assert.deepEqual(b, { id: B, position: 50, duration: 900, x: 1, updated: NOW - 10 });
    const a = change.upsert.find(e => e.id === A);
    assert.equal(a.done, true);
    assert.equal(a.position, 0);
    assert.deepEqual(t.applied.queue[0], [{ id: B, title: 'Fern' }]);
    assert.equal(t.local.stored.queueText, items); // Originaltext bleibt erhalten
  } finally { await t.cleanup(); }
});

test('Lokal neuerer Stand wird nicht von einem älteren apply überschrieben', async () => {
  const result = { apply: [{ name: `p:${A}`, kind: 'Progress', modified: NOW - 500, fields: { id: A, position: 1, duration: 600 } }] };
  const t = setup({ FAKE_RESULT: JSON.stringify(result) });
  try {
    t.sync.start();
    await until(() => t.local.stored && t.local.stored.initialized, 'Abgleich');
    assert.equal(t.applied.progress.length, 0);
  } finally { await t.cleanup(); }
});

test('Gekürzte lokale Einträge werden nie als Löschung gemeldet; pending nur für Geändertes', async () => {
  const t = setup();
  try {
    t.sync.start();
    await until(() => t.local.stored && t.local.stored.initialized, 'erster Abgleich');
    t.local.progress = []; // gekürzt: Eintrag fehlt lokal
    t.local.progress.push({ id: B, position: 5, duration: 100, updated: NOW - 1 });
    t.sync.notifyLocalChange();
    await until(() => t.commands().filter(c => c.cmd === 'sync').length === 2, 'zweiter sync');
    const second = t.commands().filter(c => c.cmd === 'sync')[1];
    assert.deepEqual(second.local.map(r => r.name), [`p:${B}`]); // kein Record für A, keine deleted-Marke
    assert.equal(second.local.some(r => r.deleted), false);
    assert.deepEqual(second.pending, [`p:${B}`]);
  } finally { await t.cleanup(); }
});

test('Lokale Änderung stößt entprellt genau einen Abgleich an', async () => {
  const t = setup();
  try {
    t.sync.start();
    await until(() => t.local.stored && t.local.stored.initialized, 'erster Abgleich');
    t.sync.notifyLocalChange(); t.sync.notifyLocalChange(); t.sync.notifyLocalChange();
    await until(() => t.commands().filter(c => c.cmd === 'sync').length === 2, 'Debounce-Sync');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(t.commands().filter(c => c.cmd === 'sync').length, 2);
  } finally { await t.cleanup(); }
});

test('remoteChange löst sync aus', async () => {
  const t = setup({ FAKE_EVENTS: JSON.stringify([{ event: 'remoteChange' }]) });
  try {
    t.sync.start();
    await until(() => t.commands().filter(c => c.cmd === 'sync').length >= 2, 'sync nach remoteChange');
  } finally { await t.cleanup(); }
});

test('Kein iCloud-Konto: Status no_account, kein sync', async () => {
  const t = setup({ FAKE_ACCOUNT: 'no_account' });
  try {
    t.sync.start();
    await until(() => t.sync.getStatus().state === 'no_account', 'no_account');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(t.commands().some(c => c.cmd === 'sync'), false);
    t.sync.notifyLocalChange();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(t.commands().some(c => c.cmd === 'sync'), false);
  } finally { await t.cleanup(); }
});

test('Konto-Fehler beim sync (no_account) setzt den Status', async () => {
  const t = setup({ FAKE_SYNC_ERROR: 'no_account' });
  try {
    t.sync.start();
    await until(() => t.sync.getStatus().state === 'no_account', 'no_account durch sync');
  } finally { await t.cleanup(); }
});

test('Absturz im sync: begrenzter Neustart, danach läuft der Abgleich', async () => {
  const t = setup({ FAKE_MODE: 'crash-once' });
  try {
    t.sync.start();
    await until(() => t.local.stored && t.local.stored.initialized, 'Abgleich nach Neustart');
    assert.equal(t.commands().filter(c => c.cmd === 'hello').length, 2);
    assert.equal(t.sync.getStatus().state, 'active');
    assert.ok(t.statuses.includes('starting'));
  } finally { await t.cleanup(); }
});

test('Dauernder Absturz: nach begrenzten Neustarts Status error, App läuft weiter', async () => {
  const t = setup({ FAKE_MODE: 'crash-always' });
  try {
    t.sync.start();
    await until(() => t.sync.getStatus().state === 'error', 'error');
    assert.equal(t.commands().filter(c => c.cmd === 'hello').length, 3); // 1 Start + 2 Neustarts
  } finally { await t.cleanup(); }
});

test('EOF auf stdout (Prozess lebt): wie Absturz behandelt, Neustart', async () => {
  const t = setup({ FAKE_MODE: 'eof-once' });
  try {
    t.sync.start();
    await until(() => t.local.stored && t.local.stored.initialized, 'Abgleich nach EOF-Neustart');
    assert.equal(t.commands().filter(c => c.cmd === 'hello').length, 2);
  } finally { await t.cleanup(); }
});

test('Kaputte Zeilen werden verworfen, der Abgleich läuft', async () => {
  const t = setup({ FAKE_MODE: 'garbage' });
  try {
    t.sync.start();
    await until(() => t.local.stored && t.local.stored.initialized, 'Abgleich trotz Müll');
    assert.equal(t.sync.getStatus().state, 'active');
  } finally { await t.cleanup(); }
});

test('Hängender Helfer: Timeout, Prozess wird beendet und neu gestartet', async () => {
  const t = setup({ FAKE_MODE: 'hang' }, { timing: { debounceMs: 30, helloTimeoutMs: 1500, syncTimeoutMs: 150, retryAfterFailureMs: 60000, restartDelaysMs: [20], stopGraceMs: 1500 } });
  try {
    t.sync.start();
    await until(() => t.commands().filter(c => c.cmd === 'hello').length >= 2, 'Neustart nach Hänger');
  } finally { await t.cleanup(); }
});

test('Protokollversion passt nicht: Status error, kein Neustart', async () => {
  const t = setup({ FAKE_PROTOCOL: '2' });
  try {
    t.sync.start();
    await until(() => t.sync.getStatus().state === 'error', 'error');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(t.commands().filter(c => c.cmd === 'hello').length, 1);
    assert.equal(t.commands().some(c => c.cmd === 'sync'), false);
  } finally { await t.cleanup(); }
});

test('stop() beendet den Helfer sauber (shutdown + EOF)', async () => {
  const t = setup();
  try {
    t.sync.start();
    await until(() => t.commands().some(c => c.cmd === 'sync'), 'sync');
    await t.sync.stop();
    assert.ok(t.commands().some(c => c.cmd === 'shutdown'));
  } finally { await t.cleanup(); }
});

test('setEnabled(false) stoppt, setEnabled(true) startet wieder', async () => {
  const t = setup();
  try {
    t.sync.start();
    await until(() => t.sync.getStatus().state === 'active', 'aktiv');
    const off = await t.sync.setEnabled(false);
    assert.equal(off.state, 'disabled');
    const on = await t.sync.setEnabled(true);
    assert.equal(on.enabled, true);
    await until(() => t.sync.getStatus().state === 'active' && t.commands().filter(c => c.cmd === 'hello').length === 2, 'wieder aktiv');
  } finally { await t.cleanup(); }
});

test('No-op: Linux/Windows, fehlender Helfer, Schalter aus – nichts wird gestartet', async () => {
  for (const [label, options, state] of [
    ['linux', { platform: 'linux' }, 'unsupported'],
    ['win32', { platform: 'win32' }, 'unsupported'],
    ['ohne Helfer', { command: { file: path.join(os.tmpdir(), 'gibt-es-nicht', 'StreamingHubSync'), args: [] } }, 'no_helper'],
    ['Schalter aus', { enabled: false }, 'disabled'],
  ]) {
    const t = setup({}, options);
    let spawns = 0;
    const sync = createICloudSync({ platform: 'darwin', enabled: true, helperDir: t.dir, command: { file: path.join(t.dir, 'fehlt'), args: [] }, adapter: { readProgress: () => [], readQueue: () => [], applyProgress() {}, applyQueue() {} }, ...options, spawnImpl: () => { spawns += 1; throw new Error('darf nicht starten'); } });
    assert.equal(sync.start(), false, label);
    assert.equal(sync.getStatus().state, state, label);
    sync.notifyLocalChange();
    await sync.stop();
    assert.equal(spawns, 0, label);
    assert.equal(sync.getStatus().supported, options.platform ? false : true, label);
    await t.cleanup();
  }
});

test('failed bleibt pending und wird beim nächsten sync wieder mitgesendet', async () => {
  const t = setup({ FAKE_RESULT: JSON.stringify({ failed: [`p:${A}`], settled: [], uploaded: [] }) });
  t.local.progress.push({ id: B, position: 9, duration: 100, updated: NOW - 2 });
  try {
    t.sync.start();
    await until(() => t.local.stored && t.local.stored.initialized, 'erster Abgleich');
    t.sync.notifyLocalChange();
    await until(() => t.commands().filter(c => c.cmd === 'sync').length === 2, 'zweiter sync');
    const second = t.commands().filter(c => c.cmd === 'sync')[1];
    assert.deepEqual(second.pending, [`p:${A}`]); // B war erledigt, A (failed) wieder dabei
  } finally { await t.cleanup(); }
});
