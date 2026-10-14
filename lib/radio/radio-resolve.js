'use strict';

// Playlist-Auflösung für Radio (Main-Prozess, rein + testbar): .pls, .m3u, .asx, direkter Stream, HLS.
// Ergebnis { streamUrl, kind: 'direct'|'hls', contentType, via }. Globaler fetch (injizierbar) mit
// AbortController-Gesamt-Timeout, Größenlimit für Playlists, begrenzten Redirects und Playlist-Tiefe.
// Messung R0: Content-Type vor dem Parsen prüfen, da manche "-pls"-URLs direkt Audio liefern.

const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  parseHttpUrl,
  withDeadline,
  fetchFollow,
  nodeFetch,
  discardBody,
  readLimited,
} = require('./radio-http.js');

const MAX_PLAYLIST_DEPTH = 3;
const PROBE_BYTES = 4096;

const PLAYLIST_TYPE = /mpegurl|scpls|pls\+xml|x-ms-asf|text\/|application\/(octet-stream|xml|x-mpegurl)/;
const PLAYLIST_EXT = /\.(pls|m3u8?|asx)(\?|#|$)/i;
const AUDIO_TYPE = /^audio\/|^application\/ogg|^video\/ogg/;

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 512);
  if (!sample.length) return false;
  let odd = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) odd += 1;
  }
  return odd / sample.length > 0.1;
}

/**
 * Erkennt Playlist-Formate im Text. Rückgabe { type: 'hls' } | { type: 'pls'|'asx'|'m3u', url } | null.
 * Die URL kann relativ sein (Auflösung gegen die Playlist-Adresse erledigt der Aufrufer).
 */
function parsePlaylist(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  if (/^\s*#EXTM3U/i.test(text) && /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(text)) return { type: 'hls' };
  if (/^\s*\[playlist\]/im.test(text) || /^File\d+=/im.test(text)) {
    const match = text.match(/^File\d+=(\S+)/im);
    return match ? { type: 'pls', url: match[1].trim() } : null;
  }
  if (/<asx/i.test(text)) {
    const match = text.match(/<ref[^>]+href\s*=\s*["']([^"']+)["']/i);
    return match ? { type: 'asx', url: match[1].trim() } : null;
  }
  if (/^\s*</.test(text)) return null; // Markup (z. B. HTML-Fehlerseite), keine Playlist
  // m3u: erste Nicht-Kommentarzeile, absolute http(s)-Adresse oder relativer Pfad ohne Leerzeichen/Schema
  const line = text
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .find(entry => entry && !entry.startsWith('#'));
  if (line && !/^https?:\/\/\S+$/i.test(line) && !/^(?![a-z][a-z0-9+.-]*:)[^\s<>]+$/i.test(line)) return null;
  return line ? { type: 'm3u', url: line } : null;
}

/** Webseite aus dem ICY-Header icy-url: nur http/https ohne Zugangsdaten, sonst undefined. */
function icyHomepage(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 2000) return undefined;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function optionsFrom(options = {}) {
  return {
    fetchImpl: options.fetch || nodeFetch,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes || DEFAULT_MAX_BYTES,
    maxRedirects: options.maxRedirects === undefined ? DEFAULT_MAX_REDIRECTS : options.maxRedirects,
    maxDepth: options.maxDepth === undefined ? MAX_PLAYLIST_DEPTH : options.maxDepth,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  };
}

async function resolveStep(url, opts, signal, depth, via) {
  const { response, finalUrl } = await fetchFollow(url, {
    fetchImpl: opts.fetchImpl,
    signal,
    maxRedirects: opts.maxRedirects,
  });
  if (response.status >= 400) {
    await discardBody(response);
    throw new Error(`Server antwortet mit HTTP ${response.status}`);
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  const hasIcyHeader = Boolean(response.headers.get('icy-name') || response.headers.get('icy-metaint'));
  const playlistHint = PLAYLIST_TYPE.test(contentType) || PLAYLIST_EXT.test(finalUrl);
  const audioType = AUDIO_TYPE.test(contentType) || (contentType === '' && hasIcyHeader);
  if (audioType && !playlistHint) {
    await discardBody(response);
    return { streamUrl: finalUrl, kind: 'direct', contentType, via };
  }
  if (depth >= opts.maxDepth) {
    await discardBody(response);
    throw new Error('Playlist ist zu tief verschachtelt');
  }
  const { buffer } = await readLimited(response, opts.maxBytes);
  if (looksBinary(buffer)) {
    // Audio-Daten ohne passenden Content-Type (z. B. application/octet-stream)
    return { streamUrl: finalUrl, kind: 'direct', contentType, via };
  }
  const playlist = parsePlaylist(buffer.toString('utf8'));
  if (!playlist) throw new Error('Keine Playlist erkannt');
  if (playlist.type === 'hls') return { streamUrl: finalUrl, kind: 'hls', contentType, via };
  let next;
  try {
    next = parseHttpUrl(new URL(playlist.url, finalUrl)).toString();
  } catch {
    throw new Error('Playlist enthält keine gültige http/https-Adresse');
  }
  return resolveStep(next, opts, signal, depth + 1, [...via, playlist.type]);
}

/**
 * Löst eine Eingabe-URL zum abspielbaren Stream auf.
 * options: fetch, timeoutMs (Gesamt-Timeout), maxBytes (Playlist-Limit), maxRedirects, maxDepth.
 */
async function resolveStream(inputUrl, options) {
  const opts = optionsFrom(options);
  parseHttpUrl(inputUrl);
  return withDeadline(opts.timeoutMs, signal => resolveStep(inputUrl, opts, signal, 0, []), opts);
}

/**
 * Auflösung + kurzer Verbindungstest (Einstellungen: „Stream prüfen“). Wirft nie:
 * { ok: true, streamUrl, kind, contentType, bytes?, icyName?, bitrate?, homepage? (icy-url) } | { ok: false, error }.
 */
async function probeStream(inputUrl, options) {
  const opts = optionsFrom(options);
  try {
    parseHttpUrl(inputUrl);
    return await withDeadline(
      opts.timeoutMs,
      async signal => {
        const resolved = await resolveStep(inputUrl, opts, signal, 0, []);
        if (resolved.kind === 'hls') return { ok: true, ...resolved };
        const { response } = await fetchFollow(resolved.streamUrl, { fetchImpl: opts.fetchImpl, signal, maxRedirects: opts.maxRedirects });
        if (response.status >= 400) {
          await discardBody(response);
          throw new Error(`Server antwortet mit HTTP ${response.status}`);
        }
        const icyName = response.headers.get('icy-name') || undefined;
        const bitrate = response.headers.get('icy-br') || undefined;
        const homepage = icyHomepage(response.headers.get('icy-url'));
        const { buffer } = await readLimited(response, PROBE_BYTES);
        if (!buffer.length) throw new Error('Stream liefert keine Daten');
        return { ok: true, ...resolved, bytes: buffer.length, ...(icyName ? { icyName } : {}), ...(bitrate ? { bitrate } : {}), ...(homepage ? { homepage } : {}) };
      },
      opts
    );
  } catch (error) {
    return { ok: false, error: error.message || 'Stream nicht erreichbar' };
  }
}

module.exports = { resolveStream, probeStream, icyHomepage, parsePlaylist, MAX_PLAYLIST_DEPTH };
