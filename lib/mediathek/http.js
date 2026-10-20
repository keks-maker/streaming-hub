'use strict';

// HTTP-Zugriff der Mediathek im Main-Prozess: nur https, nur Hosts der Allowlist (sources.js, auch nach jedem Redirect),
// Ziel-IP-Filter gegen SSRF (net-safety.js), hartes Zeitlimit und Größenlimit. Der Transport ist injizierbar (Tests laufen
// ohne Netz); Fehlermeldungen enthalten nie die angefragte Adresse.

const { nodeFetch, fetchFollow, readLimited, discardBody, withDeadline } = require('../radio/radio-http.js');
const { createSafeLookup } = require('../net-safety.js');
const { isAllowedFetchUrl } = require('./sources.js');

const TIMEOUT_MS = 20000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'StreamingHub/1.0'; // wie tvOS/iPad

/**
 * Ergebnis: { getText(url), getJson(url) }. Beide werfen Error mit lesbarer Meldung und code
 * ('forbidden-host' | 'http' | 'network' | 'too-large' | 'invalid-json'); HTTP-Status steht in error.status.
 * options: fetchImpl (Transport), lookup (Standard: createSafeLookup()), timeoutMs, maxBytes, auth ({ ensureFresh(sender),
 * getAuthHeaders(sender, url), reportUnauthorized(sender) }, Konten-Modul). getText(url, { auth: sender }) hängt dann die Kopfzeilen
 * des Kontos an; sie werden je Weiterleitungsschritt neu bestimmt und gelten nur für die Hosts des Senders (Hostbindung im
 * Konten-Modul), nie für Weiterleitungsziele fremder Hosts. Antwort 401 meldet den Token als abgelehnt (error.status 401).
 */
function createMediathekHttp({ fetchImpl = nodeFetch, lookup = createSafeLookup(), timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, auth = null } = {}) {
  const guardUrl = url => {
    if (!isAllowedFetchUrl(url)) throw Object.assign(new Error('Adresse nicht erlaubt'), { code: 'forbidden-host' });
  };

  async function getText(url, { accept = 'application/json', auth: sender = null } = {}) {
    guardUrl(url);
    const useAuth = Boolean(sender && auth);
    if (useAuth) await auth.ensureFresh(sender);
    const hopHeaders = hopUrl => ({ 'User-Agent': USER_AGENT, Accept: accept, ...(useAuth ? auth.getAuthHeaders(sender, hopUrl) : {}) });
    let result;
    try {
      // withDeadline macht aus jedem Fehler einen neuen Error ohne code: Ergebnis daher als Wert zurückgeben und danach prüfen
      result = await withDeadline(timeoutMs, async signal => {
        const { response } = await fetchFollow(url, { fetchImpl, signal, headers: hopHeaders, maxRedirects: MAX_REDIRECTS, lookup, guardUrl });
        if (response.status !== 200) {
          await discardBody(response);
          return { status: response.status };
        }
        const { buffer, truncated } = await readLimited(response, maxBytes);
        return { status: 200, truncated, text: buffer.toString('utf8') };
      });
    } catch (error) {
      throw Object.assign(new Error((error && error.message) || 'Mediathek nicht erreichbar'), { code: 'network' });
    }
    if (result.status === 401 && useAuth) auth.reportUnauthorized(sender);
    if (result.status !== 200) throw Object.assign(new Error(`Server antwortete mit HTTP ${result.status}`), { code: 'http', status: result.status });
    if (result.truncated) throw Object.assign(new Error('Antwort ist zu groß'), { code: 'too-large' });
    return result.text;
  }

  async function getJson(url) {
    const text = await getText(url);
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Antwort ist kein gültiges JSON'), { code: 'invalid-json' });
    }
  }

  return { getText, getJson };
}

module.exports = { createMediathekHttp, USER_AGENT };
