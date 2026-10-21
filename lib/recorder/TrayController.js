// v0.5.9 – TrayController: Tray-Icon + Menü + Beenden-/Shutdown-Verhalten
// (Aufnahme Phase 1c, Karte t_bafa7928; Konzept §3.2)
//
// Verantwortlichkeiten (SRP): Tray-Darstellung und App-Lifecycle rund um
// laufende Aufnahmen. Keine Aufnahme-Logik — der RecorderService wird nur
// beobachtet (Events + status()-Abfrage).
//
// Verhalten:
// - Icon: App-Brand (violett, assets/icon.svg: #6c5ce7 → #a78bfa) im Leerlauf,
//   ROT mit weißem REC-Punkt, solange ≥ 1 Aufnahme läuft. Icons werden zur
//   Laufzeit als nativeImage aus SVG-abgeleiteten PNG-Quellen erzeugt —
//   ohne externe Abhängigkeiten (Electron kann SVG nicht direkt dekodieren,
//   daher zeichnet ein kleines JS-Raster die Pixmaps selbst).
// - Menü: je Aufnahme „● <Kanal> — <Titel> · MM:SS“ mit Stopp-Action,
//   (Etappe 2b) „Geplant: <Sender — Titel · heute 20:15>“ (nächste 3) und
//   „Planung öffnen“, „Aufnahmen-Ordner öffnen“, „App öffnen“, (bei laufender
//   Aufnahme) „Beenden …“ mit Bestätigung. Aufbau/Bereinigung: tray-menu-model.js.
// - Tray-Icon (E3): im Leerlauf violett — auch mit Planung —, ROT nur bei
//   laufender Aufnahme; Geplantes zeigt nur das Menü.
// - Benachrichtigungen (Aufnahme UND Planung) laufen über den gemeinsamen
//   Notifier (Notifier.js); attachScheduler() übernimmt 'schedule:notify' und
//   aktualisiert das Menü bei 'schedule:changed'.
// - Fenster schließen ≠ App beenden, solange ≥ 1 Aufnahme läuft
//   (window-all-closed → Tray). Ohne Aufnahmen: normales Quit-Verhalten.
// - Shutdown: macOS powerMonitor 'shutdown' → Bestätigungsdialog
//   „Es läuft eine Aufnahme — trotzdem herunterfahren?“. Linux: KEIN OS-Block
//   (User-Beschluss 30.09) — nur Tray-Benachrichtigung + Hinweis-Event an den
//   Renderer (falls Fenster offen).
//
// Plattform-Pflicht: alles macOS + Linux kompatibel, plattformexklusive APIs
// nur hinter Guards.

'use strict';

const path = require('path');
const { nativeImage, Tray, Menu, app, dialog, shell, powerMonitor, Notification } = require('electron');
const logger = require('../../logger.js');
const { formatDuration } = require('./ui-model.js');
const { createNotifier } = require('./Notifier.js');
const { revealWindow } = require('../e2e-background.js');
const { marqueeWindow, MARQUEE_STEP_MS, MARQUEE_FONT_TYPE } = require('../radio/tray-marquee.js');
const { TrayPixelMarquee } = require('../radio/tray-pixel-marquee.js');
const { buildTrayMenuModel, trayIconKind, trayTooltip, trayTitleText, VOLUME_STEP } = require('./tray-menu-model.js');

// Quit-Cleanup (Karte t_695bf150): max. Wartezeit auf nachlaufende Remuxes
// beim Beenden — darüber entscheidet der before-quit-Sweep hart (Recovery
// holt den Rest beim nächsten Start nach). 10 s reicht für stream-copy
// auch bei längeren Aufnahmen (MP4-Durchsatz ≫ Aufnahme-Dauer).
const MAX_QUIT_REMUX_WAIT_MS = 10000;

// Radio (R4): Titelwechsel (ICY) bauen das Menü höchstens alle 5 s neu; Zustandswechsel sofort.
const RADIO_TITLE_THROTTLE_MS = 5000;

// ── Icons ──
// Die Tray-Icons (Brand violett / rot mit REC-Punkt) werden zur BUILD-Zeit
// aus assets/icon.svg abgeleitet: scripts/generate-tray-icons.js erzeugt
// assets/tray/tray-idle.png + tray-rec.png. nativeImage kann SVG nicht
// dekodieren — deshalb kompilierte PNGs statt Laufzeit-Rasterung. Ist das
// Tray-Asset nicht vorhanden (Dev-Checkout ohne Build-Schritt), fällt der
// Controller auf assets/icon.png zurück (funktional, nur nicht farbcodiert).

