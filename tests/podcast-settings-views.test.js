'use strict';

// Tests: Einstellungsseiten Podcasts (P4) — Modell (Reihenfolge, Status, Formular) und die drei Ansichten (Abos, Eigene Feeds,
// Wiedergabe) mit Fake-DOM und einer Attrappe für window.podcasts. Außerdem: Navigation, Mini-Player-Sprungweiten,
// „Podcasts verwalten“. Kein Browser, kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../settings-podcast-subs-model.js');
const { SETTINGS_NAV, isValidPage } = require('../settings-view.js');
const { createPodcastSubsView } = require('../settings-podcast-subs.js');
const { createPodcastFeedsView } = require('../settings-podcast-feeds.js');
const { createPodcastPlaybackView } = require('../settings-podcast-playback.js');
const { createPodcastDashboard } = require('../podcast-dashboard-view.js');
const { podcastMiniPlayerModel } = require('../radio-miniplayer-model.js');
const { normalizePodcastSettings } = require('../lib/podcast/podcast-settings.js');
const { makeDoc } = require('./helpers/fake-dom.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const NOW = Date.parse('2026-10-15T12:00:00Z');
const sub = (id, over = {}) => ({ id, title: `Sendung ${id}`, author: 'Autor', source: 'suche', cover: null, feedUrl: `https://${id}.test/feed`, feed: { lastChecked: '2026-10-15T11:50:00Z', lastError: null, lastErrorAt: null }, ...over });

// ── Modell ──

test('Navigation: Gruppe „Podcasts“ mit Abos, Eigene Feeds, Wiedergabe direkt nach Radio', () => {
  const keys = SETTINGS_NAV.map(entry => entry.key || entry.page);
  assert.ok(keys.indexOf('podcasts') === keys.indexOf('radio') + 1);
  const group = SETTINGS_NAV.find(entry => entry.key === 'podcasts');
  assert.deepEqual(group.children.map(c => c.page), ['podcast-subs', 'podcast-feeds', 'podcast-playback']);
  assert.ok(['podcast-subs', 'podcast-feeds', 'podcast-playback'].every(page => isValidPage(page)));
});

test('Modell: Reihenfolge verschieben und per Drop; Grenzen und Unbekanntes ändern nichts', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(model.moveId(order, 'c', -1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(model.moveId(order, 'a', 1), ['b', 'a', 'c', 'd']);
  assert.equal(model.moveId(order, 'a', -1), null);
  assert.equal(model.moveId(order, 'd', 1), null);
  assert.equal(model.moveId(order, 'x', 1), null);
  assert.deepEqual(model.dropOn(order, 'a', 'c'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(model.dropOn(order, 'd', 'a'), ['d', 'a', 'b', 'c']);
  assert.equal(model.dropOn(order, 'a', 'a'), null);
  assert.equal(model.dropOn(order, 'a', 'x'), null);
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'Eingabe bleibt unverändert');
});

test('Modell: Fehlerstatus, Quellen, Zusammenfassung, Formularprüfung, Patch', () => {
  assert.deepEqual(model.feedStatus(sub('a'), NOW), { kind: 'ok', text: 'Geprüft vor 10 Min.' });
  assert.deepEqual(model.feedStatus(sub('a', { feed: {} }), NOW), { kind: 'pending', text: 'Noch nicht geprüft' });
  const failed = model.feedStatus(sub('a', { feed: { lastError: 'Feed nicht erreichbar (404)', lastErrorAt: '2026-10-15T11:00:00Z', lastChecked: '2026-10-15T11:00:00Z' } }), NOW);
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /404.*vor 1 Std\./);
  assert.equal(model.sourceLabel({ source: 'eigene-podcasts' }), 'Eigener Feed');
  assert.equal(model.isCustom({ source: 'eigene-podcasts' }), true);
  assert.equal(model.isCustom({ source: 'suche' }), false);
  assert.equal(model.summary([sub('a'), sub('b', { feed: { lastError: 'x' } })]), '2 Abos · 1 mit Fehler');
  assert.equal(model.summary([sub('a')]), '1 Abo');
  assert.deepEqual(model.validateOverrideForm({ title: '  Neu ', cover: ' https://a.test/c.png ' }), { values: { title: 'Neu', cover: 'https://a.test/c.png' }, errors: {} });
  for (const cover of ['ftp://a.test/c.png', 'a.test/c.png', 'https://u:p@a.test/c.png', 'javascript:1']) {
    assert.ok(model.validateOverrideForm({ cover }).errors.cover, cover);
  }
  assert.ok(model.validateOverrideForm({ title: 'x'.repeat(301) }).errors.title);
  const current = sub('a', { overrides: { title: 'Alt', cover: 'https://a.test/c.png' } });
  assert.equal(model.overridePatch(current, { title: 'Alt', cover: 'https://a.test/c.png' }), null);
  assert.deepEqual(model.overridePatch(current, { title: '', cover: 'https://a.test/c.png' }), { title: null });
  assert.deepEqual(model.overridePatch(sub('b'), { title: 'Neu', cover: '' }), { title: 'Neu' });
});

// ── Attrappe ──

function makePodcasts({ subs = [sub('a'), sub('b'), sub('c')], settings, failOverride } = {}) {
  const calls = [];
  const listeners = { subs: new Set(), refreshed: new Set(), settings: new Set(), state: new Set() };
  const api = {
    calls,
    subs,
    settings: normalizePodcastSettings(settings || {}),
    list: async () => api.subs,
    reorder: async ({ order }) => {
      calls.push(['reorder', order]);
      api.subs = order.map(id => api.subs.find(s => s.id === id));
      return api.commit(api.subs);
    },
    setOverride: async input => {
      calls.push(['setOverride', input]);
      if (failOverride) throw new Error("Error invoking remote method 'podcast:set-override': Error: Cover konnte nicht geladen werden (Adresse nicht erreichbar oder kein Bild)");
      api.subs = api.subs.map(s => {
        if (s.id !== input.id) return s;
        const overrides = { ...(s.overrides || {}) };
        for (const key of ['title', 'cover']) if (key in input) (input[key] ? (overrides[key] = input[key]) : delete overrides[key]);
        return { ...s, title: overrides.title || (s.original && s.original.title) || s.title, original: { title: (s.original && s.original.title) || s.title, cover: null }, overrides: Object.keys(overrides).length ? overrides : undefined };
      });
      return api.commit(api.subs);
    },
    unsubscribe: async id => {
      calls.push(['unsubscribe', id]);
      api.subs = api.subs.filter(s => s.id !== id);
      api.commit(api.subs);
      return { ok: true, removed: true };
    },
    refresh: async options => {
      calls.push(['refresh', options]);
      return { ok: true, failed: 1 };
    },
    probeFeed: async url => {
      calls.push(['probeFeed', url]);
      return /broken/.test(url) ? { ok: false, error: 'Kein gültiger Podcast-Feed' } : { ok: true, title: 'Probe <b>Feed</b>', author: 'Probe-Autor', cover: null, episodeCount: 7 };
    },
    subscribe: async input => {
      calls.push(['subscribe', input]);
      const added = !api.subs.some(s => s.feedUrl === input.feedUrl);
      if (added) api.subs = [...api.subs, sub('neu', { title: input.title, source: input.source, feedUrl: input.feedUrl })];
      api.commit(api.subs);
      return { ok: true, added };
    },
    getSettings: async () => api.settings,
    setSettings: async patch => {
      calls.push(['setSettings', patch]);
      if (api.failSettings) throw new Error("Error invoking remote method 'podcast:set-settings': Error: kaputt");
      api.settings = normalizePodcastSettings({ ...api.settings, ...patch });
      return api.settings;
    },
    getCover: async () => ({ ok: false }),
    commit(next) {
      api.subs = next;
      listeners.subs.forEach(cb => cb(next));
      return next;
    },
    onSubscriptionsChanged: cb => (listeners.subs.add(cb), () => listeners.subs.delete(cb)),
    onRefreshed: cb => (listeners.refreshed.add(cb), () => listeners.refreshed.delete(cb)),
    onSettingsChanged: cb => (listeners.settings.add(cb), () => listeners.settings.delete(cb)),
    emitSettings: next => listeners.settings.forEach(cb => cb(next)),
    player: {
      getState: async () => ({ volume: 0.6 }),
      setVolume: async value => calls.push(['setVolume', value]),
      onState: cb => (listeners.state.add(cb), () => listeners.state.delete(cb)),
    },
    emitPlayer: next => listeners.state.forEach(cb => cb(next)),
  };
  return api;
}

function mount(create, podcasts, extra = {}) {
  const doc = makeDoc();
  const root = doc.createElement('div');
  root.ownerDocument = doc;
  const view = create(root, { podcasts, now: () => NOW, ...extra });
  return { root, view, doc };
}

const byId = (root, id) => root.byId(id);
const rowsOf = root => root.byId('settingsPodcastSubsList').children;
const names = root => rowsOf(root).map(row => row.byClass('settings-podcast-name')[0].textContent);
const action = (node, name) => node.find(n => n.dataset && n.dataset.action === name && !n.disabled)[0];
const field = (node, name) => node.find(n => n.dataset && n.dataset.field === name)[0];

// ── Abos ──

test('Abos: Liste in gespeicherter Reihenfolge, Text ohne Markup, Fehlerstatus sichtbar', async () => {
  const api = makePodcasts({ subs: [sub('a', { title: '<b>Fett</b>' }), sub('b', { feed: { lastError: 'Feed nicht erreichbar (404)', lastErrorAt: '2026-10-15T11:00:00Z', lastChecked: '2026-10-15T11:00:00Z' } }), sub('c', { source: 'eigene-podcasts' })] });
  const { root, view } = mount(createPodcastSubsView, api);
  await view.refresh();
  assert.deepEqual(names(root), ['<b>Fett</b>', 'Sendung b', 'Sendung c']);
  assert.equal(root.find(n => n.tagName === 'b').length, 0, 'kein Markup aus Feed-Texten');
  assert.equal(byId(root, 'settingsPodcastSubsSummary').textContent, '3 Abos · 1 mit Fehler');
  const errorRow = rowsOf(root)[1];
  assert.match(errorRow.byClass('settings-podcast-feedstatus')[0].textContent, /Fehler beim Prüfen: Feed nicht erreichbar \(404\)/);
  assert.ok(errorRow.byClass('settings-podcast-feedstatus')[0].classList.contains('error'));
  assert.match(rowsOf(root)[2].textContent, /Eigener Feed/);
  assert.equal(byId(root, 'settingsPodcastSubsEmpty').hidden, true);
});

test('Abos: Leerzustand mit Hinweis, „Jetzt aktualisieren“ deaktiviert', async () => {
  const { root, view } = mount(createPodcastSubsView, makePodcasts({ subs: [] }));
  await view.refresh();
  assert.equal(byId(root, 'settingsPodcastSubsEmpty').hidden, false);
  assert.equal(byId(root, 'settingsPodcastSubsRefresh').disabled, true);
  assert.equal(rowsOf(root).length, 0);
});

test('Abos: ▲▼ ändern die Reihenfolge (Speichern über podcast:reorder), Fokus bleibt, Grenzen deaktiviert', async () => {
  const api = makePodcasts();
  const { root, view } = mount(createPodcastSubsView, api);
  await view.refresh();
  assert.equal(action(rowsOf(root)[0], 'up'), undefined, '▲ am Listenanfang deaktiviert');
  assert.equal(rowsOf(root)[2].find(n => n.dataset && n.dataset.action === 'down')[0].disabled, true);
  action(rowsOf(root)[2], 'up').click();
  await tick();
  assert.deepEqual(api.calls.at(-1), ['reorder', ['a', 'c', 'b']]);
  assert.deepEqual(names(root), ['Sendung a', 'Sendung c', 'Sendung b']);
  assert.match(byId(root, 'settingsPodcastSubsStatus').textContent, /Reihenfolge gespeichert/);
  assert.ok(rowsOf(root)[1].find(n => n.dataset && n.dataset.action === 'up')[0].getAttribute('aria-label').startsWith('Sendung c'));
  action(rowsOf(root)[0], 'down').click();
  await tick();
  assert.deepEqual(api.calls.at(-1), ['reorder', ['c', 'a', 'b']]);
});

test('Abos: Drag & Drop legt den gezogenen Eintrag auf das Ziel', async () => {
  const api = makePodcasts();
  const { root, view } = mount(createPodcastSubsView, api);
  await view.refresh();
  const handle = rowsOf(root)[0].byClass('settings-chan-drag')[0];
  const data = {};
  handle.dispatch('dragstart', { dataTransfer: { setData: (t, v) => (data[t] = v), effectAllowed: '' } });
  assert.equal(data['text/plain'], 'a');
  assert.ok(rowsOf(root)[0].classList.contains('dragging'));
  const target = rowsOf(root)[2];
  target.dispatch('dragover', { preventDefault() {} });
  assert.ok(target.classList.contains('drag-over'));
  target.dispatch('drop', { preventDefault() {}, dataTransfer: { getData: t => data[t] } });
  await tick();
  assert.deepEqual(api.calls.at(-1), ['reorder', ['b', 'c', 'a']]);
  assert.deepEqual(names(root), ['Sendung b', 'Sendung c', 'Sendung a']);
});

test('Abos: Abbestellen erst nach Bestätigung; „Behalten“ bricht ab', async () => {
  const api = makePodcasts();
  const { root, view } = mount(createPodcastSubsView, api);
  await view.refresh();
  action(rowsOf(root)[1], 'remove').click();
  assert.equal(api.calls.length, 0, 'noch nichts passiert');
  assert.ok(action(rowsOf(root)[1], 'confirm-remove'));
  assert.equal(action(rowsOf(root)[0], 'confirm-remove'), undefined, 'nur die gewählte Zeile fragt nach');
  action(rowsOf(root)[1], 'cancel-remove').click();
  assert.equal(api.calls.length, 0);
  assert.ok(action(rowsOf(root)[1], 'remove'));
  action(rowsOf(root)[1], 'remove').click();
  action(rowsOf(root)[1], 'confirm-remove').click();
  await tick();
  assert.deepEqual(api.calls.at(-1), ['unsubscribe', 'b']);
  assert.deepEqual(names(root), ['Sendung a', 'Sendung c']);
  assert.match(byId(root, 'settingsPodcastSubsStatus').textContent, /abbestellt/);
});

test('Abos: Anpassen — Name und Cover speichern, Formularfehler ohne Aufruf, Fehler des Main am Feld, Zurücksetzen', async () => {
  const api = makePodcasts();
  const { root, view } = mount(createPodcastSubsView, api);
  await view.refresh();
  action(rowsOf(root)[0], 'edit').click();
  const form = () => root.find(n => n.tagName === 'form')[0];
  const input = name => field(form(), name);
  assert.ok(input('title') && input('cover'));
  input('cover').value = 'ftp://x.test/c.png';
  input('cover').dispatch('input');
  form().dispatch('submit', { preventDefault() {} });
  await tick();
  assert.equal(api.calls.filter(c => c[0] === 'setOverride').length, 0, 'ungültige Adresse erreicht den Main nicht');
  assert.match(form().textContent, /http:\/\/ oder https:\/\//);
  input('title').value = '  Mein Name ';
  input('title').dispatch('input');
  input('cover').value = 'https://img.test/c.png';
  input('cover').dispatch('input');
  form().dispatch('submit', { preventDefault() {} });
  await tick();
  await tick();
  assert.deepEqual(api.calls.at(-1), ['setOverride', { id: 'a', title: 'Mein Name', cover: 'https://img.test/c.png' }]);
  assert.equal(names(root)[0], 'Mein Name');
  assert.equal(root.find(n => n.tagName === 'form').length, 0, 'Formular geschlossen');
  assert.match(rowsOf(root)[0].textContent, /angepasst/);
  // Zurücksetzen entfernt beide Felder
  action(rowsOf(root)[0], 'edit').click();
  action(form(), 'reset').click();
  await tick();
  await tick();
  assert.deepEqual(api.calls.at(-1), ['setOverride', { id: 'a', title: null, cover: null }]);
  assert.equal(names(root)[0], 'Sendung a');
});

test('Abos: Cover-Fehler des Main erscheint am Feld, Eingaben bleiben erhalten', async () => {
  const api = makePodcasts({ failOverride: true });
  const { root, view } = mount(createPodcastSubsView, api);
  await view.refresh();
  action(rowsOf(root)[0], 'edit').click();
  const form = () => root.find(n => n.tagName === 'form')[0];
  field(form(), 'cover').value = 'http://192.168.0.5/c.png';
  field(form(), 'cover').dispatch('input');
  form().dispatch('submit', { preventDefault() {} });
  await tick();
  await tick();
  assert.match(form().textContent, /Cover konnte nicht geladen werden/);
  assert.equal(field(form(), 'cover').value, 'http://192.168.0.5/c.png');
  assert.ok(root.find(n => n.getAttribute && n.getAttribute('aria-invalid') === 'true').length >= 1);
});

test('Abos: „Jetzt aktualisieren“ erzwingt die Prüfung und meldet Fehlerzahl', async () => {
  const api = makePodcasts();
  const { root, view } = mount(createPodcastSubsView, api);
  await view.refresh();
  byId(root, 'settingsPodcastSubsRefresh').click();
  await tick();
  await tick();
  assert.deepEqual(api.calls.find(c => c[0] === 'refresh'), ['refresh', { force: true }]);
  assert.match(byId(root, 'settingsPodcastSubsStatus').textContent, /1 Abo hat einen Fehler/);
  assert.equal(byId(root, 'settingsPodcastSubsRefresh').disabled, false);
});

// ── Eigene Feeds ──

test('Eigene Feeds: prüfen, Vorschau zeigen, erst nach Bestätigung abonnieren (Quelle eigene-podcasts)', async () => {
  const api = makePodcasts({ subs: [sub('x', { source: 'eigene-podcasts', title: 'Mein Feed' }), sub('y')] });
  const { root, view } = mount(createPodcastFeedsView, api);
  await view.refresh();
  assert.equal(root.byId('settingsPodcastFeedList').children.length, 1, 'nur eigene Feeds in der Liste');
  const input = byId(root, 'settingsPodcastFeedUrl');
  input.value = 'https://neu.test/feed.xml';
  input.dispatch('input');
  root.find(n => n.tagName === 'form')[0].dispatch('submit', { preventDefault() {} });
  await tick();
  assert.deepEqual(api.calls.find(c => c[0] === 'probeFeed'), ['probeFeed', 'https://neu.test/feed.xml']);
  assert.equal(byId(root, 'settingsPodcastFeedPreview').hidden, false);
  assert.match(byId(root, 'settingsPodcastFeedPreview').textContent, /Probe <b>Feed<\/b>/, 'Titel als Text');
  assert.match(byId(root, 'settingsPodcastFeedPreview').textContent, /7 Episoden/);
  assert.equal(api.calls.filter(c => c[0] === 'subscribe').length, 0, 'noch nicht abonniert');
  byId(root, 'settingsPodcastFeedConfirm').click();
  await tick();
  await tick();
  assert.deepEqual(api.calls.find(c => c[0] === 'subscribe'), ['subscribe', { feedUrl: 'https://neu.test/feed.xml', source: 'eigene-podcasts', title: 'Probe <b>Feed</b>', author: 'Probe-Autor' }]);
  assert.equal(byId(root, 'settingsPodcastFeedPreview').hidden, true);
  assert.equal(root.byId('settingsPodcastFeedList').children.length, 2);
  assert.match(byId(root, 'settingsPodcastFeedStatus').textContent, /abonniert/);
});

test('Eigene Feeds: ungültiger Feed zeigt den Fehler ohne Abo; bereits abonnierter Feed wird gemeldet', async () => {
  const api = makePodcasts({ subs: [sub('x', { source: 'eigene-podcasts', feedUrl: 'https://dup.test/feed.xml' })] });
  const { root, view } = mount(createPodcastFeedsView, api);
  await view.refresh();
  const input = byId(root, 'settingsPodcastFeedUrl');
  const form = root.find(n => n.tagName === 'form')[0];
  input.value = 'https://x.test/broken.xml';
  input.dispatch('input');
  form.dispatch('submit', { preventDefault() {} });
  await tick();
  assert.match(byId(root, 'settingsPodcastFeedMessage').textContent, /Kein gültiger Podcast-Feed/);
  assert.equal(byId(root, 'settingsPodcastFeedPreview').hidden, true);
  input.value = 'https://dup.test/feed.xml';
  input.dispatch('input');
  form.dispatch('submit', { preventDefault() {} });
  await tick();
  byId(root, 'settingsPodcastFeedConfirm').click();
  await tick();
  await tick();
  assert.match(byId(root, 'settingsPodcastFeedMessage').textContent, /bereits abonniert/);
  form.dispatch('submit', { preventDefault() {} });
  input.value = '';
  input.dispatch('input');
  form.dispatch('submit', { preventDefault() {} });
  assert.match(byId(root, 'settingsPodcastFeedMessage').textContent, /Feed-Adresse eingeben/);
});

test('Eigene Feeds: Abbestellen mit Bestätigung, Liste zeigt nur den Host (nie die vollständige URL)', async () => {
  const api = makePodcasts({ subs: [sub('x', { source: 'eigene-podcasts', title: 'Privat', feedUrl: 'https://privat.test/feed?token=geheim' })] });
  const { root, view } = mount(createPodcastFeedsView, api);
  await view.refresh();
  const row = root.byId('settingsPodcastFeedList').children[0];
  assert.match(row.textContent, /privat\.test/);
  assert.doesNotMatch(root.textContent, /geheim/);
  action(row, 'remove').click();
  assert.equal(api.calls.length, 0);
  action(root.byId('settingsPodcastFeedList').children[0], 'confirm-remove').click();
  await tick();
  await tick();
  assert.deepEqual(api.calls.at(-1), ['unsubscribe', 'x']);
  assert.equal(byId(root, 'settingsPodcastFeedEmpty').hidden, false);
});

// ── Wiedergabe ──

test('Wiedergabe: Werte laden, Änderungen sofort über setSettings speichern, Fehler stellt die Anzeige zurück', async () => {
  const api = makePodcasts({ settings: { rate: 1.25, skipBack: 10, skipForward: 45, autoPlayNext: true, refreshIntervalMinutes: 30, autoMarkPlayed: false, volume: 0.5 } });
  const { root, view } = mount(createPodcastPlaybackView, api);
  await view.refresh();
  assert.deepEqual(['settingsPodcastRate', 'settingsPodcastSkipBack', 'settingsPodcastSkipForward', 'settingsPodcastInterval'].map(id => byId(root, id).value), ['1.25', '10', '45', '30']);
  assert.equal(byId(root, 'settingsPodcast-autoPlayNext').checked, true);
  assert.equal(byId(root, 'settingsPodcast-autoMarkPlayed').checked, false);
  assert.equal(byId(root, 'settingsPodcastVolume').value, '60', 'Lautstärke folgt dem Player-Zustand');
  const skip = byId(root, 'settingsPodcastSkipForward');
  skip.value = '30';
  skip.dispatch('change');
  await tick();
  assert.deepEqual(api.calls.at(-1), ['setSettings', { skipForward: 30 }]);
  assert.match(byId(root, 'settingsPodcastPlaybackStatus').textContent, /Gespeichert/);
  const interval = byId(root, 'settingsPodcastInterval');
  interval.value = '120';
  interval.dispatch('change');
  await tick();
  assert.deepEqual(api.calls.at(-1), ['setSettings', { refreshIntervalMinutes: 120 }]);
  const mark = byId(root, 'settingsPodcast-autoMarkPlayed');
  mark.checked = true;
  mark.dispatch('change');
  await tick();
  assert.deepEqual(api.calls.at(-1), ['setSettings', { autoMarkPlayed: true }]);
  api.failSettings = true;
  const next = byId(root, 'settingsPodcast-autoPlayNext');
  next.checked = false;
  next.dispatch('change');
  await tick();
  assert.equal(next.checked, true, 'Fehler: gespeicherter Stand bleibt sichtbar');
  assert.match(byId(root, 'settingsPodcastPlaybackStatus').textContent, /kaputt/);
});

test('Wiedergabe: Lautstärke über player.setVolume, Änderungen aus dem Main werden übernommen, Hinweis auf gemeinsame Radio-Optionen', async () => {
  const api = makePodcasts();
  let opened = 0;
  const { root, view } = mount(createPodcastPlaybackView, api, { onOpenRadioPlayback: () => (opened += 1) });
  await view.refresh();
  const slider = byId(root, 'settingsPodcastVolume');
  slider.value = '25';
  slider.dispatch('input');
  assert.equal(byId(root, 'settingsPodcastVolumeValue').textContent, '25 %');
  slider.dispatch('change');
  await tick();
  assert.deepEqual(api.calls.at(-1), ['setVolume', 0.25]);
  api.emitPlayer({ volume: 0.9 });
  assert.equal(slider.value, '90');
  api.emitSettings(normalizePodcastSettings({ skipBack: 60 }));
  assert.equal(byId(root, 'settingsPodcastSkipBack').value, '60');
  assert.match(byId(root, 'settingsPodcastSharedNote').textContent, /weiterspielen/);
  assert.match(byId(root, 'settingsPodcastSharedNote').textContent, /auch für Podcasts/);
  byId(root, 'settingsPodcastOpenRadioPlayback').click();
  assert.equal(opened, 1);
  const options = byId(root, 'settingsPodcastSkipBack').children.map(o => o.value);
  assert.deepEqual(options, ['10', '15', '30', '45', '60']);
  assert.deepEqual(byId(root, 'settingsPodcastInterval').children.map(o => o.value), ['30', '60', '120']);
});

// ── Mini-Player und Dashboard ──

test('Mini-Player-Modell: Sprungweiten aus dem Zustand, ungültige Werte fallen auf 15/30', () => {
  const base = { status: 'playing', episode: { podcastId: 'p', episodeId: 'e', title: 'T', show: 'S', cover: null }, position: 10, duration: 100, rate: 1, volume: 0.5, error: null };
  assert.deepEqual([podcastMiniPlayerModel(base).skipBack, podcastMiniPlayerModel(base).skipForward], [15, 30]);
  const set = podcastMiniPlayerModel({ ...base, skipBack: 10, skipForward: 60 });
  assert.deepEqual([set.skipBack, set.skipForward], [10, 60]);
  const bad = podcastMiniPlayerModel({ ...base, skipBack: -1, skipForward: 'x' });
  assert.deepEqual([bad.skipBack, bad.skipForward], [15, 30]);
});

test('Dashboard: „Podcasts verwalten“ ruft die Verwaltung auf; ohne Handler ist der Knopf verborgen', () => {
  const build = manage => {
    const doc = makeDoc();
    const root = doc.createElement('div');
    root.ownerDocument = doc;
    const data = { snapshot: () => ({ loaded: false, subscriptions: [], episodes: {}, catalog: [], refreshing: false, loadError: '' }), subscribe: () => () => {}, load() {}, loadCatalog() {}, refreshAll: async () => ({}) };
    createPodcastDashboard(root, { podcasts: { player: {} }, data, getPlayer: () => null, now: () => NOW, open() {}, announce() {}, notify() {}, logger: null, manage });
    return root;
  };
  let calls = 0;
  const withManage = build(() => (calls += 1));
  const button = byId(withManage, 'podcastManage');
  assert.equal(button.hidden, false);
  assert.match(button.textContent, /Podcasts verwalten/);
  button.click();
  assert.equal(calls, 1);
  assert.equal(byId(build(null), 'podcastManage').hidden, true);
});
