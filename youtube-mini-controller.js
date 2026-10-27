// YouTube-Mini-Player: Controller im Renderer. Verbindet die zwei Webviews (Stöbern = contentView, Video = Player-Webview),
// das Stufenmodell (youtube-mini-state.js), den Verlauf (youtube-nav-trail.js), die Playlist (lib/youtube-playlist.js)
// und die gemeinsame Leiste (radio-miniplayer-view.js). Die Entscheidungen liegen in den reinen Modulen; hier stehen nur
// Webview-Ereignisse, Platzierung und IPC. Kein Eingriff in andere Dienste: nur Seiten von YouTube (persist:streaming).
//
// Ablauf (Vorbild iOS-App mytube): Klick auf ein Video im Stöbern → die Player-Webview lädt es (Stufe page). Klick auf eine
// andere YouTube-Seite im Player → die Inhalts-Webview lädt sie, das Video bleibt in der Player-Webview und wird klein (Stufe mini).
// Die Player-Webview wird nie neu geladen, nur verschoben (CSS), damit Video und Position erhalten bleiben.

'use strict';

const state = require('./youtube-mini-state.js');
const trailModel = require('./youtube-nav-trail.js');
const playlistModel = require('./lib/youtube-playlist.js');
const { classifyYoutubeUrl, watchUrl } = require('./lib/youtube-url.js');

const HOME_URL = 'https://www.youtube.com/';
const PLACEMENT_CLASSES = ['hidden', 'content', 'slot', 'window'];
const ESC_AFTER_FULLSCREEN_MS = 400;
const FULLSCREEN_CONFIRM_MS = 1500;
const STATE_IGNORE_MS = 3000;
const STRAY_GUARD_MS = 1500;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function watchUrlOrEmpty(id) {
  try {
    return watchUrl(id);
  } catch (_) {
    return '';
  }
}

/**
 * deps: { contentView, playerView, api (window.electronAPI), logger, notify(message), now, win,
 *         hooks: { beforePlay(), enterYoutubeArea(), onPlacement(place), onHtmlFullscreen(active), isYoutubeArea() } }
 */
