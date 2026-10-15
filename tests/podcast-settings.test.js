'use strict';

// Tests: Podcast-Einstellungen (P4) — Validierung, Persistenz (podcast-settings.json), Backup/Restore, Einstellungsdienst
// (Lautstärke verzögert speichern), Prüf-Zeitplan, Mindestabstand der Feed-Prüfung, nächste Episode und die Wirkung auf den
// PodcastController (Standardgeschwindigkeit, Sprungweiten, Autoplay, „gehört“-Automatik). Kein Fenster, kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../lib/podcast/podcast-settings.js');
const { PodcastLibrary } = require('../lib/podcast/PodcastLibrary.js');
const { PodcastController } = require('../lib/podcast/PodcastController.js');
const listenState = require('../lib/podcast/podcast-state.js');
const { createPodcastSettingsService } = require('../lib/podcast/podcast-settings-service.js');
const { createRefreshSchedule, intervalMs } = require('../lib/podcast/podcast-refresh-timer.js');
const { createPodcastRefresher, INTERVAL_TOLERANCE_MS } = require('../lib/podcast/podcast-refresh.js');
const { nextEpisodeId } = require('../lib/podcast/podcast-next.js');
const { createUserStorage } = require('../lib/user-storage.js');
const { parseBackup } = require('../lib/backup.js');
const { validatePodcastSettingsPatch } = require('../lib/podcast/podcast-settings.js');
const { validatePodcastReorder, validatePodcastOverride } = require('../lib/ipc-validation.js');
const { ManualTimers, createFakeWindowClass } = require('./helpers/radio-fakes.js');

function tmpStorage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-podcast-settings-'));
  const bundlePath = path.join(root, 'bundle');
  fs.mkdirSync(bundlePath, { recursive: true });
  return { root, storage: createUserStorage({ userDataPath: path.join(root, 'user'), bundlePath }) };
}

// ── Modell und Validierung ──

test('Standardwerte: Rate 1, Sprünge 15/30, Autoplay aus, Intervall 60, „gehört“ an, Lautstärke 0,8', () => {
  assert.deepEqual(settings.normalizePodcastSettings(undefined), { rate: 1, skipBack: 15, skipForward: 30, autoPlayNext: false, refreshIntervalMinutes: 60, autoMarkPlayed: true, volume: 0.8 });
  assert.deepEqual(settings.normalizePodcastSettings([]), settings.normalizePodcastSettings({}));
});

test('Normalisierung: ungültige Werte fallen auf den Standard zurück, gültige bleiben', () => {
  const clean = settings.normalizePodcastSettings({ rate: 1.5, skipBack: 10, skipForward: 60, autoPlayNext: true, refreshIntervalMinutes: 120, autoMarkPlayed: false, volume: 0.3 });
  assert.deepEqual(clean, { rate: 1.5, skipBack: 10, skipForward: 60, autoPlayNext: true, refreshIntervalMinutes: 120, autoMarkPlayed: false, volume: 0.3 });
  const broken = settings.normalizePodcastSettings({ rate: 'schnell', skipBack: 7, skipForward: -3, autoPlayNext: 'ja', refreshIntervalMinutes: 5, autoMarkPlayed: 0, volume: 'laut', extra: 1 });
  assert.deepEqual(broken, { rate: 1, skipBack: 15, skipForward: 30, autoPlayNext: false, refreshIntervalMinutes: 60, autoMarkPlayed: true, volume: 0.8 });
  assert.equal(settings.normalizePodcastSettings({ refreshIntervalMinutes: 15 }).refreshIntervalMinutes, 60, 'Minimum 30 Minuten');
  assert.equal(settings.normalizePodcastSettings({ volume: 5 }).volume, 1);
});

test('Patch-Validierung: nur bekannte Felder mit erlaubten Werten', () => {
  assert.deepEqual(validatePodcastSettingsPatch({ skipBack: 30 }), { skipBack: 30 });
  for (const bad of [null, [], {}, { unbekannt: 1 }, { skipBack: 12 }, { skipForward: '30' }, { refreshIntervalMinutes: 10 }, { refreshIntervalMinutes: 45 }, { rate: 3 }, { autoPlayNext: 1 }, { autoMarkPlayed: 'true' }, { volume: 2 }, { volume: NaN }]) {
    assert.throws(() => validatePodcastSettingsPatch(bad), undefined, JSON.stringify(bad));
  }
  const next = settings.applyPodcastSettingsPatch(settings.normalizePodcastSettings({}), { autoPlayNext: true, rate: 1.25 });
  assert.equal(next.autoPlayNext, true);
  assert.equal(next.rate, 1.25);
});

