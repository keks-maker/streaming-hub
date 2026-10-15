'use strict';

// Tests: Podcast-Oberfläche (P3) — Dashboard-Modell (Neue Episoden, Sortierung, Badges, Statuszeile, Leerzustand, Beliebte),
// Sendungsseiten-Modell (Begrenzung, Vorschau, Fehler), Such-Modell (Entprellung, Zustände, veraltete Antworten),
// Feed-Prüfung (erst nach Bestätigung abonnieren), Formate und Routen der Navigation.

const test = require('node:test');
const assert = require('node:assert/strict');
const dash = require('../podcast-dashboard-model.js');
const showModel = require('../podcast-show-model.js');
const { episodeItem, isNewEpisode, episodeStatus } = require('../podcast-episode-model.js');
const { createSearchModel, DEBOUNCE_MS } = require('../podcast-search-model.js');
const { createFeedAddModel } = require('../podcast-feed-add-model.js');
const format = require('../podcast-format.js');
const { persistableRoute, normalizeRoute } = require('../podcast-hub-view.js');

const NOW = Date.parse('2026-10-15T12:00:00Z');
const day = n => new Date(NOW - n * 24 * 3600 * 1000).toISOString();
const ep = (id, daysAgo, state = {}, extra = {}) => ({ id, title: `Folge ${id}`, pubDate: day(daysAgo), duration: 1800, state: { position: 0, duration: null, played: false, ...state }, ...extra });
const sub = (id, title, extra = {}) => ({ id, title, author: 'Autor', cover: 'https://x.test/c.jpg', feedUrl: `https://x.test/${id}.xml`, feed: { lastChecked: new Date(NOW - 3 * 60 * 1000).toISOString(), lastError: null }, ...extra });

test('Neue Episoden: über alle Abos, neueste zuerst; gehörte und alte fallen heraus, begonnene bleiben', () => {
  const model = dash.podcastDashboardModel({
    subscriptions: [sub('a', 'Alpha'), sub('b', 'Beta')],
    episodes: {
      a: { episodes: [ep('a1', 2), ep('a2', 10), ep('a3', 1, { played: true }), ep('a4', 90), ep('a5', 80, { position: 300 })] },
      b: { episodes: [ep('b1', 5), ep('b2', 0.5)] },
    },
    now: NOW,
  });
  assert.deepEqual(model.newEpisodes.map(item => item.episodeId), ['b2', 'a1', 'b1', 'a2', 'a5']);
  assert.equal(model.newCount, 5);
  assert.equal(model.newEpisodes[0].show, 'Beta');
  const started = model.newEpisodes.find(item => item.episodeId === 'a5');
  assert.equal(started.status, 'started');
  assert.equal(started.progress, 0.17);
});

test('Neue Episoden: keine Kappung je Abo/gesamt, Zähler = Zeilenzahl; ab 50 Zeilen „Mehr laden“ in Schritten von 50', () => {
  const many = Array.from({ length: 12 }, (_, i) => ep(`e${i}`, i * 0.1 + 0.1));
  const subs = Array.from({ length: 10 }, (_, i) => sub(`s${i}`, `Show ${i}`));
  const episodes = Object.fromEntries(subs.map(s => [s.id, { episodes: many }]));
  const model = dash.podcastDashboardModel({ subscriptions: subs, episodes, now: NOW });
  assert.equal(model.newCount, 120);
  assert.equal(model.newEpisodes.length, 50, 'erste Seite');
  assert.equal(model.column.hasMore, true);
  assert.equal(model.column.moreLabel, 'Mehr laden (70 weitere)');
  assert.ok(model.newEpisodes.every(item => item.podcastId));
  const second = dash.podcastDashboardModel({ subscriptions: subs, episodes, now: NOW, view: { limit: 100 } });
  assert.equal(second.newEpisodes.length, 100);
  const third = dash.podcastDashboardModel({ subscriptions: subs, episodes, now: NOW, view: { limit: 150 } });
  assert.deepEqual([third.newEpisodes.length, third.column.hasMore, third.newCount], [120, false, 120], 'zuletzt: Zeilen = Zähler');
  const few = dash.podcastDashboardModel({ subscriptions: subs.slice(0, 3), episodes, now: NOW });
  assert.deepEqual([few.newEpisodes.length, few.newCount, few.allEntry.newCount, few.column.hasMore], [36, 36, 36, false], 'unter 50: Zähler = Zeilen, kein „Mehr laden“');
});