function createYoutubeMini(deps) {
  const { contentView, playerView, api, logger, notify = () => {}, now = Date.now, win = window, hooks = {} } = deps;

  let settings = { enabled: true, clickBehavior: 'replace' };
  let model = state.initialState();
  let playlist = [];
  let trail = trailModel.createTrail();
  let pendingFrom = '';
  let panelOpen = false;
  let view = { title: '', channel: '', position: 0, duration: 0, volume: 1 };
  let slotEl = null;
  let slotObserver = null;
  let playerReady = false;
  let pendingLoad = '';
  let pendingId = '';
  let pendingUntil = 0;
  let fullscreenConfirmed = false;
  let lastFullscreenLeave = 0;
  let lastStray = { id: '', at: 0 };
  let ready = false; // erst nach init() melden Platzierungen an die App (deren Zustand entsteht nach dem Controller)
  const listeners = new Set();

  const warn = (message, error) => logger && logger.warn(`YouTube-Mini-Player: ${message}`, error && error.message ? error.message : error || '');
  const emit = () => listeners.forEach(cb => cb());
  const exec = (code, gesture = false) => {
    try {
      return Promise.resolve(playerView.executeJavaScript(code, gesture)).catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  };
  const callPage = (method, arg) => exec(`window.__shMini && window.__shMini.${method}(${arg === undefined ? '' : JSON.stringify(arg)})`);

  // ───────── Platzierung ─────────

  function pageMode() {
    if (model.stage === 'mini') return 'mini';
    if (model.stage === 'app') return 'app';
    if (model.stage === 'fullscreen') return model.back[model.back.length - 1] === 'page' ? 'page' : 'app';
    return 'page';
  }

  function applyPlacement() {
    const place = state.placement(model);
    PLACEMENT_CLASSES.forEach(name => playerView.classList.toggle(`yt-place-${name}`, name === place));
    if (place === 'slot') {
      const rect = slotEl ? slotEl.getBoundingClientRect() : null;
      if (rect && rect.width > 0 && rect.height > 0) {
        Object.assign(playerView.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      } else {
        playerView.classList.remove('yt-place-slot');
        playerView.classList.add('yt-place-hidden');
      }
    } else {
      Object.assign(playerView.style, { left: '', top: '', width: '', height: '' });
    }
    if (ready && hooks.onPlacement) hooks.onPlacement(place);
  }

  function syncMode() {
    if (state.isActive(model)) callPage('setMode', pageMode());
  }

  function setModel(next) {
    if (next === model) return;
    const stageChanged = next.stage !== model.stage;
    model = next;
    if (stageChanged) {
      applyPlacement();
      syncMode();
    }
    emit();
  }

  // ───────── Playlist ─────────

  function persistPlaylist() {
    Promise.resolve(api.setYoutubePlaylist(playlist)).catch(error => {
      warn('Playlist konnte nicht gespeichert werden', error);
      notify('Playlist konnte nicht gespeichert werden');
    });
  }

  function setPlaylist(next) {
    if (next === playlist) return false;
    playlist = next;
    persistPlaylist();
    emit();
    return true;
  }

  function fillTitle(id) {
    Promise.resolve(api.resolveYoutubeTitle({ id }))
      .then(title => {
        if (title) setPlaylist(playlistModel.withTitle(playlist, id, title));
      })
      .catch(() => {});
  }

  /** In die Playlist (hinten oder als nächstes). Läuft nichts und wartet nichts, startet das Video sofort klein. */
  function addToPlaylist(id, title, { next = false } = {}) {
    if (!settings.enabled || !id) return;
    if (!state.isActive(model) && !playlist.length) {
      openVideo({ id, title, stage: 'mini' });
      return;
    }
    if (id === model.videoId) {
      notify('Dieses Video läuft gerade');
      return;
    }
    const entry = { id, title };
    const updated = next ? playlistModel.addNext(playlist, entry) : playlistModel.addEntry(playlist, entry);
    if (updated === playlist) {
      notify(playlist.some(item => item.id === id) ? 'Schon in der Playlist' : 'Die Playlist ist voll');
      return;
    }
    setPlaylist(updated);
    notify(next ? 'Wird als Nächstes abgespielt' : 'Zur Playlist hinzugefügt');
    if (!title) fillTitle(id);
  }

  // ───────── Webview-Steuerung ─────────

  function loadInPlayer(url) {
    if (!playerReady) {
      pendingLoad = url;
      return;
    }
    Promise.resolve(playerView.loadURL(url)).catch(() => {}); // ein überlappendes Laden bricht mit ERR_ABORTED ab: erwartet
  }

  function openVideo({ id, title = '', stage = 'page' }) {
    const url = settings.enabled ? watchUrlOrEmpty(id) : '';
    if (!url) return false;
    if (hooks.beforePlay) hooks.beforePlay();
    // Das Video verlässt die Playlist, falls es darin stand
    if (playlist.some(item => item.id === id)) setPlaylist(playlistModel.removeEntry(playlist, id));
    pendingId = id;
    pendingUntil = now() + STATE_IGNORE_MS;
    view = { title: title || '', channel: '', position: 0, duration: 0, volume: view.volume };
    fullscreenConfirmed = false;
    setModel(state.openVideo(model, { videoId: id, stage }));
    loadInPlayer(url);
    syncMode();
    applyPlacement();
    emit();
    return true;
  }

  function closeVideo() {
    if (!state.isActive(model)) return;
    const wasFullscreen = model.stage === 'fullscreen';
    pendingId = '';
    view = { title: '', channel: '', position: 0, duration: 0, volume: view.volume };
    setModel(state.close());
    if (wasFullscreen) exec('document.fullscreenElement && document.exitFullscreen()');
    loadInPlayer('about:blank');
    applyPlacement();
    emit();
  }

  function handleEnded() {
    const { next, rest } = playlistModel.takeFirst(playlist);
    if (next) {
      setPlaylist(rest);
      openVideo({ id: next.id, title: next.title, stage: model.stage === 'page' ? 'page' : 'mini' });
      return;
    }
    // Leere Playlist: auf der Wiedergabeseite bleibt die Seite stehen (Kommentare), sonst endet die Wiedergabe
    if (model.stage !== 'page') closeVideo();
  }

  function showBrowseArea() {
    // Die Inhalts-Webview liegt unter dem Player und ist schon sichtbar; nur ohne Seite eine Startseite laden
    let url;
    try {
      url = contentView.getURL();
    } catch (_) {
      url = '';
    }
    if (!url || url === 'about:blank') Promise.resolve(contentView.loadURL(HOME_URL)).catch(() => {});
  }

  /** Aus der Wiedergabeseite weg (Stöbern, anderer App-Bereich): laufendes Video wird klein, pausiertes verworfen. */
  function leavePlayerPage() {
    const result = state.leavePage(model);
    if (result.drop) closeVideo();
    else setModel(result.state);
    return result;
  }

  /** Eine Stufe kleiner (Esc, X-Knopf): aus Vollbild bzw. App-füllend zurück zur Herkunft. true = behandelt. */
  function stepDown() {
    const result = state.escape(model);
    if (!result.handled) return false;
    const wasFullscreen = model.stage === 'fullscreen';
    setModel(result.state);
    if (wasFullscreen) exec('document.fullscreenElement && document.exitFullscreen()');
    return true;
  }

  // ───────── Nachrichten der Webviews ─────────

  function videoIdOf(message) {
    const target = classifyYoutubeUrl(typeof message.id === 'string' ? watchUrlOrEmpty(message.id) : '');
    return target.kind === 'watch' ? target.videoId : '';
  }

  function onPlayerMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state') {
      onPlayerState(message);
    } else if (message.type === 'browse') {
      const target = classifyYoutubeUrl(message.url);
      if (target.kind === 'browse') browseFromPlayer(target.url);
    } else if (message.type === 'mini') {
      if (state.isActive(model)) minimize();
    } else if (message.type === 'shrink') {
      stepDown(); // X-Knopf über dem Video: wie Esc
    } else if (message.type === 'add') {
      const id = videoIdOf(message);
      if (id) addToPlaylist(id, playlistModel.cleanTitle(message.title));
    }
  }

  function onContentMessage(message) {
    if (!message || typeof message !== 'object' || !settings.enabled) return;
    const id = videoIdOf(message);
    if (!id) return;
    const title = playlistModel.cleanTitle(message.title);
    if (message.type === 'open') {
      if (state.isActive(model) && settings.clickBehavior === 'playlist') addToPlaylist(id, title);
      else {
        if (hooks.enterYoutubeArea) hooks.enterYoutubeArea();
        openVideo({ id, title, stage: 'page' });
      }
    } else if (message.type === 'add') addToPlaylist(id, title);
  }

  function onPlayerState(message) {
    if (!state.isActive(model) || typeof message.id !== 'string') return;
    if (pendingId) {
      if (message.id === pendingId) pendingId = '';
      else if (now() < pendingUntil) return;
      else pendingId = '';
    }
    if (message.id !== model.videoId) {
      // Wechsel innerhalb der Wiedergabeseite (Klick auf ein Vorschlagsvideo): anderes Video, die Stufe bleibt
      setModel(state.setVideoId(model, message.id));
      if (playlist.some(item => item.id === message.id)) setPlaylist(playlistModel.removeEntry(playlist, message.id));
    }
    const status = message.ended ? 'ended' : message.paused ? 'paused' : message.loading ? 'loading' : 'playing';
    const previous = model.status;
    view = {
      title: typeof message.title === 'string' && message.title ? message.title.slice(0, 200) : view.title,
      channel: typeof message.channel === 'string' ? message.channel.slice(0, 120) : view.channel,
      position: finite(message.time),
      duration: finite(message.duration),
      volume: message.muted ? 0 : Math.min(1, Math.max(0, finite(message.volume, 1))),
    };
    setModel(state.setStatus(model, status));
    if (message.mode && message.mode !== pageMode()) syncMode();
    emit();
    if (status === 'ended' && previous !== 'ended') handleEnded();
  }

  function browseFromPlayer(url) {
    if (hooks.enterYoutubeArea) hooks.enterYoutubeArea();
    const from = model.stage === 'page' || model.stage === 'app' ? model.videoId : '';
    const result = leavePlayerPage();
    pendingFrom = result.drop ? '' : from;
    Promise.resolve(contentView.loadURL(url)).catch(() => {});
    emit();
  }

  function minimize() {
    if (hooks.enterYoutubeArea) hooks.enterYoutubeArea();
    showBrowseArea();
    setModel(state.minimize(model));
  }

  // ───────── Inhalts-Webview: Verlauf und unabgefangene Video-Seiten ─────────

  function onContentNavigated(url) {
    if (!settings.enabled) return;
    const target = classifyYoutubeUrl(url);
    if (target.kind === 'watch') {
      // Ein Video-Link, den das Seitenskript nicht abfangen konnte: das Video gehört in die Player-Webview
      if (lastStray.id === target.videoId && now() - lastStray.at < STRAY_GUARD_MS) return;
      lastStray = { id: target.videoId, at: now() };
      openVideo({ id: target.videoId, stage: 'page' });
      try {
        if (contentView.canGoBack()) contentView.goBack();
        else Promise.resolve(contentView.loadURL(HOME_URL)).catch(() => {});
      } catch (_) {
        /* Webview nicht bereit */
      }
      return;
    }
    if (target.kind === 'browse') {
      const from = pendingFrom;
      pendingFrom = '';
      trail = trailModel.visit(trail, url, from);
    }
  }

  // ───────── Aktionen der Leiste ─────────

  const actions = {
    playPause(action) {
      if (action === 'start') {
        const { next, rest } = playlistModel.takeFirst(playlist);
        if (!next) return undefined;
        setPlaylist(rest);
        openVideo({ id: next.id, title: next.title, stage: 'mini' });
        return undefined;
      }
      if (action === 'pause') return callPage('pause');
      if (model.status === 'ended') {
        loadInPlayer(watchUrlOrEmpty(model.videoId));
        return undefined;
      }
      return exec('window.__shMini && window.__shMini.play()', true);
    },
    seek(seconds) {
      if (Number.isFinite(seconds)) callPage('seek', Math.max(0, seconds));
    },
    skip(delta) {
      if (Number.isFinite(delta)) callPage('seek', Math.max(0, view.position + delta));
    },
    setVolume(value) {
      if (!Number.isFinite(value)) return;
      view = { ...view, volume: Math.min(1, Math.max(0, value)) };
      callPage('volume', view.volume);
      emit();
    },
    back() {
      if (!state.isActive(model)) return;
      if (hooks.enterYoutubeArea) hooks.enterYoutubeArea();
      showBrowseArea();
      setModel(state.showPage(model));
    },
    appFill() {
      setModel(state.appFill(model));
    },
    fullscreen() {
      if (!state.isActive(model)) return;
      fullscreenConfirmed = false;
      setModel(state.enterFullscreen(model));
      exec('window.__shMini && window.__shMini.fullscreen()', true);
      // Verweigert die Seite den Vollbildmodus (keine Meldung), bleibt es bei app-füllend
      win.setTimeout(() => {
        if (model.stage === 'fullscreen' && !fullscreenConfirmed) setModel(state.fullscreenFailed(model));
      }, FULLSCREEN_CONFIRM_MS);
    },
    close() {
      closeVideo();
    },
    togglePanel() {
      panelOpen = !panelOpen;
      emit();
    },
    playEntry(id) {
      const { next, rest } = playlistModel.takeEntry(playlist, id);
      if (!next) return;
      setPlaylist(rest);
      openVideo({ id: next.id, title: next.title, stage: model.stage === 'page' ? 'page' : 'mini' });
    },
    removeEntry(id) {
      setPlaylist(playlistModel.removeEntry(playlist, id));
    },
    moveEntry(id, targetId) {
      setPlaylist(playlistModel.moveToTarget(playlist, id, targetId));
    },
    moveBy(id, delta) {
      setPlaylist(playlistModel.moveBy(playlist, id, delta));
    },
  };

  // ───────── Webview-Ereignisse ─────────

  function wirePlayerView() {
    // Anmeldung beim Main (Rolle „player“ für den Preload): sobald die Kennung der Webview verfügbar ist, vor dem ersten Video-Laden
    let registering = false;
    const register = () => {
      if (playerReady || registering) return;
      let id;
      try {
        id = playerView.getWebContentsId();
      } catch (_) {
        return; // noch nicht angebunden: das nächste Ereignis versucht es erneut
      }
      if (!Number.isInteger(id) || id < 1) return;
      registering = true;
      Promise.resolve(api.registerYoutubePlayer(id))
        .catch(error => warn('Player-Webview konnte nicht angemeldet werden', error))
        .finally(() => {
          registering = false;
          playerReady = true;
          if (pendingLoad) {
            const url = pendingLoad;
            pendingLoad = '';
            loadInPlayer(url);
          }
        });
    };
    playerView.addEventListener('did-attach', register);
    playerView.addEventListener('dom-ready', register);
    playerView.addEventListener('ipc-message', event => {
      if (event.channel === 'youtube-mini' && event.args && event.args[0]) onPlayerMessage(event.args[0]);
    });
    playerView.addEventListener('did-finish-load', () => syncMode());
    playerView.addEventListener('did-navigate-in-page', () => syncMode());
    playerView.addEventListener('enter-html-full-screen', () => {
      fullscreenConfirmed = true;
      setModel(state.enterFullscreen(model));
      syncMode();
      if (hooks.onHtmlFullscreen) hooks.onHtmlFullscreen(true);
    });
    playerView.addEventListener('leave-html-full-screen', () => {
      lastFullscreenLeave = now();
      setModel(state.leaveFullscreen(model));
      syncMode();
      if (hooks.onHtmlFullscreen) hooks.onHtmlFullscreen(false);
    });
    playerView.addEventListener('will-navigate', event => {
      try {
        const url = new URL(event.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') event.preventDefault();
      } catch (_) {
        event.preventDefault();
      }
    });
    playerView.addEventListener('permissionrequest', event => {
      if (event.permission === 'media' || event.permission === 'mediaKeySystemAccess') event.request.allow();
      else event.request.deny();
    });
    playerView.addEventListener('did-fail-load', event => {
      if (event.errorCode === -3 || !event.isMainFrame || !state.isActive(model)) return;
      warn('Video konnte nicht geladen werden', `${event.errorCode} ${event.errorDescription}`);
      notify('Video konnte nicht geladen werden');
      closeVideo();
    });
    playerView.addEventListener('crashed', () => {
      warn('Player-Webview abgestürzt');
      notify('Das Video wurde beendet (Absturz)');
      closeVideo();
    });
    playerView.addEventListener('destroyed', () => {
      playerReady = false;
    });
  }

  function wireContentView() {
    contentView.addEventListener('ipc-message', event => {
      if (event.channel === 'youtube-mini' && event.args && event.args[0]) onContentMessage(event.args[0]);
    });
    contentView.addEventListener('did-navigate', event => onContentNavigated(event.url || ''));
    contentView.addEventListener('did-navigate-in-page', event => {
      if (event.isMainFrame !== false) onContentNavigated(event.url || '');
    });
  }

  function setVideoSlot(element) {
    slotEl = element;
    if (slotObserver) slotObserver.disconnect();
    if (element && typeof win.ResizeObserver === 'function') {
      slotObserver = new win.ResizeObserver(() => applyPlacement());
      slotObserver.observe(element);
    }
    applyPlacement();
  }

  async function init() {
    wirePlayerView();
    wireContentView();
    win.addEventListener('resize', () => applyPlacement());
    try {
      settings = await api.getYoutubeMiniSettings();
    } catch (error) {
      warn('Einstellungen nicht verfügbar', error);
    }
    try {
      playlist = playlistModel.normalizePlaylist(await api.getYoutubePlaylist());
    } catch (error) {
      warn('Playlist nicht verfügbar', error);
    }
    ready = true;
    emit();
    if (api.onYoutubeContextAction) {
      api.onYoutubeContextAction(payload => {
        const target = classifyYoutubeUrl(payload && payload.url);
        if (target.kind !== 'watch' || !settings.enabled) return;
        const title = playlistModel.cleanTitle(payload.title);
        if (payload.action === 'next') addToPlaylist(target.videoId, title, { next: true });
        else if (payload.action === 'add') addToPlaylist(target.videoId, title);
      });
    }
  }

  // ───────── Schnittstelle zur App ─────────

  return {
    init,
    actions,
    setVideoSlot,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getView() {
      return { stage: model.stage, status: model.status, videoId: model.videoId, ...view, playlist, panelOpen };
    },
    getState: () => model,
    getSettings: () => ({ ...settings }),
    isEnabled: () => settings.enabled,
    isActive: () => state.isActive(model),
    /** Das Player-Webview steht groß (Wiedergabeseite oder app-füllend/Vollbild): dann sind seine Seiten der aktive Webview. */
    isPlayerShown: () => model.stage === 'page' || model.stage === 'app' || model.stage === 'fullscreen',

    async applySettings(patch) {
      const saved = await api.setYoutubeMiniSettings(patch);
      const wasEnabled = settings.enabled;
      settings = saved;
      if (!settings.enabled) closeVideo();
      if (settings.enabled !== wasEnabled) {
        // Die Seitenskripte entstehen beim Laden: Inhalts-Webview neu laden, damit der Schalter sofort wirkt
        try {
          if (classifyYoutubeUrl(contentView.getURL()).kind !== 'invalid') contentView.reload();
        } catch (_) {
          /* Webview nicht bereit */
        }
      } else if ('clickBehavior' in patch) {
        try {
          contentView.executeJavaScript(`window.__shMini && window.__shMini.setConfig(${JSON.stringify({ clickBehavior: settings.clickBehavior })})`).catch(() => {});
        } catch (_) {
          /* Webview nicht bereit */
        }
        callPage('setConfig', { clickBehavior: settings.clickBehavior });
      }
      emit();
      return settings;
    },

    /** navigateTo mit einer Video-Adresse: gehört in die Player-Webview. true = erledigt. */
    interceptNavigate(url) {
      const target = classifyYoutubeUrl(url);
      if (!settings.enabled || target.kind !== 'watch') return false;
      return openVideo({ id: target.videoId, stage: 'page' });
    },

    /** Navigation zu einem Dienst (navigateTo): YouTube behält das Video (klein), jeder andere Dienst beendet es. */
    onServiceNavigate(isYoutube) {
      trail = trailModel.createTrail();
      pendingFrom = '';
      if (!state.isActive(model)) return;
      if (isYoutube) leavePlayerPage();
      else closeVideo();
    },

    /** Andere App-Bereiche (Dashboards, TV ...): das Video läuft klein weiter. */
    onLeaveArea() {
      if (model.stage === 'page' || model.stage === 'app') leavePlayerPage();
    },

    /** Eine andere Wiedergabe startet (Streamingdienst, LiveTV, Radio, Podcast, Mediathek, Aufnahme): Video beenden. */
    stopForOtherPlayback() {
      if (state.isActive(model)) closeVideo();
    },

    /** Zurück im YouTube-Bereich. true = behandelt. */
    handleBack() {
      if (!settings.enabled || (hooks.isYoutubeArea && !hooks.isYoutubeArea())) return false;
      const action = trailModel.backAction(trail, { stage: model.stage, videoId: model.videoId, playerAlive: state.isActive(model) });
      if (action.kind === 'show-browse') {
        showBrowseArea();
        leavePlayerPage();
        return true;
      }
      if (action.kind === 'show-player' || action.kind === 'webview-back') {
        try {
          if (!contentView.canGoBack()) return false;
          trail = trailModel.markBack(trail);
          contentView.goBack();
        } catch (_) {
          return false;
        }
        if (action.kind === 'show-player') setModel(state.showPage(model));
        return true;
      }
      return false;
    },

    /** Gibt es in der Wiedergabeseite etwas, wohin „Zurück“ führt? */
    canGoBack() {
      return settings.enabled && model.stage === 'page' && trail.entries.length > 0;
    },

    /** Esc: eine Stufe kleiner. true = behandelt. */
    handleEscape() {
      if (now() - lastFullscreenLeave < ESC_AFTER_FULLSCREEN_MS) return true; // dieselbe Taste hat den Vollbildmodus schon beendet
      return stepDown();
    },

    /** Medientasten der Tastatur steuern das kleine Video. true = behandelt. */
    handleMediaKey(action) {
      if (model.stage !== 'mini') return false;
      if (action === 'playpause') {
        actions.playPause(model.status === 'playing' || model.status === 'loading' ? 'pause' : 'resume');
        return true;
      }
      if (action === 'stop') {
        closeVideo();
        return true;
      }
      return false;
    },

    close: closeVideo,
    reposition: applyPlacement,
  };
}

module.exports = { createYoutubeMini };
