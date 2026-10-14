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
const trayCalls = { images: [], tooltips: [], titles: [], fonts: [] };
const shows = [];
let quitCalls = 0;

require.cache[require.resolve('electron')] = {
  id: 'electron-mock',
  filename: 'electron-mock',
  loaded: true,
  exports: {
    nativeImage: { createFromPath: p => ({ isEmpty: () => false, p, resize: () => ({ toBitmap: () => Buffer.alloc(64 * 64 * 4, 5) }) }), createEmpty: () => ({}) },
    Tray: class {
      setToolTip(t) { trayCalls.tooltips.push(t); }
      setTitle(t, o) { trayCalls.titles.push(t); trayCalls.fonts.push(o && o.fontType ? o.fontType : null); }
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

const { buildTrayMenuModel, trayIconKind, trayTooltip, trayTitleText, MAX_VISIBLE_FAVORITES } = require('../lib/recorder/tray-menu-model.js');
const { TrayController } = require('../lib/recorder/TrayController.js');
const { decideWindowAllClosed } = require('../lib/radio/keep-alive.js');
const sourcesLogic = require('../lib/radio/radio-sources-logic.js');
const radioState = require('../lib/radio/radio-state.js');
const { radioDashboardModel } = require('../radio-dashboard-model.js');

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

test('Zustand playing: Statuszeile, Pause, Stopp, flache Favoriten, Nächster/Vorheriger, Lautstärke, Dashboard', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio() });
  assert.deepEqual(labels(items).slice(0, 10), [
    'Zwei — Interpret – Titel',
    'Pause',
    'Stopp',
    'Eins',
    'Zwei',
    'Drei',
    'Nächster Favorit',
    'Vorheriger Favorit',
    'Lautstärke',
    'Radio-Dashboard öffnen',
  ]);
  assert.equal(items[0].enabled, false, 'Statuszeile deaktiviert');
  assert.deepEqual(ids(items).slice(0, 5), ['radio-status', 'radio-pause', 'radio-stop', 'separator', 'radio-favorite']);
  assert.equal(items[ids(items).indexOf('radio-open') + 1].type, 'separator');
  assert.equal(labels(items).at(-1), 'Beenden');
  assert.ok(!ids(items).includes('radio-favorites'), 'kein Favoriten-Untermenü mehr');
});

test('Zustand paused: ⏸-Statuszeile und „Fortsetzen“ statt „Pause“', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'paused', nowPlaying: null }) });
  assert.equal(items[0].label, '⏸ Zwei');
  assert.ok(labels(items).includes('Fortsetzen'));
  assert.ok(!labels(items).includes('Pause'));
  assert.ok(labels(items).includes('Stopp'));
});

test('Zustand idle: „Radio aus“; „Abspielen“ nur mit bekanntem letztem Sender, kein Pause/Stopp', () => {
  const idle = over => buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'idle', station: null, nowPlaying: null, ...over }) });
  const items = idle({ canPlayLast: true });
  assert.equal(items[0].label, 'Radio aus');
  const l = labels(items);
  assert.ok(l.includes('Abspielen'));
  assert.equal(items.find(i => i.label === 'Abspielen').id, 'radio-play-last');
  assert.ok(!l.includes('Pause') && !l.includes('Fortsetzen') && !l.includes('Stopp'));
  assert.ok(l.includes('Lautstärke') && l.includes('Radio-Dashboard öffnen') && l.includes('Eins'));
  assert.ok(!labels(idle({ canPlayLast: false })).includes('Abspielen'));
});

test('Zustand error: Fehlertext in der Statuszeile, kein Stopp', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'error', nowPlaying: null, error: 'Stream nicht erreichbar' }) });
  assert.equal(items[0].label, '⚠ Zwei — Stream nicht erreichbar');
  assert.ok(!labels(items).includes('Stopp'));
});

test('Zustand loading: Verbindungszeile mit Pause und Stopp', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ state: 'loading', nowPlaying: null }) });
  assert.equal(items[0].label, 'Zwei — verbinde …');
  assert.ok(labels(items).includes('Pause') && labels(items).includes('Stopp'));
});

test('Aufnahme und Radio gleichzeitig: Radio-Abschnitt unterhalb der Aufnahme-Einträge', () => {
  const jobs = [{ recId: 'r1', channelName: 'Das Erste', epgTitle: 'Tagesschau', elapsedText: '12:34' }];
  const items = buildTrayMenuModel({ jobs, nowMs: NOW, radio: radio() });
  assert.deepEqual(ids(items).slice(0, 5), ['job', 'job-stop', 'separator', 'radio-status', 'radio-pause']);
  assert.equal(labels(items).at(-1), 'Beenden …');
});

test('Favoriten flach: Reihenfolge wie geliefert, aktiver Sender mit Häkchen, Schlüssel am Eintrag', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio() });
  const favs = items.filter(i => i.id === 'radio-favorite');
  assert.deepEqual(favs.map(i => i.label), ['Eins', 'Zwei', 'Drei']);
  assert.deepEqual(favs.map(i => i.checked), [false, true, false]);
  assert.ok(favs.every(i => i.type === 'checkbox'));
  assert.deepEqual([favs[0].sourceId, favs[0].stationId], ['s', 'a']);
  assert.ok(!ids(items).includes('radio-favorites-more'));
});

test('mehr als 12 Favoriten: 12 flach, der Rest unter „Weitere Favoriten“', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ sourceId: 's', id: `f${i}`, name: `Sender ${i + 1}`, active: i === 13 }));
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ favorites: many }) });
  assert.equal(items.filter(i => i.id === 'radio-favorite').length, MAX_VISIBLE_FAVORITES);
  assert.equal(MAX_VISIBLE_FAVORITES, 12);
  const more = items.find(i => i.id === 'radio-favorites-more');
  assert.equal(more.label, 'Weitere Favoriten');
  assert.deepEqual(more.submenu.map(i => i.label), ['Sender 13', 'Sender 14', 'Sender 15']);
  assert.equal(more.submenu[1].checked, true, 'Häkchen auch im Untermenü');
  const exactly = buildTrayMenuModel({ nowMs: NOW, radio: radio({ favorites: many.slice(0, 12) }) });
  assert.ok(!ids(exactly).includes('radio-favorites-more'));
});

