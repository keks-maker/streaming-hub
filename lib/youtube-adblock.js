// YouTube-Werbeblocker: reine Logik ohne Electron und I/O (Host-Erkennung, Netzsperre, Einstellungen, CSS).
//
// Logik übernommen aus der iOS-App mytube (Blocking.swift: Netzmuster; Scripts.swift: Werbung aus
// Player-Antworten entfernen, Werbe-Elemente ausblenden, Skip-Fallback). Das Skript selbst läuft im
// Preload (preload-content.js, Main-World); hier liegen Muster, Host-Prüfung und das CSS.
//
// Sicherheitsgrenze: gesperrt oder verändert wird NUR, wenn die auslösende Seite ein YouTube-Host ist.
// Andere Dienste der gemeinsamen Partition (Netflix, Disney+, Widevine-Lizenzen ...) bleiben unberührt.

'use strict';

const DEFAULT_ENABLED = true;

// Hosts der Seite, auf der der Blocker wirkt: youtube.com, *.youtube.com, youtube-nocookie.com (und Subdomains)
const PAGE_HOST_SUFFIXES = Object.freeze(['youtube.com', 'youtube-nocookie.com']);

// Werbe-/Tracking-Domains (mytube: doubleclick.net, googlesyndication.com, googleadservices.com, google-analytics.com)
const AD_DOMAINS = Object.freeze(['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com']);

// Werbe-Pfade auf youtube.com (mytube: /api/stats/ads, /pagead/, /ptracking, /get_midroll_)
const AD_PATH_PREFIXES = Object.freeze(['/api/stats/ads', '/pagead/', '/ptracking', '/get_midroll_']);

// Vorfilter für session.webRequest (Electron-Muster): nur diese Anfragen erreichen den Handler
const REQUEST_URL_FILTERS = Object.freeze([
  ...AD_DOMAINS.map(domain => `*://*.${domain}/*`),
  ...AD_PATH_PREFIXES.map(prefix => `*://*.youtube.com${prefix}*`),
]);

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

function parseUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value);
  } catch (_) {
    return null;
  }
}

/** Ist der Hostname youtube.com, *.youtube.com oder youtube-nocookie.com (inkl. Subdomains)? */
function isYouTubeHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return PAGE_HOST_SUFFIXES.some(suffix => hostMatches(host, suffix));
}

/** Ist die Seiten-URL eine YouTube-Seite (http/https)? */
function isYouTubePageUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return false;
  return isYouTubeHost(parsed.hostname);
}

/** Entspricht die Anfrage-URL einem der acht Werbe-Muster? (unabhängig von Seite und Schalter) */
function isAdRequestUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (AD_DOMAINS.some(domain => hostMatches(host, domain))) return true;
  if (hostMatches(host, 'youtube.com')) {
    return AD_PATH_PREFIXES.some(prefix => parsed.pathname.startsWith(prefix));
  }
  return false;
}

/** Sperren nur: Blocker an UND Seite ist YouTube UND die Anfrage ist ein Werbe-Muster. */
function shouldBlockRequest({ url, pageUrl, enabled }) {
  if (enabled !== true) return false;
  if (!isYouTubePageUrl(pageUrl)) return false;
  return isAdRequestUrl(url);
}

/** Gespeicherte (oder fremde) Daten → vollständige Einstellungen; Standard: an. */
function normalizeYoutubeAdblockSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_ENABLED };
}

// Werbe-Elemente ausblenden. Der erste Block sind die m.youtube-Selektoren aus mytube (ytm-*),
// der zweite die Desktop-Selektoren (maßvoll: nur eindeutige Werbe-Renderer).
const AD_HIDE_CSS = `
ytm-promoted-sparkles-web-renderer, ytm-promoted-video-renderer, ytm-companion-ad-renderer,
ytm-ad-slot-renderer, ytm-statement-banner-renderer, ytm-mealbar-promo-renderer,
ytm-brand-video-singleton-renderer, ytm-upsell-dialog-renderer,
.ad-container, .ytp-ad-module, .ytp-ad-overlay-container, #player-ads,
ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer,
ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-promoted-sparkles-text-search-renderer,
ytd-companion-slot-renderer, ytd-action-companion-ad-renderer, ytd-banner-promo-renderer,
ytd-statement-banner-renderer, ytd-brand-video-singleton-renderer, ytd-player-legacy-desktop-watch-ads-renderer,
#masthead-ad, .video-ads, .ytp-ad-image-overlay, .ytp-ad-text-overlay { display: none !important; }
`;

module.exports = {
  DEFAULT_ENABLED,
  AD_DOMAINS,
  AD_PATH_PREFIXES,
  REQUEST_URL_FILTERS,
  AD_HIDE_CSS,
  isYouTubeHost,
  isYouTubePageUrl,
  isAdRequestUrl,
  shouldBlockRequest,
  normalizeYoutubeAdblockSettings,
};
