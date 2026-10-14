'use strict';

// RadioController (Konzept §2): Zustand im Main (Single Source of Truth) und einzige Audio-Engine als
// unsichtbares Player-Fenster (radio-player.html + preload-radio.js: show:false, backgroundThrottling:false,
// sandbox:true, autoplayPolicy no-user-gesture-required). Hauptfenster und Tray sind nur Fernbedienungen:
// sie rufen play/pause/stop/next/prev/setVolume und hören auf das Event 'state'.
//
// Ablauf Wiedergabe: Sender wählen → Playlist/Redirects im Main auflösen (radio-resolve) → Player-Fenster
// spielt <audio> (MP3/AAC/Ogg) bzw. hls.js (HLS) → Player meldet 'playing' → Now Playing per ICY-Zweitverbindung
// im Main (icy-parser, alle icyIntervalMs). Abbrüche: bis zu 3 Wiederverbindungen mit Backoff (radio-state),
// danach Status error. Jede Aktion erhöht die Sitzungsnummer; Antworten veralteter Sitzungen werden verworfen.
//
// Abhängigkeiten (BrowserWindow, Timer, fetch, Auflösung, ICY) sind injizierbar → ohne Electron testbar.

const { EventEmitter } = require('events');
const state = require('./radio-state.js');
const { resolveStream: defaultResolveStream } = require('./radio-resolve.js');
const { readIcyTitle: defaultReadIcyTitle } = require('./icy-parser.js');

const DEFAULT_ICY_INTERVAL_MS = 25000;
const VOLUME_SAVE_DELAY_MS = 500;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

