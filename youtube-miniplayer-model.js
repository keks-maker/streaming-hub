// YouTube-Mini-Player: Modell der gemeinsamen Leiste im Modus „Video“ (neben Radio und Podcast).
// Reine Funktionen ohne DOM und IPC; die Ansicht (radio-miniplayer-view.js) setzt alle Texte per textContent.
// Eingabe: Ansichtszustand des Controllers { stage, status, videoId, title, channel, position, duration, volume, playlist, panelOpen }.

'use strict';

const { formatClock } = require('./radio-miniplayer-model.js');
const { thumbnailUrl } = require('./lib/youtube-url.js');

// Tooltips aller Knöpfe (deutsch)
const VIDEO_LABELS = Object.freeze({
  back: 'Zurück zum Video',
  appFill: 'App-füllend anzeigen',
  fullscreen: 'Vollbild',
  playlistShow: 'Playlist anzeigen',
  playlistHide: 'Playlist ausblenden',
  play: 'Abspielen',
  pause: 'Pausieren',
  close: 'Schließen',
  info: 'Zurück zum Video',
});

const STATUS_TEXT = { loading: 'Lädt …', paused: 'Pausiert', ended: 'Beendet' };

/**
 * Sichtbar, wenn das Video klein läuft (Stufe mini) oder wenn keines läuft, aber Einträge in der Playlist warten
 * (dann startet die Abspielen-Taste den ersten). Nicht im Vollbild/Player-Vollbild (suppressed).
 */
function isVideoMiniPlayerVisible(view, { suppressed = false } = {}) {
  if (!view || suppressed) return false;
  if (view.stage === 'mini') return true;
  return view.stage === 'idle' && Array.isArray(view.playlist) && view.playlist.length > 0;
}

/** Wiedergabetaste: laufend/ladend → pause · pausiert/beendet → resume · nichts geladen (Playlist wartet) → start. */
function videoPlayPauseAction(view) {
  if (view.stage === 'idle') return 'start';
  if (view.status === 'playing' || view.status === 'loading') return 'pause';
  return 'resume';
}

function playlistRows(list) {
  return (Array.isArray(list) ? list : []).map((item, index, all) => {
    const title = item.title || 'YouTube-Video';
    return {
      id: item.id,
      title,
      thumbnail: thumbnailUrl(item.id),
      playLabel: `${title} abspielen`,
      removeLabel: `${title} aus der Playlist entfernen`,
      canUp: index > 0,
      canDown: index < all.length - 1,
    };
  });
}

function countText(count) {
  return count === 1 ? '1 Video in der Playlist' : `${count} Videos in der Playlist`;
}

/**
 * Ausgabe: { visible, mode:'video', idle, name, subtitle, status, action, playPauseLabel, labels, position, duration, canSeek, seekMax, seekValue,
 *            valueText, positionText, durationText, volume, volumePercent, playlist (Zeilen), playlistCount, playlistText, panelOpen, live }
 */
function youtubeMiniPlayerModel(view, { suppressed = false } = {}) {
  const visible = isVideoMiniPlayerVisible(view, { suppressed });
  if (!visible) {
    return { visible: false, mode: 'video', idle: true, name: '', subtitle: '', status: 'idle', action: 'start', playPauseLabel: VIDEO_LABELS.play, labels: VIDEO_LABELS, position: 0, duration: 0, canSeek: false, seekMax: 0, seekValue: 0, valueText: '', positionText: '0:00', durationText: '0:00', volume: 0, volumePercent: 0, playlist: [], playlistCount: 0, playlistText: '', panelOpen: false, live: '' };
  }
  const idle = view.stage === 'idle';
  const rows = playlistRows(view.playlist);
  const duration = Number.isFinite(view.duration) && view.duration > 0 ? view.duration : 0;
  const rawPosition = Number.isFinite(view.position) && view.position > 0 ? view.position : 0;
  const position = duration > 0 ? Math.min(rawPosition, duration) : rawPosition;
  const action = videoPlayPauseAction(view);
  const volume = Number.isFinite(view.volume) ? Math.min(1, Math.max(0, view.volume)) : 1;
  const status = idle ? 'idle' : view.status || 'loading';
  const title = idle ? 'Playlist' : view.title || 'YouTube-Video';
  const subtitle = idle ? countText(rows.length) : [STATUS_TEXT[status], view.channel].filter(Boolean).join(' – ') || 'YouTube';
  return {
    visible: true,
    mode: 'video',
    idle,
    name: title,
    subtitle,
    status,
    action,
    playPauseLabel: action === 'pause' ? VIDEO_LABELS.pause : VIDEO_LABELS.play,
    labels: VIDEO_LABELS,
    position,
    duration,
    canSeek: !idle && duration > 0,
    seekMax: Math.floor(duration),
    seekValue: Math.floor(position),
    valueText: duration > 0 ? `${formatClock(position)} von ${formatClock(duration)}` : formatClock(position),
    positionText: formatClock(position),
    durationText: duration > 0 ? formatClock(duration) : '–:–',
    volume,
    volumePercent: Math.round(volume * 100),
    playlist: rows,
    playlistCount: rows.length,
    playlistText: countText(rows.length),
    panelOpen: Boolean(view.panelOpen),
    live: idle ? '' : status === 'paused' ? `${title}: pausiert` : status === 'ended' ? `${title}: beendet` : `${title}: spielt`,
  };
}

module.exports = { VIDEO_LABELS, isVideoMiniPlayerVisible, videoPlayPauseAction, playlistRows, youtubeMiniPlayerModel };
