'use strict';

// PodcastController (Konzept §2/§12): Zustand der Episoden-Wiedergabe im Main (Single Source of Truth, podcast-playback-state).
// Audio läuft im selben Player-Host wie das Radio (radio-player.html + preload-radio.js), jedoch in einem eigenen
// unsichtbaren Fenster (show:false, backgroundThrottling:false, sandbox:true). Die Exklusivität zum Radio regelt
// playback-exclusivity.js. Hauptfenster und Mini-Player sind nur Fernbedienungen: sie rufen play/pause/resume/stop/seek/skip/
// setRate/setVolume und hören auf das Event 'state'.
//
// Position: wird bei Pause, Stopp, Ende, Fehler, Episodenwechsel und alle 10 s (während der Wiedergabe) über die
// PodcastLibrary gespeichert; ab 95 % gilt die Episode als gehört (podcast-state). Event 'listen-changed' meldet geänderte
// Gehört-Markierungen. Kein Wiederverbinden: ein Fehler beendet die Wiedergabe mit Status error.
//
// Abhängigkeiten (BrowserWindow, Timer, Bibliothek) sind injizierbar → ohne Electron testbar.

const { EventEmitter } = require('events');
const playback = require('./podcast-playback-state.js');
const { DEFAULT_PODCAST_SETTINGS } = require('./podcast-settings.js');
const { nextEpisodeId } = require('./podcast-next.js');

const SAVE_INTERVAL_MS = 10000;
const MAX_PENDING_COMMANDS = 20;

function httpUrlOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

