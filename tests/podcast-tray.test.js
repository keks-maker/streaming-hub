'use strict';

process.env.TZ = 'Europe/Berlin';

// Tests: Podcast im Tray (P4, Konzept §5) — Menümodell (Episode, Pause/Fortsetzen, Sprünge nach Einstellung, Stopp, Öffnen),
// Symbol/Tooltip/Text „Sendung – Episode“, Radio und Aufnahme unverändert, TrayController mit Fakes (Aktionen, Zustandsschlüssel).
// Electron wird gemockt, kein echtes Tray.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const menuTemplates = [];
const trayCalls = { images: [], tooltips: [], titles: [] };
const fakeTrays = [];

require.cache[require.resolve('electron')] = {
  id: 'electron-mock',
  filename: 'electron-mock',
  loaded: true,
  exports: {
    nativeImage: { createFromPath: p => ({ isEmpty: () => false, p, template: false, setTemplateImage(v) { this.template = v; }, isTemplateImage() { return this.template; }, resize: ({ width = 64 } = {}) => ({ toBitmap: () => Buffer.alloc(width * width * 4, 5) }) }), createEmpty: () => ({}) },
    Tray: class {
      constructor(image) {
        this.image = image;
        this.handlers = {};
        this.destroyed = false;
        fakeTrays.push(this);
      }
      setToolTip(t) { trayCalls.tooltips.push(t); }
      setTitle(t) { trayCalls.titles.push(t); }
      setImage(img) { trayCalls.images.push(img); this.image = img; }
      setContextMenu(menu) { this.menu = menu; }
      on(event, fn) { this.handlers[event] = fn; }
      destroy() { this.destroyed = true; }
    },
    Menu: { buildFromTemplate: template => { menuTemplates.push(template); return { template }; } },
    app: { quit() {}, exit() {} },
    dialog: { showMessageBoxSync: () => 1 },
    shell: { openPath: async () => '' },
    powerMonitor: { on() {} },
    Notification: class {
      static isSupported() { return true; }
      show() {}
    },
  },
};

const { buildTrayMenuModel, trayIconKind, trayTooltip, trayTitleText } = require('../lib/recorder/tray-menu-model.js');
const { TrayController } = require('../lib/recorder/TrayController.js');

const NOW = Date.parse('2026-10-05T12:00:00+02:00');
const podcast = (over = {}) => ({ state: 'playing', show: 'Der Tag', title: 'Folge 12: Wahl', skipBack: 15, skipForward: 30, ...over });
const radio = (over = {}) => ({ state: 'idle', station: null, nowPlaying: null, error: null, volume: 0.5, favorites: [], ...over });
const labels = items => items.map(i => i.label).filter(Boolean);
const ids = items => items.map(i => i.id || i.type);

// ── Modell ──

test('ohne Podcast bleibt das Menü exakt wie zuvor (Radio und Aufnahme unverändert)', () => {
  const base = { planned: [], nowMs: NOW, hasStorageRoot: true, hasLibrary: true, hasPlanning: true, radio: radio({ state: 'playing', station: { name: 'Zwei' } }) };
  assert.deepEqual(buildTrayMenuModel({ ...base, podcast: null }), buildTrayMenuModel(base));
  assert.deepEqual(buildTrayMenuModel({ ...base, podcast: { state: 'idle' } }), buildTrayMenuModel(base), 'Leerlauf zeigt keinen Podcast-Abschnitt');
  assert.ok(!ids(buildTrayMenuModel(base)).some(id => String(id).startsWith('podcast-')));
});

test('Podcast spielt: Statuszeile „Sendung – Episode“ (nicht klickbar), Pause, Sprünge, Stopp, Podcasts öffnen', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, podcast: podcast() });
  assert.deepEqual(ids(items).slice(0, 7), ['podcast-status', 'podcast-pause', 'podcast-skip-back', 'podcast-skip-forward', 'podcast-stop', 'podcast-open', 'separator']);
  assert.equal(items[0].label, 'Der Tag – Folge 12: Wahl');
  assert.equal(items[0].enabled, false);
  assert.deepEqual(labels(items).slice(1, 6), ['Pause', '15 s zurück', '30 s vor', 'Stopp', 'Podcasts öffnen']);
  assert.deepEqual([items[2].value, items[3].value], [-15, 30]);
  assert.equal(labels(items).at(-1), 'Beenden');
});

