'use strict';

// Tests: Startseite „Fortsetzen“ (Design-Umbau Schritt 6) — Auswahl, Reihenfolge und Leerfall der Karten.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runningNowCards, radioCard, podcastCard, historyCard, recordingCard, cardAriaLabel, MAX_CARDS } = require('../running-now-model.js');

const sources = [{ id: 'src', stations: [{ id: 'swr3', name: 'SWR3' }, { id: 'dlf', name: 'Deutschlandfunk' }] }];
const lastStation = { sourceId: 'src', id: 'swr3' };
const episodes = {
  p1: {
    episodes: [
      { id: 'a', title: 'Alt', state: { position: 60, duration: 600, played: false, updatedAt: '2026-11-01T10:00:00Z' } },
      { id: 'b', title: 'Neu begonnen', state: { position: 300, duration: 600, played: false, updatedAt: '2026-11-10T10:00:00Z' } },
      { id: 'c', title: 'Gehört', state: { position: 500, duration: 600, played: true, updatedAt: '2026-11-15T10:00:00Z' } },
      { id: 'd', title: 'Unberührt', state: { position: 0, played: false } },
    ],
  },
};
const subscriptions = [{ id: 'p1', title: 'Die Sendung' }];
const history = [
  { title: 'Gelöscht', serviceKey: 'weg', serviceName: 'Weg' },
  { title: 'Film X', serviceKey: 'nf', serviceName: 'Netflix' },
];

test('leer: ohne Daten keine Karten', () => {
  assert.deepEqual(runningNowCards({}), []);
  assert.deepEqual(runningNowCards({ recordings: [], radio: { sources, state: { status: 'idle' } }, podcast: { subscriptions, episodes: {} }, history: { history: [], serviceIds: [] } }), []);
});

test('Aufnahme: nur status recording; mehrere werden zu einer Karte', () => {
  assert.equal(recordingCard([{ status: 'completed' }, { status: 'failed' }]), null);
  const one = recordingCard([{ status: 'recording', channelName: 'Das Erste', epgTitle: 'Tagesschau' }]);
  assert.equal(one.title, 'Tagesschau');
  assert.match(one.subtitle, /Das Erste/);
  assert.deepEqual(one.action, { type: 'recordings' });
  assert.equal(one.live, true);
  assert.equal(recordingCard([{ status: 'recording', channelName: 'A' }, { status: 'recording', channelName: 'B' }]).title, '2 Aufnahmen');
});

test('Radio: zuletzt gehört, laufend und pausiert', () => {
  const idle = radioCard({ sources, lastStation, state: { status: 'idle' } });
  assert.equal(idle.title, 'SWR3');
  assert.equal(idle.subtitle, 'Zuletzt gehört');
  assert.equal(idle.live, true);
  assert.equal(idle.active, false);
  assert.equal(idle.action.type, 'radio-play');
  const playing = radioCard({ sources, lastStation, state: { status: 'playing', station: { sourceId: 'src', id: 'dlf', name: 'x' } } });
  assert.equal(playing.title, 'Deutschlandfunk');
  assert.equal(playing.subtitle, 'Läuft');
  assert.equal(playing.action.type, 'radio-open');
  const paused = radioCard({ sources, lastStation, state: { status: 'paused', station: { sourceId: 'src', id: 'dlf' } } });
  assert.equal(paused.subtitle, 'Pausiert');
  assert.equal(paused.action.type, 'radio-play');
  assert.equal(radioCard({ sources, lastStation: { sourceId: 'src', id: 'unbekannt' }, state: null }), null);
  assert.equal(radioCard({ sources, state: null }), null);
});

test('Podcast: jüngste begonnene, ungehörte Episode mit Fortschritt', () => {
  const card = podcastCard({ subscriptions, episodes });
  assert.equal(card.title, 'Neu begonnen');
  assert.equal(card.subtitle, 'Die Sendung');
  assert.equal(card.progress, 0.5);
  assert.deepEqual(card.action, { type: 'podcast', podcastId: 'p1', episodeId: 'b', play: true });
  assert.equal(podcastCard({ subscriptions, episodes: { p1: { episodes: [episodes.p1.episodes[2], episodes.p1.episodes[3]] } } }), null);
});

