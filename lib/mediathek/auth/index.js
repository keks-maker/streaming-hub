'use strict';

// Konten der Mediatheken (experimentell): Anmeldung beim Anbieter im eigenen Fenster (login-window.js), Token nur verschlüsselt
// (store.js), Auffrischung vor Ablauf, Kopfzeilen für Abrufe an die Hosts des jeweiligen Senders (getAuthHeaders) und Status für
// die Einstellungen. Das Passwort sieht diese App nie. Status, Fehler und Logs enthalten keine Token oder Adressen mit Token.
// ZDF ist bewusst nicht umgesetzt (Freigabe je Video, Spike): Status 'unsupported'.

const { EventEmitter } = require('node:events');
const { httpsHost } = require('./util.js');

const REFRESH_MARGIN_MS = 2 * 60 * 1000; // vor Ablauf auffrischen
const SENDER_ORDER = ['arte', 'ard', 'zdf'];
const SENDER_NAMES = { arte: 'arte', ard: 'ARD', zdf: 'ZDF' };

/**
 * options: providers ({ ard, arte }), store (createAuthStore), loginRunner ({ run }), clearPartition(partition) -> Promise,
 * http ({ getText(url, { auth }) }, für "Freischaltung testen"; optional, auch per setHttp), now, logger.
 */
