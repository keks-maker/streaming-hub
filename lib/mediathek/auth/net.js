'use strict';

// Token-Abrufe der Konten-Module (Firebase securetoken/identitytoolkit, arte Keycloak): feste Host-Liste, nur https und POST,
// keine Weiterleitungen, Zeit- und Größenlimit. Fehler tragen nur code/status, nie Adresse, Anfragekörper oder Antwort.

const { URLSearchParams } = require('node:url');

const ALLOWED_HOSTS = new Set(['identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'id.arte.tv']);
const TIMEOUT_MS = 15000;
const MAX_BYTES = 64 * 1024;
// Nur Hosts, deren API-Key Referer-beschränkt ist (Firebase): Zusatz-Header werden nie an andere Hosts gesendet.
const EXTRA_HEADER_HOSTS = new Set(['identitytoolkit.googleapis.com', 'securetoken.googleapis.com']);
const EXTRA_HEADER_NAMES = new Set(['Referer', 'Origin']);

function authError(code, status = null) {
  return Object.assign(new Error(code === 'network' ? 'Anbieter nicht erreichbar' : 'Anbieter hat die Anfrage abgelehnt'), { code, status });
}

/**
 * Ergebnis: { postJson(url, body, extraHeaders?), postForm(url, fields, extraHeaders?) } -> geparstes JSON.
 * Fehler: code 'forbidden-host' | 'network' | 'rejected' (HTTP 4xx, status gesetzt) | 'http' (sonst) | 'invalid-json'.
 */
function createAuthNet({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  async function post(url, { contentType, body, extraHeaders }) {
    let target;
    try {
      target = new URL(url);
    } catch {
      throw authError('forbidden-host');
    }
    if (target.protocol !== 'https:' || target.username || target.password || !ALLOWED_HOSTS.has(target.hostname)) throw authError('forbidden-host');
    const extra = {};
    if (extraHeaders && EXTRA_HEADER_HOSTS.has(target.hostname)) {
      for (const [name, value] of Object.entries(extraHeaders)) if (EXTRA_HEADER_NAMES.has(name) && typeof value === 'string') extra[name] = value;
    }
    let response;
    try {
      response = await fetchImpl(target.toString(), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': contentType, Accept: 'application/json', ...extra },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw authError('network');
    }
    if (response.status >= 300 && response.status < 400) throw authError('http', response.status);
    let text;
    try {
      text = await response.text();
    } catch {
      throw authError('network');
    }
    if (response.status >= 400 && response.status < 500) throw authError('rejected', response.status);
    if (response.status !== 200) throw authError('http', response.status);
    if (text.length > maxBytes) throw authError('http', response.status);
    try {
      return JSON.parse(text);
    } catch {
      throw authError('invalid-json');
    }
  }

  return {
    postJson: (url, value, extraHeaders) => post(url, { contentType: 'application/json', body: JSON.stringify(value), extraHeaders }),
    postForm: (url, fields, extraHeaders) => post(url, { contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams(fields).toString(), extraHeaders }),
  };
}

module.exports = { createAuthNet, ALLOWED_HOSTS };
