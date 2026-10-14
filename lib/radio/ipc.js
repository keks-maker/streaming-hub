'use strict';

// IPC für Radio (Konzept §7): alle radio:*-Kanäle mit Absenderprüfung (nur Hauptfenster) und Schema-Validierung;
// die Nachrichten des unsichtbaren Player-Fensters (radio-player:report) werden nur vom Player-WebContents
// angenommen und auf eine Whitelist normalisiert. Zustandsänderungen gehen als Event radio:state an das Hauptfenster.

const {
  radioStation: validateRadioStation,
  radioStationUpdates: validateRadioStationUpdates,
  radioStationOverride: validateRadioStationOverride,
  radioStreamUrlError,
  favoriteOrder: validateFavoriteOrder,
  text: validateText,
} = require('../input-validation.js');
const {
  validateNoPayload,
  validateRadioStationKey,
  validateRadioPlay,
  validateRadioVolume,
  validateRadioFavoriteFlag,
  validateRadioSettingsPatch,
  validateRadioFindLogo,
  normalizeRadioPlayerReport,
} = require('../ipc-validation.js');
const { probeStream } = require('./radio-resolve.js');
const { CUSTOM_SOURCE_ID } = require('./radio-sources-logic.js');

/**
 * options:
 * - ipcMain, controller, library
 * - requireMainRenderer(event): wirft bei nicht autorisiertem Absender
 * - sendToMain(channel, payload): Event an das Hauptfenster (falls vorhanden)
 * - probe(url): Auflösung + Verbindungstest (Standard: probeStream)
 * - findLogo(homepage): Logo-Suche (radio-logo-finder.js, im Main verdrahtet) -> { logo, source }
 * - onSettingsChanged(settings): nach gespeicherten Wiedergabe-Optionen (z. B. Tray-Anzeige neu bewerten)
 * - refreshStreams(): „Liste aktualisieren“ (radio-refresh.js, Netzwerk im Main verdrahtet), logger
 */