function createMediathekAuth({ providers, store, loginRunner, clearPartition = async () => {}, http: initialHttp = null, now = Date.now, logger = null }) {
  let http = initialHttp; // wird nachgereicht (setHttp): der HTTP-Client braucht dieses Modul, der Test den HTTP-Client
  const events = new EventEmitter();
  const refreshing = new Map(); // sender -> Promise (parallele Abrufe teilen sich eine Auffrischung)

  const log = message => {
    if (logger) logger.warn(message);
  };
  const changed = () => events.emit('changed', status());

  function isSupported(sender) {
    return Boolean(providers[sender]);
  }

  function stateOf(sender) {
    if (!isSupported(sender)) return 'unsupported';
    const record = store.get(sender);
    if (!record) return 'signedOut';
    return record.state === 'expired' ? 'expired' : 'signedIn';
  }

  /** Status je Sender für die Oberfläche: nie Token, nur Zustand und Zeitpunkt. */
  function status() {
    return {
      persistent: store.persistent,
      accounts: SENDER_ORDER.map(sender => {
        const record = store.get(sender);
        const state = stateOf(sender);
        return { sender, name: SENDER_NAMES[sender], experimental: true, state, since: record && record.state !== 'expired' ? record.since : null, refreshFailed: state === 'signedIn' && !tokenUsable(sender) };
      }),
    };
  }

  function isSignedIn(sender) {
    return stateOf(sender) === 'signedIn';
  }

  /** true, wenn angemeldet und der Token noch nicht abgelaufen ist (nach fehlgeschlagener Auffrischung per Netz: false). */
  function tokenUsable(sender) {
    const record = isSignedIn(sender) ? store.get(sender) : null;
    return Boolean(record) && record.expiresAt > now();
  }

  /** Setzt den Konto-Status auf "abgelaufen" (Token verworfen, Anmeldung nötig). */
  function markExpired(sender) {
    const record = store.get(sender);
    if (!record || record.state === 'expired') return;
    store.set(sender, { ...record, state: 'expired', refreshToken: null });
    changed();
  }

  /** Meldet 401 des Anbieters: der Token wurde abgelehnt. */
  function reportUnauthorized(sender) {
    markExpired(sender);
  }

  async function doRefresh(sender) {
    const provider = providers[sender];
    const record = store.get(sender);
    try {
      const next = await provider.refresh(record);
      store.set(sender, { ...next, since: record.since });
    } catch (error) {
      if (error && (error.code === 'rejected' || error.code === 'invalid-json')) {
        markExpired(sender);
        return false;
      }
      log(`Mediathek-Konto (${sender}): Token konnte nicht aufgefrischt werden (${(error && error.code) || 'fehler'}).`);
      return false; // Netzproblem: Status bleibt, nächster Abruf versucht es erneut
    }
    return true;
  }

  /** Frischt den Token bei Bedarf (oder mit force) auf. Ergebnis: true, wenn danach ein gültiger Token vorliegt. */
  async function ensureFresh(sender, { force = false } = {}) {
    if (!isSignedIn(sender)) return false;
    const record = store.get(sender);
    if (!force && record.expiresAt - now() > REFRESH_MARGIN_MS) return true;
    if (!refreshing.has(sender)) {
      refreshing.set(
        sender,
        doRefresh(sender).finally(() => refreshing.delete(sender))
      );
    }
    await refreshing.get(sender);
    const after = store.get(sender);
    return Boolean(after) && after.state === 'ok' && after.expiresAt > now();
  }

  /**
   * Kopfzeilen für einen Abruf: nur wenn angemeldet, der Token nicht abgelaufen ist und die Adresse (https) exakt zu einem Host des
   * Senders gehört. Wird je Weiterleitungsschritt aufgerufen, damit der Token nie an Weiterleitungsziele fremder Hosts geht.
   */
  function getAuthHeaders(sender, url) {
    const provider = providers[sender];
    if (!provider || !isSignedIn(sender)) return {};
    const host = httpsHost(url);
    if (!host || !provider.tokenHosts.includes(host)) return {};
    const record = store.get(sender);
    if (record.expiresAt <= now()) return {};
    return provider.headers(record);
  }

  /** Adresse für einen personalisierten Abruf (ARD: ?userId=); ohne Konto/Anbieter-Regel unverändert. */
  function personalizeUrl(sender, url) {
    const provider = providers[sender];
    if (!provider || typeof provider.personalizeUrl !== 'function' || !isSignedIn(sender)) return url;
    return provider.personalizeUrl(url, store.get(sender));
  }

  async function login(sender) {
    const provider = providers[sender];
    if (!provider) return { ok: false, code: 'unsupported', message: `${SENDER_NAMES[sender] || 'Dieser Sender'}: noch nicht unterstützt.` };
    const result = await loginRunner.run(provider);
    if (!result.ok) {
      const messages = { cancelled: 'Anmeldung abgebrochen.', timeout: 'Anmeldung nicht abgeschlossen (Zeit abgelaufen).', busy: 'Es läuft bereits eine Anmeldung.' };
      return { ok: false, code: result.code, message: messages[result.code] || 'Anmeldung nicht möglich.' };
    }
    store.set(sender, result.record);
    changed();
    events.emit('signedIn', sender);
    return { ok: true, status: status() };
  }

  async function logout(sender) {
    const provider = providers[sender];
    if (!provider) return { ok: true, status: status() };
    store.remove(sender);
    try {
      await clearPartition(provider.partition);
    } catch {
      log(`Mediathek-Konto (${sender}): Sitzungsdaten konnten nicht vollständig gelöscht werden.`);
    }
    changed();
    return { ok: true, status: status() };
  }

  /**
   * "Freischaltung testen": prüft die Token-Gültigkeit (Auffrischung erzwingen; ARD zusätzlich ein personalisierter Abruf). Löst
   * keinen FSK-Beitrag auf, weil kein dauerhaft gesperrter Testeintrag bekannt ist.
   */
  async function test(sender) {
    const provider = providers[sender];
    if (!provider) return { ok: false, code: 'unsupported', message: `${SENDER_NAMES[sender] || 'Dieser Sender'}: noch nicht unterstützt.` };
    const state = stateOf(sender);
    if (state === 'signedOut') return { ok: false, code: 'signedOut', message: 'Nicht angemeldet.' };
    if (state === 'expired') return { ok: false, code: 'expired', message: 'Anmeldung abgelaufen. Bitte neu anmelden.' };
    const valid = await ensureFresh(sender, { force: true });
    if (!valid) {
      return isSignedIn(sender) ? { ok: false, code: 'network', message: 'Anbieter nicht erreichbar. Bitte später erneut versuchen.' } : { ok: false, code: 'expired', message: 'Anmeldung abgelaufen. Bitte neu anmelden.' };
    }
    if (provider.validateUrl && http) {
      try {
        await http.getText(provider.validateUrl, { auth: sender });
      } catch (error) {
        if (error && error.status === 401) return { ok: false, code: 'expired', message: 'Der Anbieter hat die Anmeldung abgelehnt. Bitte neu anmelden.' };
        return { ok: false, code: 'network', message: 'Anbieter nicht erreichbar. Bitte später erneut versuchen.' };
      }
    }
    return { ok: true, code: 'valid', message: 'Anmeldung gültig. Ob ein gesperrter Beitrag freigeschaltet wird, zeigt sich erst beim Abruf eines solchen Beitrags.' };
  }

  return {
    status,
    isSignedIn,
    isSupported,
    accountState: stateOf,
    tokenUsable,
    setHttp: value => {
      http = value;
    },
    ensureFresh,
    getAuthHeaders,
    personalizeUrl,
    reportUnauthorized,
    login,
    logout,
    test,
    on: (event, listener) => events.on(event, listener),
  };
}

module.exports = { createMediathekAuth, SENDER_NAMES };
