'use strict';

// Tests: WakeScheduler (Konzept §4.3) mit Fake-Helfer, injizierter Uhr und
// Fake-Speicher: setzen, löschen bei Absage/Verschiebung, No-op ohne Helfer,
// Datumsformat, Vergangenheit ignorieren, Persistenz. Sowie die IPC-Brücke.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WakeScheduler, formatWakeTime, parseWakeTime } = require('../lib/recorder/WakeScheduler.js');
const { registerWakeIpc } = require('../lib/recorder/ipc-wake.js');
const { validateNoPayload } = require('../lib/ipc-validation.js');

const MIN = 60000;
const NOW = new Date(2026, 9, 12, 20, 0, 0).getTime(); // lokale Zeit, Mo 12.10.2026 20:00

function make({ active = true, windows = [], persisted = [], sendOk = true } = {}) {
  const sent = [];
  const s = { active, windows, sendOk, now: NOW, saved: { times: persisted } };
  const helper = {
    isSupported: () => true,
    isActive: () => s.active,
    send: (verb, text) => {
      sent.push(`${verb} ${text}`);
      return s.sendOk;
    },
  };
  const wake = new WakeScheduler({
    helper,
    getWindows: () => s.windows,
    storage: { read: () => s.saved, write: v => (s.saved = v) },
    now: () => s.now,
  });
  return { wake, sent, s };
}

test('Format: lokale Zeit MM/dd/yy HH:mm:ss, Rückparsen', () => {
  const ms = new Date(2026, 0, 5, 3, 7, 0).getTime();
  assert.equal(formatWakeTime(ms), '01/05/26 03:07:00');
  assert.equal(parseWakeTime('01/05/26 03:07:00'), ms);
  assert.equal(parseWakeTime('Quatsch'), null);
});

test('setzt Wecktermin 5 min vor effektivem Start, auf die Minute abgerundet', () => {
  const start = new Date(2026, 9, 13, 2, 13, 30).getTime();
  const { wake, sent } = make({ windows: [{ id: 'a', startMs: start }] });
  wake.reconcile();
  assert.deepEqual(sent, ['wake 10/13/26 02:08:00']);
});

test('Termine in der Vergangenheit werden ignoriert, Duplikate zusammengefasst', () => {
  const soon = NOW + 3 * MIN; // Wecktermin läge in der Vergangenheit
  const later = new Date(2026, 9, 13, 8, 0, 0).getTime();
  const { wake, sent } = make({ windows: [{ startMs: soon }, { startMs: later }, { startMs: later + 20000 }] });
  wake.reconcile();
  assert.deepEqual(sent, ['wake 10/13/26 07:55:00']);
});

test('zweiter Abgleich setzt nichts doppelt; Absage löscht den Termin', () => {
  const t = new Date(2026, 9, 13, 8, 0, 0).getTime();
  const { wake, sent, s } = make({ windows: [{ startMs: t }] });
  wake.reconcile();
  wake.reconcile();
  assert.deepEqual(sent, ['wake 10/13/26 07:55:00']);
  s.windows = [];
  wake.reconcile();
  assert.deepEqual(sent, ['wake 10/13/26 07:55:00', 'cancel 10/13/26 07:55:00']);
  assert.deepEqual(s.saved.times, []);
});

test('Verschiebung: alter Termin gelöscht, neuer gesetzt', () => {
  const t = new Date(2026, 9, 13, 8, 0, 0).getTime();
  const { wake, sent, s } = make({ windows: [{ startMs: t }] });
  wake.reconcile();
  s.windows = [{ startMs: t + 30 * MIN }];
  wake.reconcile();
  assert.deepEqual(sent.slice(1), ['cancel 10/13/26 07:55:00', 'wake 10/13/26 08:25:00']);
  assert.deepEqual(s.saved.times, ['10/13/26 08:25:00']);
});

test('ohne Helfer: nichts tun, Speicher unverändert, kein Wurf', () => {
  const { wake, sent, s } = make({ active: false, windows: [{ startMs: NOW + 60 * MIN }], persisted: ['10/13/26 08:00:00'] });
  assert.doesNotThrow(() => wake.reconcile());
  assert.deepEqual(sent, []);
  assert.deepEqual(s.saved.times, ['10/13/26 08:00:00']);
});