// ── Persistenz und Backup ──

test('PodcastLibrary: Einstellungen werden in podcast-settings.json gespeichert und überstehen einen Neustart', () => {
  const { storage, root } = tmpStorage();
  const library = new PodcastLibrary({ userStorage: storage });
  assert.equal(library.getSettings().skipBack, 15);
  assert.equal(library.updateSettings({ skipBack: 10, autoPlayNext: true }).skipBack, 10);
  assert.throws(() => library.updateSettings({ skipBack: 3 }), /Sprungweite/);
  const file = path.join(root, 'user', 'podcast-settings.json');
  assert.ok(fs.existsSync(file));
  const reopened = new PodcastLibrary({ userStorage: createUserStorage({ userDataPath: path.join(root, 'user'), bundlePath: path.join(root, 'bundle') }) });
  assert.deepEqual([reopened.getSettings().skipBack, reopened.getSettings().autoPlayNext], [10, true]);
  fs.writeFileSync(file, '{kaputt');
  assert.equal(reopened.getSettings().skipBack, 15, 'beschädigte Datei: Standardwerte statt Absturz');
});

test('Backup: Einstellungen werden exportiert; Import normalisiert; ältere Sicherungen ohne Einstellungen bleiben gültig', () => {
  const { storage } = tmpStorage();
  const library = new PodcastLibrary({ userStorage: storage });
  library.updateSettings({ refreshIntervalMinutes: 30 });
  assert.equal(library.exportBackup().podcastSettings.refreshIntervalMinutes, 30);
  const base = { services: [], tvsources: [], history: [] };
  assert.equal(parseBackup(JSON.stringify(base)).podcastSettings, undefined);
  const restored = parseBackup(JSON.stringify({ ...base, podcastSettings: { skipBack: 10, refreshIntervalMinutes: 7, autoPlayNext: 'x', fremd: true } }));
  assert.deepEqual(restored.podcastSettings, { ...settings.DEFAULT_PODCAST_SETTINGS, skipBack: 10 });
});

// ── Einstellungsdienst ──

test('Einstellungsdienst: update validiert, speichert, meldet an Controller und Oberfläche; Lautstärke nur verzögert', () => {
  const { storage } = tmpStorage();
  const library = new PodcastLibrary({ userStorage: storage });
  const timers = new ManualTimers();
  const changed = [];
  let controllerCalls = 0;
  const service = createPodcastSettingsService({ library, controller: { settingsChanged: () => (controllerCalls += 1) }, onChanged: next => changed.push(next), setTimer: timers.setTimer, clearTimer: timers.clearTimer, volumeDelayMs: 600 });
  assert.equal(service.get().skipForward, 30);
  service.update({ skipForward: 45 });
  assert.equal(service.get().skipForward, 45);
  assert.deepEqual([controllerCalls, changed.length], [1, 1]);
  assert.throws(() => service.update({ skipForward: 5 }));
  service.rememberVolume(0.2);
  service.rememberVolume(0.4);
  assert.equal(library.getSettings().volume, 0.8, 'noch nicht geschrieben');
  assert.equal(timers.pending(600), 1, 'ein Timer, auch bei mehreren Werten');
  timers.fire(600);
  assert.equal(library.getSettings().volume, 0.4);
  service.rememberVolume(0.6);
  service.flushVolume();
  assert.equal(library.getSettings().volume, 0.6, 'flushVolume (Beenden) schreibt sofort');
  assert.equal(changed.length, 1, 'Lautstärke löst keine Folgeaktion aus');
});

// ── Zeitplan und Mindestabstand ──

