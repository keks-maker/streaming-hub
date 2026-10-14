'use strict';

process.env.TZ = 'Europe/Berlin';

// Tests: Radio im Tray (R4, Konzept §6): Menümodell (alle Zustände, Aufnahme+Radio, Favoriten, Kürzen),
// Icon-Vorrang, Tooltip, TrayController mit Fakes (Aktionen, Drosselung), Weiterspielen bei Fenster zu
// (decideWindowAllClosed) und mediaSession-Handler des Players. Electron wird gemockt, kein echtes Tray.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const menuTemplates = [];
const trayCalls = { images: [], tooltips: [] };
const shows = [];
let quitCalls = 0;

require.cache[require.resolve('electron')] = {
  id: 'electron-mock',
  filename: 'electron-mock',
  loaded: true,
  exports: {
    nativeImage: { createFromPath: p => ({ isEmpty: () => false, p }), createEmpty: () => ({}) },
    Tray: class {
      setToolTip(t) { trayCalls.tooltips.push(t); }
      setImage(img) { trayCalls.images.push(img); }
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    Menu: { buildFromTemplate: template => { menuTemplates.push(template); return { template }; } },
    app: { quit() { quitCalls += 1; }, exit() {} },
    dialog: { showMessageBoxSync: () => 1 },
    shell: { openPath: async () => '' },
    powerMonitor: { on() {} },
    Notification: class {
      static isSupported() { return true; }
      constructor(opts) { this.opts = opts; }
      show() { shows.push(this.opts); }
    },
  },
};

const { buildTrayMenuModel, trayIconKind, trayTooltip, VOLUME_PRESETS } = require('../lib/recorder/tray-menu-model.js');
const { TrayController } = require('../lib/recorder/TrayController.js');
const { decideWindowAllClosed } = require('../lib/radio/keep-alive.js');

const NOW = Date.parse('2026-10-05T12:00:00+02:00');
const FAVS = [
  { sourceId: 's', id: 'a', name: 'Eins', active: false },
  { sourceId: 's', id: 'b', name: 'Zwei', active: true },
  { sourceId: 's', id: 'c', name: 'Drei', active: false },
];
const radio = (over = {}) => ({
  state: 'playing',
  station: { name: 'Zwei' },
  nowPlaying: { artist: 'Interpret', title: 'Titel' },
  error: null,
  volume: 0.5,
  favorites: FAVS,
  hasPrev: true,
  hasNext: true,
  ...over,
});
const labels = items => items.map(i => i.label).filter(Boolean);
const ids = items => items.map(i => i.id || i.type);

// ── Modell ──

test('ohne radio-Parameter bleibt das Menü exakt wie zuvor', () => {
  const base = { planned: [], nowMs: NOW, hasStorageRoot: true, hasLibrary: true, hasPlanning: true };
  assert.deepEqual(buildTrayMenuModel({ ...base, radio: null }), buildTrayMenuModel(base));
  assert.deepEqual(labels(buildTrayMenuModel(base)), ['Planung öffnen', 'Aufnahmen-Ordner öffnen', 'App öffnen', 'Aufnahmen-Bibliothek', 'Beenden']);
});

test('Zustand playing: Statuszeile, Pause, Stopp, Nächster/Vorheriger, Favoriten, Lautstärke, Dashboard', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio() });
  assert.deepEqual(labels(items).slice(0, 7), [
    '▶ Zwei — Interpret – Titel',
    'Pause',
    'Radio stoppen',
    'Nächster Favorit',
    'Vorheriger Favorit',
    'Favoriten',
    'Lautstärke',
  ]);
  assert.equal(items[0].enabled, false, 'Statuszeile deaktiviert');
  assert.ok(labels(items).includes('Radio-Dashboard öffnen'));
  assert.equal(items[labels(items).length > 0 ? ids(items).indexOf('radio-open') + 1 : 0].type, 'separator');
  assert.equal(labels(items).at(-1), 'Beenden');
});

test('Zustand paused: ⏸-Statuszeile und „Fortsetzen“ statt „Pause“', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'paused', nowPlaying: null }) });
  assert.equal(items[0].label, '⏸ Zwei');
  assert.ok(labels(items).includes('Fortsetzen'));
  assert.ok(!labels(items).includes('Pause'));
  assert.ok(labels(items).includes('Radio stoppen'));
});