test('persistierte Termine überleben den Neustart und werden bei Helfer-Start bereinigt', () => {
  const { wake, sent, s } = make({ persisted: ['10/13/26 08:00:00', '10/11/26 08:00:00'], windows: [] });
  wake.reconcile();
  // vergangener Termin: nur aus dem Speicher, kein cancel
  assert.deepEqual(sent, ['cancel 10/13/26 08:00:00']);
  assert.deepEqual(s.saved.times, []);
});

test('Sendefehler: Termin bleibt ungesetzt, später erneuter Versuch', () => {
  const { wake, sent, s } = make({ windows: [{ startMs: NOW + 60 * MIN }], sendOk: false });
  wake.reconcile();
  assert.deepEqual(s.saved.times, []);
  s.sendOk = true;
  wake.reconcile();
  assert.equal(sent.length, 2);
  assert.equal(s.saved.times.length, 1);
});

test('wirft nie: kaputte Fenster-Quelle und kaputter Speicher', () => {
  const helper = { isActive: () => true, send: () => true };
  const wake = new WakeScheduler({
    helper,
    getWindows: () => {
      throw new Error('boom');
    },
    storage: {
      read: () => {
        throw new Error('kaputt');
      },
      write: () => {},
    },
  });
  assert.doesNotThrow(() => wake.reconcile());
});

test('attach: schedule:changed löst Abgleich aus; cancelAll räumt auf', () => {
  const t = new Date(2026, 9, 13, 8, 0, 0).getTime();
  const { wake, sent, s } = make({ windows: [{ startMs: t }] });
  const em = new EventEmitter();
  wake.attach(em);
  em.emit('schedule:changed', { reason: 'added' });
  assert.equal(sent.length, 1);
  wake.cancelAll();
  assert.deepEqual(sent.slice(1), ['cancel 10/13/26 07:55:00']);
  assert.deepEqual(s.saved.times, []);
  wake.detach();
  em.emit('schedule:changed', {});
  assert.equal(sent.length, 2);
});

test('Status: nextWakeMs und active', () => {
  const t = new Date(2026, 9, 13, 8, 0, 0).getTime();
  const { wake } = make({ windows: [{ startMs: t }] });
  wake.reconcile();
  const st = wake.getStatus();
  assert.equal(st.active, true);
  assert.equal(st.nextWakeMs, t - 5 * MIN);
});

// ── IPC ──

function ipcHarness({ supported = true, startResult = { ok: true } } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const calls = [];
  const helper = {
    isSupported: () => supported,
    start: async () => {
      calls.push('start');
      return startResult;
    },
    quit: () => calls.push('quit'),
  };
  const wake = {
    getStatus: () => ({ supported, active: true }),
    reconcile: () => calls.push('reconcile'),
    cancelAll: () => calls.push('cancelAll'),
  };
  const sent = [];
  registerWakeIpc({
    ipcMain,
    requireMainRenderer: e => {
      if (e !== 'main') throw new Error('nicht autorisiert');
    },
    helper,
    wake,
    broadcast: (c, p) => sent.push(c),
  });
  return { handlers, calls, sent };
}

test('IPC: fremder Sender abgelehnt, Nutzlast abgelehnt', async () => {
  const { handlers, calls } = ipcHarness();
  for (const ch of ['wake:get-status', 'wake:enable', 'wake:disable']) {
    await assert.rejects(async () => handlers.get(ch)('fremd'), /nicht autorisiert/);
    await assert.rejects(async () => handlers.get(ch)('main', '10/12/26 01:00:00; rm -rf /'), /Unerwartete Eingabe/);
  }
  assert.deepEqual(calls, []);
  assert.throws(() => validateNoPayload([1]));
  assert.doesNotThrow(() => validateNoPayload([]));
});

test('IPC: enable startet Helfer und setzt sofort alle Termine; disable löscht und beendet', async () => {
  const { handlers, calls, sent } = ipcHarness();
  const r = await handlers.get('wake:enable')('main');
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['start', 'reconcile']);
  await handlers.get('wake:disable')('main');
  assert.deepEqual(calls.slice(2), ['cancelAll', 'quit']);
  assert.deepEqual(sent, ['wake:changed', 'wake:changed']);
});

test('IPC: Abbruch/Linux ohne Reconcile, Linux ohne Start', async () => {
  const a = ipcHarness({ startResult: { ok: false, cancelled: true, error: 'Abgebrochen' } });
  const r = await a.handlers.get('wake:enable')('main');
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.deepEqual(a.calls, ['start']);
  const b = ipcHarness({ supported: false });
  const r2 = await b.handlers.get('wake:enable')('main');
  assert.equal(r2.ok, false);
  assert.deepEqual(b.calls, []);
});