test('genau ein Favorit: kein Nächster/Vorheriger', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ favorites: FAVS.slice(0, 1) }) });
  assert.ok(!labels(items).includes('Nächster Favorit') && !labels(items).includes('Vorheriger Favorit'));
  assert.equal(items.filter(i => i.id === 'radio-favorite').length, 1);
});

test('Favoriten-Logo: nur als logo-Feld am Eintrag, wenn geliefert', () => {
  const items = buildTrayMenuModel({
    nowMs: NOW,
    radio: radio({ favorites: [{ sourceId: 's', id: 'a', name: 'Eins', active: false, logo: 'https://x.test/a.png' }, { sourceId: 's', id: 'b', name: 'Zwei', active: false }] }),
  });
  const favs = items.filter(i => i.id === 'radio-favorite');
  assert.equal(favs[0].logo, 'https://x.test/a.png');
  assert.ok(!('logo' in favs[1]));
});

test('ohne Favoriten: „Keine Favoriten“ (deaktiviert), kein Nächster/Vorheriger', () => {
  const items = buildTrayMenuModel({ nowMs: NOW, radio: radio({ favorites: [] }) });
  const empty = items.find(i => i.id === 'radio-favorites-empty');
  assert.equal(empty.enabled, false);
  assert.ok(!labels(items).includes('Nächster Favorit'));
});

test('Lautstärke-Untermenü: Stumm (Häkchen bei 0) und Lauter/Leiser', () => {
  const sub = volume => buildTrayMenuModel({ nowMs: NOW, radio: radio({ volume }) }).find(i => i.id === 'radio-volume-menu').submenu;
  assert.deepEqual(sub(0.5).map(i => i.label), ['Stumm', 'Lauter', 'Leiser']);
  assert.deepEqual(sub(0.5).map(i => i.id), ['radio-mute', 'radio-volume-up', 'radio-volume-down']);
  assert.equal(sub(0.5)[0].checked, false);
  assert.equal(sub(0)[0].checked, true);
  assert.ok(sub(0).slice(1).every(i => i.enabled !== false), 'Lauter/Leiser bleiben bedienbar');
});

test('Texte werden gekürzt und von Steuerzeichen befreit; Labels sind reiner Text', () => {
  const long = 'x'.repeat(200);
  const items = buildTrayMenuModel({
    nowMs: NOW,
    radio: radio({ nowPlaying: { artist: long, title: 'A\u0000B\n%s ${x} <b>' }, favorites: [{ sourceId: 's', id: 'a', name: long, active: false }] }),
  });
  assert.ok(items[0].label.length <= 100, `Statuszeile ${items[0].label.length}`);
  assert.ok(![...items[0].label].some(ch => ch.charCodeAt(0) < 32));
  const fav = items.find(i => i.id === 'radio-favorite');
  assert.ok(fav.label.length <= 40);
  const text = buildTrayMenuModel({ nowMs: NOW, radio: radio({ nowPlaying: { artist: '', title: '%s ${x} <b>' } }) })[0].label;
  assert.equal(text, 'Zwei — %s ${x} <b>', 'unverändert als Text (kein Format-Injection)');
});

// ── Text neben dem Symbol ──

test('trayTitleText: Sender und Titel, nur Sender, aus', () => {
  assert.equal(trayTitleText(0, radio()), 'Zwei · Interpret – Titel');
  assert.equal(trayTitleText(0, radio(), { display: 'station-title', max: 60 }), 'Zwei · Interpret – Titel');
  assert.equal(trayTitleText(0, radio(), { display: 'station' }), 'Zwei');
  assert.equal(trayTitleText(0, radio(), { display: 'off' }), '');
  assert.equal(trayTitleText(0, radio({ nowPlaying: null })), 'Zwei', 'ohne Titel nur der Sender');
  assert.equal(trayTitleText(0, radio({ state: 'loading', nowPlaying: null })), 'Zwei');
});

test('trayTitleText: Pause mit ⏸, Leerfälle (idle, Fehler, kein Radio, ohne Sendername)', () => {
  assert.equal(trayTitleText(0, radio({ state: 'paused' })), '⏸ Zwei');
  assert.equal(trayTitleText(0, radio({ state: 'idle', station: null })), '');
  assert.equal(trayTitleText(0, radio({ state: 'error', error: 'x' })), '');
  assert.equal(trayTitleText(0, null), '');
  assert.equal(trayTitleText(0, undefined), '');
  assert.equal(trayTitleText(0, radio({ station: null })), '');
  assert.equal(trayTitleText(0, radio({ station: { name: '   ' } })), '');
});

test('trayTitleText: Aufnahme hat Vorrang (kein Radiotext)', () => {
  assert.equal(trayTitleText(1, radio()), '');
  assert.equal(trayTitleText(2, radio({ state: 'paused' }), { display: 'station' }), '');
});