class TrayController {
  /**
   * options:
   * - recorder: RecorderService-Instanz (Event-Quelle + status())
   * - getWindow: () => BrowserWindow|null (Hauptfenster)
   * - openLibrary: () => void — öffnet die Aufnahmen-Bibliothek im Renderer
   * - openPlanning: () => void — zeigt das Hauptfenster, Dashboard Aufnahmen → „Geplant“
   * - showWindow: () => void — Hauptfenster zeigen (erzeugt es bei Bedarf neu)
   * - getPlanned: () => Planungseinträge (Scheduler.list), now: () => ms
   * - confirmQuit: async () => bool — Beenden-Dialog bei Planung < 24 h (QuitCoordinator)
   * - notifier: { notify(title, body) } (Default: Electron-Notification)
   * - getStorageRoot: () => string — aktueller Speicherort
   * - radio: RadioController (optional; Events 'state', play/pause/resume/stop/next/prev/setVolume/getState)
   * - getRadioFavorites: () => [{ sourceId, id, name, logo? }] Favoriten in Dashboard-Reihenfolge
   * - getTrayDisplay: () => 'off'|'station'|'station-title' — Text neben dem Symbol (nur macOS), Standard 'station-title'
   * - getTrayScroll: () => bool — lange Texte neben dem Symbol durchlaufen lassen (Standard an)
   * - getTrayScrollMode: () => 'smooth'|'steps' — 'smooth': Text als Template-Bild in einem zweiten Menüleisten-Eintrag rechts
   *   neben dem farbigen Symbol (Farbe durch macOS); 'steps': setTitle am Symbol-Eintrag (schrittweise). Standard 'smooth'
   * - renderTrayText: async (text) => { buffer, width, height } | null — Textbild (schwarz mit Alpha) für 'smooth' (ohne: nur 'steps')
   * - getReducedMotion: () => bool — macOS „Bewegung reduzieren“: dann kein Lauftext, sondern gekürzt mit „…“
   * - setTick/clearTick: Intervall-Injektion für den Lauftext (Tests)
   * - canPlayLast: () => bool — gibt es einen zuletzt gehörten Sender („Abspielen“ im Leerlauf)
   * - logoCache: { peek(url), request(urls) } (radio-logo-cache.js); logosEnabled: () => bool (Logo-Schalter)
   * - platform: Standard process.platform (Menü-Icons nicht unter Linux, Titeltext nur macOS)
   * - openRadio: () => void — zeigt das Hauptfenster und öffnet das Radio-Dashboard
   * - podcast: PodcastController (optional; Events 'state', pause/resume/stop/skip/getState); openPodcasts: () => void — öffnet den Podcast-Bereich
   * - setTimer/clearTimer: Timer-Injektion für die Drosselung (Tests)
   * - appRoot: App-Stamm (assets/tray/*.png, assets/icon.png-Fallback)
   */
  constructor({
    recorder,
    getWindow,
    openLibrary,
    openPlanning,
    showWindow,
    getPlanned,
    confirmQuit,
    notifier,
    now = () => Date.now(),
    getStorageRoot,
    radio,
    podcast,
    openPodcasts,
    getRadioFavorites,
    getTrayDisplay,
    getTrayScroll,
    getTrayScrollMode,
    renderTrayText,
    createImage = (buffer, options) => nativeImage.createFromBitmap(buffer, options),
    getReducedMotion,
    canPlayLast,
    logoCache,
    logosEnabled,
    platform = process.platform,
    openRadio,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setTick = setInterval,
    clearTick = clearInterval,
    appRoot,
  }) {
    if (!recorder) throw new Error('TrayController benötigt einen RecorderService');
    if (typeof getWindow !== 'function') throw new Error('TrayController benötigt getWindow()');
    this.recorder = recorder;
    this.getWindow = getWindow;
    this.openLibrary = typeof openLibrary === 'function' ? openLibrary : null;
    this.openPlanning = typeof openPlanning === 'function' ? openPlanning : null;
    this.showWindow = typeof showWindow === 'function' ? showWindow : null;
    this.getPlanned = typeof getPlanned === 'function' ? getPlanned : () => [];
    this.confirmQuit = typeof confirmQuit === 'function' ? confirmQuit : null;
    this.notifier = notifier || createNotifier({ NotificationClass: Notification, logger });
    this.now = now;
    this.getStorageRoot = typeof getStorageRoot === 'function' ? getStorageRoot : null;
    this.radio = radio && typeof radio.getState === 'function' ? radio : null;
    this.podcast = podcast && typeof podcast.getState === 'function' ? podcast : null;
    this.openPodcasts = typeof openPodcasts === 'function' ? openPodcasts : null;
    this.getRadioFavorites = typeof getRadioFavorites === 'function' ? getRadioFavorites : () => [];
    this.openRadio = typeof openRadio === 'function' ? openRadio : null;
    this.getTrayDisplay = typeof getTrayDisplay === 'function' ? getTrayDisplay : () => 'station-title';
    this.getTrayScroll = typeof getTrayScroll === 'function' ? getTrayScroll : () => true;
    this.getTrayScrollMode = typeof getTrayScrollMode === 'function' ? getTrayScrollMode : () => 'smooth';
    this._pixel = platform === 'darwin' && typeof renderTrayText === 'function'
      ? new TrayPixelMarquee({
          render: renderTrayText,
          createImage,
          setImage: image => this._setTextImage(image),
          now,
          setTick,
          clearTick,
          logger,
          onFail: () => this._pixelFailed(this._pixelText),
        })
      : null;
    this._pixelText = ''; // Text, für den der Bildmodus angefordert wurde (gerendert, laufend oder statisch)
    this._pixelFailedText = ''; // Text, für den das Rendern fehlschlug: dafür schrittweise
    this.textTray = null; // zweiter Eintrag (nur Text als Template-Bild), existiert nur, solange Text angezeigt wird
    this.getReducedMotion = typeof getReducedMotion === 'function' ? getReducedMotion : () => false;
    this.setTick = setTick;
    this.clearTick = clearTick;
    this._scrollTimer = null;
    this._scrollText = '';
    this._scrollStep = 0;
    this.canPlayLast = typeof canPlayLast === 'function' ? canPlayLast : () => false;
    this.logoCache = logoCache && typeof logoCache.peek === 'function' ? logoCache : null;
    this.logosEnabled = typeof logosEnabled === 'function' ? logosEnabled : () => true;
    this.platform = platform;
    this._title = '';
    this._titleFont = null;
    this._preMuteVolume = null;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this._radioKey = '';
    this._podcastKey = '';
    this._radioTitleAt = 0;
    this._radioTitleTimer = null;
    this._menuSignature = '';
    this.appRoot = appRoot || __dirname;

    this.tray = null; // Symbol-Eintrag (farbig; im Modus „steps“ trägt er den Titeltext)
    this._tooltip = 'Streaming Hub';
    this._menuItems = null;
    this._activeCount = 0;
    this._elapsedTimer = null;
    this._destroyed = false;

    this._onChanged = () => this.refresh();
    this._onProgress = () => this._scheduleMenuTick();

    // Bewusst KEINE Auto-Neuerstellung im Konstruktor: create() ruft der
    // App-Start, sobald das Fenster existiert.
  }

