'use strict';

process.env.TZ = 'Europe/Berlin';

// Tests: Tray-Menü-Modell, Notifier und TrayController-Anbindung der Planung
// (Etappe 2b; Konzept §3.5, E3). Electron wird gemockt (Muster recorder-tray.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers');

const menuTemplates = [];
const trayImages = [];
const shows = [];
const state = { activeJobs: [], supported: true };

require.cache[require.resolve('electron')] = {
  id: 'electron-mock',
  filename: 'electron-mock',
  loaded: true,
  exports: {
    nativeImage: { createFromPath: p => ({ isEmpty: () => true, p }), createEmpty: () => ({}) },
    Tray: class {
      setToolTip() {}
      setImage(img) { trayImages.push(img); }
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    Menu: { buildFromTemplate: template => { menuTemplates.push(template); return { template }; } },
    app: { quit() {}, exit() {} },
    dialog: { showMessageBoxSync: () => 1 },
    shell: { openPath: async () => '' },
    powerMonitor: { on() {} },
    Notification: class {
      static isSupported() { return state.supported; }
      constructor(opts) { this.opts = opts; }
      show() { shows.push(this.opts); }
    },
  },
};

const { buildTrayMenuModel, trayIconKind } = require('../lib/recorder/tray-menu-model.js');
const { createNotifier } = require('../lib/recorder/Notifier.js');
const { TrayController } = require('../lib/recorder/TrayController.js');

const NOW = Date.parse('2026-10-05T12:00:00+02:00');

function plan(i, over = {}) {
  const startMs = NOW + (i + 1) * 3600 * 1000;
  return {
    id: `sch_${i}`,
    channelId: 'das-erste',
    channelName: 'Das Erste',
    title: `Sendung ${i}`,
    epgStart: new Date(startMs).toISOString(),
    epgStop: new Date(startMs + 1800 * 1000).toISOString(),
    state: 'scheduled',
    ...over,
  };
}

const labels = items => items.map(i => i.label).filter(Boolean);

test('Modell ohne Planung: kein „Geplant“, aber „Planung öffnen“; Beenden ohne Bestätigung', () => {
  const items = buildTrayMenuModel({ planned: [], nowMs: NOW, hasStorageRoot: true, hasLibrary: true, hasPlanning: true });
  const l = labels(items);
  assert.ok(!l.some(x => x.startsWith('Geplant:')));
  assert.deepEqual(l, ['Planung öffnen', 'Aufnahmen-Ordner öffnen', 'App öffnen', 'Aufnahmen-Bibliothek', 'Beenden']);
});

test('Modell: 1, 3 und 5 Planungen (nächste 3, Rest als Zähler), Reihenfolge nach Start', () => {
  const one = labels(buildTrayMenuModel({ planned: [plan(0)], nowMs: NOW, hasPlanning: true }));
  assert.equal(one[0], 'Geplant: Das Erste — Sendung 0 · heute 13:00');
  const five = [plan(4), plan(2), plan(0), plan(3), plan(1)];
  const l = labels(buildTrayMenuModel({ planned: five, nowMs: NOW, hasPlanning: true }));
  assert.deepEqual(l.slice(0, 5), [
    'Geplant: Das Erste — Sendung 0 · heute 13:00',
    'Geplant: Das Erste — Sendung 1 · heute 14:00',
    'Geplant: Das Erste — Sendung 2 · heute 15:00',
    '… und 2 weitere geplant',
    'Planung öffnen',
  ]);
  const three = labels(buildTrayMenuModel({ planned: five.slice(0, 3), nowMs: NOW, hasPlanning: true }));
  assert.ok(!three.some(x => x.startsWith('…')));
});

test('Modell: nur anstehende zählen (abgesagt/erledigt/Sendung vorbei werden nicht gelistet)', () => {
  const planned = [
    plan(0, { state: 'cancelled' }),
    plan(1, { state: 'done' }),
    plan(2, { epgStart: '2026-10-05T09:00:00+02:00', epgStop: '2026-10-05T10:00:00+02:00' }),
    plan(3),
  ];
  const l = labels(buildTrayMenuModel({ planned, nowMs: NOW }));
  assert.equal(l.filter(x => x.startsWith('Geplant:')).length, 1);
  assert.match(l[0], /Sendung 3/);
});

test('Modell: Fremdtext wird bereinigt (Steuerzeichen, Länge), Aufnahmezeile unverändert im Format', () => {
  const evil = plan(0, { channelName: `Kanal\u0000\n${'k'.repeat(100)}`, title: `T‮${'t'.repeat(300)}\r\nEnde` });
  const items = buildTrayMenuModel({
    jobs: [{ recId: 'rec_1', channelName: 'Das Erste', epgTitle: 'Tagesschau', elapsedText: '12:34' }],
    planned: [evil],
    nowMs: NOW,
  });
  assert.equal(items[0].label, '● Das Erste — Tagesschau · 12:34');
  const planned = items.find(i => i.id === 'planned').label;
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f‮]/.test(planned));
  assert.ok(planned.length < 160, `Länge ${planned.length}`);
  assert.match(planned, /^Geplant: Kanal k+… — T t+… · heute/);
  assert.equal(items.find(i => i.id === 'quit-confirm').label, 'Beenden …');
});

test('Tray-Icon (E3): Leerlauf violett (auch mit Planung), Rot nur bei laufender Aufnahme', () => {
  assert.equal(trayIconKind(0), 'idle');
  assert.equal(trayIconKind(1), 'rec');
  assert.equal(trayIconKind(3), 'rec');
});

