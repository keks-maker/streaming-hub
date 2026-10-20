'use strict';

// Netzregeln der Downloads: Host-Allowlist wie lib/mediathek/http.js (API- und Manifest-Hosts), für ARD zusätzlich gezielt die
// CDN-Domains der Landesrundfunkanstalten (progressive MP4-Dateien liegen dort); nie "alles offen". Abrufe prüfen außerdem die
// Ziel-IP (net-safety.js), damit keine Adresse im lokalen Netz erreicht wird.

const { isAllowedFetchUrl } = require('../mediathek/sources.js');
const { assertPublicUrl } = require('../net-safety.js');

/** CDN-Domains der ARD-Anstalten (Endung mit führendem Punkt), nur für Beiträge der Quelle ARD. */
const ARD_CDN_SUFFIXES = ['.br.de', '.ndr.de', '.swr.de', '.wdr.de', '.mdr.de', '.hr.de', '.sr.de', '.rbb-online.de', '.radiobremen.de', '.ard.de', '.tagesschau.de', '.kika.de'];

/** true für https-Adressen, die ein Download der Quelle lesen darf. */
function isAllowedDownloadUrl(value, sourceId) {
  if (isAllowedFetchUrl(value)) return true;
  if (sourceId !== 'ard') return false;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password && ARD_CDN_SUFFIXES.some(suffix => url.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Wirft code 'forbidden-host', wenn die Adresse nicht erlaubt ist, und code 'forbidden-address' bei Zielen im lokalen Netz. */
async function assertDownloadUrl(value, sourceId, { allowUrl = isAllowedDownloadUrl, assertPublic = assertPublicUrl } = {}) {
  if (!allowUrl(value, sourceId)) throw Object.assign(new Error('Adresse nicht erlaubt'), { code: 'forbidden-host' });
  try {
    await assertPublic(value);
  } catch {
    throw Object.assign(new Error('Adresse nicht erlaubt'), { code: 'forbidden-address' });
  }
}

module.exports = { ARD_CDN_SUFFIXES, isAllowedDownloadUrl, assertDownloadUrl };