test('Abo-Kacheln: Reihenfolge der Abos, Badge mit neuen, Fehlerzustand sichtbar, Text ohne Markup', () => {
  const model = dash.podcastDashboardModel({
    subscriptions: [sub('b', '<b>Beta</b>', { feed: { lastChecked: null, lastError: 'HTTP 404' } }), sub('a', 'Alpha')],
    episodes: { a: { episodes: [ep('a1', 1), ep('a2', 2)] }, b: { episodes: [] } },
    now: NOW,
  });
  assert.deepEqual(model.shows.map(tile => tile.id), ['b', 'a']);
  assert.equal(model.shows[0].title, '<b>Beta</b>'); // unverändert: die Ansicht setzt per textContent
  assert.equal(model.shows[0].error, true);
  assert.equal(model.shows[0].errorText, 'Feed nicht erreichbar');
  assert.equal(model.shows[1].newCount, 2);
  assert.equal(model.shows[1].badgeText, '2');
  assert.match(model.shows[1].ariaLabel, /2 neue Episoden/);
  assert.equal(model.shows[1].badgeLabel, '2 neue Episoden (ungehört, höchstens 30 Tage alt)');
  assert.equal(model.shows[0].badgeLabel, '', 'bei 0 kein Badge-Text');
});

test('Statuszeile: Abos, neue Episoden, zuletzt geprüft', () => {
  const model = dash.podcastDashboardModel({ subscriptions: [sub('a', 'A')], episodes: { a: { episodes: [ep('a1', 1)] } }, now: NOW });
  assert.equal(model.statusText, '1 Abo · 1 neue Episode · geprüft vor 3 Min.');
  const none = dash.podcastDashboardModel({ subscriptions: [sub('a', 'A', { feed: { lastChecked: null } })], episodes: {}, now: NOW });
  assert.equal(none.statusText, '1 Abo · 0 neue Episoden · geprüft noch nie');
});

