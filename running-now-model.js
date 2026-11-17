// Startseite „Fortsetzen“ (Design-Umbau Schritt 6): Auswahl und Reihenfolge der kleinen Karten. Reine Funktionen ohne
// DOM und IPC; die Ansicht (running-now-view.js) rendert das Ergebnis. Datenquellen sind vorhandene Renderer-Zustände:
// recording:list, Radio-Zustand und -Einstellungen, Podcast-Daten (Hörzustand je Episode) und der Verlauf.

'use strict';

const { findStation } = require('./lib/radio/radio-sources-logic.js');
const { sanitizeHistoryUrl, hostBelongsToService } = require('./lib/history-entry.js');

const MAX_CARDS = 4;
const TV_KEY = '__tv__';
const RADIO_ACTIVE = ['loading', 'playing', 'paused'];
const PODCAST_ACTIVE = ['loading', 'playing', 'paused'];

const text = value => (typeof value === 'string' ? value.trim() : '');

/** Gespeicherte Adresse eines Verlaufseintrags, nur wenn sie http/https ist und zur Domain des Dienstes (serviceUrl) gehört, sonst ''. */
function historyEntryUrl(entry, serviceUrl) {
  const clean = sanitizeHistoryUrl(entry && entry.url);
  return clean && hostBelongsToService(clean, serviceUrl) ? clean : '';
}

function clamp01(value, total) {
  if (!(total > 0) || !(value > 0)) return 0;
  return Math.min(1, value / total);
}

/** Laufende Aufnahmen (status 'recording'): eine Karte, bei mehreren als Zähler. */
function recordingCard(recordings) {
  const running = (Array.isArray(recordings) ? recordings : []).filter(rec => rec && rec.status === 'recording');
  if (!running.length) return null;
  if (running.length > 1) {
    return { kind: 'recording', area: 'livetv', icon: 'circle-dot', title: `${running.length} Aufnahmen`, subtitle: 'laufen gerade', live: true, rec: true, progress: null, active: true, action: { type: 'recordings' } };
  }
  const rec = running[0];
  const channel = text(rec.channelName);
  const title = text(rec.epgTitle) || channel || 'Aufnahme';
  return { kind: 'recording', area: 'livetv', icon: 'circle-dot', title, subtitle: channel && channel !== title ? `Aufnahme · ${channel}` : 'Aufnahme läuft', live: true, rec: true, progress: null, active: true, action: { type: 'recordings' } };
}

/** Radio: der aktuelle Sender (lädt, spielt, pausiert) sonst der zuletzt gehörte. */
function radioCard({ state, sources, lastStation } = {}) {
  const current = state && state.station && RADIO_ACTIVE.includes(state.status) ? state.station : null;
  const key = current ? { sourceId: current.sourceId, id: current.id } : lastStation;
  if (!key || !key.sourceId || !key.id) return null;
  const station = findStation(sources, { sourceId: key.sourceId, stationId: key.id });
  const name = text(station && station.name) || text(current && current.name);
  if (!name) return null;
  const playing = Boolean(current) && state.status !== 'paused';
  let subtitle = 'Zuletzt gehört';
  if (current) subtitle = state.status === 'paused' ? 'Pausiert' : 'Läuft';
  return { kind: 'radio', area: 'radio', icon: 'radio', title: name, subtitle, live: true, progress: null, active: playing, action: { type: playing ? 'radio-open' : 'radio-play', key: { sourceId: key.sourceId, stationId: key.id } } };
}

/** Podcast: laufende Episode, sonst die zuletzt begonnene, noch nicht gehörte. */
function podcastCard({ subscriptions, episodes, player } = {}) {
  const titles = new Map((Array.isArray(subscriptions) ? subscriptions : []).map(sub => [sub.id, text(sub.title)]));
  const active = player && player.episode && PODCAST_ACTIVE.includes(player.status) ? player.episode : null;
  let best = null;
  for (const [podcastId, feed] of Object.entries(episodes || {})) {
    for (const episode of (feed && feed.episodes) || []) {
      const state = (episode && episode.state) || {};
      const isActive = Boolean(active) && active.podcastId === podcastId && active.episodeId === episode.id;
      if (!isActive && (state.played || !(Number(state.position) > 0))) continue;
      const stamp = Date.parse(state.updatedAt) || 0;
      const rank = isActive ? Infinity : stamp;
      if (!best || rank > best.rank) best = { rank, podcastId, episode, state, isActive };
    }
  }
  if (!best) return null;
  const { podcastId, episode, state, isActive } = best;
  const duration = (isActive && player.duration > 0 ? player.duration : 0) || Number(state.duration) || Number(episode.duration) || 0;
  const position = isActive && Number.isFinite(player.position) ? player.position : Number(state.position) || 0;
  const playing = isActive && player.status !== 'paused';
  return {
    kind: 'podcast',
    area: 'podcast',
    icon: 'mic',
    title: text(episode.title) || 'Ohne Titel',
    subtitle: titles.get(podcastId) || 'Podcast',
    live: false,
    progress: clamp01(position, duration),
    active: playing,
    action: { type: 'podcast', podcastId, episodeId: episode.id, play: !playing },
  };
}

/** Verlauf: der jüngste Eintrag, dessen Dienst noch existiert (LiveTV-Sender gelten als live). */
function historyCard({ history, serviceIds, serviceUrls } = {}) {
  const known = new Set(Array.isArray(serviceIds) ? serviceIds : []);
  const entry = (Array.isArray(history) ? history : []).find(e => e && text(e.title) && (e.serviceKey === TV_KEY || known.has(e.serviceKey)));
  if (!entry) return null;
  if (entry.serviceKey === TV_KEY) {
    const name = text(entry.serviceName) || text(entry.title).replace(/^TV:\s*/, '');
    return { kind: 'history', area: 'livetv', icon: 'tv-minimal', title: name, subtitle: 'LiveTV', live: true, progress: null, active: false, action: { type: 'tv', name } };
  }
  return { kind: 'history', area: 'streaming', icon: 'monitor-play', title: text(entry.title), subtitle: text(entry.serviceName) || 'Streaming', live: false, progress: null, active: false, action: { type: 'service', serviceKey: entry.serviceKey, url: historyEntryUrl(entry, serviceUrls && serviceUrls[entry.serviceKey]) } };
}

/**
 * Karten der Leiste (höchstens vier, eine je Quelle). Reihenfolge: laufende Dinge zuerst (Aufnahme, spielendes Radio oder
 * Podcast), danach Radio, Podcast, Verlauf; innerhalb derselben Stufe in dieser Quellenreihenfolge. Leer: [].
 */
function runningNowCards(input = {}) {
  const cards = [recordingCard(input.recordings), radioCard(input.radio), podcastCard(input.podcast), historyCard(input.history)].filter(Boolean);
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => Number(b.card.active) - Number(a.card.active) || a.index - b.index)
    .slice(0, MAX_CARDS)
    .map(item => item.card);
}

/** Beschriftung für Screenreader: Titel, Zustand, Fortschritt. */
function cardAriaLabel(card) {
  const parts = [card.title, card.subtitle];
  if (card.live) parts.push('live');
  if (card.progress > 0) parts.push(`${Math.round(card.progress * 100)} Prozent gehört`);
  return parts.filter(Boolean).join(', ');
}

module.exports = { MAX_CARDS, historyEntryUrl, runningNowCards, recordingCard, radioCard, podcastCard, historyCard, cardAriaLabel };