test('Zustand idle: „Radio aus“, kein Pause/Stopp, Favoriten und Lautstärke bleiben', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'idle', station: null, nowPlaying: null }) });
  assert.equal(items[0].label, 'Radio aus');
  const l = labels(items);
  assert.ok(!l.includes('Pause') && !l.includes('Fortsetzen') && !l.includes('Radio stoppen'));
  assert.ok(l.includes('Favoriten') && l.includes('Lautstärke') && l.includes('Radio-Dashboard öffnen'));
});

test('Zustand error: Fehlertext in der Statuszeile, kein Stopp', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'error', nowPlaying: null, error: 'Stream nicht erreichbar' }) });
  assert.equal(items[0].label, '⚠ Zwei — Stream nicht erreichbar');
  assert.ok(!labels(items).includes('Radio stoppen'));
});

test('Zustand loading: Verbindungszeile mit Pause und Stopp', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'loading', nowPlaying: null }) });
  assert.equal(items[0].label, '▶ Zwei — verbinde …');
  assert.ok(labels(items).includes('Pause') && labels(items).includes('Radio stoppen'));
});

test('Aufnahme und Radio gleichzeitig: Radio-Abschnitt unterhalb der Aufnahme-Einträge', () => {
  const jobs = [{ recId: 'r1', channelName: 'Das Erste', epgTitle: 'Tagesschau', elapsedText: '12:34' }];
  const items = buildTrayMenuModel({ jobs, nowMs: NOW, radio: radio() });
  assert.deepEqual(ids(items).slice(0, 5), ['job', 'job-stop', 'separator', 'radio-status', 'radio-pause']);
  assert.equal(labels(items).at(-1), 'Beenden …');
});

test('Favoriten-Untermenü: Reihenfolge wie geliefert, aktiver Sender mit Häkchen, Schlüssel am Eintrag', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio() });
  const sub = items.find(i => i.id === 'radio-favorites').submenu;
  assert.deepEqual(sub.map(i => i.label), ['Eins', 'Zwei', 'Drei']);
  assert.deepEqual(sub.map(i => i.checked), [false, true, false]);
  assert.ok(sub.every(i => i.type === 'checkbox'));
  assert.deepEqual([sub[0].sourceId, sub[0].stationId], ['s', 'a']);
});

test('ohne Favoriten: „Keine Favoriten“ (deaktiviert), kein Nächster/Vorheriger', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ favorites: [] }) });
  const empty = items.find(i => i.id === 'radio-favorites-empty');
  assert.equal(empty.enabled, false);
  assert.ok(!labels(items).includes('Nächster Favorit'));
});

test('Lautstärke-Untermenü: Stumm, 25/50/75/100 %, aktuelle Stufe gewählt', () => {
  const sub = volume => buildTrayMenuModel({ nowMs: NOW, radio: radio({ volume }) }).find(i => i.id === 'radio-volume-menu').submenu;
  assert.deepEqual(sub(0.5).map(i => i.label), ['Stumm', '25 %', '50 %', '75 %', '100 %']);
  assert.deepEqual(sub(0.5).map(i => i.checked), [false, false, true, false, false]);
  assert.equal(sub(0)[0].checked, true);
  assert.equal(sub(1)[4].checked, true);
  assert.ok(sub(0.8).every(i => !i.checked), 'Zwischenwerte markieren keine Stufe');
  assert.deepEqual(VOLUME_PRESETS.map(p => p.value), [0, 0.25, 0.5, 0.75, 1]);
});