class RadioController extends EventEmitter {
  /**
   * options:
   * - BrowserWindow: Electron-Klasse (Test: Attrappe mit loadFile/on/close/isDestroyed/webContents.send)
   * - playerHtml, preloadPath: Pfade des Player-Hosts
   * - library: { getStation(key), getFavoriteKeys(), getSettings(), updateSettings(patch) }
   * - resolveStream, readIcyTitle, fetch: Netzwerk (Standard: radio-resolve / icy-parser / globaler fetch)
   * - setTimer, clearTimer, logger, icyIntervalMs
   */
  constructor({
    BrowserWindow,
    playerHtml,
    preloadPath,
    library,
    resolveStream = defaultResolveStream,
    readIcyTitle = defaultReadIcyTitle,
    fetch = globalThis.fetch,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = null,
    icyIntervalMs = DEFAULT_ICY_INTERVAL_MS,
  } = {}) {
    super();
    if (!BrowserWindow) throw new Error('RadioController benötigt BrowserWindow');
    if (!library) throw new Error('RadioController benötigt library');
    this.BrowserWindow = BrowserWindow;
    this.playerHtml = playerHtml;
    this.preloadPath = preloadPath;
    this.library = library;
    this.resolveStream = resolveStream;
    this.readIcyTitle = readIcyTitle;
    this.fetch = fetch;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.icyIntervalMs = icyIntervalMs;

    this._state = state.createState({ volume: this._safeSettings().volume });
    this._session = 0;
    this._win = null;
    this._playerReady = false;
    this._pendingCommand = null;
    this._retryTimer = null;
    this._icyTimer = null;
    this._volumeTimer = null;
    this._resolved = null;
    /** Laufender Verbindungsaufbau (Promise; für Tests und geordnetes Beenden). */
    this.connecting = Promise.resolve();
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[radio] ${message}`);
  }

  _safeSettings() {
    try {
      return this.library.getSettings();
    } catch (error) {
      this._log('warn', `Einstellungen nicht lesbar: ${error.message}`);
      return { volume: state.DEFAULT_VOLUME, lastStation: null };
    }
  }

  // ── Zustand ──

  getState() {
    return state.publicState(this._state);
  }

  isPlaying() {
    return this._state.status === 'playing' || this._state.status === 'loading';
  }

  /** Radio ist "an": spielt, lädt oder pausiert (nicht idle/error). Hält die App im Tray, wenn das Fenster zugeht. */
  isActive() {
    return this._state.status !== 'idle' && this._state.status !== 'error';
  }

  _dispatch(action) {
    const next = state.reduce(this._state, action);
    if (next === this._state) return false;
    this._state = next;
    this.emit('state', this.getState());
    return true;
  }

  _stationKey() {
    const station = this._state.station;
    return station ? { sourceId: station.sourceId, id: station.id } : null;
  }

  // ── Steuerung ──

  /** Spielt den Sender key ({ sourceId, stationId }); ohne key: Pause beenden bzw. letzter Sender/erster Favorit. */
  async play(key) {
    if (!key) {
      if (this._state.status === 'paused') return this.resume();
      if (this.isPlaying()) return this.getState();
      key = this._defaultKey();
      if (!key) throw new Error('Kein Sender ausgewählt');
    }
    const station = this.library.getStation(key);
    if (!station) throw new Error('Sender nicht gefunden');
    if (!station.streamUrl) throw new Error('Sender hat keine Stream-URL');
    this._begin(station);
    return this.getState();
  }

  /**
   * App-Start: setzt den zuletzt gehörten Sender fort, aber nur bei aktivierter Option "resumeOnStart" und nur,
   * wenn der Sender noch existiert (kein Rückgriff auf Favoriten). Liefert true, wenn die Wiedergabe gestartet wurde.
   */
  resumeOnStart() {
    if (this._state.status !== 'idle') return false;
    const settings = this._safeSettings();
    const last = settings.resumeOnStart === true ? settings.lastStation : null;
    if (!last) return false;
    const station = this.library.getStation({ sourceId: last.sourceId, stationId: last.id });
    if (!station || !station.streamUrl) return false;
    this._begin(station);
    return true;
  }

  _defaultKey() {
    const last = this._safeSettings().lastStation;
    if (last && this.library.getStation({ sourceId: last.sourceId, stationId: last.id })) {
      return { sourceId: last.sourceId, stationId: last.id };
    }
    const first = this.library.getFavoriteKeys()[0];
    return first ? { sourceId: first.sourceId, stationId: first.id } : null;
  }

  _begin(station) {
    this._session += 1;
    this._clearTimers();
    this._dispatch({ type: 'select', station });
    try {
      this.library.updateSettings({ lastStation: { sourceId: station.sourceId, id: station.id } });
    } catch (error) {
      this._log('warn', `Letzter Sender nicht gespeichert: ${error.message}`);
    }
    this.connecting = this._connect(this._session);
  }

  pause() {
    if (this._state.status !== 'playing') return this.getState();
    this._session += 1;
    this._clearTimers();
    // Live-Stream: Verbindung und Player-Fenster freigeben (Fortsetzen verbindet neu und erzeugt das Fenster wieder)
    this._closePlayer();
    this._dispatch({ type: 'pause' });
    return this.getState();
  }

  resume() {
    if (this._state.status !== 'paused') return this.getState();
    this._session += 1;
    this._dispatch({ type: 'resume' });
    this.connecting = this._connect(this._session);
    return this.getState();
  }

  stop() {
    this._session += 1;
    this._clearTimers();
    this._closePlayer();
    this._dispatch({ type: 'stop' });
    return this.getState();
  }

  next() {
    return this._step(1);
  }

  prev() {
    return this._step(-1);
  }

  async _step(delta) {
    const key = state.favoriteNeighbor(this.library.getFavoriteKeys(), this._stationKey(), delta);
    if (!key) return this.getState();
    return this.play({ sourceId: key.sourceId, stationId: key.id });
  }

  setVolume(value) {
    this._dispatch({ type: 'volume', value });
    this._sendPlayer({ cmd: 'volume', volume: this._state.volume });
    if (this._volumeTimer) this.clearTimer(this._volumeTimer);
    this._volumeTimer = this.setTimer(() => {
      this._volumeTimer = null;
      try {
        this.library.updateSettings({ volume: this._state.volume });
      } catch (error) {
        this._log('warn', `Lautstärke nicht gespeichert: ${error.message}`);
      }
    }, VOLUME_SAVE_DELAY_MS);
    return this.getState();
  }

  dispose() {
    this.removeAllListeners(); // beim Beenden keine Folgereaktionen (z. B. erneutes app.quit()) auslösen
    this.stop();
    if (this._volumeTimer) {
      this.clearTimer(this._volumeTimer);
      this._volumeTimer = null;
    }
  }

  // ── Verbindung ──

  async _connect(session) {
    const station = this._state.station;
    if (!station) return;
    try {
      const resolved = await this.resolveStream(station.streamUrl, { fetch: this.fetch });
      if (session !== this._session) return;
      this._resolved = resolved;
      this._sendPlayer({ cmd: 'play', seq: session, url: resolved.streamUrl, kind: resolved.kind, volume: this._state.volume });
    } catch (error) {
      if (session !== this._session) return;
      this._log('warn', `Auflösung fehlgeschlagen (${station.name}): ${error.message}`);
      this._handleFailure(error.message || 'Stream nicht erreichbar');
    }
  }

  /** Abbruch/Fehler: Wiederverbindung mit Backoff oder endgültig Status error. */
  _handleFailure(message, { retry = true } = {}) {
    const plan = retry ? state.planReconnect(this._state) : { retry: false };
    this._clearTimers();
    if (plan.retry) {
      this._session += 1;
      const session = this._session;
      this._dispatch({ type: 'reconnecting', attempt: plan.attempt });
      this._sendPlayer({ cmd: 'halt' });
      this._log('info', `Wiederverbindung ${plan.attempt}/${state.MAX_RECONNECTS} in ${plan.delayMs} ms`);
      this._retryTimer = this.setTimer(() => {
        this._retryTimer = null;
        if (session !== this._session) return;
        this.connecting = this._connect(session);
      }, plan.delayMs);
      return;
    }
    this._session += 1;
    this._closePlayer();
    this._dispatch({ type: 'fail', message });
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
      if (this.isPlaying()) this._handleFailure('Wiedergabe-Fenster wurde beendet');
    });
    if (win.webContents && typeof win.webContents.on === 'function') {
      win.webContents.on('render-process-gone', () => {
        if (this._win !== win) return;
        this._log('warn', 'Player-Prozess beendet');
        this._win = null;
        this._playerReady = false;
        if (this.isPlaying()) this._handleFailure('Wiedergabe-Prozess wurde beendet');
      });
    }
    const loaded = win.loadFile(this.playerHtml);
    if (loaded && typeof loaded.catch === 'function') {
      loaded.catch(error => this._log('error', `Player konnte nicht geladen werden: ${error.message}`));
    }
    return win;
  }

  _sendPlayer(command) {
    if (command.cmd === 'halt' && !this._win) return; // nichts zu beenden
    const win = this._ensurePlayer();
    if (!this._playerReady) {
      this._pendingCommand = command.cmd === 'volume' && this._pendingCommand ? { ...this._pendingCommand, volume: command.volume } : command;
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
    this._pendingCommand = null;
    if (win && !this._isDestroyed(win)) {
      try {
        win.close();
      } catch (_) {
        // Fenster zwischendurch weg
      }
    }
  }

  /** Nachricht des Player-Hosts (vom IPC bereits geprüft/normalisiert, siehe normalizeRadioPlayerReport). */
  onPlayerReport(report) {
    if (!report || typeof report.t !== 'string') return;
    if (report.t === 'ready') {
      this._playerReady = true;
      const pending = this._pendingCommand;
      this._pendingCommand = null;
      if (pending && this._win) this._deliver(this._win, pending);
      return;
    }
    if (report.t === 'action') {
      this._handleAction(report.action);
      return;
    }
    if (report.seq !== undefined && report.seq !== this._session) return; // veraltete Sitzung
    if (report.t === 'playing') {
      if (this._dispatch({ type: 'playing' })) this._onPlaying();
    } else if (report.t === 'error') {
      this._handleFailure(playerErrorMessage(report), { retry: report.code !== MEDIA_ERR_SRC_NOT_SUPPORTED });
    } else if (report.t === 'ended') {
      this._handleFailure('Stream wurde beendet');
    }
  }

  _handleAction(action) {
    const run = promise => {
      Promise.resolve(promise).catch(error => this._log('warn', `Medienaktion fehlgeschlagen: ${error.message}`));
    };
    if (action === 'play') run(this.play());
    else if (action === 'pause') this.pause();
    else if (action === 'stop') this.stop();
    else if (action === 'nexttrack') run(this.next());
    else if (action === 'previoustrack') run(this.prev());
  }

  _onPlaying() {
    this._sendMeta();
    const resolved = this._resolved;
    if (resolved && resolved.kind === 'direct') this._pollIcy(this._session, resolved.streamUrl);
  }

  // ── Now Playing (ICY) ──

  _pollIcy(session, streamUrl) {
    const tick = async () => {
      this._icyTimer = null;
      let again = true;
      try {
        const result = await this.readIcyTitle(streamUrl, { fetch: this.fetch });
        if (session !== this._session || this._state.status !== 'playing') return;
        if (!result.metaint) again = false; // Sender liefert kein ICY: nicht weiter abfragen
        this._setNowPlaying(result.title || result.artist ? { title: result.title, artist: result.artist } : null);
      } catch (error) {
        if (session !== this._session) return;
        this._log('info', `ICY nicht lesbar: ${error.message}`);
      }
      if (again && session === this._session && this._state.status === 'playing') {
        this._icyTimer = this.setTimer(tick, this.icyIntervalMs);
      }
    };
    this._icyTimer = this.setTimer(tick, 0);
  }

  _setNowPlaying(nowPlaying) {
    const current = this._state.nowPlaying;
    const same = current && nowPlaying ? current.title === nowPlaying.title && current.artist === nowPlaying.artist : current === nowPlaying;
    if (same) return;
    if (this._dispatch({ type: 'now-playing', nowPlaying })) this._sendMeta();
  }

  _sendMeta() {
    const station = this._state.station;
    if (!station) return;
    const now = this._state.nowPlaying;
    this._sendPlayer({
      cmd: 'meta',
      title: (now && now.title) || station.name,
      artist: (now && now.artist) || '',
      album: station.name,
    });
  }

  _clearTimers() {
    if (this._retryTimer) this.clearTimer(this._retryTimer);
    if (this._icyTimer) this.clearTimer(this._icyTimer);
    this._retryTimer = null;
    this._icyTimer = null;
  }
}

function playerErrorMessage(report) {
  return report.code === MEDIA_ERR_SRC_NOT_SUPPORTED ? 'Format nicht unterstützt' : 'Stream nicht erreichbar';
}

module.exports = { RadioController, DEFAULT_ICY_INTERVAL_MS };
