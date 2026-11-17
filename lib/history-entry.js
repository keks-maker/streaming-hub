'use strict';

/* global URL, URLSearchParams */

// Verlaufseinträge von Diensten speichern die Seiten-URL, damit „Fortsetzen“ und das Verlauf-Overlay dorthin zurückführen.
// Gespeichert wird nur der Pfad: Query und Fragment (Sitzungs-/Tracking-Parameter) fallen weg, Ausnahme sind Parameter, die
// das Ziel bestimmen (YouTube: v, list, t). Beim Öffnen muss der Host zum Dienst gehören (hostBelongsToService).

const MAX_URL_LENGTH = 2048;
const MAX_INPUT_LENGTH = 8192;
const TARGET_PARAMS_BY_HOST = [
  { match: host => host === 'youtube.com' || host.endsWith('.youtube.com'), params: ['v', 'list', 't'] },
];
// Weitere Domains, auf denen ein Dienst Seiten ausliefert (Schlüssel: Basis-Host der Dienst-URL ohne „www.“)
const SERVICE_ALIAS_HOSTS = {
  'primevideo.com': ['amazon.de', 'amazon.com', 'amazon.co.uk'],
  'youtube.com': ['youtu.be'],
};

const normalizeHost = host => String(host || '').toLowerCase().replace(/\.$/, '');

function parseHttpUrl(value, maxLength) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > maxLength) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Bereinigte Adresse (http/https, ohne Zugangsdaten, Fragment und Tracking-Query; youtu.be/<id> wird youtube.com/watch?v=<id>) oder ''. */
function sanitizeHistoryUrl(value) {
  const parsed = parseHttpUrl(value, MAX_INPUT_LENGTH);
  if (!parsed) return '';
  let host = normalizeHost(parsed.hostname);
  const source = new URLSearchParams(parsed.search);
  const kept = new URLSearchParams();
  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/')[1];
    if (!id) return '';
    parsed.protocol = 'https:';
    parsed.hostname = 'www.youtube.com';
    parsed.port = '';
    parsed.pathname = '/watch';
    kept.set('v', id);
    host = 'www.youtube.com';
  }
  const rule = TARGET_PARAMS_BY_HOST.find(r => r.match(host));
  if (rule) for (const name of rule.params) if (source.has(name) && !kept.has(name)) kept.set(name, source.get(name));
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = kept.toString();
  return parsed.href.length <= MAX_URL_LENGTH ? parsed.href : '';
}

/** Gehört die Adresse zum Dienst (gleicher Host, Subdomain oder Alias-Domain; Port wie bei der Dienst-URL)? */
function hostBelongsToService(url, serviceUrl) {
  const target = parseHttpUrl(url, MAX_INPUT_LENGTH);
  const base = parseHttpUrl(serviceUrl, MAX_INPUT_LENGTH);
  if (!target || !base || target.port !== base.port) return false;
  const baseHost = normalizeHost(base.hostname).replace(/^www\./, '');
  const host = normalizeHost(target.hostname);
  if (!baseHost) return false;
  return [baseHost, ...(SERVICE_ALIAS_HOSTS[baseHost] || [])].some(h => host === h || host.endsWith(`.${h}`));
}

/**
 * Kopie des Eintrags mit bereinigter url; ungültig oder (bei übergebener serviceUrl, auch '') dienstfremd: Feld fehlt.
 * Nicht-Objekte bleiben unverändert.
 */
function sanitizeHistoryEntry(entry, serviceUrl) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  const { url, ...rest } = entry;
  const clean = sanitizeHistoryUrl(url);
  const allowed = clean && (serviceUrl === undefined || hostBelongsToService(clean, serviceUrl));
  return allowed ? { ...rest, url: clean } : rest;
}

module.exports = { sanitizeHistoryUrl, sanitizeHistoryEntry, hostBelongsToService };
