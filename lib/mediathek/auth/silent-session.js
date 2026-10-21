'use strict';

// Unsichtbare Wiederherstellung der Web-Sitzung (arte): Verwirft der Anbieter den gespeicherten Refresh-Token, lädt ein nie
// angezeigtes, gehärtetes Fenster (gleiche Partition, Allowlist und Berechtigungs-Sperre wie das Anmeldefenster, ohne Node und
// Preload) die Startseite des Anbieters. Dessen Web-App meldet sich per Keycloak-Cookie still neu an (oidc-client-ts, userStore
// sessionStorage); sobald provider.collect einen frischen Datensatz liefert, wird er übernommen und das Fenster geschlossen.
// Nur bei Bedarf, nie sichtbar, höchstens ein Fenster gleichzeitig, Zeitlimit ~10 s. Passwort und Token verlassen den Anbieter-Kontext nicht.

const { httpsHost } = require('./util.js');

const TIMEOUT_MS = 10000;
const POLL_MS = 500;
const MIN_VALID_MS = 60 * 1000; // so lange muss der gelesene Token mindestens noch gelten ("frisch")

/**
 * options: openProviderWindow(provider, title, { silent }) aus createLoginRunner, logger, now, timeoutMs, pollMs.
 * Ergebnis: { run(provider) -> Promise<Datensatz|null> }; null = keine gültige Sitzung gefunden (Anmeldung nötig).
 * Wirft nur, wenn das Fenster nicht geöffnet werden kann.
 */
function createSilentSessionRunner({ openProviderWindow, logger = null, now = Date.now, timeoutMs = TIMEOUT_MS, pollMs = POLL_MS }) {
  const running = new Map(); // sender -> Promise (höchstens ein Fenster je Anbieter)

  async function open(provider) {
    const { win, contents } = openProviderWindow(provider, `Sitzung: ${provider.name}`, { silent: true });
    const close = () => {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        // schon geschlossen
      }
      try {
        if (contents && typeof contents.close === 'function' && !contents.isDestroyed()) contents.close();
      } catch {
        // schon geschlossen
      }
    };
    const startedAt = now();
    contents.loadURL(provider.login.startUrl).catch(() => {}); // Ladefehler: die Schleife läuft bis zum Zeitlimit
    try {
      while (now() - startedAt < timeoutMs) {
        await new Promise(done => setTimeout(done, pollMs));
        if (win.isDestroyed()) return null;
        const url = contents.getURL();
        const host = httpsHost(url);
        if (!host || !provider.login.isCollectPage(host)) continue;
        let record = null;
        try {
          record = await provider.collect({ url, executeJavaScript: code => contents.executeJavaScript(code, true) });
        } catch (error) {
          if (logger) logger.warn(`Mediathek-Sitzung (${provider.sender}): noch nicht lesbar (${(error && error.code) || 'fehler'}).`);
        }
        if (record && record.expiresAt - now() > MIN_VALID_MS) return record;
      }
      return null;
    } finally {
      close();
    }
  }

  return {
    run(provider) {
      if (!running.has(provider.sender)) running.set(provider.sender, open(provider).finally(() => running.delete(provider.sender)));
      return running.get(provider.sender);
    },
  };
}

module.exports = { createSilentSessionRunner, TIMEOUT_MS, MIN_VALID_MS };
