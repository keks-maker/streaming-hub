'use strict';

// ZDF-Konto ("Mein ZDF", auch mit ARD-Konto nutzbar). Kein OIDC: die Web-App spricht api.zdf.de/identity und hält den Sitzungstoken
// im Zustandsspeicher "local-user-data" (localStorage von zdf.de, Feld state.sessionToken, JWT; ausgeloggt null, Feld isArdAccount).
// Primär wird dieser Token gelesen, danach sessionStorage ("zdf-session-data"), weitere Speichereinträge und Cookies als Rückfall.
// Gültigkeit nur LOKAL (JWT-Aufbau, Ablauf exp); die Remote-Prüfung geschieht erst bei der Nutzung (GET /identity/fsk/verification:
// 401/403 = ZDF lehnt ab; abgelaufen gilt nur lokal erkannt). Der Client kennt keinen Refresh. Der Token geht ausschließlich
// an api.zdf.de unter /identity/ (Altersfreigabe und PIN prüfen), zusammen mit dem öffentlichen Api-Auth-Token der Seite (ohne ihn: 403); Streams holt die Web-App ohne Nutzertoken. Das Passwort sieht diese
// App nie. Nur mit echtem Konto prüfbar.

const { httpsHost, hostMatches, jwtExpiryMs } = require('./util.js');
const { createAppTokenSource } = require('../zdf-app-token.js');

const ZDF_ACCEPT = 'application/vnd.de.zdf.v1.0+json';
const IDENTITY_URL = 'https://api.zdf.de/identity';
const VERIFICATION_URL = `${IDENTITY_URL}/fsk/verification`;
const EXPIRY_MARGIN_MS = 60 * 1000;
const LOCAL_KEY = 'local-user-data';
const SESSION_MS = 12 * 60 * 60 * 1000; // Token ohne lesbares Ablaufdatum: lokal 12 Stunden gültig, die Nutzung zeigt Ablehnung
const TOKEN_PATTERN = /^[\x21-\x7e]{8,4096}$/;

/**
 * Skript für die zdf.de-Seite: JSON [{ key, value }] aller localStorage- und sessionStorage-Einträge, deren Schlüssel nach Anmeldung
 * aussieht (token/auth/user/session/zdf). Der tatsächliche Ablageort des Tokens ist nicht gesichert; nichts wird verändert.
 */
const READ_SCRIPT = `(() => {
  const hint = /token|auth|user|session|zdf/i;
  const found = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (!key || !hint.test(key)) continue;
        const value = store.getItem(key);
        if (typeof value === 'string' && value.length <= 200000) found.push({ key, value });
      }
    } catch (error) {
      // Speicher nicht lesbar: überspringen
    }
  }
  return JSON.stringify(found);
})()`;

const KEY_HINT = /token|access|session|bearer|auth/i;
const JWT_PATTERN = /^eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*$/;
const MAX_CANDIDATES = 12;
const MAX_DEPTH = 6;

/** Sammelt Token-Kandidaten aus einem Wert (Zeichenkette, JSON-Text oder verschachtelt); jwt = JWT-ähnlich, sonst Schlüsselhinweis. */
function collectFrom(value, keyHint, out, depth = 0, loose = false) {
  if (depth > MAX_DEPTH || out.length >= 64) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[[{"]/.test(text)) {
      try {
        collectFrom(JSON.parse(text), keyHint, out, depth + 1, loose);
        return;
      } catch {
        // kein JSON: als Zeichenkette prüfen
      }
    }
    if (JWT_PATTERN.test(text)) out.push({ token: text, rank: 0 });
    else if (KEY_HINT.test(keyHint) && TOKEN_PATTERN.test(text) && !/^(true|false|null|undefined)$/i.test(text)) out.push({ token: text, rank: 1 });
    else if (loose && text.length >= 20 && TOKEN_PATTERN.test(text)) out.push({ token: text, rank: 2 }); // Cookie-Name unbekannt: lange Werte zuletzt
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFrom(item, keyHint, out, depth + 1, loose);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectFrom(item, key, out, depth + 1, loose);
  }
}

/**
 * Token-Kandidaten aus den Storage-Einträgen ([{ key, value }] als JSON-Text) und den Cookies ([{ name, value }]): JWT-ähnliche
 * zuerst, dann Werte unter Schlüsseln wie token/access/session; ohne Duplikate, höchstens 12. Es wird nichts geprüft.
 */
function tokenCandidates(storageJson, cookies = []) {
  const found = [];
  let entries = [];
  try {
    const parsed = JSON.parse(storageJson);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry && typeof entry.key === 'string' && typeof entry.value === 'string') collectFrom(entry.value, entry.key, found);
  }
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!cookie || typeof cookie.value !== 'string') continue;
    let value = cookie.value;
    try {
      value = decodeURIComponent(value);
    } catch {
      // Rohwert verwenden
    }
    collectFrom(value, String(cookie.name || ''), found, 0, true);
  }
  const seen = new Set();
  return found
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .filter(item => (seen.has(item.token) ? false : (seen.add(item.token), true)))
    .slice(0, MAX_CANDIDATES)
    .map(item => item.token);
}