test('Podcast pausiert und lädt: ⏸-Zeile und „Fortsetzen“; beim Laden „Pause“', () => {
  const paused = buildTrayMenuModel({ nowMs: NOW, podcast: podcast({ state: 'paused' }) });
  assert.equal(paused[0].label, '⏸ Der Tag – Folge 12: Wahl');
  assert.equal(paused[1].id, 'podcast-resume');
  assert.equal(paused[1].label, 'Fortsetzen');
  assert.equal(buildTrayMenuModel({ nowMs: NOW, podcast: podcast({ state: 'loading' }) })[1].id, 'podcast-pause');
});

test('Sprungweiten folgen der Einstellung (10/45 s), ungültige Werte fallen auf 15/30', () => {
  const custom = buildTrayMenuModel({ nowMs: NOW, podcast: podcast({ skipBack: 10, skipForward: 45 }) });
  assert.deepEqual(labels(custom).slice(2, 4), ['10 s zurück', '45 s vor']);
  assert.deepEqual([custom[2].value, custom[3].value], [-10, 45]);
  const broken = buildTrayMenuModel({ nowMs: NOW, podcast: podcast({ skipBack: 'x', skipForward: -5 }) });
  assert.deepEqual(labels(broken).slice(2, 4), ['15 s zurück', '30 s vor']);
});

test('Podcast vor dem Radio-Abschnitt; Aufnahme steht darüber; Radio-Einträge bleiben vollständig', () => {
  const jobs = [{ recId: 'r1', channelName: 'Das Erste', epgTitle: 'Tagesschau', elapsedText: '12:34' }];
  const items = buildTrayMenuModel({ jobs, nowMs: NOW, podcast: podcast(), radio: radio() });
  const order = ids(items);
  assert.deepEqual(order.slice(0, 4), ['job', 'job-stop', 'separator', 'podcast-status']);
  assert.ok(order.indexOf('podcast-open') < order.indexOf('radio-status'));
  assert.ok(order.includes('radio-open') && order.includes('radio-volume-menu'));
});

test('Texte: gekürzt, ohne Steuerzeichen, „&“ maskiert (Menü), ohne Episode nur die Sendung', () => {
  const long = 'x'.repeat(300);
  const items = buildTrayMenuModel({ nowMs: NOW, podcast: podcast({ show: 'Rock & Pop\u0000', title: long }) });
  assert.ok(items[0].label.length <= 110, String(items[0].label.length));
  assert.ok(items[0].label.startsWith('Rock && Pop'), 'Menü-Mnemonic maskiert');
  assert.ok(![...items[0].label].some(ch => ch.charCodeAt(0) < 32));
  assert.equal(buildTrayMenuModel({ nowMs: NOW, podcast: podcast({ title: '' }) })[0].label, 'Der Tag');
  assert.equal(buildTrayMenuModel({ nowMs: NOW, podcast: podcast({ show: '%s ${x} <b>', title: '' }) })[0].label, '%s ${x} <b>');
});

// ── Text, Symbol, Tooltip ──

test('trayTitleText: Podcast „Sendung – Episode“, nur Sendung, aus, pausiert mit ⏸, gekürzt', () => {
  assert.equal(trayTitleText(0, radio(), { podcast: podcast() }), 'Der Tag – Folge 12: Wahl');
  const clipped = trayTitleText(0, radio(), { podcast: podcast({ title: 'T'.repeat(60) }) });
  assert.equal(Array.from(clipped).length, 28);
  assert.ok(clipped.endsWith('…'));
  assert.equal(trayTitleText(0, radio(), { podcast: podcast(), max: Infinity }), 'Der Tag – Folge 12: Wahl');
  assert.equal(trayTitleText(0, radio(), { podcast: podcast(), display: 'station', max: Infinity }), 'Der Tag');
  assert.equal(trayTitleText(0, radio(), { podcast: podcast(), display: 'off' }), '');
  assert.equal(trayTitleText(0, radio(), { podcast: podcast({ state: 'paused' }), max: Infinity }), '⏸ Der Tag – Folge 12: Wahl');
  assert.equal(trayTitleText(0, null, { podcast: podcast(), max: Infinity }), 'Der Tag – Folge 12: Wahl', 'ohne Radio-Modell');
  assert.equal(trayTitleText(0, radio(), { podcast: null }), '');
  assert.equal(trayTitleText(0, radio(), { podcast: { state: 'idle', show: 'x', title: 'y' } }), '');
});

