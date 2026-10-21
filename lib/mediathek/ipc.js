'use strict';

// IPC der nativen Mediathek (Muster lib/podcast/ipc.js): alle mediathek:*-Kanäle nur für das Hauptfenster
// (requireMainRenderer) mit Schema-Prüfung (validation.js). Netzwerk läuft im Main-Prozess, nie im Renderer. Fachliche Fehler
// (Quelle nicht erreichbar, ...) kommen als { ok: false, error, code } zurück; ungültige Eingaben werfen.
//
// Kanäle (Eingabe -> Ergebnis):
//   mediathek:home            { source }                         -> { ok, sections }
//   mediathek:search          { query, source, page? }           -> { ok, series, entries, page, hasMore }
//   mediathek:series          { series }                         -> { ok, seasons, seasonNumbers, playTarget, favorite }
//   mediathek:genre           { genre }                          -> { ok, sections }
//   mediathek:load-more       { section: { title, nextPage } }   -> { ok, section }
//   mediathek:resolve-playback { entry, series? }                -> { ok, resolution, regionRestricted, message, startPosition, webUrl }
//   mediathek:favorites-get   -                                  -> { ok, series }
//   mediathek:favorites-toggle { series }                        -> { ok, favorite, series }   (+ Event mediathek:favorites-changed)
//   mediathek:watch-progress  { sourceId, title, position, duration } -> { ok }
//   mediathek:get-progress    { sourceId, title }                -> { ok, progress: { position, duration, start } | null }
//   mediathek:resume-list     -                                  -> { ok, items }   (Weiterschauen: begonnene, nicht beendete Beiträge)
//   mediathek:get-settings    -                                  -> { ok, settings }
//   mediathek:set-settings    { ...Teiländerung }                -> { ok, settings }   (+ Event mediathek:settings-changed)

const { validateNoPayload } = require('../ipc-validation.js');
const v = require('./validation.js');
const { groupBySeason } = require('./entries.js');
const { seasonNumbers, playTarget } = require('./series-page.js');
const { ageRestrictedMessage, accountNote } = require('./restrictions.js');
const { webUrl } = require('./sources.js');

/** Weblinks gehen im Renderer an die Navigation: nur https, sonst verworfen. */
function httpsOnly(url) {
  try {
    return typeof url === 'string' && new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
const { normalizeMediathekSettings } = require('./settings.js');
const { isResumable, progressFraction, shelfKey } = require('./resume.js');

const RESOLUTION_MESSAGES = {
  geoBlocked: 'Dieser Beitrag ist in deiner Region nicht abrufbar (Geoblock).',
  unavailable: 'Stream nicht verfügbar (abgelaufen oder vom Anbieter gesperrt).',
};

/**
 * options: ipcMain, service (createMediathekService), favorites (createMediathekFavorites), watchProgress (createWatchProgress),
 * requireMainRenderer(event), sendToMain(channel, payload), logger.
 */
function registerMediathekIpc({ ipcMain, service, favorites, watchProgress, settings = null, requireMainRenderer, sendToMain, logger = null }) {
  const main = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event);
      return handler(...args);
    });
  };
  // Fachliche Fehler (Netz, Quelle) als Ergebnis statt als Exception; Details ins Log, nie Adressen an den Renderer
  const guarded = async run => {
    try {
      return { ok: true, ...(await run()) };
    } catch (error) {
      if (logger && error && error.code === 'network') logger.warn('Mediathek-Abruf fehlgeschlagen:', error.message);
      return { ok: false, error: (error && error.message) || 'Mediathek konnte nicht geladen werden', code: (error && error.code) || 'error' };
    }
  };

  main('mediathek:home', value => {
    const { source } = v.validateHome(value);
    return guarded(async () => ({ sections: await service.fetchHomeSections(source) }));
  });

  main('mediathek:search', value => {
    const { query, source, page } = v.validateSearch(value);
    return guarded(async () => service.searchPage(query, source, page));
  });

  main('mediathek:series', value => {
    const { series } = v.validateSeriesRequest(value);
    return guarded(async () => {
      const seasons = groupBySeason(await service.fetchEpisodes(series));
      return { seasons, seasonNumbers: seasonNumbers(seasons), playTarget: playTarget(seasons, series, watchProgress), favorite: favorites.isFavorite(series.id, series.sourceId) };
    });
  });

  main('mediathek:genre', value => {
    const { genre } = v.validateGenre(value);
    return guarded(async () => ({ sections: await service.fetchGenrePage(genre) }));
  });

  main('mediathek:load-more', value => {
    const { section } = v.validateLoadMore(value);
    return guarded(async () => ({ section: await service.fetchMore(section) }));
  });

  // Stream frisch auflösen (Adressen laufen ab); bei abspielbarem Stream Verlauf schreiben und Startposition mitliefern
  main('mediathek:resolve-playback', value => {
    const { entry, series } = v.validateResolvePlayback(value);
    return guarded(async () => {
      const { resolution, regionRestricted } = await service.resolveStreamDetail(entry);
      let message = null;
      let startPosition = null;
      if (resolution.kind === 'playable') {
        const saved = watchProgress.progress(entry.sourceId, entry.title);
        startPosition = saved ? saved.start : null;
        watchProgress.record({ entry, series, url: resolution.url });
      } else if (resolution.kind === 'ageRestricted') {
        message = accountNote(ageRestrictedMessage(resolution.rating), resolution.account, entry.sourceId);
      } else {
        message = RESOLUTION_MESSAGES[resolution.kind] || RESOLUTION_MESSAGES.unavailable;
      }
      return { resolution, regionRestricted, message, startPosition, webUrl: httpsOnly(webUrl(entry)) };
    });
  });

  main('mediathek:favorites-get', (...rest) => {
    validateNoPayload(rest);
    return { ok: true, series: favorites.list() };
  });

  main('mediathek:favorites-toggle', value => {
    const { series } = v.validateFavoriteToggle(value);
    const result = favorites.toggle(series);
    sendToMain('mediathek:favorites-changed', result.series);
    return { ok: true, ...result };
  });

  main('mediathek:watch-progress', value => {
    const input = v.validateWatchProgress(value);
    return { ok: watchProgress.updateProgress(input) };
  });

  main('mediathek:get-progress', value => {
    const { sourceId, title } = v.validateProgressQuery(value);
    return { ok: true, progress: watchProgress.progress(sourceId, title) };
  });

  // Weiterschauen: begonnene, nicht beendete Beiträge, je Serie nur der jüngste (Reihenfolge = Verlauf, neueste zuerst)
  main('mediathek:resume-list', (...rest) => {
    validateNoPayload(rest);
    const seen = new Set();
    const items = [];
    for (const item of watchProgress.entries()) {
      if (!isResumable(item)) continue;
      const key = shelfKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        title: item.title,
        sourceId: String(item.serviceKey).replace(/^mediathek:/, ''),
        imageUrl: item.imageUrl || null,
        series: item.series || null,
        fraction: progressFraction(item),
        position: item.positionSeconds,
        duration: item.durationSeconds,
      });
    }
    return { ok: true, items };
  });

  main('mediathek:get-settings', (...rest) => {
    validateNoPayload(rest);
    return { ok: true, settings: settings ? settings.get() : normalizeMediathekSettings(null) };
  });

  main('mediathek:set-settings', patch => {
    if (!settings) throw new Error('Einstellungen nicht verfügbar');
    const next = settings.update(patch);
    sendToMain('mediathek:settings-changed', next);
    return { ok: true, settings: next };
  });
}

module.exports = { registerMediathekIpc };
