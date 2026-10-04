// QuitCoordinator: Beenden-Dialog bei anstehender Planung (Etappe 2b; Konzept §3.5)
//
// Verdrahtung in main.js:
//   mainWindow 'close'  → handleWindowClose(event, win)   (Fenster-X)
//   app 'before-quit'   → handleBeforeQuit(event)         (Cmd+Q, Dock, Tray-„Beenden“, app.quit())
//
// Der Dialog (nur bei Planung in den nächsten 24 h, Entscheidungslogik in
// quit-guard.js) fragt asynchron — der Main-Prozess (Scheduler, Tray) wird nicht
// blockiert. Wahl:
//   „Im Hintergrund behalten“ → Fenster wird geschlossen, die App bleibt im Tray
//                               (window-all-closed hält sie wegen der Planung am Leben)
//   „Trotzdem beenden“        → app.quit() mit normalem Cleanup (before-quit/quitSweep)
//
// Nicht blockieren darf der Dialog:
//   - Updater-Relaunch (allowQuit('updater')),
//   - System-Shutdown/Neustart (markSystemShutdown(), kurzlebig: der macOS-Dialog des
//     TrayController kann „Abbrechen“ liefern, dann darf das Flag nicht ewig gelten),
//   - Quits, die der User schon bestätigt hat (confirmed: nach „Trotzdem beenden“ oder
//     über confirmQuit() des Tray-Beenden-Dialogs).
// Kein doppelter Dialog: solange einer offen ist, werden weitere Auslöser (Fenster-X
// und anschließend Quit, doppeltes Cmd+Q) verschluckt.
//
// Fällt der Dialog selbst aus (Exception), wird NICHT blockiert: der Auslöser läuft
// durch — die App darf nie unbeendbar werden.

'use strict';

const { buildQuitPrompt, choiceFromResponse } = require('./quit-guard.js');

const SYSTEM_SHUTDOWN_TTL_MS = 60 * 1000;

class QuitCoordinator {
  /**
   * options:
   * - app: { quit() }
   * - askDialog(win|null, options) → Promise<{ response }>   (nativer Dialog / Test-Hook)
   * - getEntries() → Planungseinträge, getActiveCount() → laufende Aufnahmen
   * - getWindow() → Hauptfenster|null (Elternfenster des Dialogs, wird bei „behalten“ geschlossen)
   * - now(), logger
   */
  constructor({ app, askDialog, getEntries, getActiveCount = () => 0, getWindow = () => null, now = () => Date.now(), logger = null } = {}) {
    if (!app || typeof app.quit !== 'function') throw new Error('QuitCoordinator benötigt app.quit()');
    if (typeof askDialog !== 'function') throw new Error('QuitCoordinator benötigt askDialog()');
    if (typeof getEntries !== 'function') throw new Error('QuitCoordinator benötigt getEntries()');
    this.app = app;
    this.askDialog = askDialog;
    this.getEntries = getEntries;
    this.getActiveCount = getActiveCount;
    this.getWindow = getWindow;
    this.now = now;
    this.logger = logger;
    this.quitting = false; // before-quit ist durchgelaufen: Fenster dürfen schließen
    this.confirmed = false; // User hat das Beenden bestätigt
    this.allowed = false; // Updater-Relaunch o. ä.
    this._systemUntil = 0;
    this._asking = null;
    this._bypassClose = new WeakSet();
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[quit] ${message}`);
  }

  /** Updater-/Relaunch-Quit: nie fragen. */
  allowQuit(reason = 'intern') {
    this.allowed = true;
    this._log('info', `Beenden ohne Rückfrage freigegeben (${reason})`);
  }

  /** powerMonitor 'shutdown': System fährt herunter, der Dialog darf nicht dazwischenfunken. */
  markSystemShutdown() {
    this._systemUntil = this.now() + SYSTEM_SHUTDOWN_TTL_MS;
  }

  _systemActive() {
    return this.now() < this._systemUntil;
  }

  _bypassed() {
    return this.quitting || this.confirmed || this.allowed || this._systemActive();
  }

  currentPrompt() {
    try {
      return buildQuitPrompt({ entries: this.getEntries(), nowMs: this.now(), activeRecordings: this.getActiveCount() });
    } catch (e) {
      this._log('warn', `Planung nicht lesbar (kein Dialog): ${e.message}`);
      return null;
    }
  }

  /**
   * before-quit. Rückgabe true = abgefangen (Dialog läuft, Quit abgebrochen) —
   * main.js macht dann KEIN Cleanup. false = Quit läuft durch.
   */
  handleBeforeQuit(event) {
    if (this._bypassed()) {
      this.quitting = true;
      return false;
    }
    if (this._asking) {
      event.preventDefault(); // Dialog offen: weiteren Quit-Versuch verschlucken
      return true;
    }
    const prompt = this.currentPrompt();
    if (!prompt) {
      this.quitting = true;
      return false;
    }
    event.preventDefault();
    this._ask(prompt, null, 'quit');
    return true;
  }

  /** Fenster-X. Rückgabe true = Schließen verhindert (Dialog läuft). */
  handleWindowClose(event, win) {
    if (this._bypassClose.has(win)) {
      this._bypassClose.delete(win);
      return false;
    }
    if (this._bypassed()) return false;
    if (this._asking) {
      event.preventDefault();
      return true;
    }
    const prompt = this.currentPrompt();
    if (!prompt) return false;
    event.preventDefault();
    this._ask(prompt, win, 'window');
    return true;
  }

  /**
   * Für Quit-Wege mit eigener Bestätigung (Tray „Beenden …“ bei laufender Aufnahme):
   * true = weitermachen (keine Planung oder „Trotzdem beenden“; der folgende
   * app.quit() fragt dann nicht noch einmal), false = der User behält die App.
   */
  async confirmQuit(win = null) {
    if (this._bypassed()) return true;
    const prompt = this.currentPrompt();
    if (!prompt) return true;
    if (this._asking) return false;
    const choice = await this._dialog(prompt, win);
    if (choice === 'quit') {
      this.confirmed = true;
      return true;
    }
    this._closeWindow(win || this.getWindow());
    return false;
  }

  async _dialog(prompt, win) {
    const pending = (async () => {
      try {
        const result = await this.askDialog(win && !isDestroyed(win) ? win : null, prompt.options);
        return choiceFromResponse(result && result.response);
      } catch (e) {
        this._log('warn', `Dialog fehlgeschlagen — Beenden wird nicht blockiert: ${e.message}`);
        return 'quit';
      }
    })();
    this._asking = pending;
    try {
      return await pending;
    } finally {
      this._asking = null;
    }
  }

  async _ask(prompt, win, source) {
    const choice = await this._dialog(prompt, win);
    if (choice === 'quit') {
      this.confirmed = true;
      this.app.quit();
      return;
    }
    this._log('info', 'Beenden verschoben: App läuft im Tray weiter (Planung)');
    // Fenster-X: genau dieses Fenster; Quit: das Hauptfenster (die App bleibt im Tray)
    this._closeWindow(source === 'quit' ? this.getWindow() : win);
  }

  _closeWindow(win) {
    if (win && !isDestroyed(win)) {
      this._bypassClose.add(win);
      try {
        win.close();
      } catch (_) {
        // Fenster zwischendurch weg
      }
    }
  }
}

function isDestroyed(win) {
  try {
    return typeof win.isDestroyed === 'function' && win.isDestroyed();
  } catch (_) {
    return true;
  }
}

module.exports = { QuitCoordinator, SYSTEM_SHUTDOWN_TTL_MS };
