'use strict';

// IPC für Radio (Konzept §7): alle radio:*-Kanäle mit Absenderprüfung (nur Hauptfenster) und Schema-Validierung;
// die Nachrichten des unsichtbaren Player-Fensters (radio-player:report) werden nur vom Player-WebContents
// angenommen und auf eine Whitelist normalisiert. Zustandsänderungen gehen als Event radio:state an das Hauptfenster.

const {
  radioStation: validateRadioStation,
  radioStationUpdates: validateRadioStationUpdates,
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
  normalizeRadioPlayerReport,
} = require('../ipc-validation.js');
const { probeStream } = require('./radio-resolve.js');
const { CUSTOM_SOURCE_ID } = require('./radio-sources-logic.js');

/**
 * options:
 * - ipcMain, controller, library
 * - requireMainRenderer(event): wirft bei nicht autorisiertem Absender
 * - sendToMain(channel, payload): Event an das Hauptfenster (falls vorhanden)
 * - probe(url): Auflösung + Verbindungstest (Standard: probeStream), logger
 */
function registerRadioIpc({ ipcMain, controller, library, requireMainRenderer, sendToMain, probe = probeStream, logger = null }) {
  const main = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event);
      return handler(...args);
    });
  };
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