test('Texte werden gekürzt und von Steuerzeichen befreit; Labels sind reiner Text', () => {
  const long = 'x'.repeat(200);
  const items = buildTrayMenuModel({
    nowMs: NOW,
    radio: radio({ nowPlaying: { artist: long, title: 'A\u0000B\n%s ${x} <b>' }, favorites: [{ sourceId: 's', id: 'a', name: long, active: false }] }),
  });
  assert.ok(items[0].label.length <= 100, `Statuszeile ${items[0].label.length}`);
  assert.ok(![...items[0].label].some(ch => ch.charCodeAt(0) < 32));
  const fav = items.find(i => i.id === 'radio-favorites').submenu[0];
  assert.ok(fav.label.length <= 40);
  const text = buildTrayMenuModel({ nowMs: NOW, radio: radio({ nowPlaying: { artist: '', title: '%s ${x} <b>' } }) })[0].label;
  assert.equal(text, '▶ Zwei — %s ${x} <b>', 'unverändert als Text (kein Format-Injection)');
});

// ── Icon und Tooltip ──

test('Icon-Vorrang: Aufnahme > Radio spielt > Leerlauf; Pause/Fehler/Laden = normal', () => {
  assert.equal(trayIconKind(0), 'idle');
  assert.equal(trayIconKind(0, null), 'idle');
  assert.equal(trayIconKind(1, radio()), 'rec');
  assert.equal(trayIconKind(0, radio()), 'radio');
  for (const state of ['paused', 'idle', 'error', 'loading']) assert.equal(trayIconKind(0, radio({ state })), 'idle', state);
});

test('Tooltip: Aufnahme unverändert, sonst Sender bei Radio', () => {
  assert.equal(trayTooltip(0), 'Streaming Hub');
  assert.equal(trayTooltip(1, radio()), 'Streaming Hub — 1 Aufnahme laufen');
  assert.equal(trayTooltip(2), 'Streaming Hub — 2 Aufnahmen laufen');
  assert.equal(trayTooltip(0, radio()), 'Streaming Hub — Radio: Zwei');
  assert.equal(trayTooltip(0, radio({ state: 'paused' })), 'Streaming Hub — Radio pausiert: Zwei');
  assert.equal(trayTooltip(0, radio({ state: 'idle', station: null })), 'Streaming Hub');
});

test('Icon-Datei tray-radio.png existiert (vom Build-Skript erzeugt)', () => {
  const file = path.join(__dirname, '..', 'assets', 'tray', 'tray-radio.png');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file).subarray(1, 4).toString(), 'PNG');
});

// ── TrayController mit Fakes ──

function fakeRadio(initial = {}) {
  const r = new EventEmitter();
  r.calls = [];
  r.fail = null;
  r.state = { status: 'playing', station: { sourceId: 's', id: 'b', name: 'Zwei' }, volume: 0.5, nowPlaying: { artist: 'I', title: 'T1' }, error: null, ...initial };
  r.getState = () => r.state;
  for (const name of ['pause', 'resume', 'stop', 'next', 'prev', 'setVolume', 'play']) {
    r[name] = (...args) => {
      r.calls.push([name, ...args]);
      if (r.fail) return r.fail === 'async' ? Promise.reject(new Error('boom')) : (() => { throw new Error('boom'); })();
      return Promise.resolve();
    };
  }
  r.push = patch => {
    r.state = { ...r.state, ...patch };
    r.emit('state', r.state);
  };
  return r;
}

function makeController(radioFake, extra = {}) {
  const timers = [];
  let nowMs = 1000000;
  const controller = new TrayController({
    recorder: { activeJobs: () => extra.jobs || [], stop: async () => ({}), on() {}, emit() {} },
    getWindow: () => null,
    showWindow: () => extra.calls?.push('show'),
    getStorageRoot: () => '/tmp/rec',
    getPlanned: () => [],
    now: () => nowMs,
    radio: radioFake,
    getRadioFavorites: () => FAVS.map(({ sourceId, id, name }) => ({ sourceId, id, name })),
    openRadio: () => extra.calls?.push('radio'),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: t => { t.cleared = true; },
    appRoot: path.join(__dirname, '..'),
  });
  return { controller, timers, advance: ms => { nowMs += ms; } };
}

const last = () => menuTemplates[menuTemplates.length - 1];
const find = (items, label) => items.find(i => i.label === label);

