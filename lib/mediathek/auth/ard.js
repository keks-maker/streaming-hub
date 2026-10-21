'use strict';

// ARD-Konto (accounts.ard.de). Kette laut Spike: nach dem Login holt die Mediathek-Seite mit den Cookies der Partition
// GET sso.ardmediathek.de/sso/token -> { customToken } -> Firebase signInWithCustomToken (öffentlicher Web-API-Key der
// Mediathek-Seite, Projekt ardmt-prod) -> idToken (ca. 1 h) + Firebase-Refresh-Token. Personalisierte Abrufe tragen
// "X-Authorization: Bearer <idToken>" (api.ardmediathek.de). Das Passwort sieht diese App nie; customToken landet nie im Log.
// Nur mit echtem Konto prüfbar.

const { httpsHost, hostMatches, expiryFromSeconds } = require('./util.js');

/** Öffentlicher Firebase-Web-Key aus dem HTML der ARD Mediathek (window-Konfiguration FIREBASE.apiKey); kein Geheimnis. */
const FIREBASE_API_KEY = 'AIzaSyCt2VGBTIEeXJloozEqjgib-GmjHbazZ5M';
const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`;
const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

/** Skript für die ardmediathek.de-Seite: customToken (String) oder null, mit den Cookies der Partition. */
const SSO_SCRIPT = `fetch('https://sso.ardmediathek.de/sso/token', { credentials: 'include' })
  .then(response => (response.ok ? response.json() : null))
  .then(body => (body && typeof body.customToken === 'string' && body.customToken ? body.customToken : null))
  .catch(() => null)`;

/** Der Firebase-Key ist auf die Mediathek-Seite beschränkt (ohne Referer HTTP 403); net.js sendet sie nur an die Firebase-Hosts. */
const FIREBASE_HEADERS = { Referer: 'https://www.ardmediathek.de/', Origin: 'https://www.ardmediathek.de' };

/** Firebase-uid aus dem idToken (Claim user_id bzw. sub); der Web-Client sendet sie als Query-Parameter userId. Nie loggen. */
function userIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const id = payload.user_id || payload.sub;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const rejected = () => Object.assign(new Error('Anbieter hat die Anfrage abgelehnt'), { code: 'rejected' });

function createArdProvider({ net, now = Date.now }) {
  return {
    sender: 'ard',
    name: 'ARD',
    partition: 'persist:mediathek-ard',
    tokenHosts: ['api.ardmediathek.de'],
    login: {
      startUrl: 'https://www.ardmediathek.de/',
      isAllowedHost: host => ['ardmediathek.de', 'ard.de', 'ard-zdf.de'].some(suffix => hostMatches(host, suffix)),
      isCollectPage: host => host === 'www.ardmediathek.de',
    },
    async collect(page) {
      if (httpsHost(page.url) !== 'www.ardmediathek.de') return null;
      const customToken = await page.executeJavaScript(SSO_SCRIPT);
      if (typeof customToken !== 'string' || !customToken) return null;
      const answer = await net.postJson(SIGN_IN_URL, { token: customToken, returnSecureToken: true }, FIREBASE_HEADERS);
      if (!answer || typeof answer.idToken !== 'string' || !answer.idToken || typeof answer.refreshToken !== 'string' || !answer.refreshToken) throw rejected();
      return { accessToken: answer.idToken, refreshToken: answer.refreshToken, expiresAt: expiryFromSeconds(answer.expiresIn, now()), since: now(), state: 'ok', clientId: null };
    },
    async refresh(record) {
      if (!record.refreshToken) throw rejected();
      const answer = await net.postForm(REFRESH_URL, { grant_type: 'refresh_token', refresh_token: record.refreshToken }, FIREBASE_HEADERS);
      if (!answer || typeof answer.id_token !== 'string' || !answer.id_token) throw rejected();
      return {
        ...record,
        accessToken: answer.id_token,
        refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : record.refreshToken,
        expiresAt: expiryFromSeconds(answer.expires_in, now()),
        state: 'ok',
      };
    },
    /** Personalisierte Abrufe tragen im Web-Client zusätzlich ?userId=<uid>; nur für api.ardmediathek.de. */
    personalizeUrl(url, record) {
      const id = userIdFromToken(record.accessToken);
      if (!id || httpsHost(url) !== 'api.ardmediathek.de') return url;
      const target = new URL(url);
      target.searchParams.set('userId', id);
      return target.href;
    },
    headers: record => ({ 'X-Authorization': `Bearer ${record.accessToken}` }),
    /** Leichter, personalisierter Abruf für "Freischaltung testen" (401 = Token ungültig). */
    validateUrl: 'https://api.ardmediathek.de/page-gateway/pages/ard/home?embedded=true',
  };
}

module.exports = { createArdProvider, userIdFromToken, FIREBASE_API_KEY, SSO_SCRIPT };
