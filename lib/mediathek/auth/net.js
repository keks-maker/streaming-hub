'use strict';

// Abrufe der Konten-Module (Firebase securetoken/identitytoolkit, arte Keycloak, ZDF-Identity): feste Host-Liste, nur https,
// keine Weiterleitungen, Zeit- und Größenlimit. Fehler tragen nur code/status, nie Adresse, Anfragekörper oder Antwort.
// ZDF: nur api.zdf.de unter /identity/; nur dort sind Authorization (Bearer des Kontos) und Accept als Zusatz-Kopfzeile erlaubt.

const { URLSearchParams } = require('node:url');

const ALLOWED_HOSTS = new Set(['identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'id.arte.tv', 'api.zdf.de']);
const ZDF_HOST = 'api.zdf.de';
const ZDF_IDENTITY_PREFIX = '/identity/';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 64 * 1024;
// Nur Hosts, deren API-Key Referer-beschränkt ist (Firebase): Zusatz-Header werden nie an andere Hosts gesendet.
const EXTRA_HEADER_HOSTS = new Set(['identitytoolkit.googleapis.com', 'securetoken.googleapis.com']);
const EXTRA_HEADER_NAMES = new Set(['Referer', 'Origin']);
const ZDF_HEADER_NAMES = new Set(['Authorization', 'Accept']);

function authError(code, status = null) {
  return Object.assign(new Error(code === 'network' ? 'Anbieter nicht erreichbar' : 'Anbieter hat die Anfrage abgelehnt'), { code, status });
}

/**
 * Ergebnis: { postJson(url, body, extraHeaders?), postForm(url, fields, extraHeaders?) } -> geparstes JSON (Fehler bei HTTP >= 400);
 * request(method, url, { fields?, headers? }) -> { status, json } (GET/POST, 4xx werden als Status zurückgegeben; Antworten ohne
 * JSON-Körper ergeben json null). Fehler: code 'forbidden-host' | 'network' | 'rejected' (HTTP 4xx, status gesetzt) | 'http' (sonst) |
 * 'invalid-json'.
 */
function createAuthNet({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  function target(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw authError('forbidden-host');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !ALLOWED_HOSTS.has(parsed.hostname)) throw authError('forbidden-host');
    if (parsed.hostname === ZDF_HOST && !parsed.pathname.startsWith(ZDF_IDENTITY_PREFIX)) throw authError('forbidden-host');
    return parsed;
  }

  function extraFor(parsed, extraHeaders) {
    const extra = {};
    if (!extraHeaders) return extra;
    const allowed = parsed.hostname === ZDF_HOST ? ZDF_HEADER_NAMES : EXTRA_HEADER_HOSTS.has(parsed.hostname) ? EXTRA_HEADER_NAMES : null;
    if (!allowed) return extra;
    for (const [name, value] of Object.entries(extraHeaders)) if (allowed.has(name) && typeof value === 'string') extra[name] = value;
    return extra;
  }

  async function send(method, url, { contentType = null, body = undefined, extraHeaders = null, lenient = false }) {
    const parsed = target(url);
    const headers = { Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}), ...extraFor(parsed, extraHeaders) };
    let response;
    try {
      response = await fetchImpl(parsed.toString(), { method, redirect: 'manual', headers, body, signal: AbortSignal.timeout(timeoutMs) });
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
    if (response.status >= 500) throw authError('http', response.status);
    if (response.status >= 400) {
      if (lenient) return { status: response.status, json: null };
      throw authError('rejected', response.status);
    }
    if (response.status !== 200 && !lenient) throw authError('http', response.status);
    if (text.length > maxBytes) throw authError('http', response.status);
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      if (lenient) return { status: response.status, json: null };
      throw authError('invalid-json');
    }
  }

  const post = async (url, options) => (await send('POST', url, options)).json;

  return {
    postJson: (url, value, extraHeaders) => post(url, { contentType: 'application/json', body: JSON.stringify(value), extraHeaders }),
    postForm: (url, fields, extraHeaders) => post(url, { contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams(fields).toString(), extraHeaders }),
    request: (method, url, { fields = null, headers = null } = {}) => {
      if (method !== 'GET' && method !== 'POST') return Promise.reject(authError('forbidden-host'));
      return send(method, url, { contentType: fields ? 'application/x-www-form-urlencoded' : null, body: fields ? new URLSearchParams(fields).toString() : undefined, extraHeaders: headers, lenient: true });
    },
  };
}

module.exports = { createAuthNet, ALLOWED_HOSTS };