test('Prüf-Zeitplan: Start nach Verzögerung, Intervall aus der Einstellung (30/60/120, Minimum 30), reschedule bei Änderung', () => {
  assert.deepEqual([intervalMs(30), intervalMs(60), intervalMs(120), intervalMs(5), intervalMs('x')], [1800000, 3600000, 7200000, 1800000, 3600000]);
  let minutes = 60;
  const log = [];
  const handles = [];
  const schedule = createRefreshSchedule({
    run: () => log.push('run'),
    getIntervalMinutes: () => minutes,
    startDelayMs: 20000,
    setTimer: (fn, ms) => (handles.push({ kind: 'timer', fn, ms }), handles.at(-1)),
    clearTimer: handle => (handle.cleared = true),
    setTick: (fn, ms) => (handles.push({ kind: 'tick', fn, ms }), handles.at(-1)),
    clearTick: handle => (handle.cleared = true),
  });
  schedule.start();
  assert.deepEqual(handles.map(h => [h.kind, h.ms]), [['timer', 20000], ['tick', 3600000]]);
  handles[0].fn();
  assert.deepEqual(log, ['run']);
  schedule.reschedule(); // unverändert: kein neuer Takt
  assert.equal(handles.length, 2);
  minutes = 30;
  schedule.reschedule();
  assert.equal(handles[1].cleared, true);
  assert.deepEqual([handles[2].kind, handles[2].ms], ['tick', 1800000]);
  assert.equal(schedule.getIntervalMs(), 1800000);
  schedule.stop();
  assert.equal(handles[2].cleared, true);
});

test('Feed-Prüfung: Mindestabstand ohne ETag folgt dem Prüfintervall, Taktabweichung wird toleriert', async () => {
  const { storage } = tmpStorage();
  const library = new PodcastLibrary({ userStorage: storage });
  const { subscription } = library.subscribe({ feedUrl: 'https://a.test/feed', title: 'A', source: 'eigene-podcasts' });
  let nowMs = Date.parse('2026-10-15T10:00:00Z');
  let interval = 30 * 60 * 1000;
  let calls = 0;
  const feed = '<?xml version="1.0"?><rss version="2.0"><channel><title>A</title><item><title>E</title><guid>g1</guid><enclosure url="https://a.test/e.mp3" type="audio/mpeg"/></item></channel></rss>';
  const refresher = createPodcastRefresher({ library, now: () => new Date(nowMs), noValidatorIntervalMs: () => interval, fetch: async () => ((calls += 1), { status: 'ok', text: feed, etag: null, lastModified: null }) });
  assert.equal((await refresher.refreshOne(subscription.id)).status, 'updated');
  nowMs += 20 * 60 * 1000;
  assert.equal((await refresher.refreshOne(subscription.id)).status, 'skipped', '20 min < 30 min');
  nowMs += 10 * 60 * 1000 - 1000; // 29:59 nach dem Lauf: Timer-Tick wenige Sekunden früher gilt noch als fällig (Toleranz)
  assert.ok(INTERVAL_TOLERANCE_MS >= 1000);
  assert.equal((await refresher.refreshOne(subscription.id)).status, 'updated');
  interval = 120 * 60 * 1000;
  nowMs += 60 * 60 * 1000;
  assert.equal((await refresher.refreshOne(subscription.id)).status, 'skipped', 'bei 120 min nach 60 min noch nicht fällig');
  assert.equal(calls, 2);
});

// ── Nächste Episode ──

test('nextEpisodeId: nächstneuere ungehörte Episode; ohne neuere oder ohne Audio keine', () => {
  const eps = [
    { id: 'e4', audioUrl: 'https://x/4' },
    { id: 'e3', audioUrl: 'https://x/3' },
    { id: 'e2', audioUrl: 'https://x/2' },
    { id: 'e1', audioUrl: 'https://x/1' },
  ];
  assert.equal(nextEpisodeId(eps, 'e1'), 'e2');
  assert.equal(nextEpisodeId(eps, 'e1', id => ({ played: id === 'e2' })), 'e3', 'gehörte werden übersprungen');
  assert.equal(nextEpisodeId(eps, 'e1', id => ({ played: id !== 'e4' })), 'e4');
  assert.equal(nextEpisodeId(eps, 'e1', () => ({ played: true })), null);
  assert.equal(nextEpisodeId(eps, 'e4'), null, 'neueste Episode: kein Nachfolger');
  assert.equal(nextEpisodeId(eps, 'unbekannt'), null);
  assert.equal(nextEpisodeId([{ id: 'b', audioUrl: '' }, { id: 'a', audioUrl: 'https://x/a' }], 'a'), null, 'ohne Audio-Adresse');
  assert.equal(nextEpisodeId([{ id: 'b', audioUrl: 'https://x/b', state: { played: true } }, { id: 'a', audioUrl: 'https://x/a' }], 'a'), null, 'state der Episode zählt');
  assert.equal(nextEpisodeId(null, 'a'), null);
});