test('trayTitleText: hart auf 28 Zeichen gekürzt (mit „…“), Max einstellbar, Steuerzeichen raus', () => {
  const long = trayTitleText(0, radio({ nowPlaying: { artist: 'A'.repeat(50), title: 'B' } }));
  assert.equal(Array.from(long).length, 28);
  assert.ok(long.endsWith('…'));
  assert.equal(trayTitleText(0, radio({ nowPlaying: { artist: 'A'.repeat(50), title: 'B' } }), { max: 10 }).length, 10);
  const exact = 'Zwei · ' + 'x'.repeat(21); // genau 28
  assert.equal(trayTitleText(0, radio({ nowPlaying: { artist: '', title: 'x'.repeat(21) } })), exact);
  assert.equal(trayTitleText(0, radio({ station: { name: 'A\u0000\nB' }, nowPlaying: null })), 'A B');
  assert.equal(Array.from(trayTitleText(0, radio({ station: { name: '😀'.repeat(40) }, nowPlaying: null }))).length, 28, 'Zeichen, nicht UTF-16-Einheiten');
  assert.ok(!trayTitleText(0, radio({ station: { name: 'Rock & Pop' }, nowPlaying: null })).includes('&&'), 'Titeltext ist kein Menü: unmaskiert');
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
    platform: 'darwin',
    ...(extra.opts || {}),
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
  assert.equal(last()[0].label, 'Zwei — I – T1');
  find(last(), 'Pause').click();
  find(last(), 'Stopp').click();
  find(last(), 'Nächster Favorit').click();
  find(last(), 'Vorheriger Favorit').click();
  find(last(), 'Drei').click();
  find(find(last(), 'Lautstärke').submenu, 'Lauter').click();
  find(find(last(), 'Lautstärke').submenu, 'Leiser').click();
  find(last(), 'Radio-Dashboard öffnen').click();
  assert.deepEqual(fake.calls, [
    ['pause'], ['stop'], ['next'], ['prev'],
    ['play', { sourceId: 's', stationId: 'c' }],
    ['setVolume', 0.6],
    ['setVolume', 0.4],
  ]);
  assert.deepEqual(calls, ['show', 'radio']);
  fake.state = { ...fake.state, status: 'paused' };
  controller.refresh();
  find(last(), 'Fortsetzen').click();
  assert.deepEqual(fake.calls.at(-1), ['resume']);
  assert.ok(!('sourceId' in find(last(), 'Drei')) && !('logo' in find(last(), 'Drei')), 'Modell-Metadaten gelangen nicht ins Electron-Template');
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

test('Tray-Etiketten: "&" wird als "&&" maskiert (Mnemonic unter Windows/Linux)', () => {
  const items = buildTrayMenuModel({
    nowMs: NOW,
    radio: radio({ station: { name: 'Rock & Pop' }, nowPlaying: { artist: 'Simon & Garfunkel', title: 'A & B' }, favorites: [{ sourceId: 's', id: 'a', name: 'Rock & Pop', active: true }] }),
  });
  assert.equal(items[0].label, 'Rock && Pop — Simon && Garfunkel – A && B');
  assert.equal(items.find(item => item.id === 'radio-favorite').label, 'Rock && Pop');
  assert.equal(trayTooltip(0, radio({ station: { name: 'Rock & Pop' } })), 'Streaming Hub — Radio: Rock & Pop', 'Tooltip ist kein Menü: unmaskiert');
});

// ── Text neben dem Symbol, Menü-Icons, Lautstärke (TrayController) ──

test('TrayController: Titeltext wird nur bei Änderung gesetzt; Zustände, Pause, Aufnahme-Vorrang', () => {
  menuTemplates.length = 0;
  trayCalls.titles.length = 0;
  const fake = fakeRadio();
  const { controller, advance } = makeController(fake);
  controller.create();
  assert.deepEqual(trayCalls.titles, ['Zwei · I – T1']);
  controller.refresh();
  controller.refreshRadioMenu();
  assert.equal(trayCalls.titles.length, 1, 'unverändert: kein weiterer setTitle');
  advance(6000);
  fake.push({ nowPlaying: { artist: 'I', title: 'T2' } });
  assert.equal(trayCalls.titles.at(-1), 'Zwei · I – T2');
  fake.push({ status: 'paused' });
  assert.equal(trayCalls.titles.at(-1), '⏸ Zwei');
  fake.push({ status: 'idle', station: null, nowPlaying: null });
  assert.equal(trayCalls.titles.at(-1), '', 'idle: Text weg');
  const count = trayCalls.titles.length;
  fake.push({ error: 'x', status: 'error' });
  assert.equal(trayCalls.titles.length, count, 'bereits leer: kein setTitle');
  controller.destroy();

  trayCalls.titles.length = 0;
  const rec = makeController(fakeRadio(), { jobs: [{ meta: { id: 'r1', channelName: 'ZDF' }, getRecordingSec: () => 5 }] });
  rec.controller.create();
  assert.deepEqual(trayCalls.titles, [], 'Aufnahme: kein Radiotext');
  rec.controller.destroy();
});

test('TrayController: Einstellung trayDisplay steuert den Text (nur Sender / aus), refresh wertet sie neu aus', () => {
  menuTemplates.length = 0;
  trayCalls.titles.length = 0;
  let display = 'station';
  const { controller } = makeController(fakeRadio(), { opts: { getTrayDisplay: () => display } });
  controller.create();
  assert.equal(trayCalls.titles.at(-1), 'Zwei');
  display = 'off';
  controller.refresh();
  assert.equal(trayCalls.titles.at(-1), '');
  display = 'station-title';
  controller.refresh();
  assert.equal(trayCalls.titles.at(-1), 'Zwei · I – T1');
  controller.destroy();
});

test('TrayController: ohne setTitle oder nicht unter macOS ein No-Op (Tooltip bleibt)', () => {
  trayCalls.titles.length = 0;
  trayCalls.tooltips.length = 0;
  const linux = makeController(fakeRadio(), { opts: { platform: 'linux' } });
  linux.controller.create();
  linux.controller.refresh();
  assert.deepEqual(trayCalls.titles, []);
  assert.equal(trayCalls.tooltips.at(-1), 'Streaming Hub — Radio: Zwei');
  linux.controller.destroy();

  const original = Object.getOwnPropertyDescriptor(require('electron').Tray.prototype, 'setTitle');
  delete require('electron').Tray.prototype.setTitle;
  try {
    const noTitle = makeController(fakeRadio());
    assert.doesNotThrow(() => noTitle.controller.create());
    noTitle.controller.destroy();
  } finally {
    Object.defineProperty(require('electron').Tray.prototype, 'setTitle', original);
  }
  assert.deepEqual(trayCalls.titles, []);
});

test('TrayController: „Abspielen“ im Leerlauf mit letztem Sender, Stumm merkt die Lautstärke', () => {
  menuTemplates.length = 0;
  const fake = fakeRadio({ status: 'idle', station: null, nowPlaying: null });
  const { controller } = makeController(fake, { opts: { canPlayLast: () => true } });
  controller.create();
  assert.equal(last()[0].label, 'Radio aus');
  find(last(), 'Abspielen').click();
  assert.deepEqual(fake.calls.at(-1), ['play']);
  controller.destroy();

  const nothing = makeController(fakeRadio({ status: 'idle', station: null, nowPlaying: null }));
  nothing.controller.create();
  assert.ok(!find(last(), 'Abspielen'));
  nothing.controller.destroy();

  const radioFake = fakeRadio({ volume: 0.7 });
  const mute = makeController(radioFake);
  mute.controller.create();
  find(find(last(), 'Lautstärke').submenu, 'Stumm').click();
  assert.deepEqual(radioFake.calls.at(-1), ['setVolume', 0]);
  radioFake.push({ volume: 0 });
  assert.equal(find(find(last(), 'Lautstärke').submenu, 'Stumm').checked, true);
  find(find(last(), 'Lautstärke').submenu, 'Stumm').click();
  assert.deepEqual(radioFake.calls.at(-1), ['setVolume', 0.7], 'Entstummen stellt die vorherige Stufe wieder her');
  radioFake.push({ volume: 1 });
  find(find(last(), 'Lautstärke').submenu, 'Lauter').click();
  assert.deepEqual(radioFake.calls.at(-1), ['setVolume', 1], 'Obergrenze');
  radioFake.push({ volume: 0 });
  find(find(last(), 'Lautstärke').submenu, 'Leiser').click();
  assert.deepEqual(radioFake.calls.at(-1), ['setVolume', 0], 'Untergrenze, Item bleibt bedienbar');
  mute.controller.destroy();
});

test('TrayController: Menü-Icons nur mit geladenem Logo, nicht unter Linux, nicht bei ausgeschaltetem Logo-Schalter', () => {
  const LOGO = 'https://logos.test/zwei.png';
  const makeCache = () => {
    const cache = { requested: [], images: new Map(), peek: url => cache.images.get(url) || null, request: urls => cache.requested.push(...urls) };
    return cache;
  };
  let cache = makeCache();
  const favs = FAVS.map(({ sourceId, id, name }) => ({ sourceId, id, name, logo: id === 'b' ? LOGO : undefined }));
  const setup = opts => {
    menuTemplates.length = 0;
    const made = makeController(fakeRadio(), { opts: { logoCache: cache, ...opts } });
    made.controller.getRadioFavorites = () => favs;
    made.controller.create();
    return made.controller;
  };

  let controller = setup();
  assert.deepEqual(cache.requested.slice(0, 1), [LOGO], 'Logos werden im Hintergrund angefordert');
  assert.ok(!('icon' in find(last(), 'Zwei')), 'noch nicht geladen: kein Icon');
  const image = { isEmpty: () => false, name: 'icon' };
  cache.images.set(LOGO, image);
  const before = menuTemplates.length;
  controller.refreshRadioMenu();
  assert.equal(menuTemplates.length, before + 1, 'Eintreffen eines Icons baut das Menü neu');
  assert.equal(find(last(), 'Zwei').icon, image);
  assert.ok(!('logo' in find(last(), 'Zwei')), 'URL gelangt nicht ins Electron-Template');
  assert.ok(!('icon' in find(last(), 'Eins')), 'Sender ohne Logo: kein Icon');
  controller.destroy();

  controller = setup({ platform: 'linux' });
  assert.ok(!('icon' in find(last(), 'Zwei')), 'Linux: keine Menü-Icons');
  controller.destroy();

  cache = makeCache();
  cache.images.set(LOGO, image);
  controller = setup({ logoCache: cache, logosEnabled: () => false });
  assert.ok(!('icon' in find(last(), 'Zwei')), 'Logo-Schalter aus: keine Icons');
  assert.deepEqual(cache.requested, [], 'und nichts wird geladen');
  controller.destroy();
});

// ── Favoriten-Reihenfolge: Tray = Dashboard (globale Reihenfolge, lib/favorite-order.js) ──

function twoSources() {
  const mk = (id, n) => ({
    id,
    name: id,
    type: 'bundled',
    stations: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `${id}-${i}`, streamUrl: `https://${id}.test/${i}` })),
    favorites: [],
  });
  let sources = [mk('alpha', 9), mk('beta', 9)];
  // Favoriten abwechselnd aus beiden Quellen, 15 Stück; bewusst nicht alphabetisch
  const picks = [['beta', 4], ['alpha', 7], ['beta', 0], ['alpha', 2], ['beta', 8], ['alpha', 0], ['beta', 3], ['alpha', 5], ['beta', 6], ['alpha', 1], ['beta', 1], ['alpha', 8], ['beta', 2], ['alpha', 3], ['beta', 5]];
  for (const [src, i] of picks) sources = sourcesLogic.setStationFavorite(sources, src, `s${i}`, true);
  return { sources, picks };
}

