// Notifier: gemeinsame, testbare Benachrichtigungs-Abstraktion für Tray und
// Planung (Etappe 2b). Bisher riefen TrayController und main.js (Schedule) die
// Electron-Notification getrennt auf. Jetzt läuft alles hier durch:
// - Text wird bereinigt (Steuerzeichen raus, gekürzt) — Titel/Sendernamen sind Fremdtext,
// - fehlende Notification-Unterstützung oder ein Fehler beim Anzeigen ist nie fatal.

'use strict';

const { sanitizeLabel } = require('./schedule-ui-model.js');

const BODY_MAX = 300;

/**
 * NotificationClass: Electron-`Notification` (oder Test-Fake mit
 * `static isSupported()` und `new X({title, body}).show()`).
 */
function createNotifier({ NotificationClass, logger = null } = {}) {
  function notify(title, body) {
    try {
      if (!NotificationClass || (typeof NotificationClass.isSupported === 'function' && !NotificationClass.isSupported())) {
        return false;
      }
      new NotificationClass({ title: sanitizeLabel(title, 80), body: sanitizeLabel(body, BODY_MAX) }).show();
      return true;
    } catch (e) {
      // Kein Notifizierungsdienst (z. B. Linux ohne Daemon) — die Meldung steht auch in der Planungsliste
      if (logger && typeof logger.warn === 'function') logger.warn(`[notify] nicht angezeigt: ${e.message}`);
      return false;
    }
  }
  return { notify };
}

module.exports = { createNotifier, BODY_MAX };
