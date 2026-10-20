'use strict';

// Mediathek-Player: Vollbild-Overlay mit <video> (wie die Aufnahme-Wiedergabe; hls.js ist auf der Seite global geladen).
// HLS läuft über hls.js (Qualitätsstufen, Tonspuren, Untertitel), MP4 direkt. Setzt am gespeicherten Punkt fort und meldet
// den Fortschritt gedrosselt an den Verlauf. Menüs für Qualität, Ton und Untertitel erscheinen nur, wenn der Stream Auswahl bietet.

const model = require('./mediathek-player-model.js');
const { el, button } = require('./mediathek-cards.js');

const MEDIA_ERRORS = {
  1: 'Die Wiedergabe wurde abgebrochen.',
  2: 'Netzwerkfehler beim Laden des Videos.',
  3: 'Das Video konnte nicht dekodiert werden.',
  4: 'Das Videoformat wird nicht unterstützt oder der Stream ist nicht mehr verfügbar.',
};
const IDLE_MS = 3200;

function select(doc, id, label) {
  const wrap = el(doc, 'label', 'mediathek-player-menu');
  wrap.hidden = true;
  const caption = el(doc, 'span', 'mediathek-player-menu-label', label);
  const control = el(doc, 'select', 'mediathek-player-select');
  control.id = id;
  wrap.append(caption, control);
  return { wrap, control };
}

function fill(control, options, selected) {
  control.textContent = '';
  options.forEach(option => {
    const node = control.ownerDocument.createElement('option');
    node.value = String(option.value);
    node.textContent = option.label;
    control.appendChild(node);
  });
  control.value = String(selected);
}

/**
 * ctx: { getSettings() -> { quality, audioLanguage, subtitles }, saveProgress({ entry, position, duration }) -> Promise|void,
 *        onStart(), onClose(), logger, timers }
 */