test('Leerzustand: ohne Abos Kurzliste aus dem Katalog (je Autor zuerst, höchstens 8), bereits abonnierte entfallen', () => {
  const catalog = [{ id: 's', podcasts: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Sendung ${i}`, author: i < 6 ? 'DLF' : `Sender ${i}`, feedUrl: `https://x.test/${i}.xml` })) }];
  const model = dash.podcastDashboardModel({ subscriptions: [], episodes: {}, catalog, now: NOW });
  assert.equal(model.empty, true);
  assert.equal(model.popular.length, 8);
  assert.equal(model.popular[0].catalogId, 'p0');
  assert.equal(model.popular.filter(entry => entry.author === 'DLF').length >= 1, true);
  assert.equal(model.statusText, '');
  const withSub = dash.popularCatalog(catalog, [{ catalogId: 'p0', feedUrl: 'https://x.test/0.xml' }], 3);
  assert.ok(!withSub.some(entry => entry.catalogId === 'p0'));
  assert.equal(dash.podcastDashboardModel({ subscriptions: [sub('a', 'A')], catalog }).popular.length, 0);
  const notLoaded = dash.podcastDashboardModel({ loaded: false });
  assert.equal(notLoaded.empty, false);
});

test('Episode: aktive Episode gekennzeichnet, Aktion Pause/Fortsetzen, Live-Fortschritt, Markieren', () => {
  const episode = ep('x', 1, { position: 60, duration: 600 });
  const idle = episodeItem({ podcastId: 'a', show: 'S', episode, now: NOW });
  assert.equal(idle.active, false);
  assert.equal(idle.action, 'play');
  assert.equal(idle.progress, 0.1);
  assert.equal(idle.markPlayed, true);
  const playing = episodeItem({ podcastId: 'a', show: 'S', episode, now: NOW, player: { status: 'playing', episode: { podcastId: 'a', episodeId: 'x' }, position: 300, duration: 600 } });
  assert.equal(playing.active, true);
  assert.equal(playing.playing, true);
  assert.equal(playing.action, 'pause');
  assert.equal(playing.progress, 0.5);
  const paused = episodeItem({ podcastId: 'a', show: 'S', episode, now: NOW, player: { status: 'paused', episode: { podcastId: 'a', episodeId: 'x' }, position: 10, duration: 600 } });
  assert.equal(paused.action, 'resume');
  assert.equal(paused.playing, false);
  const other = episodeItem({ podcastId: 'b', show: 'S', episode, now: NOW, player: { status: 'playing', episode: { podcastId: 'a', episodeId: 'x' } } });
  assert.equal(other.active, false);
  const played = episodeItem({ podcastId: 'a', show: 'S', episode: ep('y', 1, { played: true }), now: NOW });
  assert.equal(played.markPlayed, false);
  assert.equal(played.markLabel, 'Als ungehört markieren');
  assert.equal(episodeStatus(played ? ep('z', 1, { played: true }) : null), 'played');
  assert.equal(isNewEpisode(ep('o', 40), NOW), false);
});

test('Sendungsseite: Begrenzung mit „Mehr laden“, Fehlerhinweis, Alle-gehört-Zustand', () => {
  const episodes = Array.from({ length: 120 }, (_, i) => ep(`e${i}`, i));
  const subscription = sub('a', 'Alpha', { feed: { lastChecked: day(1), lastError: 'Server antwortete mit HTTP 404' } });
  const first = showModel.podcastShowModel({ id: 'a', subscription, feed: { episodes, channel: { description: 'Beschreibung' } }, now: NOW });
  assert.equal(first.episodes.length, 50);
  assert.equal(first.total, 120);
  assert.equal(first.hasMore, true);
  assert.match(first.moreLabel, /70 weitere/);
  assert.equal(first.description, 'Beschreibung');
  assert.match(first.errorText, /HTTP 404/);
  assert.equal(first.canMarkAll, true);
  const all = showModel.podcastShowModel({ id: 'a', subscription, feed: { episodes }, limit: 500, now: NOW });
  assert.equal(all.episodes.length, 120);
  assert.equal(all.hasMore, false);
  const done = showModel.podcastShowModel({ id: 'a', subscription, feed: { episodes: [ep('p', 1, { played: true })] }, now: NOW });
  assert.equal(done.canMarkAll, false);
  assert.equal(first.subscribeLabel, 'Abbestellen');
});

test('Sendungsseite ohne Abo: Vorschau ohne Episodenliste, Abonnieren-Knopf; Leerzustand ohne Episoden', () => {
  const preview = showModel.podcastShowModel({ id: 'n', preview: { title: 'Neu', author: 'A', episodeCount: 3 }, now: NOW });
  assert.equal(preview.subscribed, false);
  assert.equal(preview.subscribeLabel, 'Abonnieren');
  assert.equal(preview.episodes.length, 0);
  assert.match(preview.previewNote, /3 Episoden/);
  const empty = showModel.podcastShowModel({ id: 'a', subscription: sub('a', 'A'), feed: { episodes: [] }, now: NOW });
  assert.match(empty.emptyText, /Noch keine Episoden/);
});

function fakeTimers() {
  const pending = [];
  return {
    setTimeout: (fn, ms) => {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    clearTimeout: entry => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    },
    pending,
    fire: () => pending.splice(0).forEach(entry => entry.fn()),
  };
}

test('Suche: Entprellung 500 ms — nur die letzte Eingabe sucht; zu kurze Eingabe sucht nie', async () => {
  const timers = fakeTimers();
  const terms = [];
  const model = createSearchModel({ search: async term => (terms.push(term), { ok: true, results: [{ id: 'r', title: term }] }), timers });
  model.setTerm('t');
  assert.equal(model.getState().status, 'idle');
  assert.match(model.getState().message, /Mindestens 2 Zeichen/);
  model.setTerm('ta');
  model.setTerm('tag');
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, DEBOUNCE_MS);
  assert.equal(model.getState().status, 'waiting');
  timers.fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(terms, ['tag']);
  assert.equal(model.getState().status, 'done');
  assert.equal(model.getState().countText, '1 Treffer');
});

test('Suche: Leer-, Fehler- und Rate-Limit-Zustand; Enter sucht sofort; veraltete Antwort wird verworfen', async () => {
  const timers = fakeTimers();
  let reply = { ok: true, results: [] };
  const model = createSearchModel({ search: async () => reply, timers });
  await model.submit('Küche');
  assert.equal(model.getState().status, 'empty');
  assert.match(model.getState().message, /Keine Treffer für „Küche“/);
  reply = { ok: false, error: 'Zu viele Suchanfragen – bitte später erneut versuchen', code: 'rate-limited' };
  await model.submit('Küche2');
  assert.equal(model.getState().status, 'rate-limited');
  assert.match(model.getState().message, /später erneut|erneut versuchen/);
  reply = { ok: false, error: 'Zeitüberschreitung', code: 'network' };
  await model.submit('Küche3');
  assert.equal(model.getState().status, 'error');
  assert.match(model.getState().message, /Zeitüberschreitung/);
  // veraltet: erste Antwort kommt nach der zweiten Eingabe
  let release;
  const slow = new Promise(resolve => (release = resolve));
  let call = 0;
  const racing = createSearchModel({ search: () => (call++ === 0 ? slow : Promise.resolve({ ok: true, results: [{ id: 'neu' }] })), timers });
  const first = racing.submit('alt');
  await racing.submit('neu');
  release({ ok: true, results: [{ id: 'alt' }] });
  await first;
  assert.deepEqual(racing.getState().results.map(result => result.id), ['neu']);
  racing.reset();
  assert.equal(racing.getState().status, 'idle');
});

test('Eigener Feed: erst prüfen, Abo erst nach Bestätigung; Fehler bleiben ohne Abo', async () => {
  const subscribed = [];
  const model = createFeedAddModel({
    probe: async url => (url.includes('gut') ? { ok: true, title: 'Gut', author: 'A', episodeCount: 7 } : { ok: false, error: 'Kein gültiger Podcast-Feed' }),
    subscribe: async feed => (subscribed.push(feed.feedUrl), { subscription: { id: 'neu' } }),
  });
  model.setUrl('https://x.test/schlecht.xml');
  await model.check();
  assert.equal(model.getState().status, 'error');
  assert.equal(await model.confirm(), null);
  model.setUrl('https://x.test/gut.xml');
  await model.check();
  assert.equal(model.getState().status, 'ready');
  assert.deepEqual(subscribed, []); // geprüft, aber noch nicht abonniert
  const result = await model.confirm();
  assert.deepEqual(subscribed, ['https://x.test/gut.xml']);
  assert.equal(result.subscription.id, 'neu');
  assert.equal(model.getState().status, 'idle');
  model.setUrl('');
  await model.check();
  assert.match(model.getState().message, /Feed-Adresse/);
});

test('Formate: Dauer, Datum, relative Zeit, Cover-Art', () => {
  assert.equal(format.formatDuration(45 * 60), '45 Min.');
  assert.equal(format.formatDuration(3900), '1 Std. 05 Min.');
  assert.equal(format.formatDuration(30), '30 Sek.');
  assert.equal(format.formatDuration(0), '');
  assert.equal(format.formatEpisodeDate(new Date(NOW).toISOString(), NOW), 'Heute');
  assert.equal(format.formatEpisodeDate(day(1), NOW), 'Gestern');
  assert.equal(format.formatEpisodeDate(day(3), NOW), 'vor 3 Tagen');
  assert.match(format.formatEpisodeDate(day(20), NOW), /^\d{2}\.\d{2}\.\d{4}$/);
  assert.equal(format.formatAgo(day(0.0001), NOW), 'gerade eben');
  assert.equal(format.formatAgo(day(2), NOW), 'vor 2 Tagen');
  assert.equal(format.coverKind('https://a.test/c.jpg'), 'https');
  assert.equal(format.coverKind('http://a.test/c.jpg'), 'http');
  assert.equal(format.coverKind('https://u:p@a.test/c.jpg'), null);
  assert.equal(format.coverKind('javascript:alert(1)'), null);
});

test('Navigation: Routen werden für den Verlauf reduziert und beim Wiederherstellen geprüft', () => {
  assert.equal(persistableRoute({ view: 'home' }), null);
  assert.deepEqual(persistableRoute({ view: 'show', id: 'abc', preview: { title: 'x' } }), { view: 'show', id: 'abc' });
  assert.deepEqual(persistableRoute({ view: 'search', term: 'geheim' }), { view: 'search' });
  assert.deepEqual(normalizeRoute({ view: 'show', id: 'abc' }), { view: 'show', id: 'abc', preview: null });
  assert.deepEqual(normalizeRoute({ view: 'show' }), { view: 'home' });
  assert.deepEqual(normalizeRoute('x'), { view: 'home' });
  assert.deepEqual(normalizeRoute(null), { view: 'home' });
});