  // ── Lifecycle ──

  create() {
    if (this._destroyed || this.tray) return;
    this.tray = new Tray(this._idleIcon());
    this._attachTray(this.tray);
    this._rebuildMenu();
    this._wireRecorderEvents();
    this._wireRadioEvents();
    this._wirePodcastEvents();
    this._wirePowerMonitor();
  }

  destroy() {
    this._destroyed = true;
    this._stopElapsedTimer();
    this._stopScroll();
    this._pixelText = '';
    if (this._pixel) this._pixel.stop();
    this._dropTextTray();
    if (this._radioTitleTimer) {
      this.clearTimer(this._radioTitleTimer);
      this._radioTitleTimer = null;
    }
    if (this.radio && this._onRadioState && typeof this.radio.removeListener === 'function') {
      this.radio.removeListener('state', this._onRadioState);
    }
    if (this.podcast && this._onPodcastState && typeof this.podcast.removeListener === 'function') {
      this.podcast.removeListener('state', this._onPodcastState);
    }
    if (this.tray) {
      try { this.tray.destroy(); } catch (_) { /* schon weg */ }
      this.tray = null;
    }
  }

  _wireRecorderEvents() {
    this.recorder.on('recording:progress', this._onProgress);
    this.recorder.on('recording:changed', this._onChanged);
    this.recorder.on('recording:status', payload => {
      if (payload && (payload.phase === 'recording' || payload.phase === 'done')) this.refresh();
    });
    // Auto-Stopp im Main (Sendungsende/Höchstdauer/Speicher voll/Speicherort
    // weg): Benachrichtigung auch ohne offenes Fenster (Konzept §3.9).
    this.recorder.on('recording:auto-stopped', payload => {
      if (!payload) return;
      const name = payload.channelName || payload.channelId || 'Aufnahme';
      const critical = payload.reason === 'disk-full' || payload.reason === 'storage-lost';
      this._notify(
        critical
          ? `Aufnahme „${name}“ beendet: ${payload.message}. Sie bleibt abspielbar.`
          : `Aufnahme „${name}“ beendet: ${payload.message}.`,
      );
    });
  }

  // ── Radio (R4) ──

  _wireRadioEvents() {
    if (!this.radio || typeof this.radio.on !== 'function') return;
    this._radioKey = this._radioStateKey(this.radio.getState());
    this._onRadioState = state => this._handleRadioState(state);
    this.radio.on('state', this._onRadioState);
  }

  /** Alles außer dem Titel: Wechsel hier aktualisiert Icon, Tooltip und Menü sofort. */
  _radioStateKey(state) {
    const station = state && state.station;
    return JSON.stringify([state && state.status, station && station.sourceId, station && station.id, station && station.name, state && state.volume, state && state.error]);
  }

  _handleRadioState(state) {
    if (this._destroyed || !this.tray) return;
    const key = this._radioStateKey(state);
    if (key !== this._radioKey) {
      this._radioKey = key;
      this._clearRadioTitleTimer();
      this._radioTitleAt = this.now();
      this.refresh();
      return;
    }
    // Nur der Titel hat sich geändert: höchstens alle 5 s neu bauen, dazwischen genau ein nachlaufender Aufruf
    const wait = RADIO_TITLE_THROTTLE_MS - (this.now() - this._radioTitleAt);
    if (wait <= 0) {
      this._radioTitleAt = this.now();
      this._rebuildMenu({ onlyIfChanged: true });
    } else if (!this._radioTitleTimer) {
      this._radioTitleTimer = this.setTimer(() => {
        this._radioTitleTimer = null;
        this._radioTitleAt = this.now();
        this._rebuildMenu({ onlyIfChanged: true });
      }, wait);
    }
  }

  _clearRadioTitleTimer() {
    if (this._radioTitleTimer) {
      this.clearTimer(this._radioTitleTimer);
      this._radioTitleTimer = null;
    }
  }

  // ── Podcast ──

  _wirePodcastEvents() {
    if (!this.podcast || typeof this.podcast.on !== 'function') return;
    this._podcastKey = this._podcastStateKey(this.podcast.getState());
    this._onPodcastState = state => this._handlePodcastState(state);
    this.podcast.on('state', this._onPodcastState);
  }

  /** Nur was Symbol, Text und Menü betrifft; Position/Dauer/Geschwindigkeit/Lautstärke lösen keinen Neuaufbau aus. */
  _podcastStateKey(state) {
    const episode = state && state.episode;
    return JSON.stringify([state && state.status, episode && episode.podcastId, episode && episode.episodeId, episode && episode.show, episode && episode.title, state && state.skipBack, state && state.skipForward]);
  }