const trayFavoriteIds = items => [
  ...items.filter(i => i.id === 'radio-favorite'),
  ...(items.find(i => i.id === 'radio-favorites-more')?.submenu || []),
].map(i => `${i.sourceId}/${i.stationId}`);

function trayItemsFor(sources, active = null) {
  const favorites = sourcesLogic.favoriteStations(sources).map(st => ({
    sourceId: st.sourceId, id: st.id, name: st.name, active: Boolean(active) && active.sourceId === st.sourceId && active.id === st.id,
  }));
  return buildTrayMenuModel({ nowMs: NOW, radio: radio({ favorites }) });
}

test('Favoriten-Reihenfolge: Tray-Menü und Dashboard-Modell liefern dieselbe ID-Folge (mehrere Quellen, ab 13 unter „Weitere“)', () => {
  const { sources, picks } = twoSources();
  const dashboard = () => radioDashboardModel({ sources, state: { status: 'idle' } }).tiles.map(t => `${t.sourceId}/${t.id}`);
  const expected = picks.map(([src, i]) => `${src}/s${i}`);
  assert.deepEqual(dashboard(), expected);
  const items = trayItemsFor(sources);
  assert.deepEqual(trayFavoriteIds(items), expected, 'Tray = Reihenfolge der Nutzerauswahl');
  assert.deepEqual(trayFavoriteIds(items), dashboard());
  assert.deepEqual(items.filter(i => i.id === 'radio-favorite').map(i => `${i.sourceId}/${i.stationId}`), expected.slice(0, 12));
  assert.deepEqual(items.find(i => i.id === 'radio-favorites-more').submenu.map(i => `${i.sourceId}/${i.stationId}`), expected.slice(12), 'Position 13 ff. in derselben Reihenfolge');
});

