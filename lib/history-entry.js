'use strict';

/* global URL, URLSearchParams */

// Verlaufseinträge von Diensten speichern die Seiten-URL, damit „Fortsetzen“ und das Verlauf-Overlay dorthin zurückführen.
// Gespeichert wird nur der Pfad: Query und Fragment (Sitzungs-/Tracking-Parameter) fallen weg, Ausnahme sind Parameter, die
// das Ziel bestimmen (YouTube: v, list, t). Beim Öffnen muss der Host zum Dienst gehören (hostBelongsToService).

const MAX_URL_LENGTH = 2048;
const TARGET_PARAMS_BY_HOST = [
  { match: host => host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'), params: ['v', 'list', 't'] },
];

const normalizeHost = host => String(host || '').toLowerCase().replace(/\.$/, '');

function parseHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Bereinigte Adresse (http/https, ohne Zugangsdaten, Fragment und Tracking-Query) oder '' bei ungültiger Eingabe. */
function sanitizeHistoryUrl(value) {
  const parsed = parseHttpUrl(value);
  if (!parsed) return '';
  const host = normalizeHost(parsed.hostname);
  const rule = TARGET_PARAMS_BY_HOST.find(r => r.match(host));
  const kept = new URLSearchParams();
  if (rule) for (const name of rule.params) if (parsed.searchParams.has(name)) kept.set(name, parsed.searchParams.get(name));
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = kept.toString();
  return parsed.href;
}

/** Kopie des Eintrags mit bereinigter url; ist sie ungültig, fehlt das Feld. Nicht-Objekte bleiben unverändert. */
function sanitizeHistoryEntry(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  const { url, ...rest } = entry;
  const clean = sanitizeHistoryUrl(url);
  return clean ? { ...rest, url: clean } : rest;
}

/** Gehört der Host der Adresse zur Domain des Dienstes (gleicher Host oder Subdomain, „www.“ der Dienst-URL zählt nicht)? */
function hostBelongsToService(url, serviceUrl) {
  const target = parseHttpUrl(url);
  const base = parseHttpUrl(serviceUrl);
  if (!target || !base) return false;
  const baseHost = normalizeHost(base.hostname).replace(/^www\./, '');
  const host = normalizeHost(target.hostname);
  return Boolean(baseHost) && (host === baseHost || host.endsWith(`.${baseHost}`));
}

module.exports = { sanitizeHistoryUrl, sanitizeHistoryEntry, hostBelongsToService };
