'use strict';

// Zusätzliche EPG-Quelle der Standard-TV-Quelle "Deutsche Öffentlich-Rechtliche".
// iptv-epg.org/epg-de.xml ist teils veraltet (ARD/ZDF/arte enden früh), epgshare01 DE1 ist aktuell.
// `epgUrls` (Liste) ergänzt `epgUrl`; beide werden vom EpgService geladen und im EpgStore zusammengeführt.
const DEFAULT_TV_SOURCE_ID = 'deutsche-oeffentlich-rechtliche';
const DEFAULT_PRIMARY_EPG_URL = 'https://iptv-epg.org/files/epg-de.xml';
const DEFAULT_EXTRA_EPG_URL = 'https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz';

/**
 * Zieht `epgUrls` bei einer bereits vorhandenen Standard-Quelle nach. Nutzereinstellungen bleiben
 * unangetastet: nur wenn die Quelle noch das unveränderte Standard-`epgUrl` hat und das Feld `epgUrls`
 * gar nicht existiert (auch eine leere Liste gilt als bewusste Einstellung). Mutiert nicht,
 * Rückgabe { sources, changed }.
 */
function migrateDefaultEpgUrls(sources) {
  if (!Array.isArray(sources)) return { sources, changed: false };
  let changed = false;
  const next = sources.map(source => {
    if (
      !source ||
      source.id !== DEFAULT_TV_SOURCE_ID ||
      source.epgUrl !== DEFAULT_PRIMARY_EPG_URL ||
      Object.prototype.hasOwnProperty.call(source, 'epgUrls')
    ) {
      return source;
    }
    changed = true;
    return { ...source, epgUrls: [DEFAULT_EXTRA_EPG_URL] };
  });
  return { sources: changed ? next : sources, changed };
}

module.exports = {
  DEFAULT_TV_SOURCE_ID,
  DEFAULT_PRIMARY_EPG_URL,
  DEFAULT_EXTRA_EPG_URL,
  migrateDefaultEpgUrls,
};