test('Favoriten-Reihenfolge: nach Umsortieren, Stern aus/an und Quellenwechsel folgt das Menü dem Dashboard', () => {
  let { sources } = twoSources();
  const dash = () => radioDashboardModel({ sources, state: { status: 'idle' } }).tiles.map(t => `${t.sourceId}/${t.id}`);
  const current = sourcesLogic.favoriteKeys(sources);
  const reversed = [...current].reverse();
  sources = sourcesLogic.setFavoriteOrder(sources, reversed);
  assert.deepEqual(trayFavoriteIds(trayItemsFor(sources)), reversed.map(k => `${k.sourceId}/${k.id}`));
  assert.deepEqual(trayFavoriteIds(trayItemsFor(sources)), dash());
  // Stern aus (mitten in der Liste) und wieder an: neuer Favorit steht hinten, wie im Dashboard
  const victim = reversed[3];
  sources = sourcesLogic.setStationFavorite(sources, victim.sourceId, victim.id, false);
  assert.deepEqual(trayFavoriteIds(trayItemsFor(sources)), dash());
  assert.ok(!dash().includes(`${victim.sourceId}/${victim.id}`));
  sources = sourcesLogic.setStationFavorite(sources, victim.sourceId, victim.id, true);
  assert.deepEqual(trayFavoriteIds(trayItemsFor(sources)), dash());
  assert.equal(dash().at(-1), `${victim.sourceId}/${victim.id}`);

  // TrayController: Menü folgt nach radio:sources-changed (refreshRadioMenu) ohne weiteren Anstoß
  menuTemplates.length = 0;
  const fake = fakeRadio();
  const { controller } = makeController(fake);
  const live = () => sourcesLogic.favoriteStations(sources).map(st => ({ sourceId: st.sourceId, id: st.id, name: st.name }));
  controller.getRadioFavorites = live;
  controller.create();
  const names = () => last().filter(i => i.type === 'checkbox' && !i.submenu).map(i => i.label);
  assert.deepEqual(names(), live().slice(0, 12).map(f => f.name));
  sources = sourcesLogic.setFavoriteOrder(sources, [...sourcesLogic.favoriteKeys(sources)].reverse());
  controller.refreshRadioMenu();
  assert.deepEqual(names(), live().slice(0, 12).map(f => f.name));
  controller.destroy();
});

test('Favoriten-Reihenfolge: Nächster/Vorheriger gehen in Menüreihenfolge, Umlauf am Ende und am Anfang', () => {
  const { sources } = twoSources();
  const keys = sourcesLogic.favoriteKeys(sources);
  const menu = trayFavoriteIds(trayItemsFor(sources));
  assert.deepEqual(keys.map(k => `${k.sourceId}/${k.id}`), menu, 'Controller-Liste = Menüliste');
  const at = i => ({ sourceId: keys[i].sourceId, id: keys[i].id });
  const label = k => `${k.sourceId}/${k.id}`;
  for (let i = 0; i < keys.length; i += 1) {
    assert.equal(label(radioState.favoriteNeighbor(keys, at(i), 1)), menu[(i + 1) % menu.length]);
    assert.equal(label(radioState.favoriteNeighbor(keys, at(i), -1)), menu[(i + menu.length - 1) % menu.length]);
  }
  assert.equal(label(radioState.favoriteNeighbor(keys, at(keys.length - 1), 1)), menu[0], 'Umlauf am Ende');
  assert.equal(label(radioState.favoriteNeighbor(keys, at(0), -1)), menu.at(-1), 'Umlauf am Anfang');
});

test('Hauptprozess: Favoritenliste des Tray kommt aus getFavoriteKeys und Quellenänderungen bauen das Menü neu', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /radioLibrary\.getFavoriteKeys\(\)\s*\.map/, 'dieselbe globale Reihenfolge wie Dashboard und Controller');
  assert.match(main, /channel === 'radio:sources-changed' && trayController\) trayController\.refreshRadioMenu\(\)/);
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'radio', 'ipc.js'), 'utf8');
  for (const channel of ['radio:set-favorite', 'radio:set-favorite-order', 'radio:add-custom', 'radio:update-custom', 'radio:remove-custom', 'radio:set-override', 'radio:clear-override']) {
    const at = ipc.indexOf(`'${channel}'`);
    assert.ok(at > 0 && ipc.slice(at, at + 420).includes('broadcastSources'), `${channel} sendet radio:sources-changed`);
  }
});

// ── Lauftext neben dem Symbol ──

const LONG_ARTIST = 'Ein sehr langer Interpretenname';
const { marqueeWindow, MARQUEE_STEP_MS, MARQUEE_START_PAUSE_MS } = require('../lib/radio/tray-marquee.js');
const START_PAUSE_STEPS = Math.ceil(MARQUEE_START_PAUSE_MS / MARQUEE_STEP_MS); // Schritte der Anfangspause inkl. Schritt 0