test('Radio hat Vorrang, wenn es (entgegen der Exklusivität) aktiv wäre; Radiotext unverändert', () => {
  const r = radio({ state: 'playing', station: { name: 'Zwei' }, nowPlaying: { artist: 'I', title: 'T' } });
  assert.equal(trayTitleText(0, r, { podcast: podcast() }), 'Zwei · I – T');
  assert.equal(trayTooltip(0, r, podcast()), 'Streaming Hub — Radio: Zwei');
  assert.equal(trayIconKind(0, r, podcast({ state: 'paused' })), 'radio');
});

test('Icon: laufender Podcast zeigt das Audio-Symbol, Pause/Laden das normale; Aufnahme hat Vorrang', () => {
  assert.equal(trayIconKind(0, null, podcast()), 'radio');
  assert.equal(trayIconKind(0, radio(), podcast()), 'radio');
  for (const state of ['paused', 'loading', 'idle', 'error']) assert.equal(trayIconKind(0, radio(), podcast({ state })), 'idle', state);
  assert.equal(trayIconKind(1, radio(), podcast()), 'rec');
  assert.equal(trayIconKind(0, radio()), 'idle');
});

test('Tooltip: Podcast, Podcast pausiert; Aufnahme unverändert', () => {
  assert.equal(trayTooltip(0, radio(), podcast()), 'Streaming Hub — Podcast: Der Tag – Folge 12: Wahl');
  assert.equal(trayTooltip(0, radio(), podcast({ state: 'paused' })), 'Streaming Hub — Podcast pausiert: Der Tag – Folge 12: Wahl');
  assert.equal(trayTooltip(1, radio(), podcast()), 'Streaming Hub — 1 Aufnahme laufen');
  assert.equal(trayTooltip(0, radio(), null), 'Streaming Hub');
});

// ── TrayController ──

function fakePodcast(initial = {}) {
  const p = new EventEmitter();
  p.calls = [];
  p.state = { status: 'playing', episode: { podcastId: 'p1', episodeId: 'e1', show: 'Der Tag', title: 'Folge 12' }, position: 10, duration: 600, rate: 1, volume: 0.8, skipBack: 15, skipForward: 30, error: null, ...initial };
  p.getState = () => p.state;
  for (const name of ['pause', 'resume', 'stop', 'skip']) {
    p[name] = (...args) => {
      p.calls.push([name, ...args]);
      if (p.fail) return p.fail === 'async' ? Promise.reject(new Error('boom')) : (() => { throw new Error('boom'); })();
      return Promise.resolve();
    };
  }
  p.push = patch => {
    p.state = { ...p.state, ...patch };
    p.emit('state', p.state);
  };
  return p;
}

function makeController(podcastFake, extra = {}) {
  return new TrayController({
    recorder: { activeJobs: () => [], stop: async () => ({}), on() {}, emit() {} },
    getWindow: () => null,
    showWindow: () => extra.calls?.push('show'),
    getStorageRoot: () => '/tmp/rec',
    getPlanned: () => [],
    now: () => 1000000,
    podcast: podcastFake,
    openPodcasts: () => extra.calls?.push('podcasts'),
    getTrayScrollMode: () => 'steps',
    getReducedMotion: () => true,
    setTimer: () => ({}),
    clearTimer: () => {},
    appRoot: path.join(__dirname, '..'),
    platform: 'darwin',
    ...(extra.opts || {}),
  });
}

const last = () => menuTemplates[menuTemplates.length - 1];
const find = (items, label) => items.find(i => i.label === label);

test('TrayController: Podcast-Abschnitt, Aktionen rufen PodcastController-Methoden (Sprünge nach Einstellung)', () => {
  menuTemplates.length = 0;
  const calls = [];
  const fake = fakePodcast({ skipBack: 10, skipForward: 45 });
  const controller = makeController(fake, { calls });
  controller.create();
  assert.equal(last()[0].label, 'Der Tag – Folge 12');
  find(last(), 'Pause').click();
  find(last(), '10 s zurück').click();
  find(last(), '45 s vor').click();
  find(last(), 'Stopp').click();
  find(last(), 'Podcasts öffnen').click();
  assert.deepEqual(fake.calls, [['pause'], ['skip', -10], ['skip', 45], ['stop']]);
  assert.deepEqual(calls, ['show', 'podcasts']);
  assert.ok(!('value' in find(last(), '45 s vor')) || find(last(), '45 s vor').value === undefined, 'Modell-Metadaten gelangen nicht ins Electron-Template');
  fake.push({ status: 'paused' });
  find(last(), 'Fortsetzen').click();
  assert.deepEqual(fake.calls.at(-1), ['resume']);
  controller.destroy();
});

