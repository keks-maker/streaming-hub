'use strict';

// Übernimmt die erste gültige EPG-URL aus dem M3U-Header (`url-tvg`) einmalig als
// `epgUrl` einer TV-Quelle, die noch keine hat. Rein (kein I/O); der Aufrufer
// persistiert und stößt den EPG-Sync an. Ein vorhandenes `epgUrl` wird nie überschrieben.
// `validateUrl` ist die Projekt-Validierung (wirft bei ungültiger URL).
function adoptHeaderEpgUrl(sources, sourceUrl, headerUrls, validateUrl) {
  if (!Array.isArray(sources) || typeof sourceUrl !== 'string' || !Array.isArray(headerUrls)) return null;
  const source = sources.find(s => s && s.url === sourceUrl);
  if (!source || source.epgUrl) return null;
  for (const candidate of headerUrls) {
    if (typeof candidate !== 'string') continue;
    let valid;
    try {
      valid = validateUrl(candidate.trim(), 'EPG-URL');
    } catch {
      continue;
    }
    if (valid) {
      source.epgUrl = valid;
      return source;
    }
  }
  return null;
}

module.exports = { adoptHeaderEpgUrl };
