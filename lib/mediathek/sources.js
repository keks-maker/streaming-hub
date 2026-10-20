'use strict';

// Quellen (ARD, ZDF, arte), Endpunkt-Builder und Host-Allowlist der Mediathek. Reine Funktionen (Port von MediathekService.swift).
// Die Allowlist gilt für alle Abrufe im Main-Prozess: API-Hosts für JSON-Antworten, Manifest-Hosts für HLS-Master und Untertitel.

const BUILTIN_SOURCES = [
  { id: 'ard', name: 'ARD Mediathek', apiUrl: 'https://api.ardmediathek.de/', logo: 'ard' },
  { id: 'zdf', name: 'ZDF Mediathek', apiUrl: 'https://api.zdf.de/', logo: 'zdf' },
  { id: 'arte', name: 'ARTE', apiUrl: 'https://api.arte.tv/', logo: 'arte' },
];

const SOURCE_IDS = BUILTIN_SOURCES.map(source => source.id);

/** Hosts der JSON-APIs (exakter Vergleich). api.zdf.de nur der Vollständigkeit halber (liefert ohne Token HTTP 403). */
const API_HOSTS = ['api.ardmediathek.de', 'zdf-prod-futura.zdf.de', 'api.zdf.de', 'api.arte.tv', 'api-cdn.arte.tv'];

/** Hosts, von denen Manifeste/Untertitel gelesen werden dürfen (Endung mit führendem Punkt oder exakter Host). */
const MANIFEST_HOST_SUFFIXES = ['.arte.tv', '.akamaized.net', '.akamaihd.net', '.ard-mcdn.de', '.ardmediathek.de', '.daserste.de', '.zdf.de'];

const SHORT_NAMES = { ard: 'ARD', zdf: 'ZDF', arte: 'arte' };

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** true für https-Adressen der JSON-APIs. */
function isAllowedApiUrl(value) {
  const url = httpsUrl(value);
  return Boolean(url) && API_HOSTS.includes(url.hostname);
}

/** true für https-Adressen der JSON-APIs und der Manifest-/CDN-Hosts (HLS-Master, WebVTT). */
function isAllowedFetchUrl(value) {
  const url = httpsUrl(value);
  if (!url) return false;
  return API_HOSTS.includes(url.hostname) || MANIFEST_HOST_SUFFIXES.some(suffix => url.hostname.endsWith(suffix));
}

function buildUrl(base, params = []) {
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return query ? `${base}?${query}` : base;
}

function unsupported(sourceId) {
  return Object.assign(new Error(`Mediathek ${sourceId} wird nicht unterstützt`), { code: 'unsupportedSource' });
}

function homeUrl(sourceId) {
  if (sourceId === 'ard') return buildUrl('https://api.ardmediathek.de/page-gateway/pages/ard/home', [['embedded', 'true']]);
  if (sourceId === 'zdf') return 'https://zdf-prod-futura.zdf.de/mediathekV2/start-page';
  if (sourceId === 'arte') return 'https://api.arte.tv/api/emac/v3/de/web/pages/HOME/';
  throw unsupported(sourceId);
}

/** Such-Adresse; ARD pagt über vodPageNumber (0-basiert, ab Seite 1 gesetzt). */
function searchUrl(query, sourceId, page = 0) {
  const text = String(query || '').trim();
  if (sourceId === 'ard') {
    const params = [['searchString', text], ['pageSize', '24']];
    if (page > 0) params.push(['vodPageNumber', String(page)]);
    return buildUrl('https://api.ardmediathek.de/page-gateway/pages/ard/search', params);
  }
  if (sourceId === 'zdf') return buildUrl('https://zdf-prod-futura.zdf.de/mediathekV2/search', [['q', text]]);
  if (sourceId === 'arte') return buildUrl('https://api.arte.tv/api/emac/v3/de/web/data/SEARCH_LISTING/', [['query', text], ['page', '1'], ['limit', '20']]);
  throw unsupported(sourceId);
}

/** Adresse der Stream-Info einer Folge (ARD item, ZDF document, arte player config); null bei ungültiger ID/Quelle. */
function streamInfoUrl(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id) return null;
  if (entry.sourceId === 'ard') {
    const partner = typeof entry.partner === 'string' && entry.partner ? entry.partner : 'ard';
    if (!/^[A-Za-z0-9_-]+$/.test(partner)) return null;
    return buildUrl(`https://api.ardmediathek.de/page-gateway/pages/${partner}/item/${encodeURIComponent(entry.id)}`, [['devicetype', 'pc'], ['embedded', 'true']]);
  }
  if (entry.sourceId === 'arte') return `https://api.arte.tv/api/player/v2/config/de/${encodeURIComponent(entry.id)}`;
  if (entry.sourceId === 'zdf') return `https://zdf-prod-futura.zdf.de/mediathekV2/document/${encodeURIComponent(entry.id)}`; // Dokument-ID, token-frei
  return null;
}

/** Web-Adresse der Folge (für gesperrte Inhalte); ZDF ohne stabilen Direktlink -> Suche. */
function webUrl(entry) {
  const enc = encodeURIComponent;
  if (entry.sourceId === 'ard') return `https://www.ardmediathek.de/video/${enc(entry.id)}`;
  if (entry.sourceId === 'arte') return `https://www.arte.tv/de/videos/${enc(entry.id)}/`;
  if (entry.sourceId === 'zdf') return buildUrl('https://www.zdf.de/suche', [['q', entry.title]]);
  return null;
}

/** Textbausteine der Karten (plattformneutral, wie MediathekText in tvOS/iPad). */
function badge(sourceId) {
  return SHORT_NAMES[sourceId] || String(sourceId).toUpperCase();
}

module.exports = { BUILTIN_SOURCES, SOURCE_IDS, API_HOSTS, MANIFEST_HOST_SUFFIXES, isAllowedApiUrl, isAllowedFetchUrl, homeUrl, searchUrl, streamInfoUrl, webUrl, badge };
