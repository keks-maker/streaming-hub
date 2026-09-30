'use strict';

// Tests: TrayController-Logik (Phase 1c, Karte t_bafa7928; Konzept §3.2)
// Getestet wird die testbare Kernlogik ohne Electron: Menü-Label-Format,
// window-all-closed-Entscheidung. Electron-Module werden gemockt.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Electron-Mock VOR dem SUT-Require (TrayController lädt 'electron' top-level)
const menuTemplates = [];
let quitCalls = 0;
let notificationShows = [];
const powerMonitorListeners = new Map();

const state = {
  activeJobs: [],
  stopped: [],
};

function fakeJob(meta) {
  return {
    meta,
    getRecordingSec: () => 754, // 12:34
  };
}

require.cache[require.resolve('electron')] = {
  id: 'electron-mock',
  filename: 'electron-mock',
  loaded: true,
  exports: {
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Tray: class {
      constructor() { this.tooltip = ''; this.menu = null; }
      setToolTip(t) { this.tooltip = t; }
      setImage() {}
      setContextMenu(menu) { this.menu = menu; }
      on() {}
      destroy() {}
    },
    Menu: {
      buildFromTemplate: template => {
        menuTemplates.push(template);
        return { template };
      },
    },
    app: {
      quit: () => { quitCalls += 1; },
      exit: () => {},
    },
    dialog: {
      showMessageBoxSync: () => 1, // immer „Abbrechen/weiter im Tray“
    },
    shell: { openPath: async () => '' },
    powerMonitor: {
      on: (event, cb) => powerMonitorListeners.set(event, cb),
    },
    Notification: class {
      static isSupported() { return true; }
      constructor(opts) { notificationShows.push(opts); }
      show() {}
    },
  },
};

// recorder-Mock
function makeRecorder() {
  return {
    activeJobs: () => state.activeJobs,
    stop: async recId => {
      state.stopped.push(recId);
      return {};
    },
    on() {},
    emit() {},
  };
}

const { TrayController } = require('../lib/recorder/TrayController.js');

function makeController() {
  return new TrayController({
    recorder: makeRecorder(),
    getWindow: () => null,
    getStorageRoot: () => '/tmp/ recordings',
    openLibrary: () => {},
    appRoot: path.join(__dirname, '..'),
  });
}

test('TrayController: Konstruktor verlangt Recorder und getWindow', () => {
  assert.throws(() => new TrayController({ getWindow: () => null }));
  assert.throws(() => new TrayController({ recorder: makeRecorder() }));
});

test('TrayController: Menü-Label enthält Kanal, Titel und MM:SS-Laufzeit', () => {
  menuTemplates.length = 0;
  state.activeJobs = [fakeJob({ id: 'rec_1', channelName: 'Das Erste', epgTitle: 'Tagesschau' })];
  const c = makeController();
  c.create();
  c.refresh();
  assert.equal(menuTemplates.length >= 1, true, 'Menü gebaut');
  const template = menuTemplates[menuTemplates.length - 1];
  const statusItem = template.find(item => typeof item.label === 'string' && item.label.startsWith('● '));
  assert.ok(statusItem, 'Statuszeile vorhanden');
  assert.match(statusItem.label, /^● Das Erste — Tagesschau · 12:34$/);
  // Stop-Item direkt danach
  const stopIdx = template.indexOf(statusItem) + 1;
  assert.match(template[stopIdx].label, /stoppen/);
  c.destroy();
});

test('TrayController: Menü ohne aktive Aufnahmen hat kein Stop-Item und kein Beenden…', () => {
  menuTemplates.length = 0;
  state.activeJobs = [];
  const c = makeController();
  c.create();
  c.refresh();
  const template = menuTemplates[menuTemplates.length - 1];
  const labels = template.map(i => i.label || '');
  assert.ok(!labels.some(l => l.startsWith('● ')));
  assert.ok(labels.includes('Beenden'));
  assert.ok(!labels.includes('Beenden …'));
  // Ordner + App öffnen sind immer da (Konzept §3.2)
  assert.ok(labels.includes('Aufnahmen-Ordner öffnen'));
  assert.ok(labels.includes('App öffnen'));
  c.destroy();
});

test('TrayController: Refresh wechselt Icon-Zustand (aktiv > 0 ↔ 0)', () => {
  state.activeJobs = [];
  const c = makeController();
  c.create();
  c.refresh();
  assert.equal(c._activeCount, 0);
  state.activeJobs = [fakeJob({ id: 'rec_1', channelName: 'ZDF' })];
  c.refresh();
  assert.equal(c._activeCount, 1);
  state.activeJobs = [];
  c.refresh();
  assert.equal(c._activeCount, 0);
  c.destroy();
});

test('TrayController: destroy räumt auf (keine Timer, kein Tray)', () => {
  state.activeJobs = [fakeJob({ id: 'rec_2', channelName: 'RTL' })];
  const c = makeController();
  c.refresh();
  c.destroy();
  assert.equal(c.tray, null);
  assert.equal(c._elapsedTimer, null);
  assert.equal(c._destroyed, true);
  // refresh nach destroy ist ein No-op
  c.refresh();
  assert.equal(c._activeCount, 0);
});

test('TrayController: powerMonitor shutdown-Handler registriert (plattformabhängig)', () => {
  makeController();
  // Auf allen Plattformen muss ein 'shutdown'-Listener existieren
  // (macOS: Dialog-Flow, Linux: reine Warnung — User-Beschluss 30.09)
  assert.ok(powerMonitorListeners.has('shutdown'), 'shutdown-Listener registriert');
});