  _handlePodcastState(state) {
    if (this._destroyed || !this.tray) return;
    const key = this._podcastStateKey(state);
    if (key === this._podcastKey) return;
    this._podcastKey = key;
    this.refresh();
  }

  /** Podcast-Abschnitt des Menüs und Grundlage für Symbol/Text, oder null ohne laufende/pausierte Episode. */
  _podcastModel() {
    if (!this.podcast) return null;
    let state;
    try {
      state = this.podcast.getState();
    } catch (e) {
      logger.warn('[tray] Podcast-Zustand nicht lesbar:', e.message);
      return null;
    }
    if (!state || !state.episode || !['loading', 'playing', 'paused'].includes(state.status)) return null;
    return {
      state: state.status,
      show: state.episode.show,
      title: state.episode.title,
      skipBack: state.skipBack,
      skipForward: state.skipForward,
    };
  }

  /** Podcast-Aktion ausführen; Fehler (auch asynchrone) werden geloggt statt geworfen. */
  _podcastAction(name, ...args) {
    try {
      const result = this.podcast[name](...args);
      if (result && typeof result.catch === 'function') result.catch(e => logger.warn(`[tray] Podcast ${name} fehlgeschlagen:`, e.message));
    } catch (e) {
      logger.warn(`[tray] Podcast ${name} fehlgeschlagen:`, e.message);
    }
  }

  /** Favoriten geändert (Dashboard/Einstellungen): Menü auffrischen, wenn sich etwas ändert. */
  refreshRadioMenu() {
    this._rebuildMenu({ onlyIfChanged: true });
  }

  /** Radio-Abschnitt des Menüs oder null (ohne Controller bleibt das Menü wie bisher). */
  _radioModel() {
    if (!this.radio) return null;
    let state;
    try {
      state = this.radio.getState();
    } catch (e) {
      logger.warn('[tray] Radio-Zustand nicht lesbar:', e.message);
      return null;
    }
    let favorites = [];
    try {
      favorites = this.getRadioFavorites() || [];
    } catch (e) {
      logger.warn('[tray] Radio-Favoriten nicht lesbar:', e.message);
    }
    const current = state.station;
    const icons = this._menuIconsEnabled();
    if (icons) this.logoCache.request(favorites.map(f => f.logo).filter(Boolean));
    const list = favorites.map(f => ({
      sourceId: f.sourceId,
      id: f.id,
      name: f.name,
      active: Boolean(current) && current.sourceId === f.sourceId && current.id === f.id && state.status !== 'idle',
      logo: icons && f.logo && this.logoCache.peek(f.logo) ? f.logo : undefined, // nur fertig geladene Icons
    }));
    let canPlayLast = false;
    try {
      canPlayLast = Boolean(current) || Boolean(this.canPlayLast());
    } catch (e) {
      logger.warn('[tray] Letzter Sender nicht lesbar:', e.message);
    }
    return {
      state: state.status,
      station: current ? { name: current.name } : null,
      nowPlaying: state.nowPlaying,
      error: state.error,
      volume: state.volume,
      favorites: list,
      canPlayLast,
    };
  }

  /** Menü-Icons: nicht unter Linux (Menüicons unüblich), nur mit Logo-Cache und eingeschaltetem Logo-Schalter. */
  _menuIconsEnabled() {
    if (!this.logoCache || this.platform === 'linux') return false;
    try {
      return this.logosEnabled() !== false;
    } catch (_) {
      return false;
    }
  }

  /**
   * Text neben dem Symbol (nur macOS), nur setzen, wenn er sich geändert hat. Läuft auch während einer Aufnahme (der Text steht
   * im Modus „smooth“ in einem eigenen Eintrag, das Symbol zeigt dann das rote Aufnahme-Symbol).
   * 'smooth': Textbild im zweiten Eintrag (Template, Farbe durch macOS); lange Texte laufen durch (nur bei spielendem Radio,
   * trayScroll an, ohne „Bewegung reduzieren“), sonst steht der gekürzte Text („…“) als statisches Bild; nie ein Wechsel zwischen
   * Titel und Bild. 'steps' oder Renderfehler: setTitle am Symbol-Eintrag (nativ), ohne zweiten Eintrag.
   */
  _applyTitle(activeCount, radio) {
    if (this.platform !== 'darwin' || !this.tray || typeof this.tray.setTitle !== 'function') return;
    let display = 'station-title';
    try {
      display = this.getTrayDisplay() || display;
    } catch (e) {
      logger.warn('[tray] Anzeige-Einstellung nicht lesbar:', e.message);
    }
    const podcast = this._podcastModel();
    const full = trayTitleText(activeCount, radio, { display, max: Infinity, podcast });
    const scrolling = full !== '' && this._scrollAllowed(radio, display, podcast);
    if (full && this._pixelEnabled()) {
      const text = scrolling ? full : trayTitleText(activeCount, radio, { display, podcast });
      if (text !== this._pixelFailedText) {
        this._applyPixelText(text);
        return;
      }
    }
    this._leavePixel();
    if (scrolling && marqueeWindow(full, 0).scrolling) {
      if (full !== this._scrollText || !this._scrollTimer) {
        this._scrollText = full; // neuer Text (z. B. Titelwechsel): wieder von vorn
        this._scrollStep = 0;
        this._startScroll();
      }
      this._setTitle(marqueeWindow(full, this._scrollStep).text, MARQUEE_FONT_TYPE);
      return;
    }
    this._stopScroll();
    this._setTitle(trayTitleText(activeCount, radio, { display, podcast }), null);
  }