test('TrayController: Radio-Abschnitt im Menü, Aktionen rufen RadioController-Methoden', async () => {
  menuTemplates.length = 0;
  const calls = [];
  const fake = fakeRadio();
  const { controller } = makeController(fake, { calls });
  controller.create();
  assert.equal(last()[0].label, '▶ Zwei — I – T1');
  find(last(), 'Pause').click();
  find(last(), 'Radio stoppen').click();
  find(last(), 'Nächster Favorit').click();
  find(last(), 'Vorheriger Favorit').click();
  find(find(last(), 'Favoriten').submenu, 'Drei').click();
  find(find(last(), 'Lautstärke').submenu, '75 %').click();
  find(last(), 'Radio-Dashboard öffnen').click();
  assert.deepEqual(fake.calls, [
    ['pause'], ['stop'], ['next'], ['prev'],
    ['play', { sourceId: 's', stationId: 'c' }],
    ['setVolume', 0.75],
  ]);
  assert.deepEqual(calls, ['show', 'radio']);
  fake.state = { ...fake.state, status: 'paused' };
  controller.refresh();
  find(last(), 'Fortsetzen').click();
  assert.deepEqual(fake.calls.at(-1), ['resume']);
  assert.ok(!('sourceId' in find(last(), 'Favoriten').submenu[0]), 'Modell-Metadaten gelangen nicht ins Electron-Template');
  controller.destroy();
});

test('TrayController: Aktionsfehler (sync und async) werden geloggt, nicht geworfen', async () => {
  menuTemplates.length = 0;
  for (const mode of ['sync', 'async']) {
    const fake = fakeRadio();
    const { controller } = makeController(fake);
    controller.create();
    fake.fail = mode;
    assert.doesNotThrow(() => find(last(), 'Pause').click());
    await new Promise(resolve => setImmediate(resolve));
    controller.destroy();
  }
});

test('TrayController: Icon und Tooltip folgen dem Radio; Aufnahme hat Vorrang', () => {
  menuTemplates.length = 0;
  trayCalls.images.length = 0;
  trayCalls.tooltips.length = 0;
  const fake = fakeRadio();
  const { controller } = makeController(fake);
  controller.create();
  controller.refresh();
  assert.match(trayCalls.images.at(-1).p, /tray-radio\.png$/);
  assert.equal(trayCalls.tooltips.at(-1), 'Streaming Hub — Radio: Zwei');
  fake.push({ status: 'paused' });
  assert.match(trayCalls.images.at(-1).p, /tray-idle\.png$/);
  controller.destroy();

  const rec = makeController(fakeRadio(), { jobs: [{ meta: { id: 'r1', channelName: 'ZDF' }, getRecordingSec: () => 5 }] });
  rec.controller.create();
  rec.controller.refresh();
  assert.match(trayCalls.images.at(-1).p, /tray-rec\.png$/);
  assert.equal(trayCalls.tooltips.at(-1), 'Streaming Hub — 1 Aufnahme laufen');
  rec.controller.destroy();
});

test('TrayController: Zustandswechsel sofort, Titelwechsel höchstens alle 5 s (ein nachlaufender Aufruf)', () => {
  menuTemplates.length = 0;
  const fake = fakeRadio();
  const { controller, timers, advance } = makeController(fake);
  controller.create();
  const base = menuTemplates.length;

  fake.push({ status: 'paused' });
  assert.equal(menuTemplates.length, base + 1, 'Zustandswechsel baut sofort');

  fake.push({ nowPlaying: { artist: 'I', title: 'T2' } });
  fake.push({ nowPlaying: { artist: 'I', title: 'T3' } });
  assert.equal(menuTemplates.length, base + 1, 'Titel innerhalb 5 s: nicht sofort');
  assert.equal(timers.filter(t => !t.cleared).length, 1, 'genau ein nachlaufender Aufruf');
  assert.ok(timers[0].ms <= 5000 && timers[0].ms > 0);

  advance(5000);
  timers[0].fn();
  assert.equal(menuTemplates.length, base + 2);
  assert.match(last()[0].label, /T3$/);

  advance(6000);
  fake.push({ nowPlaying: { artist: 'I', title: 'T4' } });
  assert.equal(menuTemplates.length, base + 3, 'nach 5 s sofort');

  fake.push({ status: 'idle', nowPlaying: null });
  assert.equal(menuTemplates.length, base + 4, 'Zustandswechsel sofort, auch mitten im Takt');
  controller.destroy();
});