test('Notifier: bereinigt Text, ignoriert fehlende Unterstützung und Fehler', () => {
  const out = [];
  class N {
    static isSupported() { return true; }
    constructor(o) { this.o = o; }
    show() { out.push(this.o); }
  }
  const notifier = createNotifier({ NotificationClass: N });
  assert.equal(notifier.notify('Titel\n', `Text\u0007${'x'.repeat(500)}`), true);
  assert.equal(out[0].title, 'Titel');
  assert.ok(out[0].body.length <= 300 && out[0].body.endsWith('…') && !out[0].body.includes('\u0007'));
  class Off { static isSupported() { return false; } }
  assert.equal(createNotifier({ NotificationClass: Off }).notify('a', 'b'), false);
  class Throws { static isSupported() { return true; } constructor() { throw new Error('kein Daemon'); } }
  const warns = [];
  assert.equal(createNotifier({ NotificationClass: Throws, logger: { warn: m => warns.push(m) } }).notify('a', 'b'), false);
  assert.equal(warns.length, 1);
  assert.equal(createNotifier({}).notify('a', 'b'), false);
});

function makeController(extra = {}) {
  return new TrayController({
    recorder: { activeJobs: () => state.activeJobs, stop: async () => ({}), on() {}, emit() {} },
    getWindow: () => null,
    getStorageRoot: () => '/tmp/rec',
    openLibrary: () => extra.calls?.push('library'),
    openPlanning: () => extra.calls?.push('planning'),
    showWindow: () => extra.calls?.push('show'),
    getPlanned: () => extra.planned || [],
    now: () => NOW,
    appRoot: path.join(__dirname, '..'),
    ...extra.options,
  });
}

test('TrayController: Menü zeigt „Geplant: …“ und „Planung öffnen“ (zeigt Fenster, öffnet Tab „Geplant“); Icon bleibt im Leerlauf', () => {
  menuTemplates.length = 0;
  state.activeJobs = [];
  const calls = [];
  const c = makeController({ calls, planned: [plan(0)] });
  c.create();
  const last = () => menuTemplates[menuTemplates.length - 1];
  assert.ok(last().some(i => i.label === 'Geplant: Das Erste — Sendung 0 · heute 13:00' && i.enabled === false));
  last().find(i => i.label === 'Planung öffnen').click();
  last().find(i => i.label === 'App öffnen').click();
  last().find(i => i.label === 'Aufnahmen-Bibliothek').click();
  assert.deepEqual(calls, ['show', 'planning', 'show', 'show', 'library']);
  c.destroy();
});

test('TrayController: Menü aktualisiert sich bei schedule:changed; schedule:tick baut nur bei Änderung neu', () => {
  menuTemplates.length = 0;
  const scheduler = new EventEmitter();
  const ctx = { planned: [] };
  const c = makeController({ planned: ctx.planned });
  const holder = { list: [] };
  c.getPlanned = () => holder.list;
  c.create();
  c.attachScheduler(scheduler);
  const baseline = menuTemplates.length;
  scheduler.emit('schedule:tick');
  assert.equal(menuTemplates.length, baseline, 'unverändert → kein Neuaufbau');
  holder.list = [plan(0)];
  scheduler.emit('schedule:changed', { reason: 'added' });
  assert.equal(menuTemplates.length, baseline + 1);
  assert.ok(menuTemplates[menuTemplates.length - 1].some(i => (i.label || '').startsWith('Geplant:')));
  holder.list = [];
  scheduler.emit('schedule:tick');
  assert.equal(menuTemplates.length, baseline + 2, 'Planung weg → Neuaufbau');
  c.destroy();
});

test('TrayController: schedule:notify läuft über den gemeinsamen Notifier (bereinigt, Titel „Planung“)', () => {
  shows.length = 0;
  state.supported = true;
  const scheduler = new EventEmitter();
  const c = makeController();
  c.attachScheduler(scheduler);
  scheduler.emit('schedule:notify', { kind: 'missed', entry: null, message: 'Verpasst\u0007: „Tagesschau“' });
  assert.equal(shows.length, 1);
  assert.equal(shows[0].title, 'Streaming Hub — Planung');
  assert.equal(shows[0].body, 'Verpasst : „Tagesschau“');
  // Aufnahme-Meldungen nutzen denselben Notifier mit eigenem Titel
  c._notify('Aufnahme beendet');
  assert.equal(shows[1].title, 'Streaming Hub — Aufnahme');
  state.supported = false;
  assert.doesNotThrow(() => scheduler.emit('schedule:notify', { message: 'egal' }));
  state.supported = true;
});

test('TrayController: Tray-„Beenden …“ bei Aufnahme fragt erst den Beenden-Dialog; „behalten“ stoppt nichts', async () => {
  const stopped = [];
  let confirmed = 0;
  const jobs = [{ meta: { id: 'rec_1', channelName: 'ZDF' }, getRecordingSec: () => 5 }];
  const c = new TrayController({
    recorder: { activeJobs: () => jobs, stop: async id => stopped.push(id), on() {}, emit() {}, remuxing: new Set() },
    getWindow: () => ({ isDestroyed: () => false, hide() {} }),
    confirmQuit: async () => {
      confirmed += 1;
      return false; // „Im Hintergrund behalten“
    },
    appRoot: path.join(__dirname, '..'),
  });
  // showMessageBoxSync-Mock liefert 1 („Im Tray weiterlaufen“): Pfad 0 direkt über die Hilfsfunktion prüfen
  const electron = require('electron');
  electron.dialog.showMessageBoxSync = () => 0;
  c._quitWithConfirmation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, 1);
  assert.deepEqual(stopped, []);
  electron.dialog.showMessageBoxSync = () => 1;
});