  _pixelEnabled() {
    if (!this._pixel) return false;
    try {
      return this.getTrayScrollMode() !== 'steps';
    } catch (_) {
      return true;
    }
  }

  /**
   * Bildmodus: Textbild einmal rendern, dann setzt die TrayPixelMarquee die Bilder des zweiten Eintrags (bei kurzem Text genau
   * eines). Bis das erste Bild fertig ist, steht kein Text da (kein nativer Titel dazwischen). Gleicher Text: nichts tun
   * (Aufruf bei jedem Menütakt).
   */
  _applyPixelText(text) {
    if (text === this._pixelText) return;
    this._pixelText = text;
    this._stopScroll();
    this._setTitle('', null);
    this._pixel
      .start({ text })
      .then(result => {
        if (this._destroyed || !this.tray || this._pixelText !== text) return;
        if (result === 'failed') this._pixelFailed(text);
      })
      .catch(e => logger.warn('[tray] Lauftext-Bildmodus fehlgeschlagen:', e && e.message));
  }

  /** Bildmodus nicht möglich (Rendern/Bildsetzen): für diesen Text auf den Schrittmodus zurück. */
  _pixelFailed(text) {
    if (this._destroyed) return;
    this._pixelFailedText = text || '';
    this._pixelText = '';
    this._leavePixel();
    this._applyTitle(this._activeCount, this._radioModel());
  }

  /** Bildmodus verlassen: Takt aus, Textbild verwerfen, zweiten Eintrag entfernen. */
  _leavePixel() {
    this._pixelText = '';
    if (this._pixel) this._pixel.stop();
    this._dropTextTray();
  }

  /** Bild des zweiten Eintrags setzen (Template: macOS färbt es wie den Menüleistentext, auch bei Hell/Dunkel-Wechsel). */
  _setTextImage(image) {
    if (this._destroyed || !this.tray) return;
    if (image && typeof image.setTemplateImage === 'function') image.setTemplateImage(true);
    if (this.textTray) {
      this.textTray.setImage(image);
      return;
    }
    // macOS legt neue Einträge links der bestehenden ab. Soll der Text rechts vom Symbol stehen, entsteht zuerst der
    // Text-Eintrag und danach ein frischer Symbol-Eintrag (der alte wird ersetzt).
    this.textTray = new Tray(image);
    this._attachTray(this.textTray);
    const previous = this.tray;
    this.tray = this._createIconTray();
    try { previous.destroy(); } catch (_) { /* schon weg */ }
  }

  _dropTextTray() {
    if (!this.textTray) return;
    try { this.textTray.destroy(); } catch (_) { /* schon weg */ }
    this.textTray = null;
  }

  /** Neuer Symbol-Eintrag mit dem aktuellen Symbol, Titel, Tooltip, Menü und Klick. */
  _createIconTray() {
    const tray = new Tray(this._iconFor(trayIconKind(this.recorder.activeJobs().length, this._radioModel(), this._podcastModel())));
    this._attachTray(tray);
    if (this._title) {
      try {
        if (this._titleFont) tray.setTitle(this._title, { fontType: this._titleFont });
        else tray.setTitle(this._title);
      } catch (e) {
        logger.warn('[tray] Titeltext nicht setzbar:', e.message);
      }
    }
    return tray;
  }

  /** Tooltip, Klick und Kontextmenü eines Eintrags (beide Einträge verhalten sich gleich). */
  _attachTray(tray) {
    this._tooltip = trayTooltip(this.recorder.activeJobs().length, this._radioModel(), this._podcastModel());
    tray.setToolTip(this._tooltip);
    tray.on('click', () => this._showWindow());
    this._applyMenu(tray);
  }

  _applyMenu(tray) {
    if (!this._menuItems) return;
    try {
      tray.setContextMenu(Menu.buildFromTemplate(this._menuItems));
    } catch (e) {
      logger.error('[tray] Menü konnte nicht gebaut werden:', e.message);
    }
  }

  _trays() {
    return this.textTray ? [this.tray, this.textTray] : [this.tray];
  }

  _scrollAllowed(radio, display, podcast = null) {
    const radioPlaying = Boolean(radio) && radio.state === 'playing';
    const podcastPlaying = !radioPlaying && Boolean(podcast) && podcast.state === 'playing';
    if ((!radioPlaying && !podcastPlaying) || display === 'off') return false;
    try {
      if (this.getTrayScroll() === false) return false;
      if (this.getReducedMotion()) return false;
    } catch (e) {
      logger.warn('[tray] Lauftext-Einstellung nicht lesbar:', e.message);
      return false;
    }
    return true;
  }

  /** fontType: 'monospaced' beim Lauftext (konstante Breite), sonst null = Systemschrift. */
  _setTitle(text, fontType = null) {
    if (text === this._title && (fontType || null) === this._titleFont) return;
    this._title = text;
    this._titleFont = fontType || null;
    try {
      if (fontType) this.tray.setTitle(text, { fontType });
      else this.tray.setTitle(text);
    } catch (e) {
      logger.warn('[tray] Titeltext nicht setzbar:', e.message);
    }
  }

  _startScroll() {
    if (this._scrollTimer) return;
    this._scrollTimer = this.setTick(() => this._scrollTick(), MARQUEE_STEP_MS);
    if (this._scrollTimer && typeof this._scrollTimer.unref === 'function') this._scrollTimer.unref();
  }

