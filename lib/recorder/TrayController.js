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
//   „Aufnahmen-Ordner öffnen“, „App öffnen“, (bei laufender Aufnahme)
//   „Beenden …“ mit Bestätigung.
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

// Quit-Cleanup (Karte t_695bf150): max. Wartezeit auf nachlaufende Remuxes
// beim Beenden — darüber entscheidet der before-quit-Sweep hart (Recovery
// holt den Rest beim nächsten Start nach). 10 s reicht für stream-copy
// auch bei längeren Aufnahmen (MP4-Durchsatz ≫ Aufnahme-Dauer).
const MAX_QUIT_REMUX_WAIT_MS = 10000;

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
   * - getStorageRoot: () => string — aktueller Speicherort
   * - appRoot: App-Stamm (assets/tray/*.png, assets/icon.png-Fallback)
   */
  constructor({ recorder, getWindow, openLibrary, getStorageRoot, appRoot }) {
    if (!recorder) throw new Error('TrayController benötigt einen RecorderService');
    if (typeof getWindow !== 'function') throw new Error('TrayController benötigt getWindow()');
    this.recorder = recorder;
    this.getWindow = getWindow;
    this.openLibrary = typeof openLibrary === 'function' ? openLibrary : null;
    this.getStorageRoot = typeof getStorageRoot === 'function' ? getStorageRoot : null;
    this.appRoot = appRoot || __dirname;

    this.tray = null;
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
    this.tray.setToolTip('Streaming Hub');
    this.tray.on('click', () => this._showWindow());
    this._rebuildMenu();
    this._wireRecorderEvents();
    this._wirePowerMonitor();
  }

  destroy() {
    this._destroyed = true;
    this._stopElapsedTimer();
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

  _wirePowerMonitor() {
    // macOS: powerMonitor 'shutdown' feuert beim System-Shutdown — hier darf
    // ein (kurzer) Dialog gezeigt werden (Konzept §3.2). Linux: kein
    // 'shutdown'-Event → nur In-App-Warnung (User-Beschluss 30.09), kein Block.
    if (process.platform === 'darwin') {
      powerMonitor.on('shutdown', (event) => {
        if (!this._hasActiveRecordings()) return; // kein Grund einzugreifen
        event.preventDefault();
        const win = this.getWindow();
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
    const win = this.getWindow();
    try {
      win?.webContents?.send('recording:shutdown-warning', {
        message: 'Der Computer wird heruntergefahren — laufende Aufnahmen werden beendet.',
      });
    } catch (_) {
      // Fenster zwischendurch weg — Tray-Notification ist schon raus
    }
  }

  _notify(message) {
    try {
      if (Notification.isSupported()) {
        new Notification({ title: 'Streaming Hub — Aufnahme', body: message }).show();
      }
    } catch (_) {
      // Notifications nicht verfügbar (z. B. kein Notifizierungsdienst)
    }
  }

  // ── Icons ──

  _iconPath(kind) {
    // Vom Build-Skript erzeugte PNGs (scripts/generate-tray-icons.js →
    // assets/tray/tray-idle.png, tray-rec.png). Fallback: App-Icon.
    return kind === 'rec'
      ? path.join(this.appRoot, 'assets', 'tray', 'tray-rec.png')
      : path.join(this.appRoot, 'assets', 'tray', 'tray-idle.png');
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

  // ── Zustand ──

  _hasActiveRecordings() {
    return this.recorder.activeJobs().length > 0;
  }

  refresh() {
    if (this._destroyed || !this.tray) return;
    const active = this.recorder.activeJobs().length;
    const wasActive = this._activeCount;
    this._activeCount = active;
    try {
      this.tray.setImage(active > 0 ? this._recIcon() : this._idleIcon());
      this.tray.setToolTip(
        active > 0 ? `Streaming Hub — ${active} Aufnahme${active === 1 ? '' : 'n'} laufen` : 'Streaming Hub',
      );
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

  _rebuildMenu() {
    if (this._destroyed || !this.tray) return;
    const items = [];

    const jobs = this.recorder.activeJobs();
    for (const job of jobs) {
      const meta = job.meta;
      const label =
        `● ${meta.channelName || meta.channelId || 'Kanal'}` +
        `${meta.epgTitle ? ' — ' + meta.epgTitle : ''}` +
        ` · ${formatDuration(job.getRecordingSec())}`;
      items.push({
        label,
        enabled: false, // reine Statuszeile
      });
      items.push({
        label: '  ⏹ Aufnahme stoppen',
        click: () => {
          this.recorder.stop(meta.id).catch(e => {
            logger.error('[tray] Stopp fehlgeschlagen:', e.message);
            this._notify('Aufnahme konnte nicht gestoppt werden: ' + e.message);
          });
        },
      });
    }
    if (jobs.length) items.push({ type: 'separator' });

    if (this.getStorageRoot) {
      items.push({
        label: 'Aufnahmen-Ordner öffnen',
        click: () => {
          const root = this.getStorageRoot();
          if (root) shell.openPath(root).catch(() => {});
        },
      });
    }
    items.push({
      label: 'App öffnen',
      click: () => this._showWindow(),
    });
    if (this.openLibrary) {
      items.push({
        label: 'Aufnahmen-Bibliothek',
        click: () => {
          this._showWindow();
          this.openLibrary();
        },
      });
    }
    if (jobs.length) {
      items.push({ type: 'separator' });
      items.push({
        label: 'Beenden …',
        click: () => this._quitWithConfirmation(),
      });
    } else {
      items.push({ type: 'separator' });
      items.push({
        label: 'Beenden',
        click: () => app.quit(),
      });
    }

    try {
      this.tray.setContextMenu(Menu.buildFromTemplate(items));
    } catch (e) {
      logger.error('[tray] Menü konnte nicht gebaut werden:', e.message);
    }
  }

  _showWindow() {
    const win = this.getWindow();
    if (!win) {
      // Kein Fenster (window-all-closed): neu erzeugen wäre App-Logik — wir
      // benachrichtigen nur; der User startet die App neu oder klickt das
      // Dock/Taskbar-Icon. Bewusst minimal halten (SRP).
      this._notify('Streaming Hub läuft im Tray weiter.');
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
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
    const win = this.getWindow();
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
      // Stoppt alle Aufnahmen (SIGINT-Grace), wartet TOLERANT auf die
      // nachlaufenden Remuxes (Karte t_695bf150): bis MAX_QUIT_REMUX_WAIT_MS
      // — ist der Remux fertig, landet die MP4 korrekt als completed; ist
      // er es nicht, schneidet der before-quit-Sweep (quitSweep) hart ab
      // und die Recovery holt ihn beim nächsten Start nach (remuxInterrupted).
      // Bewusst KEIN endloses Warten: Quit darf nicht blockieren (QA-Befund
      // t_695bf150), aber ein Remux einer 5-min-Aufnahme ist in Sekunden fertig.
      const jobs = this.recorder.activeJobs().map(j => j.meta.id);
      Promise.allSettled(jobs.map(id => this.recorder.stop(id)))
        .then(() => {
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
    } else if (choice === 1) {
      // App bleibt im Tray — Fenster nur schließen.
      const w = this.getWindow();
      if (w) w.hide();
    }
    // choice === 2: Abbruch
  }
}

module.exports = { TrayController };