test('TrayController: Aktionsfehler (sync und async) werden geloggt, nicht geworfen', async () => {
  menuTemplates.length = 0;
  for (const mode of ['sync', 'async']) {
    const fake = fakePodcast();
    const controller = makeController(fake);
    controller.create();
    fake.fail = mode;
    assert.doesNotThrow(() => find(last(), 'Pause').click());
    await new Promise(resolve => setImmediate(resolve));
    controller.destroy();
  }
});

test('TrayController: Menü baut nur bei relevanten Änderungen neu (nicht bei Position/Dauer/Tempo/Lautstärke)', () => {
  menuTemplates.length = 0;
  const fake = fakePodcast();
  const controller = makeController(fake);
  controller.create();
  const base = menuTemplates.length;
  for (let i = 0; i < 5; i += 1) fake.push({ position: 20 + i, duration: 600 + i, rate: 1.5, volume: 0.3 });
  assert.equal(menuTemplates.length, base, 'Zeitmeldungen jede Sekunde lösen keinen Neuaufbau aus');
  fake.push({ status: 'paused' });
  assert.equal(menuTemplates.length, base + 1);
  fake.push({ skipBack: 30 });
  assert.equal(menuTemplates.length, base + 2, 'geänderte Sprungweite beschriftet das Menü neu');
  assert.ok(find(last(), '30 s zurück'));
  fake.push({ status: 'idle', episode: null });
  assert.equal(menuTemplates.length, base + 3);
  assert.ok(!labels(last()).includes('Podcasts öffnen'), 'ohne Episode kein Podcast-Abschnitt');
  controller.destroy();
});

test('TrayController: Icon, Tooltip und Titel (macOS setTitle) folgen dem Podcast', () => {
  menuTemplates.length = 0;
  trayCalls.images.length = 0;
  trayCalls.tooltips.length = 0;
  trayCalls.titles.length = 0;
  const fake = fakePodcast();
  const controller = makeController(fake);
  controller.create();
  controller.refresh();
  assert.match(trayCalls.images.at(-1).p, /tray-radio\.png$/);
  assert.equal(trayCalls.tooltips.at(-1), 'Streaming Hub — Podcast: Der Tag – Folge 12');
  assert.equal(trayCalls.titles.at(-1), 'Der Tag – Folge 12');
  fake.push({ status: 'paused' });
  assert.match(trayCalls.images.at(-1).p, /tray-idle\.png$/);
  assert.equal(trayCalls.titles.at(-1), '⏸ Der Tag – Folge 12');
  fake.push({ status: 'idle', episode: null });
  assert.equal(trayCalls.titles.at(-1), '');
  assert.equal(trayCalls.tooltips.at(-1), 'Streaming Hub');
  controller.destroy();
  fake.push({ status: 'playing' }); // nach destroy kein Listener mehr
  assert.equal(fake.listenerCount('state'), 0);
});

test('TrayController: Linux/Windows setzt keinen Titel (Tooltip-Fallback), Menü funktioniert', () => {
  menuTemplates.length = 0;
  trayCalls.titles.length = 0;
  trayCalls.tooltips.length = 0;
  const controller = makeController(fakePodcast(), { opts: { platform: 'linux' } });
  controller.create();
  assert.equal(trayCalls.titles.length, 0);
  assert.equal(trayCalls.tooltips.at(-1), 'Streaming Hub — Podcast: Der Tag – Folge 12');
  assert.equal(last()[0].label, 'Der Tag – Folge 12');
  controller.destroy();
});

test('TrayController ohne Podcast-Controller: Verhalten wie bisher', () => {
  menuTemplates.length = 0;
  const controller = makeController(null);
  controller.create();
  assert.ok(!labels(last()).includes('Podcasts öffnen'));
  controller.destroy();
});