  _stopScroll() {
    if (this._scrollTimer) {
      this.clearTick(this._scrollTimer);
      this._scrollTimer = null;
    }
    this._scrollText = '';
    this._scrollStep = 0;
  }

  _scrollTick() {
    if (this._destroyed || !this.tray || !this._scrollText) {
      this._stopScroll();
      return;
    }
    let reduced = false;
    try {
      reduced = Boolean(this.getReducedMotion());
    } catch (_) { /* wie „nicht reduziert“ */ }
    if (reduced) { // „Bewegung reduzieren“ wurde während des Laufs eingeschaltet: sofort statisch gekürzt
      this._applyTitle(this._activeCount, this._radioModel());
      return;
    }
    this._scrollStep += 1;
    this._setTitle(marqueeWindow(this._scrollText, this._scrollStep).text, MARQUEE_FONT_TYPE);
  }

  /** Lautstärke ±VOLUME_STEP (auf 10-%-Schritte gerundet); Stumm merkt die vorherige Stufe. */
  _stepVolume(delta) {
    const current = Number(this.radio.getState().volume) || 0;
    const next = Math.min(1, Math.max(0, Math.round((current + delta) * 10) / 10));
    this._radioAction('setVolume', next);
  }

  _toggleMute() {
    const current = Number(this.radio.getState().volume) || 0;
    if (current > 0) {
      this._preMuteVolume = current;
      this._radioAction('setVolume', 0);
    } else {
      this._radioAction('setVolume', this._preMuteVolume || 0.5);
      this._preMuteVolume = null;
    }
  }

  /** Radio-Aktion ausführen; Fehler (auch asynchrone) werden geloggt statt geworfen. */
  _radioAction(name, ...args) {
    try {
      const result = this.radio[name](...args);
      if (result && typeof result.catch === 'function') result.catch(e => logger.warn(`[tray] Radio ${name} fehlgeschlagen:`, e.message));
    } catch (e) {
      logger.warn(`[tray] Radio ${name} fehlgeschlagen:`, e.message);
    }
  }

  /**
   * Planung anbinden: Menü bei Änderungen/Takt auffrischen (nur wenn sich der Inhalt
   * ändert — „heute/morgen“ wechselt um Mitternacht, Sendungen laufen ab) und
   * Schedule-Benachrichtigungen (verpasst, Spätstart, Slip …) anzeigen.
   */
  attachScheduler(scheduler) {
    if (!scheduler || typeof scheduler.on !== 'function') return;
    scheduler.on('schedule:changed', () => this._rebuildMenu());
    scheduler.on('schedule:tick', () => this._rebuildMenu({ onlyIfChanged: true }));
    scheduler.on('schedule:notify', ({ message }) => {
      if (message) this.notifier.notify('Streaming Hub — Planung', message);
    });
  }

  _wirePowerMonitor() {
    // macOS: powerMonitor 'shutdown' feuert beim System-Shutdown — hier darf
    // ein (kurzer) Dialog gezeigt werden (Konzept §3.2). Linux: kein
    // 'shutdown'-Event → nur In-App-Warnung (User-Beschluss 30.09), kein Block.
    if (process.platform === 'darwin') {
      powerMonitor.on('shutdown', (event) => {
        if (!this._hasActiveRecordings()) return; // kein Grund einzugreifen
        event.preventDefault();
        const win = this._liveWindow();
        const choice = win
          ? dialog.showMessageBoxSync(win, {
              type: 'question',
              buttons: ['Trotzdem herunterfahren', 'Abbrechen'],
              defaultId: 1,
              cancelId: 1,
              message: 'Es läuft eine Aufnahme — trotzdem herunterfahren?',
              detail: 'Beim Herunterfahren werden laufende Aufnahmen beendet und die Aufnahme wird abgebrochen.',
            })
          : 0; // ohne Fenster: nicht blockieren
        if (choice === 0) {
          // User will herunterfahren: Aufnahmen sauber stoppen (SIGINT →
          // Meta-Finalisierung), dann App beenden — das gibt den Shutdown frei.
          // Quit-Cleanup-Vertrag (Karte t_695bf150, Review R1): bewusst
          // app.quit() statt app.exit(0) — app.exit() umgeht den
          // before-quit-Hook, der Quit-Sweep (quitSweep) würde hier NIE
          // laufen und die ffmpeg-Childs würden wieder verwaisen (der
          // QA-Befund, der diese Karte ausgelöst hat). app.quit() feuert
          // before-quit → Sync-Sweep killt Reste deterministisch.
          const jobs = this.recorder.activeJobs().map(j => j.meta.id);
          Promise.allSettled(jobs.map(id => this.recorder.stop(id)))
            .catch(() => {})
            .then(() => app.quit());
        }
        // Abbruch: nichts weiter — macOS fährt nicht herunter, solange der
        // Event preventDefault'ed ist und die App läuft.
      });
    } else {
      // Linux/Windows-Fallback: keine OS-Blockierung. Beim System-Shutdown
      // (Session-Ende) benachrichtigen, damit der User Bescheid weiß — die
      // Aufnahme selbst kann der OS-Shutdown nicht aufhalten.
      powerMonitor.on('shutdown', () => {
        if (!this._hasActiveRecordings()) return;
        this._notify('Aufnahme läuft — der Computer fährt herunter. Die Aufnahme wird beendet.');
        this._broadcastShutdownWarning();
      });
    }
  }