test('TrayController: refreshRadioMenu baut nur bei geänderten Favoriten neu', () => {
  menuTemplates.length = 0;
  const fake = fakeRadio();
  let favs = FAVS.map(({ sourceId, id, name }) => ({ sourceId, id, name }));
  const { controller } = makeController(fake);
  controller.getRadioFavorites = () => favs;
  controller.create();
  const base = menuTemplates.length;
  controller.refreshRadioMenu();
  assert.equal(menuTemplates.length, base, 'unverändert: kein Neubau');
  favs = favs.slice(0, 2);
  controller.refreshRadioMenu();
  assert.equal(menuTemplates.length, base + 1);
  controller.destroy();
});

test('TrayController ohne Radio: Menü wie bisher', () => {
  menuTemplates.length = 0;
  const { controller } = makeController(undefined);
  controller.create();
  assert.ok(!labels(last()).some(l => l.includes('Radio')));
  controller.destroy();
});

// ── Weiterspielen bei Fenster zu ──

test('Fenster zu: Radio + Option an → App bleibt; Option aus → Ende; Aufnahme/Planung haben Vorrang', () => {
  const recorder = jobs => ({ activeJobs: () => new Array(jobs).fill({}) });
  const scheduler = pending => ({ hasPendingSchedules: () => pending });
  const ctl = status => ({ isActive: () => status !== 'idle' && status !== 'error' });
  const radioCtx = (status, keep, hasTray = true) => ({ controller: ctl(status), settings: { keepPlayingWhenClosed: keep }, hasTray });

  assert.deepEqual(decideWindowAllClosed({ recorder: recorder(0), scheduler: scheduler(false), radio: radioCtx('playing', true) }), { quit: false, reason: 'radio' });
  assert.deepEqual(decideWindowAllClosed({ recorder: recorder(0), scheduler: scheduler(false), radio: radioCtx('paused', true) }), { quit: false, reason: 'radio' });
  assert.deepEqual(decideWindowAllClosed({ recorder: recorder(0), scheduler: scheduler(false), radio: radioCtx('playing', false) }), { quit: true, reason: null });
  assert.equal(decideWindowAllClosed({ recorder: recorder(0), scheduler: scheduler(false), radio: radioCtx('playing', true, false) }).quit, true, 'ohne Tray kein Weiterspielen');
  assert.equal(decideWindowAllClosed({ recorder: recorder(0), scheduler: scheduler(false), radio: radioCtx('idle', true) }).quit, true);
  assert.deepEqual(decideWindowAllClosed({ recorder: recorder(1), scheduler: scheduler(false), radio: radioCtx('playing', false) }), { quit: false, reason: 'recording' });
  assert.deepEqual(decideWindowAllClosed({ recorder: recorder(0), scheduler: scheduler(true), radio: radioCtx('playing', false) }), { quit: false, reason: 'schedule' });
  assert.deepEqual(decideWindowAllClosed({ recorder: recorder(1), scheduler: scheduler(true), radio: radioCtx('playing', true) }).reason, 'recording');
  assert.deepEqual(decideWindowAllClosed({ recorder: null, scheduler: null, radio: null }), { quit: true, reason: null });
});

test('Tray „Beenden“ ruft app.quit (before-quit stoppt das Radio über dispose)', () => {
  menuTemplates.length = 0;
  quitCalls = 0;
  const { controller } = makeController(fakeRadio());
  controller.create();
  find(last(), 'Beenden').click();
  assert.equal(quitCalls, 1);
  controller.destroy();
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /before-quit[\s\S]{0,600}radioController\.dispose\(\)/);
});

// ── mediaSession im Player ──

test('Player: mediaSession-Handler für play/pause/stop/nexttrack/previoustrack und Metadaten', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'radio-player.js'), 'utf8');
  assert.match(source, /\['play', 'pause', 'stop', 'nexttrack', 'previoustrack'\]/);
  assert.match(source, /setActionHandler\(action/);
  assert.match(source, /new window\.MediaMetadata\(\{ title: command\.title/);
  assert.match(source, /command\.cmd === 'meta'/);
});
