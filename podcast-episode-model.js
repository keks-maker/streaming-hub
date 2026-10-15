// Podcast-Oberfläche (P3): Anzeigemodell einer Episode (Dashboard „Neue Episoden“ und Sendungsseite). Reine Funktionen
// ohne DOM und IPC. Eingabe: Episode aus podcast:episodes (mit state { position, duration, played }) und der öffentliche
// Zustand des Players (window.podcasts.player.getState()).

'use strict';

const { formatDuration, formatEpisodeDate, clampFraction, DAY } = require('./podcast-format.js');

const NEW_WINDOW_DAYS = 30;
const ACTIVE_STATUSES = ['loading', 'playing', 'paused'];

function listenState(episode) {
  return (episode && episode.state) || {};
}

/** 'played' | 'started' (begonnen, nicht gehört) | 'new' (nicht begonnen, nicht gehört). */
function episodeStatus(episode) {
  const state = listenState(episode);
  if (state.played) return 'played';
  return Number(state.position) > 0 ? 'started' : 'new';
}

/** Neu: ungehört und innerhalb von 30 Tagen veröffentlicht; begonnene Episoden zählen unabhängig vom Alter. */
function isNewEpisode(episode, now = Date.now()) {
  const status = episodeStatus(episode);
  if (status === 'played') return false;
  if (status === 'started') return true;
  const time = Date.parse(episode.pubDate);
  return Number.isFinite(time) && now - time <= NEW_WINDOW_DAYS * DAY;
}

function isActive(player, podcastId, episodeId) {
  const current = player && player.episode;
  return Boolean(current) && current.podcastId === podcastId && current.episodeId === episodeId && ACTIVE_STATUSES.includes(player.status);
}

const STATUS_TEXT = { new: 'Neu', started: 'Begonnen', played: 'Gehört' };

/**
 * Anzeigemodell einer Episode. Ausgabe: { key, podcastId, episodeId, show, title, cover, dateText, durationText, status,
 * statusText, progress, active, playing, failed, action ('play'|'pause'|'resume'), actionLabel, markPlayed (Ziel von
 * „als gehört markieren“), markLabel, ariaLabel }
 */
function episodeItem({ podcastId, show, episode, fallbackCover = null, player = null, now = Date.now() }) {
  const state = listenState(episode);
  const active = isActive(player, podcastId, episode.id);
  const duration = (active && player.duration > 0 ? player.duration : 0) || Number(state.duration) || Number(episode.duration) || 0;
  const position = active && Number.isFinite(player.position) ? player.position : Number(state.position) || 0;
  const status = episodeStatus(episode);
  const playing = active && player.status !== 'paused';
  const failed = Boolean(player && player.episode && player.episode.podcastId === podcastId && player.episode.episodeId === episode.id && player.status === 'error');
  let action = 'play';
  if (active) action = player.status === 'paused' ? 'resume' : 'pause';
  const title = episode.title || 'Ohne Titel';
  const dateText = formatEpisodeDate(episode.pubDate, now);
  const durationText = formatDuration(duration);
  const actionLabel = { play: 'abspielen', pause: 'pausieren', resume: 'fortsetzen' }[action];
  const progress = status === 'played' ? 0 : clampFraction(position, duration);
  return {
    key: `${podcastId}\u0000${episode.id}`,
    podcastId,
    episodeId: episode.id,
    show: show || '',
    title,
    cover: episode.cover || fallbackCover || null,
    dateText,
    durationText,
    status,
    statusText: STATUS_TEXT[status],
    progress,
    active,
    playing,
    failed,
    action,
    actionLabel,
    markPlayed: status !== 'played',
    markLabel: status === 'played' ? 'Als ungehört markieren' : 'Als gehört markieren',
    ariaLabel: [show, title, dateText, durationText, STATUS_TEXT[status]].filter(Boolean).join(', ') + ` – ${actionLabel}`,
  };
}

module.exports = { NEW_WINDOW_DAYS, episodeStatus, isNewEpisode, episodeItem, isActive };
