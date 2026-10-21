'use strict';

// arte (MeinARTE, Keycloak-Realm myarte-prod). Die Web-App nutzt oidc-client-ts: der angemeldete Nutzer liegt nach dem Login im
// localStorage der arte.tv-Seite unter "oidc.user:<Realm>:<client_id>" (access_token, refresh_token, expires_at). Wir lesen ihn aus
// der Login-Partition (Skript im Anbieter-Kontext, nur lesend) und erneuern den Token selbst am öffentlichen Token-Endpunkt des
// Web-Clients (kein Secret, nur refresh_token + client_id "replay", scope openid, redirect_uri wie die Web-App). Belegt aus den
// öffentlichen Bundles: oidc-client-ts, userStore = sessionStorage (der Nutzer liegt NICHT dauerhaft im localStorage), Access-Token
// kurzlebig, Web-Client sendet "Authorization: Bearer <access_token>" an api.arte.tv. Verwirft Keycloak den Refresh-Token (invalid_grant,
// z. B. rotiert durch die Seite oder SSO-Sitzung abgelaufen), holt ein unsichtbares Fenster auf der persistenten Partition die
// Sitzung der Seite (deren Silent-Sign-in per Keycloak-Cookie) neu (silentRecover). Das Passwort sieht diese App nie.

const { httpsHost, hostMatches, expiryFromSeconds, jwtExpiryMs } = require('./util.js');

const REALM = 'https://id.arte.tv/auth/realms/myarte-prod';
const TOKEN_ENDPOINT = `${REALM}/protocol/openid-connect/token`;
const KEY_PREFIX = `oidc.user:${REALM}:`;
const REDIRECT_URI = 'https://www.arte.tv/de/profile/auth/callback'; // callbackUrl der Web-App (redirect_uri des Clients "replay")
const SCOPE = 'openid';
const ME_URL = 'https://api.arte.tv/api/sso/v3/me'; // Nutzerdaten der Web-App (Bearer = access_token, Kopfzeile client: web)

/**
 * Alters-Token aus der Antwort von /api/sso/v3/me ({ data: [{ ageVerificationToken, over16, over18 }] }) oder null. Der Web-Player
 * sendet an player/v2/config NICHT den Bearer-Token, sondern nur "X-Validated-Age: <ageVerificationToken>".
 */
function parseAgeToken(body) {
  try {
    const user = JSON.parse(body).data[0];
    return user && typeof user.ageVerificationToken === 'string' && user.ageVerificationToken ? user.ageVerificationToken : null;
  } catch {
    return null;
  }
}

/** Skript für die arte.tv-Seite: liefert JSON [{ key, value }] der oidc.user-Einträge (nichts wird verändert). */
const READ_SCRIPT = `(() => {
  const found = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key && key.startsWith(${JSON.stringify(KEY_PREFIX)})) found.push({ key, value: store.getItem(key) });
    }
  }
  return JSON.stringify(found);
})()`;

/**
 * Wählt aus den gelesenen Einträgen den angemeldeten Nutzer: Eintrag mit access_token UND refresh_token (anonyme Sitzungen der
 * Web-App haben keinen), späterer Ablauf zuerst. Ergebnis: Kontodatensatz oder null.
 */
function parseOidcEntries(json, nowMs) {
  let entries;
  try {
    entries = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const records = [];
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith(KEY_PREFIX) || typeof entry.value !== 'string') continue;
    const clientId = entry.key.slice(KEY_PREFIX.length);
    let user;
    try {
      user = JSON.parse(entry.value);
    } catch {
      continue;
    }
    if (!user || typeof user.access_token !== 'string' || !user.access_token || typeof user.refresh_token !== 'string' || !user.refresh_token || !clientId) continue;
    const expiresAt = Number.isFinite(user.expires_at) ? user.expires_at * 1000 : jwtExpiryMs(user.access_token) || expiryFromSeconds(null, nowMs);
    records.push({ accessToken: user.access_token, refreshToken: user.refresh_token, expiresAt, since: nowMs, state: 'ok', clientId });
  }
  records.sort((a, b) => b.expiresAt - a.expiresAt);
  return records[0] || null;
}

function createArteProvider({ net, now = Date.now }) {
  return {
    sender: 'arte',
    name: 'arte',
    partition: 'persist:mediathek-arte',
    /** Nur an diese Hosts geht der Token (exakter Vergleich, https). */
    tokenHosts: ['api.arte.tv'],
    login: {
      startUrl: 'https://www.arte.tv/de/',
      isAllowedHost: host => hostMatches(host, 'arte.tv'),
      isCollectPage: host => host === 'www.arte.tv',
    },
    /** Liest den Nutzer aus der Anbieter-Seite (page = { url, executeJavaScript }); null, solange nicht angemeldet. */
    async collect(page) {
      if (httpsHost(page.url) !== 'www.arte.tv') return null;
      const json = await page.executeJavaScript(READ_SCRIPT);
      return parseOidcEntries(json, now());
    },
    async refresh(record) {
      if (!record.refreshToken || !record.clientId) throw Object.assign(new Error('Anmeldung abgelaufen'), { code: 'rejected' });
      const answer = await net.postForm(TOKEN_ENDPOINT, { grant_type: 'refresh_token', refresh_token: record.refreshToken, scope: SCOPE, redirect_uri: REDIRECT_URI, client_id: record.clientId });
      if (!answer || typeof answer.access_token !== 'string' || !answer.access_token) throw Object.assign(new Error('Anbieter hat die Anfrage abgelehnt'), { code: 'rejected' });
      return {
        ...record,
        accessToken: answer.access_token,
        refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : record.refreshToken,
        expiresAt: expiryFromSeconds(answer.expires_in, now()),
        state: 'ok',
      };
    },
    headers: record => ({ Authorization: `Bearer ${record.accessToken}` }),
    /**
     * Abrufoptionen für FSK-Beiträge (wie der Web-Player): zuerst /me mit dem Bearer-Token, dann geht der Player-Abruf OHNE
     * Authorization, nur mit "X-Validated-Age". Ohne Alters-Token (Alter nicht verifiziert) bleibt der Abruf ohne die Kopfzeile.
     */
    async requestOptions(http) {
      const body = await http.getText(ME_URL, { auth: 'arte', hostHeaders: { 'api.arte.tv': { client: 'web' } } });
      const token = parseAgeToken(body);
      return { hostHeaders: { 'api.arte.tv': token ? { 'X-Validated-Age': token } : {} } };
    },
    /** Unsichtbares Fenster darf die Sitzung der Seite neu lesen, wenn der Refresh-Token verworfen wurde (auth/silent-session.js). */
    silentRecover: true,
    /** Ein 401 der API erzwingt zuerst eine Auffrischung/Wiederherstellung; "abgelaufen" erst, wenn auch die scheitert. */
    softUnauthorized: true,
    /** Adresse für "Freischaltung testen": keine -> nur die Token-Gültigkeit wird geprüft. */
    validateUrl: null,
  };
}

module.exports = { createArteProvider, parseOidcEntries, parseAgeToken, ME_URL, READ_SCRIPT, TOKEN_ENDPOINT, REALM, REDIRECT_URI };