  /**
   * In-App-Warnung (Linux, User-Beschluss 30.09): sichtbarer Hinweis im
   * App-Fenster, falls offen. Kein Block, kein Inhibit.
   */
  _broadcastShutdownWarning() {
    const win = this._liveWindow();
    try {
      win?.webContents?.send('recording:shutdown-warning', {
        message: 'Der Computer wird heruntergefahren — laufende Aufnahmen werden beendet.',
      });
    } catch (_) {
      // Fenster zwischendurch weg — Tray-Notification ist schon raus
    }
  }

  _notify(message) {
    this.notifier.notify('Streaming Hub — Aufnahme', message);
  }

  // ── Icons ──

  _iconPath(kind) {
    // Vom Build-Skript erzeugte PNGs (scripts/generate-tray-icons.js →
    // assets/tray/tray-idle.png, tray-rec.png). Fallback: App-Icon.
    const file = kind === 'rec' ? 'tray-rec.png' : kind === 'radio' ? 'tray-radio.png' : 'tray-idle.png';
    return path.join(this.appRoot, 'assets', 'tray', file);
  }

  _loadIcon(kind) {
    const fs = require('fs');
    const p = this._iconPath(kind);
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
    // Fallback: App-Icon (Brand) — unterscheidet dann nicht aktiv/Leerlauf,
    // aber der Tray bleibt funktionsfähig.
    return nativeImage.createFromPath(path.join(this.appRoot, 'assets', 'icon.png'));
  }

  _idleIcon() {
    return this._loadIcon('idle');
  }

  _recIcon() {
    return this._loadIcon('rec');
  }

  _iconFor(kind) {
    return kind === 'rec' ? this._recIcon() : this._loadIcon(kind);
  }

  // ── Zustand ──

