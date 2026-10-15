'use strict';

// Feed-Abruf im Main-Prozess (Konzept §2/§6): Transport wie Radio (nodeFetch aus radio-http.js, manuelle Redirects mit
// Prüfung jedes Ziels, hartes Zeitlimit). Ergänzt um bedingte Requests (ETag/If-Modified-Since -> 304), gzip/deflate/br
// (nodeFetch dekomprimiert nicht selbst; Ausgabegröße begrenzt, damit keine Dekompressions-Bombe möglich ist) und die
// Zeichensatz-Erkennung. Fehlermeldungen enthalten nie die Feed-URL (private Feeds können Token in der Adresse tragen).

const zlib = require('node:zlib');
const { TextDecoder } = require('node:util');
const { nodeFetch, fetchFollow, readLimited, discardBody, withDeadline } = require('../radio/radio-http.js');

const MAX_FEED_BYTES = 20 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const FEED_ACCEPT = 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';
const USER_AGENT = 'StreamingHub-Podcasts/1.0 (+https://github.com/keks-maker/streaming-hub)';

function decompress(buffer, encoding, maxBytes) {
  const options = { maxOutputLength: maxBytes };
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buffer, options);
    if (encoding === 'deflate') return zlib.inflateSync(buffer, options);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer, options);
  } catch (error) {
    if (error && error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Feed ist zu groß');
    throw new Error('Feed konnte nicht entpackt werden');
  }
  if (!encoding || encoding === 'identity') return buffer;
  throw new Error('Nicht unterstützte Kompression des Feeds');
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(buffer.subarray(0, 200).toString('latin1'));
  if (declared && !/^utf-?8$/i.test(declared[1])) {
    try {
      return new TextDecoder(declared[1]).decode(buffer);
    } catch {
      // unbekannter Zeichensatz: als UTF-8 lesen
    }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/**
 * Lädt einen Feed. validators: { etag, lastModified } für den bedingten Request.
 * Ergebnis: { status: 'ok', text, etag, lastModified } oder { status: 'not-modified', etag, lastModified }.
 * Optional: accept (Accept-Header), lookup/guardUrl (Ziel-IP-Filter, lib/net-safety.js; für Adressen aus fremden Feeds).
 * Wirft Error mit lesbarer Meldung (HTTP-Fehler, Zeitüberschreitung, zu groß, Netzwerkfehler).
 */
async function fetchFeed(url, { fetchImpl = nodeFetch, validators = {}, timeoutMs = FEED_TIMEOUT_MS, maxBytes = MAX_FEED_BYTES, maxRedirects = MAX_REDIRECTS, accept = FEED_ACCEPT, lookup, guardUrl } = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: accept,
    'Accept-Encoding': 'gzip, deflate, br',
  };
  if (validators.etag) headers['If-None-Match'] = validators.etag;
  if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  return withDeadline(timeoutMs, async signal => {
    const { response } = await fetchFollow(url, { fetchImpl, signal, headers, maxRedirects, lookup, guardUrl });
    const header = name => (response.headers && response.headers.get ? response.headers.get(name) : null);
    const etag = header('etag');
    const lastModified = header('last-modified');
    if (response.status === 304) {
      await discardBody(response);
      return { status: 'not-modified', etag: etag || validators.etag || null, lastModified: lastModified || validators.lastModified || null };
    }
    if (response.status < 200 || response.status >= 300) {
      await discardBody(response);
      throw new Error(`Server antwortete mit HTTP ${response.status}`);
    }
    const declared = Number(header('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discardBody(response);
      throw new Error('Feed ist zu groß');
    }
    const { buffer, truncated } = await readLimited(response, maxBytes);
    if (truncated) throw new Error('Feed ist zu groß');
    const plain = decompress(buffer, (header('content-encoding') || '').trim().toLowerCase(), maxBytes);
    return { status: 'ok', text: decodeText(plain), etag: etag || null, lastModified: lastModified || null };
  });
}

module.exports = { fetchFeed, MAX_FEED_BYTES, FEED_TIMEOUT_MS, MAX_REDIRECTS, USER_AGENT };
