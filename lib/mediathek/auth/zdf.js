'use strict';

// ZDF-Konto ("Mein ZDF", auch mit ARD-Konto nutzbar). Kein OIDC: die Web-App spricht api.zdf.de/identity und hält den Sitzungstoken
// im Zustandsspeicher "local-user-data" (localStorage, Feld state.sessionToken; älter: zdf_user_token). Wir lesen ihn nach der
// Anmeldung im Anbieter-Fenster nur lesend aus und prüfen ihn per GET /identity/userinfo. Der Client kennt keinen Refresh: die
// "Auffrischung" ist eine Gültigkeitsprüfung derselben Sitzung (401/403 = abgelaufen, dann neu anmelden). Der Token geht ausschließlich
// an api.zdf.de unter /identity/ (Altersfreigabe und PIN prüfen); Streams holt die Web-App ohne Nutzertoken. Das Passwort sieht diese
// App nie. Nur mit echtem Konto prüfbar.

const { httpsHost, hostMatches, jwtExpiryMs } = require('./util.js');

const ZDF_ACCEPT = 'application/vnd.de.zdf.v1.0+json';
const IDENTITY_URL = 'https://api.zdf.de/identity';
const USERINFO_URL = `${IDENTITY_URL}/userinfo`;
const SESSION_MS = 12 * 60 * 60 * 1000; // Token ohne lesbares Ablaufdatum: alle 12 Stunden erneut prüfen
const TOKEN_PATTERN = /^[\x21-\x7e]{8,4096}$/;

/** Skript für die zdf.de-Seite: JSON { store, legacy } mit den Rohwerten (nichts wird verändert). */
const READ_SCRIPT = `(() => {
  const read = key => { try { return window.localStorage.getItem(key); } catch (error) { return null; } };
  return JSON.stringify({ store: read('local-user-data'), legacy: read('zdf_user_token') });
})()`;

/** Token aus den Rohwerten: Zustandsspeicher (zustand/persist: { state: { sessionToken } }) vor dem alten Schlüssel; sonst null. */
function parseSessionToken(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const valid = value => (typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null);
  if (typeof raw.store === 'string') {
    try {
      const parsed = JSON.parse(raw.store);
      const state = parsed && typeof parsed === 'object' ? parsed.state || parsed : null;
      const token = state && valid(state.sessionToken);
      if (token) return token;
    } catch {
      // unlesbarer Speicher: alten Schlüssel versuchen
    }
  }
  if (typeof raw.legacy === 'string') {
    let legacy = raw.legacy;
    if (legacy.startsWith('"')) {
      try {
        legacy = JSON.parse(legacy);
      } catch {
        return null;
      }
    }
    return valid(legacy);
  }
  return null;
}

const rejected = () => Object.assign(new Error('Anbieter hat die Anfrage abgelehnt'), { code: 'rejected' });
const bearer = token => ({ Authorization: `Bearer ${token}`, Accept: ZDF_ACCEPT });

function createZdfProvider({ net, now = Date.now }) {
  const expiryOf = token => jwtExpiryMs(token) || now() + SESSION_MS;
  return {
    sender: 'zdf',
    name: 'ZDF',
    partition: 'persist:mediathek-zdf',
    /** Nur an diese Hosts und Pfade geht der Token (exakter Host, https, nur /identity/). */
    tokenHosts: ['api.zdf.de'],
    tokenPathPrefix: '/identity/',
    login: {
      startUrl: 'https://www.zdf.de/mein-zdf',
      isAllowedHost: host => ['zdf.de', 'ard.de', 'ard-zdf.de'].some(suffix => hostMatches(host, suffix)),
      isCollectPage: host => host === 'www.zdf.de',
    },
    /** Liest und prüft die Sitzung aus der Anbieter-Seite; null, solange nicht angemeldet (anonym oder Token abgelehnt). */
    async collect(page) {
      if (httpsHost(page.url) !== 'www.zdf.de') return null;
      const token = parseSessionToken(await page.executeJavaScript(READ_SCRIPT));
      if (!token) return null;
      const answer = await net.request('GET', USERINFO_URL, { headers: bearer(token) });
      if (answer.status === 401 || answer.status === 403) return null;
      if (answer.status !== 200) throw Object.assign(new Error('Anbieter nicht erreichbar'), { code: 'http', status: answer.status });
      return { accessToken: token, refreshToken: null, expiresAt: expiryOf(token), since: now(), state: 'ok', clientId: null };
    },
    /** Kein Refresh im Client: dieselbe Sitzung erneut prüfen (200 -> weitere 12 Stunden, 401/403 -> abgelehnt). */
    async refresh(record) {
      const answer = await net.request('GET', USERINFO_URL, { headers: bearer(record.accessToken) });
      if (answer.status === 401 || answer.status === 403) throw rejected();
      if (answer.status !== 200) throw Object.assign(new Error('Anbieter nicht erreichbar'), { code: 'http', status: answer.status });
      return { ...record, expiresAt: expiryOf(record.accessToken), state: 'ok' };
    },
    headers: record => bearer(record.accessToken),
    validateUrl: USERINFO_URL,
    validateAccept: ZDF_ACCEPT,
  };
}

module.exports = { createZdfProvider, parseSessionToken, ZDF_ACCEPT, IDENTITY_URL, USERINFO_URL, READ_SCRIPT };
