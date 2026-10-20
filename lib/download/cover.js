'use strict';

// Cover-Abruf für NFO/Cover (poster.jpg): nur https, Host-Allowlist der Mediathek (Bilder liegen bei denselben Anbietern), Ziel-IP-
// Filter, Größenlimit und Prüfung der Dateikennung (JPEG/PNG). Fehler ergeben null, nie einen Abbruch des Downloads.

const { nodeFetch, fetchFollow, readLimited, discardBody, withDeadline } = require('../radio/radio-http.js');
const { createSafeLookup } = require('../net-safety.js');
const { isAllowedDownloadUrl } = require('./net.js');
const { USER_AGENT } = require('../mediathek/http.js');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;

/** 'jpg' | 'png' nach Dateikennung, sonst null. */
function imageExtension(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

function createCoverFetcher({ fetchImpl = nodeFetch, lookup = createSafeLookup(), timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  return async function fetchCover(url, sourceId) {
    try {
      const guardUrl = target => {
        if (!isAllowedDownloadUrl(target, sourceId)) throw new Error('Adresse nicht erlaubt');
      };
      guardUrl(url);
      const result = await withDeadline(timeoutMs, async signal => {
        const { response } = await fetchFollow(url, { fetchImpl, signal, headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' }, maxRedirects: 3, lookup, guardUrl });
        if (response.status !== 200) {
          await discardBody(response);
          return null;
        }
        return readLimited(response, maxBytes);
      });
      if (!result || result.truncated) return null;
      const ext = imageExtension(result.buffer);
      return ext ? { ext, data: result.buffer } : null;
    } catch {
      return null;
    }
  };
}

module.exports = { createCoverFetcher, imageExtension };
