// Stream-Auflösung geplanter Aufnahmen (Konzept §3.3), aus main.js extrahiert
// (Etappe 2b) damit sie ohne Electron testbar ist.
//
// Beim Start einer geplanten Aufnahme wird die Stream-URL FRISCH aus der
// Senderliste aufgelöst: Quelle laden, Overrides (tvsources.json) anwenden, Kanal
// über Kanal-ID bzw. tvg-id finden. Der URL-Snapshot am Planungseintrag gilt nur
// als Fallback, wenn die Quelle nicht geladen werden kann (Netz weg). Fehlt der
// Kanal in der geladenen Liste → ok:false mit lesbarer Meldung.
//
// Abhängigkeiten werden injiziert: loadTvSources(), loadM3uChannels(urlOrPath) →
// { channels, baseUrl }, applyChannelOverrides(channels, source),
// describeM3uFetchError(err) (nur feste Texte, nie URL/Zugangsdaten), logger.

'use strict';

function createStreamResolver({ loadTvSources, loadM3uChannels, applyChannelOverrides, describeM3uFetchError, logger = null }) {
  const warn = (...args) => {
    if (logger && typeof logger.warn === 'function') logger.warn(...args);
  };

  return async function resolveScheduledStream({ sourceId, channelId, tvgId, channelName, sourceUrlSnapshot }) {
    const sources = loadTvSources();
    const candidates = sourceId ? sources.filter(s => s.id === sourceId) : sources;
    const label = channelName || channelId || 'Der Sender';
    if (!candidates.length) {
      return { ok: false, message: `Die TV-Quelle von „${label}“ existiert nicht mehr.` };
    }
    let loadFailed = false;
    for (const source of candidates) {
      let loaded;
      try {
        loaded = await loadM3uChannels(source.url);
      } catch (err) {
        loadFailed = true;
        warn('[schedule] Senderliste nicht ladbar:', source.name, describeM3uFetchError(err));
        continue;
      }
      const channels = applyChannelOverrides(loaded.channels, { ...source, baseUrl: loaded.baseUrl });
      const found =
        channels.find(c => c.id === channelId) || (tvgId ? channels.find(c => c.tvgId && c.tvgId === tvgId) : null);
      if (found && typeof found.url === 'string' && /^https?:\/\//i.test(found.url)) {
        return { ok: true, url: found.url, channelName: found.name || channelName };
      }
    }
    if (loadFailed && sourceUrlSnapshot) {
      warn('[schedule] Senderliste nicht erreichbar — nutze gespeicherte Stream-URL als Fallback:', label);
      return { ok: true, url: sourceUrlSnapshot, channelName };
    }
    if (loadFailed) {
      return { ok: false, message: `Die Senderliste konnte nicht geladen werden — „${label}“ wurde nicht gestartet.` };
    }
    return { ok: false, message: `„${label}“ ist nicht mehr in der Senderliste — die geplante Aufnahme wurde nicht gestartet.` };
  };
}

module.exports = { createStreamResolver };