// ── Wirkung auf den PodcastController ──

const SUB = { id: 'p1', title: 'Sendung', cover: null };
const EPISODES = [
  { id: 'e3', title: 'Folge 3', audioUrl: 'https://a.test/e3.mp3', duration: 100 },
  { id: 'e2', title: 'Folge 2', audioUrl: 'https://a.test/e2.mp3', duration: 100 },
  { id: 'e1', title: 'Folge 1', audioUrl: 'https://a.test/e1.mp3', duration: 100 },
];

function controllerSetup(initialSettings = {}) {
  const { FakeWindow, instances } = createFakeWindowClass();
  const timers = new ManualTimers();
  let current = settings.normalizePodcastSettings(initialSettings);
  let state = listenState.normalizeState({});
  const library = {
    getSubscription: id => (id === SUB.id ? SUB : null),
    getCachedFeed: () => ({ episodes: EPISODES }),
    getEpisodes: () => ({ episodes: EPISODES.map(e => ({ ...e, state: listenState.getEpisodeState(state, 'p1', e.id) })) }),
    getEpisodeState: (p, e) => listenState.getEpisodeState(state, p, e),
    savePosition: (p, e, progress) => {
      state = listenState.savePosition(state, p, e, progress, new Date('2026-10-15T10:00:00Z'));
      return listenState.getEpisodeState(state, p, e);
    },
  };
  const controller = new PodcastController({ BrowserWindow: FakeWindow, playerHtml: '/p.html', preloadPath: '/pre.js', library, getSettings: () => current, rate: current.rate, volume: current.volume, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const events = [];
  controller.on('state', s => events.push(s));
  const win = () => instances[instances.length - 1];
  const cmds = name => win().commands().filter(c => c.cmd === name);
  const start = async episodeId => {
    await controller.play({ podcastId: 'p1', episodeId });
    controller.onPlayerReport({ t: 'ready' });
    const seq = cmds('play').at(-1).seq;
    controller.onPlayerReport({ t: 'playing', seq });
    return seq;
  };
  return { controller, events, instances, win, cmds, start, set: patch => (current = settings.normalizePodcastSettings({ ...current, ...patch })), played: id => listenState.getEpisodeState(state, 'p1', id).played };
}

test('Controller: Standardgeschwindigkeit gilt je neu gestarteter Episode, nicht mitten in der laufenden', async () => {
  const t = controllerSetup({ rate: 1.5 });
  assert.equal(t.controller.getState().rate, 1.5, 'Leerlauf: Startwert');
  await t.start('e1');
  assert.equal(t.cmds('play')[0].rate, 1.5);
  t.controller.setRate(2); // nur für diese Episode
  t.set({ rate: 1.25 });
  t.controller.settingsChanged();
  assert.equal(t.controller.getState().rate, 2, 'laufende Episode behält ihre Geschwindigkeit');
  await t.controller.play({ podcastId: 'p1', episodeId: 'e2' });
  assert.equal(t.controller.getState().rate, 1.25);
});

test('Controller: Sprungweiten stehen im Zustand und gelten für Medientasten; Änderung wird gemeldet', async () => {
  const t = controllerSetup({ skipBack: 10, skipForward: 45 });
  const s = await t.start('e1');
  assert.deepEqual([t.controller.getState().skipBack, t.controller.getState().skipForward], [10, 45]);
  t.controller.onPlayerReport({ t: 'time', seq: s, position: 50, duration: 3000 });
  t.controller.onPlayerReport({ t: 'action', action: 'seekforward' });
  assert.equal(t.controller.getState().position, 95);
  t.controller.onPlayerReport({ t: 'action', action: 'previoustrack' });
  assert.equal(t.controller.getState().position, 85);
  const before = t.events.length;
  t.set({ skipBack: 30 });
  t.controller.settingsChanged();
  assert.equal(t.events.length, before + 1);
  assert.equal(t.events.at(-1).skipBack, 30);
});

test('Controller: „nach Ende nächste Episode“ aus: Ende bleibt beendet, nichts startet', async () => {
  const t = controllerSetup({ autoPlayNext: false });
  const s = await t.start('e1');
  t.controller.onPlayerReport({ t: 'ended', seq: s });
  assert.equal(t.controller.getState().status, 'ended');
  assert.equal(t.instances.length, 1);
});

test('Controller: „nach Ende nächste Episode“ an: nächstneuere ungehörte Episode startet ohne Zwischenzustand „beendet“', async () => {
  const t = controllerSetup({ autoPlayNext: true });
  const s = await t.start('e1');
  t.controller.onPlayerReport({ t: 'ended', seq: s });
  assert.equal(t.events.some(e => e.status === 'ended'), false, 'kein „ended“ nach außen (sonst beendet die App bei geschlossenem Fenster)');
  assert.equal(t.controller.getState().episode.episodeId, 'e2');
  assert.equal(t.controller.getState().status, 'loading');
  assert.equal(t.played('e1'), true, 'beendete Episode ist gehört');
  assert.equal(t.instances.length, 2, 'neues Player-Fenster für die nächste Episode');
  t.controller.onPlayerReport({ t: 'ready' });
  assert.equal(t.cmds('play')[0].url, 'https://a.test/e2.mp3');
  // Folge 2 beendet: es folgt Folge 3, danach (neueste) endet die Wiedergabe
  const t2 = controllerSetup({ autoPlayNext: true });
  const s2 = await t2.start('e2');
  t2.controller.onPlayerReport({ t: 'ended', seq: s2 });
  assert.equal(t2.controller.getState().episode.episodeId, 'e3');
  t2.controller.onPlayerReport({ t: 'ready' });
  const s3 = t2.cmds('play').at(-1).seq;
  t2.controller.onPlayerReport({ t: 'ended', seq: s3 });
  assert.equal(t2.controller.getState().status, 'ended', 'neueste Episode: kein Nachfolger');
});

test('Controller: „automatisch gehört“ aus: 95 % und Ende markieren nicht, Fortschritt bleibt', async () => {
  const off = controllerSetup({ autoMarkPlayed: false });
  const s = await off.start('e1');
  off.controller.onPlayerReport({ t: 'time', seq: s, position: 97, duration: 100 });
  off.controller.pause();
  assert.equal(off.played('e1'), false);
  off.controller.resume();
  off.controller.onPlayerReport({ t: 'ended', seq: s });
  assert.equal(off.played('e1'), false);
  const on = controllerSetup({ autoMarkPlayed: true });
  const s2 = await on.start('e1');
  on.controller.onPlayerReport({ t: 'time', seq: s2, position: 97, duration: 100 });
  on.controller.pause();
  assert.equal(on.played('e1'), true);
});

test('Lautstärke: eigene Einstellung des Controllers startet mit dem gespeicherten Wert (nicht Radio)', () => {
  const t = controllerSetup({ volume: 0.35 });
  assert.equal(t.controller.getState().volume, 0.35);
});

// ── IPC-Validierung der Verwaltung ──

test('IPC-Validierung: Reihenfolge und Anpassung', () => {
  assert.deepEqual(validatePodcastReorder({ order: ['a', 'b'] }), { order: ['a', 'b'] });
  assert.throws(() => validatePodcastReorder({ order: 'a' }));
  assert.throws(() => validatePodcastReorder({ order: [1] }));
  assert.throws(() => validatePodcastReorder({ order: ['a'], extra: 1 }));
  assert.deepEqual(validatePodcastOverride({ id: 'p', title: '  Neu ' }), { id: 'p', patch: { title: 'Neu' } });
  assert.deepEqual(validatePodcastOverride({ id: 'p', title: '', cover: null }), { id: 'p', patch: { title: null, cover: null } });
  assert.deepEqual(validatePodcastOverride({ id: 'p', cover: 'https://a.test/c.png' }), { id: 'p', patch: { cover: 'https://a.test/c.png' } });
  for (const bad of [{ id: 'p' }, { id: 'p', cover: 'ftp://a.test/c.png' }, { id: 'p', cover: 'https://u:p@a.test/c.png' }, { id: 'p', cover: 'javascript:alert(1)' }, { id: 'p', cover: 5 }, { id: 'p', title: 'x'.repeat(301) }, { id: 'p', title: 'a\u0000b' }, { id: '', title: 'x' }, { id: 'p', title: 'x', extra: 1 }]) {
    assert.throws(() => validatePodcastOverride(bad), undefined, JSON.stringify(bad));
  }
});