function createMediathekPlayer(host, ctx) {
  const doc = host.ownerDocument || document;
  const win = doc.defaultView || window;
  const timers = ctx.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

  let overlay = null;
  let video = null;
  let hls = null;
  let session = null;
  let idleTimer = null;
  let recovered = { network: 0, media: 0 };
  let ui = null;
  let saver = null;

  function showError(text) {
    if (!ui) return;
    ui.error.textContent = text;
    ui.error.hidden = false;
    ui.loading.hidden = true;
  }

  function wakeBar() {
    if (!overlay) return;
    overlay.classList.remove('is-idle');
    if (idleTimer) timers.clearTimeout(idleTimer);
    idleTimer = timers.setTimeout(() => {
      const menuOpen = doc.activeElement && doc.activeElement.tagName === 'SELECT';
      if (overlay && video && !video.paused && !menuOpen) overlay.classList.add('is-idle');
    }, IDLE_MS);
  }

  function buildLevels() {
    if (!hls || !ui) return;
    const levels = hls.levels || [];
    if (levels.length < 2) {
      ui.quality.wrap.hidden = true;
      return;
    }
    const settings = ctx.getSettings();
    const preferred = model.pickLevel(levels, settings.quality);
    const options = [{ value: -1, label: 'Automatisch' }].concat(
      levels
        .map((level, index) => ({ value: index, label: level.height ? `${level.height}p` : `Stufe ${index + 1}`, height: level.height || 0 }))
        .sort((a, b) => b.height - a.height),
    );
    fill(ui.quality.control, options, preferred);
    ui.quality.wrap.hidden = false;
    hls.currentLevel = preferred;
  }

  function buildAudio() {
    if (!hls || !ui) return;
    const tracks = hls.audioTracks || [];
    if (tracks.length < 2) {
      ui.audio.wrap.hidden = true;
      return;
    }
    const preferred = model.pickAudioTrack(tracks, ctx.getSettings().audioLanguage);
    const selected = preferred >= 0 ? preferred : Math.max(0, hls.audioTrack);
    fill(ui.audio.control, tracks.map((track, index) => ({ value: index, label: model.trackLabel(track, index) })), selected);
    if (preferred >= 0) hls.audioTrack = preferred;
    ui.audio.wrap.hidden = false;
    buildSubtitles();
  }

  function buildSubtitles() {
    if (!hls || !ui) return;
    const tracks = hls.subtitleTracks || [];
    if (!tracks.length) {
      ui.subtitles.wrap.hidden = true;
      return;
    }
    const audioTrack = (hls.audioTracks || [])[hls.audioTrack];
    const preferred = model.pickSubtitleTrack(tracks, ctx.getSettings().subtitles, audioTrack && audioTrack.lang ? String(audioTrack.lang).toLowerCase().split('-')[0] : '');
    fill(ui.subtitles.control, [{ value: -1, label: 'Aus' }].concat(tracks.map((track, index) => ({ value: index, label: model.trackLabel(track, index) }))), preferred);
    hls.subtitleDisplay = preferred >= 0;
    hls.subtitleTrack = preferred;
    ui.subtitles.wrap.hidden = false;
  }

  function attachHls(url, start) {
    const Hls = win.Hls;
    hls = new Hls({ enableWorker: false, startPosition: start > 0 ? start : -1, maxBufferLength: 30 });
    hls.on(Hls.Events.MANIFEST_PARSED, buildLevels);
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, buildAudio);
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, buildSubtitles);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered.network < 2) {
        recovered.network += 1;
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered.media < 2) {
        recovered.media += 1;
        hls.recoverMediaError();
      } else {
        showError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? MEDIA_ERRORS[2] : MEDIA_ERRORS[4]);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  function disposeMedia() {
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* schon weg */
      }
      hls = null;
    }
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  function close({ restoreFocus = true } = {}) {
    if (!overlay) return;
    if (saver) saver.flush();
    saver = null;
    if (idleTimer) timers.clearTimeout(idleTimer);
    idleTimer = null;
    disposeMedia();
    const trigger = session && session.trigger;
    if (doc.fullscreenElement === overlay) doc.exitFullscreen().catch(() => {});
    overlay.remove();
    overlay = null;
    video = null;
    ui = null;
    session = null;
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
    if (ctx.onClose) ctx.onClose();
  }

  function seekBy(seconds) {
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + seconds));
  }

  function onKeydown(event) {
    wakeBar();
    const tag = event.target && event.target.tagName;
    if (event.key === 'Escape') {
      if (doc.fullscreenElement) return; // Esc beendet zuerst den Vollbildmodus (Browser)
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (tag === 'SELECT' || tag === 'INPUT') return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
      else overlay.requestFullscreen().catch(() => {});
    } else if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      video.muted = !video.muted;
    } else if (event.key === 'ArrowLeft' && tag !== 'VIDEO') {
      event.preventDefault();
      seekBy(-10);
    } else if (event.key === 'ArrowRight' && tag !== 'VIDEO') {
      event.preventDefault();
      seekBy(10);
    } else if ((event.key === ' ' || event.key === 'k') && tag !== 'BUTTON') {
      event.preventDefault();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }
  }

  /**
   * Startet die Wiedergabe. play: { entry, series, url, startPosition, trigger }.
   * Eine laufende Wiedergabe wird zuvor beendet.
   */
  function open(play) {
    close({ restoreFocus: false });
    if (ctx.onStart) ctx.onStart();
    session = play;
    recovered = { network: 0, media: 0 };
    overlay = el(doc, 'div', 'mediathek-player');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Wiedergabe: ${play.entry.title}`);

    video = el(doc, 'video', 'mediathek-player-video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.tabIndex = 0;
    video.setAttribute('aria-label', play.entry.title);

    const bar = el(doc, 'div', 'mediathek-player-bar');
    const closeBtn = button(doc, 'mediathek-player-close', '×', () => close(), 'Wiedergabe schließen');
    closeBtn.id = 'mediathekPlayerClose';
    const title = el(doc, 'span', 'mediathek-player-title', play.entry.title);
    const menus = el(doc, 'div', 'mediathek-player-menus');
    const quality = select(doc, 'mediathekPlayerQuality', 'Qualität');
    const audio = select(doc, 'mediathekPlayerAudio', 'Ton');
    const subtitles = select(doc, 'mediathekPlayerSubtitles', 'Untertitel');
    menus.append(quality.wrap, audio.wrap, subtitles.wrap);
    bar.append(closeBtn, title, menus);

    const error = el(doc, 'div', 'mediathek-player-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const loading = el(doc, 'div', 'mediathek-player-loading', 'Wird geladen …');
    loading.setAttribute('role', 'status');
    ui = { error, loading, quality, audio, subtitles };
    overlay.append(video, bar, loading, error);
    host.appendChild(overlay);

    quality.control.addEventListener('change', () => {
      if (hls) hls.currentLevel = Number(quality.control.value);
    });
    audio.control.addEventListener('change', () => {
      if (hls) hls.audioTrack = Number(audio.control.value);
    });
    subtitles.control.addEventListener('change', () => {
      if (!hls) return;
      const index = Number(subtitles.control.value);
      hls.subtitleDisplay = index >= 0;
      hls.subtitleTrack = index;
    });

    saver = model.createProgressSaver({ save: payload => ctx.saveProgress({ entry: play.entry, ...payload }) });
    video.addEventListener('timeupdate', () => saver && saver.tick(video.currentTime, video.duration));
    video.addEventListener('pause', () => saver && saver.flush());
    video.addEventListener('ended', () => {
      if (saver && Number.isFinite(video.duration)) saver.tick(video.duration, video.duration);
      if (saver) saver.flush();
    });
    video.addEventListener('playing', () => {
      loading.hidden = true;
      error.hidden = true;
      wakeBar();
    });
    video.addEventListener('waiting', () => {
      loading.hidden = false;
    });
    video.addEventListener('error', () => {
      const code = video.error && video.error.code;
      showError(MEDIA_ERRORS[code] || 'Die Wiedergabe ist fehlgeschlagen.');
    });
    video.addEventListener('loadedmetadata', () => {
      if (play.startPosition > 0 && Number.isFinite(video.duration) && play.startPosition < video.duration - 5 && Math.abs(video.currentTime - play.startPosition) > 2) {
        video.currentTime = play.startPosition;
      }
    });
    video.addEventListener('pause', wakeBar);
    overlay.addEventListener('mousemove', wakeBar);
    overlay.addEventListener('focusin', wakeBar);
    overlay.addEventListener('keydown', onKeydown);

    if (model.streamKind(play.url) === 'hls' && win.Hls && win.Hls.isSupported()) attachHls(play.url, play.startPosition);
    else video.src = play.url;
    video.play().catch(() => {});
    video.focus();
    wakeBar();
  }

  return { open, close, isOpen: () => Boolean(overlay), current: () => (session ? session.entry : null) };
}

module.exports = { createMediathekPlayer };
