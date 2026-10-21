'use strict';

// ZDF-Konto ("Mein ZDF", auch mit ARD-Konto nutzbar). Kein OIDC: die Web-App spricht api.zdf.de/identity und hält den Sitzungstoken
// im Zustandsspeicher "local-user-data" (localStorage, Feld state.sessionToken; älter: zdf_user_token) - der echte Ablageort ist aber
// nicht gesichert. Nach der Anmeldung im Anbieter-Fenster sammeln wir daher nur lesend Kandidaten aus localStorage, sessionStorage und
// den Cookies der Partition und prüfen jeden per GET /identity/userinfo; der erste gültige wird übernommen. Der Client kennt keinen Refresh: die
// "Auffrischung" ist eine Gültigkeitsprüfung derselben Sitzung (401/403 = abgelaufen, dann neu anmelden). Der Token geht ausschließlich
// an api.zdf.de unter /identity/ (Altersfreigabe und PIN prüfen); Streams holt die Web-App ohne Nutzertoken. Das Passwort sieht diese
// App nie. Nur mit echtem Konto prüfbar.

const { httpsHost, hostMatches, jwtExpiryMs } = require('./util.js');

const ZDF_ACCEPT = 'application/vnd.de.zdf.v1.0+json';
const IDENTITY_URL = 'https://api.zdf.de/identity';
const USERINFO_URL = `${IDENTITY_URL}/userinfo`;
const SESSION_MS = 12 * 60 * 60 * 1000; // Token ohne lesbares Ablaufdatum: alle 12 Stunden erneut prüfen
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
const REJECT_MEMORY_MS = 60 * 1000;

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

const rejected = () => Object.assign(new Error('Anbieter hat die Anfrage abgelehnt'), { code: 'rejected' });
const bearer = token => ({ Authorization: `Bearer ${token}`, Accept: ZDF_ACCEPT });

function createZdfProvider({ net, now = Date.now }) {
  const expiryOf = token => jwtExpiryMs(token) || now() + SESSION_MS;
  const rejectedTokens = new Map(); // Kandidat -> Zeitpunkt, bis zu dem er nicht erneut geprüft wird (nur im Speicher)
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
      for (const [token, until] of rejectedTokens) if (until <= at) rejectedTokens.delete(token);
      let failure = null;
      for (const token of tokenCandidates(storageJson, cookies)) {
        if (rejectedTokens.has(token)) continue;
        let answer;
        try {
          answer = await net.request('GET', USERINFO_URL, { headers: bearer(token) });
        } catch (error) {
          failure = failure || error;
          continue;
        }
        if (answer.status === 200) return { accessToken: token, refreshToken: null, expiresAt: expiryOf(token), since: now(), state: 'ok', clientId: null };
        if (answer.status === 401 || answer.status === 403) {
          if (rejectedTokens.size < 200) rejectedTokens.set(token, at + REJECT_MEMORY_MS);
        } else {
          failure = failure || Object.assign(new Error('Anbieter nicht erreichbar'), { code: 'http', status: answer.status });
        }
      }
      if (failure) throw Object.assign(new Error('ZDF-Anmeldung nicht erkannt'), { code: failure.code || 'http', status: failure.status || null });
      return null;
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

module.exports = { createZdfProvider, tokenCandidates, ZDF_ACCEPT, IDENTITY_URL, USERINFO_URL, READ_SCRIPT };