function makeScrolling(initial = {}, opts = {}) {
  menuTemplates.length = 0;
  trayCalls.titles.length = 0;
  trayCalls.fonts.length = 0;
  const fake = fakeRadio({ nowPlaying: { artist: LONG_ARTIST, title: 'Und ein ebenso langer Titel' }, ...initial });
  const ticks = [];
  const made = makeController(fake, {
    opts: {
      setTick: (fn, ms) => { const t = { fn, ms, cleared: false }; ticks.push(t); return t; },
      clearTick: t => { t.cleared = true; },
      ...opts,
    },
  });
  const live = () => ticks.filter(t => !t.cleared);
  const tick = (n = 1) => { for (let i = 0; i < n; i++) live().at(-1).fn(); };
  return { fake, ticks, live, tick, ...made };
}
const FULL = `Zwei · ${LONG_ARTIST} – Und ein ebenso langer Titel`;

test('Lauftext: langer Text startet den Timer (150 ms), setTitle mit dem Fensteranfang in Monospace', () => {
  const { controller, live } = makeScrolling();
  controller.create();
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 150);
  assert.equal(trayCalls.titles.at(-1), marqueeWindow(FULL, 0).text);
  assert.equal(Array.from(trayCalls.titles.at(-1)).length, 28);
  assert.equal(trayCalls.fonts.at(-1), 'monospaced');
  controller.destroy();
});

test('Lauftext: setTitle nur bei Fensteränderung (Pausen ohne Aufruf), höchstens ~7 Aufrufe pro Sekunde', () => {
  const { controller, tick } = makeScrolling();
  controller.create();
  const before = trayCalls.titles.length;
  tick(START_PAUSE_STEPS - 1); // Pause am Anfang (inkl. Schritt 0)
  assert.equal(trayCalls.titles.length, before, 'Anfangspause: kein setTitle');
  tick(1);
  assert.equal(trayCalls.titles.length, before + 1);
  assert.equal(trayCalls.titles.at(-1), marqueeWindow(FULL, START_PAUSE_STEPS).text);
  const total = marqueeWindow(FULL, 0).cycleSteps;
  tick(total - START_PAUSE_STEPS - 1); // bis eins vor Zyklusende
  const atEnd = trayCalls.titles.length;
  tick(1); // Neustart
  assert.equal(trayCalls.titles.at(-1), marqueeWindow(FULL, 0).text, 'Neustart am Anfang');
  assert.equal(trayCalls.titles.length, atEnd + 1);
  assert.ok(1000 / MARQUEE_STEP_MS <= 7, 'Takt 150 ms = höchstens 6,7 Aufrufe pro Sekunde');
  controller.destroy();
});

test('Lauftext: statisch bei kurzem Text, Pause, idle, error und Aufnahme; Timer wird aufgeräumt', () => {
  const s = makeScrolling({ nowPlaying: null });
  s.controller.create();
  assert.equal(s.live().length, 0, 'kurzer Text: kein Timer');
  assert.equal(trayCalls.titles.at(-1), 'Zwei');
  s.fake.push({ nowPlaying: { artist: LONG_ARTIST, title: 'Und ein ebenso langer Titel' } });
  s.advance(6000);
  s.controller.refresh();
  assert.equal(s.live().length, 1, 'langer Text: Timer läuft');
  s.fake.push({ status: 'paused' });
  assert.equal(s.live().length, 0, 'Pause: Timer gestoppt');
  assert.equal(trayCalls.titles.at(-1), '⏸ Zwei');
  assert.equal(trayCalls.fonts.at(-1), null, 'statisch wieder in der Systemschrift');
  s.fake.push({ status: 'playing' });
  assert.equal(s.live().length, 1);
  s.fake.push({ status: 'idle', station: null, nowPlaying: null });
  assert.equal(s.live().length, 0);
  assert.equal(trayCalls.titles.at(-1), '');
  s.fake.push({ status: 'playing', station: { sourceId: 's', id: 'b', name: 'Zwei' }, nowPlaying: { artist: LONG_ARTIST, title: 'Und ein ebenso langer Titel' } });
  assert.equal(s.live().length, 1);
  s.fake.push({ status: 'error', error: 'x' });
  assert.equal(s.live().length, 0, 'error: Timer gestoppt');
  s.controller.destroy();

  const rec = makeScrolling({}, {});
  rec.controller.recorder.activeJobs = () => [{ meta: { id: 'r1', channelName: 'ZDF' }, getRecordingSec: () => 5 }];
  rec.controller.create();
  assert.equal(rec.live().length, 0, 'Aufnahme-Vorrang: kein Lauftext');
  assert.deepEqual(trayCalls.titles, []);
  rec.controller.destroy();
});

test('Lauftext: Titelwechsel setzt zurück auf den Anfang, derselbe Text nicht', () => {
  const s = makeScrolling();
  s.controller.create();
  s.tick(START_PAUSE_STEPS + 3);
  const scrolled = trayCalls.titles.at(-1);
  assert.notEqual(scrolled, marqueeWindow(FULL, 0).text);
  s.controller.refresh(); // gleicher Text: kein Reset
  assert.equal(trayCalls.titles.at(-1), scrolled);
  s.advance(6000);
  s.fake.push({ nowPlaying: { artist: LONG_ARTIST, title: 'Ein ganz anderer langer Titel' } });
  const next = `Zwei · ${LONG_ARTIST} – Ein ganz anderer langer Titel`;
  assert.equal(trayCalls.titles.at(-1), marqueeWindow(next, 0).text, 'Titelwechsel: wieder von vorn');
  assert.equal(s.live().length, 1, 'weiterhin genau ein Timer');
  s.tick(START_PAUSE_STEPS);
  assert.equal(trayCalls.titles.at(-1), marqueeWindow(next, START_PAUSE_STEPS).text);
  s.controller.destroy();
});

