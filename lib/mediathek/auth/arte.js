'use strict';

// arte (MeinARTE, Keycloak-Realm myarte-prod). Die Web-App nutzt oidc-client-ts: der angemeldete Nutzer liegt nach dem Login im
// localStorage der arte.tv-Seite unter "oidc.user:<Realm>:<client_id>" (access_token, refresh_token, expires_at). Wir lesen ihn aus
// der Login-Partition (Skript im Anbieter-Kontext, nur lesend) und erneuern den Token selbst am öffentlichen Token-Endpunkt des
// Web-Clients (kein Secret, nur refresh_token + client_id). Das Passwort sieht diese App nie. Nur mit echtem Konto prüfbar.

const { httpsHost, hostMatches, expiryFromSeconds } = require('./util.js');

const REALM = 'https://id.arte.tv/auth/realms/myarte-prod';
const TOKEN_ENDPOINT = `${REALM}/protocol/openid-connect/token`;
const KEY_PREFIX = `oidc.user:${REALM}:`;

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

/** Ablauf aus einem JWT (exp in Sekunden) oder null; die Signatur wird nicht geprüft (nur die Zeitangabe wird gelesen). */
function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

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
      const answer = await net.postForm(TOKEN_ENDPOINT, { grant_type: 'refresh_token', client_id: record.clientId, refresh_token: record.refreshToken });
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
    /** Adresse für "Freischaltung testen": keine -> nur die Token-Gültigkeit wird geprüft. */
    validateUrl: null,
    pinBinding: null,
  };
}

module.exports = { createArteProvider, parseOidcEntries, READ_SCRIPT, TOKEN_ENDPOINT, REALM };
