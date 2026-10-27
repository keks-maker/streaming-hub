// YouTube-URLs für den Mini-Player: Klassifizierung (Video / Stöbern / extern) und Video-IDs.
// Reine Funktionen ohne Electron und DOM; im Main (Kontextmenü, Validierung) und im Renderer genutzt.
// Das Skript im Webview (lib/youtube-mini-page.js) bringt eine eigene, gleich aufgebaute Prüfung mit, weil es als Text in die Seite geht.

'use strict';

const { isYouTubeHost } = require('./youtube-adblock.js');

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function parseHttp(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch (_) {
    return null;
  }
}

function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}

/** Kanonische Wiedergabe-Adresse einer Video-ID (ohne Playlist- und Zeitparameter). */
function watchUrl(videoId) {
  if (!isVideoId(videoId)) throw new Error('Ungültige Video-ID');
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Vorschaubild (https://i.ytimg.com), die CSP der App erlaubt https-Bilder. */
function thumbnailUrl(videoId) {
  if (!isVideoId(videoId)) return '';
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * Art einer Adresse:
 *  - 'watch'    Video (youtube.com/watch?v=ID, /live/ID, youtu.be/ID) → videoId, url (kanonisch)
 *  - 'browse'   andere YouTube-Seite (Start, Suche, Kanal, Shorts, Abos ...)
 *  - 'external' alles andere (auch youtube-nocookie.com), 'invalid' kein http(s)
 */
function classifyYoutubeUrl(value) {
  const u = parseHttp(value);
  if (!u) return { kind: 'invalid', url: '', videoId: '' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return isVideoId(id) ? { kind: 'watch', url: watchUrl(id), videoId: id } : { kind: 'external', url: u.href, videoId: '' };
  }
  if (!isYouTubeHost(host) || host.endsWith('youtube-nocookie.com')) return { kind: 'external', url: u.href, videoId: '' };
  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v');
    return isVideoId(id) ? { kind: 'watch', url: watchUrl(id), videoId: id } : { kind: 'browse', url: u.href, videoId: '' };
  }
  const live = /^\/live\/([^/]+)/.exec(u.pathname);
  if (live && isVideoId(live[1])) return { kind: 'watch', url: watchUrl(live[1]), videoId: live[1] };
  return { kind: 'browse', url: u.href, videoId: '' };
}

module.exports = { VIDEO_ID_PATTERN, isVideoId, watchUrl, thumbnailUrl, classifyYoutubeUrl };