test('Lauftext: trayScroll aus, „Bewegung reduzieren“ und trayDisplay „off“/„station“ → statisch gekürzt', () => {
  let scroll = false;
  const s = makeScrolling({}, { getTrayScroll: () => scroll });
  s.controller.create();
  assert.equal(s.live().length, 0);
  assert.equal(trayCalls.titles.at(-1), `${FULL.slice(0, 27).trimEnd()}…`, 'gekürzt mit …');
  assert.equal(trayCalls.fonts.at(-1), null);
  scroll = true;
  s.controller.refresh(); // Einstellung geändert: sofortige Wirkung
  assert.equal(s.live().length, 1);
  scroll = false;
  s.controller.refresh();
  assert.equal(s.live().length, 0, 'trayScroll aus: Timer weg');
  assert.ok(trayCalls.titles.at(-1).endsWith('…'));
  s.controller.destroy();

  let reduced = true;
  const r = makeScrolling({}, { getReducedMotion: () => reduced });
  r.controller.create();
  assert.equal(r.live().length, 0, 'reducedMotion: kein Timer');
  assert.ok(trayCalls.titles.at(-1).endsWith('…'));
  reduced = false;
  r.controller.refresh();
  assert.equal(r.live().length, 1);
  reduced = true; // während des Laufens eingeschaltet: nächster Tick stoppt und kürzt
  r.tick();
  assert.equal(r.live().length, 0);
  assert.ok(trayCalls.titles.at(-1).endsWith('…'));
  r.controller.destroy();

  let display = 'off';
  const d = makeScrolling({}, { getTrayDisplay: () => display });
  d.controller.create();
  assert.equal(d.live().length, 0, 'off: kein Timer');
  display = 'station';
  d.controller.refresh();
  assert.equal(d.live().length, 0, 'nur Sender (kurz): kein Timer');
  display = 'station-title';
  d.controller.refresh();
  assert.equal(d.live().length, 1);
  display = 'off';
  d.controller.refresh();
  assert.equal(d.live().length, 0);
  assert.equal(trayCalls.titles.at(-1), '');
  d.controller.destroy();
});

test('Lauftext: destroy räumt den Timer auf; Tick nach destroy ist wirkungslos', () => {
  const s = makeScrolling();
  s.controller.create();
  const timer = s.live()[0];
  s.controller.destroy();
  assert.equal(timer.cleared, true);
  const count = trayCalls.titles.length;
  timer.fn();
  assert.equal(trayCalls.titles.length, count);
});

test('Lauftext: nicht unter macOS kein Timer', () => {
  const s = makeScrolling({}, { platform: 'linux' });
  s.controller.create();
  s.controller.refresh();
  assert.equal(s.ticks.length, 0);
  assert.deepEqual(trayCalls.titles, []);
  s.controller.destroy();
  const w = makeScrolling({}, { platform: 'win32' });
  w.controller.create();
  assert.equal(w.ticks.length, 0);
  w.controller.destroy();
});


// ── Pixelweiser Lauftext (trayScrollMode 'smooth') ──