class PodcastController extends EventEmitter {
  /**
   * options:
   * - BrowserWindow: Electron-Klasse (Test: Attrappe mit loadFile/on/close/isDestroyed/webContents.send)
   * - playerHtml, preloadPath: Pfade des Player-Hosts
   * - library: PodcastLibrary ({ getSubscription, getCachedFeed, getEpisodeState, savePosition })
   * - volume: Startlautstärke (0–1), rate: Startgeschwindigkeit
   * - getSettings: () => Podcast-Einstellungen (podcast-settings.js): Standardgeschwindigkeit, Sprungweiten, autoPlayNext,
   *   autoMarkPlayed; wird bei jeder Verwendung gelesen (Änderungen wirken ohne Neustart, siehe settingsChanged())
   * - setTimer, clearTimer, logger, saveIntervalMs
   */
  constructor({
    BrowserWindow,
    playerHtml,
    preloadPath,
    library,
    volume,
    rate,
    getSettings = () => DEFAULT_PODCAST_SETTINGS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = null,
    saveIntervalMs = SAVE_INTERVAL_MS,
  } = {}) {
    super();
    if (!BrowserWindow) throw new Error('PodcastController benötigt BrowserWindow');
    if (!library) throw new Error('PodcastController benötigt library');
    this.BrowserWindow = BrowserWindow;
    this.playerHtml = playerHtml;
    this.preloadPath = preloadPath;
    this.library = library;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => DEFAULT_PODCAST_SETTINGS;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.saveIntervalMs = saveIntervalMs;

    this._state = playback.createState({ volume, rate });
    this._session = 0;
    this._win = null;
    this._playerReady = false;
    this._pending = [];
    this._saveTimer = null;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[podcast] ${message}`);
  }

  // ── Zustand ──

  _settings() {
    try {
      return { ...DEFAULT_PODCAST_SETTINGS, ...this.getSettings() };
    } catch (_) {
      return DEFAULT_PODCAST_SETTINGS;
    }
  }

  /** Öffentlicher Zustand inkl. der eingestellten Sprungweiten (Mini-Player und Tray beschriften ihre Knöpfe damit). */
  getState() {
    const { skipBack, skipForward } = this._settings();
    return { ...playback.publicState(this._state), skipBack, skipForward };
  }

  /** Einstellungen wurden geändert: Zustand mit neuen Sprungweiten erneut melden; im Leerlauf gilt die neue Standardgeschwindigkeit sofort. */
  settingsChanged() {
    if (this._state.status === 'idle') this._dispatch({ type: 'rate', value: this._settings().rate });
    this.emit('state', this.getState());
  }

  /** Lädt oder spielt. */
  isPlaying() {
    return this._state.status === 'playing' || this._state.status === 'loading';
  }

  /** Episode ist "an": lädt, spielt oder pausiert (nicht idle/ended/error). Hält die App im Tray, wenn das Fenster zugeht. */
  isActive() {
    const status = this._state.status;
    return status === 'loading' || status === 'playing' || status === 'paused';
  }

  _dispatch(action) {
    const next = playback.reduce(this._state, action);
    if (next === this._state) return false;
    this._state = next;
    this.emit('state', this.getState());
    return true;
  }

  _sameEpisode(podcastId, episodeId) {
    const episode = this._state.episode;
    return Boolean(episode && episode.podcastId === podcastId && episode.episodeId === episodeId);
  }

  // ── Steuerung ──

  /**
   * Spielt die Episode { podcastId, episodeId } (Daten aus Abo und Episoden-Cache). startPosition (Sekunden) überschreibt die
   * Fortsetzungsregel (gespeicherte Position; von vorn bei „gehört“ oder nahem Ende). Dieselbe Episode läuft weiter
   * (Pause wird beendet), statt neu zu starten.
   */
  async play(key, startPosition) {
    const { podcastId, episodeId } = key || {};
    if (this._sameEpisode(podcastId, episodeId)) {
      const status = this._state.status;
      if (status === 'paused') {
        if (startPosition !== undefined) this.seek(startPosition);
        return this.resume();
      }
      if (status === 'playing' || status === 'loading') {
        if (startPosition !== undefined) this.seek(startPosition);
        return this.getState();
      }
    }
    const episode = this._lookup(podcastId, episodeId);
    this._saveProgress(); // laufende andere Episode vorher sichern
    const listen = this.library.getEpisodeState(podcastId, episodeId);
    const duration = episode.duration || listen.duration || 0;
    const start = startPosition !== undefined ? startPosition : playback.resumePosition(listen, duration);
    this._dispatch({ type: 'rate', value: this._settings().rate }); // jede neue Episode startet mit der Standardgeschwindigkeit
    this._session += 1;
    this._clearSaveTimer();
    this._pending = []; // Befehle der vorigen Sitzung verfallen
    this._dispatch({ type: 'select', episode: episode.info, position: start, duration });
    this._sendPlayer({
      cmd: 'play',
      mode: 'file',
      seq: this._session,
      url: episode.info.enclosureUrl,
      kind: 'direct',
      volume: this._state.volume,
      rate: this._state.rate,
      start: this._state.position,
    });
    this._sendMeta();
    return this.getState();
  }

  /** Episode aus Abo und Cache: { info (öffentliche Felder), duration } oder Fehler. */
  _lookup(podcastId, episodeId) {
    const subscription = typeof podcastId === 'string' ? this.library.getSubscription(podcastId) : null;
    if (!subscription) throw new Error('Abo nicht gefunden');
    const cached = this.library.getCachedFeed(podcastId).episodes.find(entry => entry && entry.id === episodeId);
    if (!cached) throw new Error('Episode nicht gefunden');
    const enclosureUrl = httpUrlOrNull(cached.audioUrl);
    if (!enclosureUrl) throw new Error('Episode hat keine Audio-Adresse');
    return {
      duration: Number.isFinite(cached.duration) && cached.duration > 0 ? cached.duration : 0,
      info: {
        podcastId,
        episodeId,
        title: String(cached.title || 'Ohne Titel'),
        show: String(subscription.title || ''),
        cover: httpUrlOrNull(cached.cover) || httpUrlOrNull(subscription.cover),
        enclosureUrl,
      },
    };
  }

  pause() {
    if (this._state.status !== 'playing' && this._state.status !== 'loading') return this.getState();
    this._clearSaveTimer();
    this._dispatch({ type: 'pause' });
    this._saveProgress();
    this._sendPlayer({ cmd: 'pause' });
    return this.getState();
  }

  resume() {
    if (this._state.status === 'ended') return this._replay();
    if (this._state.status !== 'paused') return this.getState();
    this._dispatch({ type: 'resume' });
    this._sendPlayer({ cmd: 'resume' });
    return this.getState();
  }

  /** Beendete Episode erneut abspielen (von vorn). */
  _replay() {
    const episode = this._state.episode;
    if (!episode) return this.getState();
    this.play({ podcastId: episode.podcastId, episodeId: episode.episodeId }, 0).catch(error => this._log('warn', `Neustart fehlgeschlagen: ${error.message}`));
    return this.getState();
  }

  stop() {
    if (this._state.status === 'idle') return this.getState();
    this._saveProgress();
    this._session += 1;
    this._clearSaveTimer();
    this._closePlayer();
    this._dispatch({ type: 'stop' });
    return this.getState();
  }

  seek(position) {
    if (!this._state.episode || this._state.status === 'ended') return this.getState();
    const target = Number.isFinite(position) ? position : 0;
    this._dispatch({ type: 'seek', position: target });
    this._sendPlayer({ cmd: 'seek', position: this._state.position });
    return this.getState();
  }

  /** Sprung relativ zur Position (z. B. −15 / +30 Sekunden). */
  skip(delta) {
    if (!this._state.episode || this._state.status === 'ended') return this.getState();
    return this.seek(playback.skipTarget(this._state, delta));
  }

  setRate(value) {
    this._dispatch({ type: 'rate', value });
    this._sendPlayer({ cmd: 'rate', rate: this._state.rate });
    return this.getState();
  }

  setVolume(value) {
    this._dispatch({ type: 'volume', value });
    this._sendPlayer({ cmd: 'volume', volume: this._state.volume });
    return this.getState();
  }

  dispose() {
    this.removeAllListeners(); // beim Beenden keine Folgereaktionen auslösen
    this.stop();
  }

  // ── Position speichern ──

  _saveProgress() {
    const { episode, position, duration, status } = this._state;
    if (!episode || status === 'idle') return;
    try {
      const before = this.library.getEpisodeState(episode.podcastId, episode.episodeId);
      const after = this.library.savePosition(episode.podcastId, episode.episodeId, { position, duration: duration || undefined, markPlayed: this._settings().autoMarkPlayed });
      if (after && after.played !== before.played) {
        this.emit('listen-changed', { podcastId: episode.podcastId, episodeId: episode.episodeId, state: after });
      }
    } catch (error) {
      this._log('warn', `Position nicht gespeichert: ${error.message}`);
    }
  }

  _armSaveTimer() {
    this._clearSaveTimer();
    const session = this._session;
    this._saveTimer = this.setTimer(() => {
      this._saveTimer = null;
      if (session !== this._session || this._state.status !== 'playing') return;
      this._saveProgress();
      this._armSaveTimer();
    }, this.saveIntervalMs);
  }

  _clearSaveTimer() {
    if (this._saveTimer) this.clearTimer(this._saveTimer);
    this._saveTimer = null;
  }

  // ── Player-Fenster ──

  /** WebContents des Player-Fensters (für die Absenderprüfung im IPC), sonst null. */
  playerWebContents() {
    return this._win && !this._isDestroyed(this._win) ? this._win.webContents : null;
  }

  _isDestroyed(win) {
    try {
      return typeof win.isDestroyed === 'function' && win.isDestroyed();
    } catch (_) {
      return true;
    }
  }

  _ensurePlayer() {
    if (this._win && !this._isDestroyed(this._win)) return this._win;
    const win = new this.BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        preload: this.preloadPath,
      },
    });
    this._win = win;
    this._playerReady = false;
    win.on('closed', () => {
      if (this._win !== win) return;
      this._win = null;
      this._playerReady = false;
      if (this.isActive()) this._handleFailure('Wiedergabe-Fenster wurde beendet');
    });
    if (win.webContents && typeof win.webContents.on === 'function') {
      win.webContents.on('render-process-gone', () => {
        if (this._win !== win) return;
        this._log('warn', 'Player-Prozess beendet');
        this._win = null;
        this._playerReady = false;
        if (this.isActive()) this._handleFailure('Wiedergabe-Prozess wurde beendet');
      });
    }
    const loaded = win.loadFile(this.playerHtml);
    if (loaded && typeof loaded.catch === 'function') {
      loaded.catch(error => this._log('error', `Player konnte nicht geladen werden: ${error.message}`));
    }
    return win;
  }

  _sendPlayer(command) {
    if (!this._win && command.cmd !== 'play') return; // ohne Player-Fenster gibt es nichts zu steuern (kein Fenster für Lautstärke/Tempo)
    const win = this._ensurePlayer();
    if (!this._playerReady) {
      // Befehle der Reihe nach merken; "play" ersetzt alles Frühere, gleichartige Einstellungen überschreiben sich
      if (command.cmd === 'play') this._pending = [];
      else this._pending = this._pending.filter(entry => entry.cmd !== command.cmd);
      if (this._pending.length < MAX_PENDING_COMMANDS) this._pending.push(command);
      return;
    }
    this._deliver(win, command);
  }

  _deliver(win, command) {
    try {
      win.webContents.send('radio-player:cmd', command);
    } catch (error) {
      this._log('warn', `Player-Befehl fehlgeschlagen: ${error.message}`);
    }
  }

  _closePlayer() {
    const win = this._win;
    this._win = null;
    this._playerReady = false;
    this._pending = [];
    if (win && !this._isDestroyed(win)) {
      try {
        win.close();
      } catch (_) {
        // Fenster zwischendurch weg
      }
    }
  }

  _handleFailure(message) {
    this._saveProgress();
    this._session += 1;
    this._clearSaveTimer();
    this._closePlayer();
    this._dispatch({ type: 'fail', message });
  }

  _handleEnded() {
    // Ende: Position = Dauer (→ gehört ab 95 %, sofern „automatisch als gehört markieren“ an ist), Fenster freigeben;
    // keine Wiederverbindung. Mit „nach Ende nächste Episode abspielen“ folgt ohne Zwischenzustand „beendet“ die nächste
    // ungehörte Episode derselben Sendung (sonst würde die App bei geschlossenem Fenster dazwischen beenden).
    const next = this._nextAfterEnd();
    if (next) this._state = playback.reduce(this._state, { type: 'ended' }); // stiller Übergang: nur für das Speichern der Endposition
    else this._dispatch({ type: 'ended' });
    this._saveProgress();
    this._session += 1;
    this._clearSaveTimer();
    this._closePlayer();
    if (!next) return;
    this.play(next).catch(error => {
      this._log('warn', `Nächste Episode nicht gestartet: ${error.message}`);
      this._dispatch({ type: 'fail', message: 'Nächste Episode konnte nicht geladen werden' });
    });
  }

  /** Einstellung „nach Ende nächste Episode abspielen“: Schlüssel der nächsten ungehörten Episode derselben Sendung oder null. */
  _nextAfterEnd() {
    const episode = this._state.episode;
    if (!episode || !this._settings().autoPlayNext) return null;
    try {
      const feed = typeof this.library.getEpisodes === 'function' ? this.library.getEpisodes(episode.podcastId) : this.library.getCachedFeed(episode.podcastId);
      const nextId = nextEpisodeId(feed.episodes, episode.episodeId, id => this.library.getEpisodeState(episode.podcastId, id));
      return nextId ? { podcastId: episode.podcastId, episodeId: nextId } : null;
    } catch (error) {
      this._log('warn', `Nächste Episode nicht ermittelt: ${error.message}`);
      return null;
    }
  }

  /** Nachricht des Player-Hosts (vom IPC bereits geprüft/normalisiert, siehe normalizeRadioPlayerReport). */
  onPlayerReport(report) {
    if (!report || typeof report.t !== 'string') return;
    if (report.t === 'ready') {
      this._playerReady = true;
      const pending = this._pending;
      this._pending = [];
      if (this._win) pending.forEach(command => this._deliver(this._win, command));
      return;
    }
    if (report.t === 'action') {
      this._handleAction(report);
      return;
    }
    if (report.seq !== undefined && report.seq !== this._session) return; // veraltete Sitzung
    if (report.t === 'playing') {
      this._dispatch({ type: 'playing' });
      if (this._state.status === 'playing' && !this._saveTimer) this._armSaveTimer();
    } else if (report.t === 'time') {
      this._dispatch({ type: 'time', position: report.position, duration: report.duration });
    } else if (report.t === 'error') {
      if (!this.isActive()) return;
      this._handleFailure(report.code === 4 ? 'Format nicht unterstützt' : 'Episode konnte nicht geladen werden');
    } else if (report.t === 'ended') {
      this._handleEnded();
    }
  }

  _handleAction(report) {
    const action = report.action;
    if (action === 'play') {
      if (this._state.status === 'paused' || this._state.status === 'ended') this.resume();
    } else if (action === 'pause') this.pause();
    else if (action === 'stop') this.stop();
    else if (action === 'seekbackward' || action === 'previoustrack') this.skip(-this._settings().skipBack); // Medientasten/Now Playing: eingestellte Sprungweite
    else if (action === 'seekforward' || action === 'nexttrack') this.skip(this._settings().skipForward);
    else if (action === 'seekto' && Number.isFinite(report.seekTime)) this.seek(report.seekTime);
  }

  _sendMeta() {
    const episode = this._state.episode;
    if (!episode) return;
    this._sendPlayer({ cmd: 'meta', title: episode.title, artist: episode.show, album: episode.show, artwork: episode.cover || null });
  }
}

module.exports = { PodcastController, SAVE_INTERVAL_MS };