test('Podcast: laufende Episode hat Vorrang und nutzt die Playerposition', () => {
  const player = { status: 'playing', episode: { podcastId: 'p1', episodeId: 'a' }, position: 150, duration: 600 };
  const card = podcastCard({ subscriptions, episodes, player });
  assert.equal(card.title, 'Alt');
  assert.equal(card.progress, 0.25);
  assert.equal(card.active, true);
  assert.equal(card.action.play, false);
});

test('Verlauf: jüngster Eintrag mit bekanntem Dienst; LiveTV-Sender als live', () => {
  assert.equal(historyCard({ history, serviceIds: ['nf'] }).title, 'Film X');
  assert.equal(historyCard({ history, serviceIds: [] }), null);
  const tv = historyCard({ history: [{ title: 'TV: Das Erste', serviceKey: '__tv__', serviceName: 'Das Erste' }], serviceIds: [] });
  assert.equal(tv.live, true);
  assert.deepEqual(tv.action, { type: 'tv', name: 'Das Erste' });
});

test('Reihenfolge: laufende zuerst, sonst Aufnahme, Radio, Podcast, Verlauf; höchstens vier', () => {
  const input = {
    recordings: [{ status: 'recording', channelName: 'Kanal' }],
    radio: { sources, lastStation, state: { status: 'idle' } },
    podcast: { subscriptions, episodes },
    history: { history, serviceIds: ['nf'] },
  };
  assert.deepEqual(runningNowCards(input).map(c => c.kind), ['recording', 'radio', 'podcast', 'history']);
  const playingRadio = { ...input, recordings: [], radio: { sources, lastStation, state: { status: 'playing', station: { sourceId: 'src', id: 'dlf' } } } };
  assert.deepEqual(runningNowCards(playingRadio).map(c => c.kind), ['radio', 'podcast', 'history']);
  const playingBoth = { ...input, radio: playingRadio.radio };
  assert.deepEqual(runningNowCards(playingBoth).map(c => c.kind), ['recording', 'radio', 'podcast', 'history']);
  const onlyPodcastPlaying = { ...input, recordings: [], podcast: { subscriptions, episodes, player: { status: 'playing', episode: { podcastId: 'p1', episodeId: 'b' } } } };
  assert.deepEqual(runningNowCards(onlyPodcastPlaying).map(c => c.kind), ['podcast', 'radio', 'history']);
  assert.ok(runningNowCards(input).length <= MAX_CARDS);
});

test('aria-Beschriftung nennt Titel, Zustand, live und Fortschritt', () => {
  assert.equal(cardAriaLabel({ title: 'SWR3', subtitle: 'Läuft', live: true, progress: null }), 'SWR3, Läuft, live');
  assert.equal(cardAriaLabel({ title: 'Folge', subtitle: 'Sendung', live: false, progress: 0.5 }), 'Folge, Sendung, 50 Prozent gehört');
});

test('Verlaufskarte: gespeicherte Adresse des Eintrags wird Ziel, ungültige fällt auf leer zurück', () => {
  const { historyEntryUrl } = require('../running-now-model.js');
  const url = 'https://www.youtube.com/watch?v=abc123DEF45';
  const card = historyCard({ history: [{ title: 'Video', serviceKey: 'youtube', serviceName: 'YouTube', url }], serviceIds: ['youtube'] });
  assert.deepEqual(card.action, { type: 'service', serviceKey: 'youtube', url });
  assert.equal(historyCard({ history: [{ title: 'Video', serviceKey: 'youtube', serviceName: 'YouTube' }], serviceIds: ['youtube'] }).action.url, '');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'kein url', '', null, 42]) assert.equal(historyEntryUrl({ url: bad }), '');
});