  /** Hauptfenster oder null (nach „Fenster zu, App im Tray“ ist es zerstört). */
  _liveWindow() {
    const win = this.getWindow();
    try {
      return win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) ? win : null;
    } catch (_) {
      return null;
    }
  }

  _hasActiveRecordings() {
    return this.recorder.activeJobs().length > 0;
  }

  refresh() {
    if (this._destroyed || !this.tray) return;
    const active = this.recorder.activeJobs().length;
    const wasActive = this._activeCount;
    this._activeCount = active;
    try {
      const radio = this._radioModel();
      const podcast = this._podcastModel();
      const kind = trayIconKind(active, radio, podcast);
      this.tray.setImage(this._iconFor(kind)); // farbiges Symbol (Aufnahme: rot), nie ein Template
      this._tooltip = trayTooltip(active, radio, podcast);
      for (const tray of this._trays()) tray.setToolTip(this._tooltip);
    } catch (e) {
      logger.warn('[tray] Icon-Update fehlgeschlagen:', e.message);
    }
    this._rebuildMenu();
    if (active > 0 && wasActive === 0) this._startElapsedTimer();
    if (active === 0) this._stopElapsedTimer();
  }

  // ── Menü ──

  _scheduleMenuTick() {
    // Menü-Zeiten im 15s-Takt auffrischen (Timer nur bei aktiven Aufnahmen)
    if (this._activeCount > 0 && !this._elapsedTimer) this._startElapsedTimer();
  }

  _startElapsedTimer() {
    this._stopElapsedTimer();
    this._elapsedTimer = setInterval(() => {
      if (this._activeCount > 0) this._rebuildMenu();
      else this._stopElapsedTimer();
    }, 15000);
  }

  _stopElapsedTimer() {
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
    }
  }

  _rebuildMenu({ onlyIfChanged = false } = {}) {
    if (this._destroyed || !this.tray) return;
    const jobs = this.recorder.activeJobs().map(job => ({
      recId: job.meta.id,
      channelName: job.meta.channelName,
      channelId: job.meta.channelId,
      epgTitle: job.meta.epgTitle,
      elapsedText: formatDuration(job.getRecordingSec()),
    }));
    let planned = [];
    try {
      planned = this.getPlanned() || [];
    } catch (e) {
      logger.warn('[tray] Planung nicht lesbar:', e.message);
    }
    const radio = this._radioModel();
    const model = buildTrayMenuModel({
      jobs,
      planned,
      nowMs: this.now(),
      hasStorageRoot: !!this.getStorageRoot,
      hasLibrary: !!this.openLibrary,
      hasPlanning: !!this.openPlanning,
      radio,
      podcast: this._podcastModel(),
    });
    this._applyTitle(jobs.length, radio);
    const signature = JSON.stringify(model);
    if (onlyIfChanged && signature === this._menuSignature) return;
    this._menuSignature = signature;

    const actions = {
      'job-stop': item => () => {
        this.recorder.stop(item.recId).catch(e => {
          logger.error('[tray] Stopp fehlgeschlagen:', e.message);
          this._notify('Aufnahme konnte nicht gestoppt werden: ' + e.message);
        });
      },
      'open-planning': () => () => {
        this._showWindow();
        this.openPlanning();
      },
      'open-folder': () => () => {
        const root = this.getStorageRoot();
        if (root) shell.openPath(root).catch(() => {});
      },
      'open-app': () => () => this._showWindow(),
      'open-library': () => () => {
        this._showWindow();
        this.openLibrary();
      },
      'radio-pause': () => () => this._radioAction('pause'),
      'radio-resume': () => () => this._radioAction('resume'),
      'radio-play-last': () => () => this._radioAction('play'),
      'radio-stop': () => () => this._radioAction('stop'),
      'radio-next': () => () => this._radioAction('next'),
      'radio-prev': () => () => this._radioAction('prev'),
      'radio-favorite': item => () => this._radioAction('play', { sourceId: item.sourceId, stationId: item.stationId }),
      'radio-mute': () => () => this._toggleMute(),
      'radio-volume-up': () => () => this._stepVolume(VOLUME_STEP),
      'radio-volume-down': () => () => this._stepVolume(-VOLUME_STEP),
      'radio-open': () => () => {
        this._showWindow();
        if (this.openRadio) this.openRadio();
      },
      'podcast-pause': () => () => this._podcastAction('pause'),
      'podcast-resume': () => () => this._podcastAction('resume'),
      'podcast-stop': () => () => this._podcastAction('stop'),
      'podcast-skip-back': item => () => this._podcastAction('skip', item.value),
      'podcast-skip-forward': item => () => this._podcastAction('skip', item.value),
      'podcast-open': () => () => {
        this._showWindow();
        if (this.openPodcasts) this.openPodcasts();
      },
      'quit-confirm': () => () => this._quitWithConfirmation(),
      quit: () => () => app.quit(), // before-quit fragt bei Planung < 24 h (QuitCoordinator)
    };
    const toTemplate = item => {
      const click = actions[item.id] ? actions[item.id](item) : null;
      const template = { ...item };
      delete template.id; // nur Modell-Metadaten, kein Electron-Menüfeld
      delete template.recId;
      delete template.entryId;
      delete template.sourceId;
      delete template.stationId;
      delete template.value;
      delete template.logo;
      if (item.logo && this.logoCache) {
        const icon = this.logoCache.peek(item.logo);
        if (icon) template.icon = icon;
      }
      if (Array.isArray(item.submenu)) template.submenu = item.submenu.map(toTemplate);
      return click ? { ...template, click } : template;
    };
    const items = model.map(toTemplate);

    this._menuItems = items;
    for (const tray of this._trays()) this._applyMenu(tray);
  }

  _showWindow() {
    if (this.showWindow) {
      // main.js: zeigt das Fenster und erzeugt es nach „Fenster zu, App im Tray“ neu
      this.showWindow();
      return;
    }
    const win = this.getWindow();
    if (!win) {
      // Kein Fenster (window-all-closed): neu erzeugen wäre App-Logik — wir
      // benachrichtigen nur; der User startet die App neu oder klickt das
      // Dock/Taskbar-Icon. Bewusst minimal halten (SRP).
      this._notify('Streaming Hub läuft im Tray weiter.');
      return;
    }
    if (win.isMinimized()) win.restore();
    revealWindow(win, process.env);
  }

  /**
   * Beenden mit laufender Aufnahme: Bestätigungsdialog (Konzept §3.2
   * „Fenster schließen ≠ App beenden“ — dasselbe Schutz-Niveau für Quit).
   */
  _quitWithConfirmation() {
    if (!this._hasActiveRecordings()) {
      app.quit();
      return;
    }
    const win = this._liveWindow();
    const active = this.recorder.activeJobs().length;
    const choice = win
      ? dialog.showMessageBoxSync(win, {
          type: 'question',
          buttons: ['Aufnahmen stoppen und beenden', 'Im Tray weiterlaufen lassen', 'Abbrechen'],
          defaultId: 1,
          cancelId: 2,
          message: `Es ${active === 1 ? 'läuft eine Aufnahme' : `laufen ${active} Aufnahmen`} — wirklich beenden?`,
          detail: 'Laufende Aufnahmen werden beendet und konvertiert. Die App kann auch im Tray weiterlaufen.',
        })
      : 0;
    if (choice === 0) {
      // Planung < 24 h: erst deren Beenden-Dialog (QuitCoordinator) — „Im Hintergrund
      // behalten“ lässt die Aufnahmen weiterlaufen (nichts wurde gestoppt).
      Promise.resolve(this.confirmQuit ? this.confirmQuit() : true)
        .catch(() => true)
        .then(proceed => {
          if (proceed) this._stopAllAndQuit();
        });
    } else if (choice === 1) {
      // App bleibt im Tray — Fenster nur schließen.
      const w = this._liveWindow();
      if (w) w.hide();
    }
    // choice === 2: Abbruch
  }

  _stopAllAndQuit() {
    // Stoppt alle Aufnahmen (SIGINT-Grace), wartet TOLERANT auf die
    // nachlaufenden Remuxes (Karte t_695bf150): bis MAX_QUIT_REMUX_WAIT_MS
    // — ist der Remux fertig, landet die MP4 korrekt als completed; ist
    // er es nicht, schneidet der before-quit-Sweep (quitSweep) hart ab
    // und die Recovery holt ihn beim nächsten Start nach (remuxInterrupted).
    // Bewusst KEIN endloses Warten: Quit darf nicht blockieren (QA-Befund
    // t_695bf150), aber ein Remux einer 5-min-Aufnahme ist in Sekunden fertig.
    const jobs = this.recorder.activeJobs().map(j => j.meta.id);
    Promise.allSettled(jobs.map(id => this.recorder.stop(id))).then(() => {
      const start = Date.now();
      const tick = () => {
        if (this.recorder.remuxing.size === 0 || Date.now() - start >= MAX_QUIT_REMUX_WAIT_MS) {
          app.quit();
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }
}

module.exports = { TrayController };