/** JWT-Aufbau (3 Teile, lesbare JSON-Nutzdaten) und - falls exp vorhanden - noch nicht abgelaufen (mit kleinem Puffer). Keine Signaturprüfung. */
function isUsableJwt(token, nowMs) {
  if (typeof token !== 'string' || !JWT_PATTERN.test(token)) return false;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return false;
    return !Number.isFinite(payload.exp) || payload.exp * 1000 > nowMs + EXPIRY_MARGIN_MS;
  } catch {
    return false;
  }
}

/** Aus dem Zustandsspeicher-Eintrag local-user-data: { token, ardAccount } oder null (kaputtes JSON, kein/abgelaufener Token). */
function sessionFromLocalData(storageJson, nowMs) {
  let entries;
  try {
    entries = JSON.parse(storageJson);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const entry = entries.find(item => item && item.key === LOCAL_KEY && typeof item.value === 'string');
  if (!entry) return null;
  try {
    const state = JSON.parse(entry.value).state;
    if (!state || !isUsableJwt(state.sessionToken, nowMs)) return null;
    return { token: state.sessionToken, ardAccount: state.isArdAccount === true };
  } catch {
    return null;
  }
}

const rejected = () => Object.assign(new Error('Anbieter hat die Anfrage abgelehnt'), { code: 'rejected' });
const bearer = token => ({ Authorization: `Bearer ${token}`, Accept: ZDF_ACCEPT });

function createZdfProvider({ now = Date.now } = {}) {
  let tokenSource = null;
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
      isCollectPage: host => hostMatches(host, 'zdf.de'),
      /** Seite, auf der die Web-App die Sitzung sicher gesetzt hat (Übernehmen-Knopf, falls auf der aktuellen Seite nichts gefunden wird). */
      collectUrl: 'https://www.zdf.de/mein-zdf',
      /** Cookies dieser Domain werden als Kandidaten mitgegeben. */
      cookieDomain: 'zdf.de',
    },
    /**
     * Liest und prüft die Sitzung: Kandidaten aus localStorage, sessionStorage und Cookies der Partition werden der Reihe nach gegen
     * die Identity-API geprüft, der erste gültige gewinnt, abgelehnte werden verworfen (und kurz nicht erneut gesendet). null, solange
     * keiner gilt. Token und Cookie-Werte landen nie in Fehlern oder Logs.
     */
    async collect(page) {
      const host = httpsHost(page.url);
      if (!host || !hostMatches(host, 'zdf.de')) return null;
      const storageJson = await Promise.resolve()
        .then(() => page.executeJavaScript(READ_SCRIPT))
        .catch(() => '[]'); // Seite noch nicht bereit: Cookies können trotzdem reichen
      let cookies = [];
      if (typeof page.getCookies === 'function') {
        try {
          cookies = await page.getCookies();
        } catch {
          cookies = [];
        }
      }
      const at = now();
      const primary = sessionFromLocalData(storageJson, at);
      if (primary) return { accessToken: primary.token, refreshToken: null, expiresAt: expiryOf(primary.token), since: at, state: 'ok', clientId: null, ardAccount: primary.ardAccount };
      for (const token of tokenCandidates(storageJson, cookies)) {
        if (isUsableJwt(token, at)) return { accessToken: token, refreshToken: null, expiresAt: expiryOf(token), since: at, state: 'ok', clientId: null, ardAccount: false };
      }
      return null;
    },
    /** Kein Refresh im Client: nur lokale Ablaufprüfung; die Ablehnung durch ZDF zeigt sich bei der Nutzung (Altersfreigabe, PIN). */
    async refresh(record) {
      if (jwtExpiryMs(record.accessToken) !== null && !isUsableJwt(record.accessToken, now())) throw rejected();
      return { ...record, expiresAt: expiryOf(record.accessToken), state: 'ok' };
    },
    headers: record => bearer(record.accessToken),
    /** "Freischaltung testen": Altersverifikation des Kontos abfragen; Antwort nur als ja/nein ausgewertet. */
    validateUrl: VERIFICATION_URL,
    validateAccept: ZDF_ACCEPT,
    /** Kopfzeilen je Host für den Prüfabruf: Api-Auth der Web-App für api.zdf.de (wie im Web-Client; ohne ihn lehnt die Identity-API ab). */
    async validateHostHeaders(http) {
      tokenSource = tokenSource || createAppTokenSource({ http, now });
      return { 'api.zdf.de': { 'Api-Auth': `Bearer ${await tokenSource.get('appToken')}` } };
    },
    describeValidation(body) {
      let verified = null;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.verified === 'boolean') verified = parsed.verified;
      } catch {
        verified = null;
      }
      return `Angemeldet; Altersverifikation bei ZDF: ${verified === null ? 'nicht prüfbar' : verified ? 'ja' : 'nein'}.`;
    },
  };
}

module.exports = { createZdfProvider, tokenCandidates, isUsableJwt, sessionFromLocalData, ZDF_ACCEPT, IDENTITY_URL, VERIFICATION_URL, READ_SCRIPT };