const { PIXEL_WINDOW_WIDTH } = require('../lib/radio/tray-marquee.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

function makePixel(initial = {}, opts = {}) {
  const renders = [];
  const created = [];
  const theme = new EventEmitter();
  theme.shouldUseDarkColors = false;
  const s = makeScrolling(initial, {
    renderTrayText: async (text, { dark }) => {
      renders.push({ text, dark });
      if (opts.renderFails) return null;
      const width = (opts.textWidthPt || PIXEL_WINDOW_WIDTH + 80) * 2;
      return { buffer: Buffer.alloc(width * 64 * 4, 1), width, height: 64 };
    },
    createImage: (buffer, options) => { const image = { frame: true, ...options }; created.push(image); return image; },
    nativeTheme: theme,
    ...(opts.controller || {}),
  });
  return { ...s, renders, created, theme };
}

test('Pixelmodus: langer Text wird einmal gerendert, Frames per setImage, setTitle(\'\') währenddessen, genau ein Takt', async () => {
  const s = makePixel();
  s.controller.create();
  const baseImages = trayCalls.images.length;
  assert.equal(trayCalls.titles.at(-1), `${FULL.slice(0, 27).trimEnd()}…`, 'bis das Bild fertig ist: statisch gekürzt');
  await flush();
  assert.equal(s.renders.length, 1);
  assert.equal(s.renders[0].text, FULL);
  assert.equal(s.renders[0].dark, false);
  assert.equal(s.live().length, 1, 'ein Takt (30 fps), kein Schrittmodus-Timer');
  assert.equal(s.live()[0].ms, 33);
  assert.equal(trayCalls.titles.at(-1), '', 'kein doppelter Text');
  assert.ok(trayCalls.images.length > baseImages);
  assert.equal(trayCalls.images.at(-1).frame, true);
  assert.equal(trayCalls.images.at(-1).scaleFactor, 2);
  s.controller.refresh(); // gleicher Text: kein erneutes Rendern, Titel bleibt leer
  s.controller.refresh();
  await flush();
  assert.equal(s.renders.length, 1);
  assert.equal(trayCalls.titles.at(-1), '');
  s.controller.destroy();
});

test('Pixelmodus: Titelwechsel rendert neu (ein Takt), Pause/idle/error/Aufnahme zurück auf statischen Titel und Symbol, Takt aus', async () => {
  const s = makePixel();
  s.controller.create();
  await flush();
  s.fake.push({ nowPlaying: { artist: LONG_ARTIST, title: 'Ein ganz anderer langer Titel' } });
  await flush();
  assert.equal(s.renders.length, 2);
  assert.equal(s.live().length, 1, 'weiterhin genau ein Takt');
  s.fake.push({ status: 'paused' });
  assert.equal(s.live().length, 0, 'Pause: Takt aus');
  assert.equal(trayCalls.titles.at(-1), '⏸ Zwei', 'statischer Titel');
  assert.equal(trayCalls.images.at(-1).frame, undefined, 'ursprüngliches Symbol wieder gesetzt');
  assert.ok(trayCalls.images.at(-1).p.endsWith('tray-idle.png') || trayCalls.images.at(-1).p.endsWith('tray-radio.png'));
  s.fake.push({ status: 'playing' });
  await flush();
  assert.equal(s.live().length, 1);
  s.fake.push({ status: 'error', error: 'x' });
  assert.equal(s.live().length, 0, 'error: Takt aus');
  assert.equal(trayCalls.images.at(-1).frame, undefined);
  s.fake.push({ status: 'playing' });
  await flush();
  s.fake.push({ status: 'idle', station: null, nowPlaying: null });
  assert.equal(s.live().length, 0);
  assert.equal(trayCalls.titles.at(-1), '');
  s.controller.destroy();

  const rec = makePixel({}, {});
  rec.controller.recorder.activeJobs = () => [{ meta: { id: 'r1', channelName: 'ZDF' }, getRecordingSec: () => 5 }];
  rec.controller.create();
  await flush();
  assert.equal(rec.renders.length, 0, 'Aufnahme-Vorrang: kein Textbild');
  assert.equal(rec.live().length, 0);
  rec.controller.destroy();
});

test('Pixelmodus: Symbolwechsel (refresh) überschreibt das Frame nicht; destroy räumt Takt, Bilder und Theme-Listener auf', async () => {
  const s = makePixel();
  s.controller.create();
  await flush();
  const before = trayCalls.images.length;
  s.controller.refresh();
  assert.equal(trayCalls.images.length, before, 'refresh setzt im Bildmodus kein Symbol');
  assert.equal(s.theme.listenerCount('updated'), 1);
  s.controller.destroy();
  assert.equal(s.live().length, 0);
  assert.equal(s.theme.listenerCount('updated'), 0);
  assert.equal(s.controller._iconBitmaps.size, 0);
  assert.equal(s.controller._pixel.active, false);
});

test('Pixelmodus: Text, der ins Fenster passt, bleibt statischer Titel ohne Takt; Texte ≤ 28 Zeichen werden nicht gerendert', async () => {
  const wide = makePixel({}, { textWidthPt: 120 });
  wide.controller.create();
  await flush();
  assert.equal(wide.renders.length, 1);
  assert.equal(wide.live().length, 0);
  assert.equal(trayCalls.titles.at(-1), FULL, 'ganzer Text als normaler Titel');
  wide.controller.destroy();
  const short = makePixel({ nowPlaying: null });
  short.controller.create();
  await flush();
  assert.equal(short.renders.length, 0);
  assert.equal(trayCalls.titles.at(-1), 'Zwei');
  short.controller.destroy();
});

test('Pixelmodus: Rendern schlägt fehl → Schrittmodus (setTitle mit Fenster, Takt 150 ms), kein Bild', async () => {
  const s = makePixel({}, { renderFails: true });
  s.controller.create();
  await flush();
  assert.equal(s.renders.length, 1);
  assert.equal(s.live().length, 1);
  assert.equal(s.live()[0].ms, 150);
  assert.equal(trayCalls.titles.at(-1), marqueeWindow(FULL, 0).text);
  assert.equal(trayCalls.fonts.at(-1), 'monospaced');
  s.controller.refresh();
  await flush();
  assert.equal(s.renders.length, 1, 'derselbe Text wird nicht erneut versucht');
  s.fake.push({ nowPlaying: { artist: LONG_ARTIST, title: 'Ein ganz anderer langer Titel' } });
  await flush();
  assert.equal(s.renders.length, 2, 'neuer Text: neuer Versuch');
  s.controller.destroy();
});

test('Pixelmodus: trayScrollMode „steps“ rendert nie; Wechsel zur Laufzeit; Nicht-macOS ohne Bildmodus', async () => {
  let mode = 'steps';
  const s = makePixel({}, { controller: { getTrayScrollMode: () => mode } });
  s.controller.create();
  await flush();
  assert.equal(s.renders.length, 0);
  assert.equal(s.live().length, 1);
  assert.equal(s.live()[0].ms, 150);
  mode = 'smooth';
  s.controller.refresh();
  await flush();
  assert.equal(s.renders.length, 1, 'sofortige Wirkung der Einstellung');
  assert.equal(s.live().length, 1, 'Schritt-Timer ersetzt durch Bildtakt');
  assert.equal(s.live()[0].ms, 33);
  assert.equal(trayCalls.titles.at(-1), '');
  mode = 'steps';
  s.controller.refresh();
  assert.equal(s.live()[0].ms, 150);
  assert.equal(trayCalls.images.at(-1).frame, undefined, 'Symbol wieder als Tray-Bild');
  assert.equal(trayCalls.titles.at(-1), marqueeWindow(FULL, 0).text);
  s.controller.destroy();

  const linux = makePixel({}, { controller: { platform: 'linux' } });
  linux.controller.create();
  await flush();
  assert.equal(linux.renders.length, 0);
  assert.equal(linux.live().length, 0);
  linux.controller.destroy();
});

test('Pixelmodus: Hell/Dunkel-Wechsel rendert den Text in der neuen Farbe neu; „Bewegung reduzieren“ stoppt den Bildmodus', async () => {
  let reduced = false;
  const s = makePixel({}, { controller: { getReducedMotion: () => reduced } });
  s.controller.create();
  await flush();
  s.theme.shouldUseDarkColors = true;
  s.theme.emit('updated');
  await flush();
  assert.equal(s.renders.length, 2);
  assert.equal(s.renders[1].dark, true);
  assert.equal(s.live().length, 1);
  reduced = true;
  s.controller.refresh();
  assert.equal(s.live().length, 0);
  assert.ok(trayCalls.titles.at(-1).endsWith('…'));
  assert.equal(trayCalls.images.at(-1).frame, undefined);
  s.controller.destroy();
});