function registerRadioIpc({ ipcMain, controller, library, requireMainRenderer, sendToMain, probe = probeStream, findLogo = null, refreshStreams = null, onSettingsChanged = null, logger = null }) {
  const main = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event);
      return handler(...args);
    });
  };
  const findingByWindow = new WeakSet(); // Doppelstart-Schutz der Logo-Suche pro Absender-Fenster
  const broadcastSources = sources => {
    sendToMain('radio:sources-changed', sources);
    return sources;
  };

  main('radio:get-sources', (...rest) => {
    validateNoPayload(rest);
    return library.getSources();
  });
  main('radio:add-custom', input => {
    const result = library.addCustom(validateRadioStation(input));
    broadcastSources(result.sources);
    return result;
  });
  main('radio:update-custom', (id, patch) => {
    const stationId = validateText(id, 'Sender-ID', 500);
    return broadcastSources(library.updateCustom(stationId, validateRadioStationUpdates(patch)));
  });
  main('radio:remove-custom', id => {
    const stationId = validateText(id, 'Sender-ID', 500);
    const current = controller.getState().station;
    const sources = library.removeCustom(stationId);
    // Läuft der gelöschte Sender gerade, wird die Wiedergabe beendet
    if (current && current.sourceId === CUSTOM_SOURCE_ID && current.id === stationId) controller.stop();
    return broadcastSources(sources);
  });
  main('radio:set-favorite', (key, favorite) => {
    const { sourceId, stationId } = validateRadioStationKey(key);
    return broadcastSources(library.setFavorite(sourceId, stationId, validateRadioFavoriteFlag(favorite)));
  });
  main('radio:set-override', (key, patch) => {
    const { sourceId, stationId } = validateRadioStationKey(key);
    return broadcastSources(library.setOverride(sourceId, stationId, validateRadioStationOverride(patch)));
  });
  main('radio:clear-override', key => {
    const { sourceId, stationId } = validateRadioStationKey(key);
    return broadcastSources(library.clearOverride(sourceId, stationId));
  });
  main('radio:set-favorite-order', order => broadcastSources(library.setFavoriteOrder(validateFavoriteOrder(order))));

  main('radio:play', key => controller.play(validateRadioPlay(key)));
  main('radio:pause', (...rest) => {
    validateNoPayload(rest);
    return controller.pause();
  });
  main('radio:stop', (...rest) => {
    validateNoPayload(rest);
    return controller.stop();
  });
  main('radio:next', (...rest) => {
    validateNoPayload(rest);
    return controller.next();
  });
  main('radio:prev', (...rest) => {
    validateNoPayload(rest);
    return controller.prev();
  });
  main('radio:set-volume', value => controller.setVolume(validateRadioVolume(value)));
  main('radio:get-settings', (...rest) => {
    validateNoPayload(rest);
    return library.getSettings();
  });
  main('radio:set-settings', patch => {
    const next = library.updateSettings(validateRadioSettingsPatch(patch));
    if (typeof onSettingsChanged === 'function') {
      try {
        onSettingsChanged(next);
      } catch (error) {
        if (logger) logger.warn('Radio-Einstellungen: Folgeaktion fehlgeschlagen:', error.message);
      }
    }
    return next;
  });
  main('radio:get-state', (...rest) => {
    validateNoPayload(rest);
    return controller.getState();
  });

  let probing = false;
  main('radio:probe', async url => {
    const error = radioStreamUrlError(url);
    if (error) return { ok: false, error };
    if (probing) return { ok: false, error: 'Es läuft bereits eine Prüfung' };
    probing = true;
    try {
      return await probe(url);
    } finally {
      probing = false;
    }
  });

  ipcMain.handle('radio:find-logo', async (event, ...args) => {
    requireMainRenderer(event);
    if (args.length !== 1) throw new Error('Logo-Suche ist ungültig');
    const query = validateRadioFindLogo(args[0]);
    if (typeof findLogo !== 'function') return { ok: false, error: 'Logo-Suche nicht verfügbar' };
    if (findingByWindow.has(event.sender)) return { ok: false, error: 'Es läuft bereits eine Logo-Suche' };
    findingByWindow.add(event.sender);
    try {
      let homepage = query.homepage || null;
      if (!homepage) {
        // Webseite aus dem ICY-Header des Streams; keine Ableitung aus dem Stream-Host (CDN-Hosts liefern falsche Logos)
        const probed = await probe(query.streamUrl);
        homepage = (probed && probed.ok && probed.homepage) || null;
        if (!homepage) return { ok: true, logo: null, source: null, homepage: null, reason: 'no-homepage' };
      }
      const found = await findLogo(homepage);
      return { ok: true, logo: found.logo || null, source: found.source || null, homepage };
    } catch (error) {
      if (logger) logger.warn('Radio: Logo-Suche fehlgeschlagen:', error.message);
      return { ok: false, error: error.message || 'Logo-Suche fehlgeschlagen' };
    } finally {
      findingByWindow.delete(event.sender);
    }
  });

  let refreshing = false;
  main('radio:refresh-stream-urls', async (...rest) => {
    validateNoPayload(rest);
    if (typeof refreshStreams !== 'function') return { ok: false, error: 'Aktualisierung nicht verfügbar' };
    if (refreshing) return { ok: false, error: 'Es läuft bereits eine Aktualisierung' };
    refreshing = true;
    try {
      const summary = await refreshStreams();
      broadcastSources(library.getSources());
      return { ok: true, ...summary };
    } catch (error) {
      if (logger) logger.warn('Radio: Liste aktualisieren fehlgeschlagen:', error.message);
      return { ok: false, error: 'Senderverzeichnis nicht erreichbar' };
    } finally {
      refreshing = false;
    }
  });

  ipcMain.on('radio-player:report', (event, message) => {
    const player = controller.playerWebContents();
    if (!player || event.sender !== player) return;
    const report = normalizeRadioPlayerReport(message);
    if (!report) {
      if (logger) logger.warn('Ungültige Nachricht vom Radio-Player verworfen');
      return;
    }
    controller.onPlayerReport(report);
  });

  controller.on('state', state => sendToMain('radio:state', state));
}

module.exports = { registerRadioIpc };
