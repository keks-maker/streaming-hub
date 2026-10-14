'use strict';

// Persistenz-Fassade für Radio: Senderlisten (radiosources.json) und Einstellungen (radio-settings.json) über
// den user-storage. Die Logik liegt in radio-sources-logic.js; hier nur Lesen/Schreiben und Abwehr kaputter Dateien.
// Eingaben werden von den IPC-Handlern vorab validiert (input-validation.js).

const logic = require('./radio-sources-logic.js');
const { normalizeRadioSettings, applyRadioSettingsPatch } = require('./radio-settings.js');

class RadioLibrary {
  /** options: userStorage ({ readJson, writeJson }), logger, idFactory (Tests) */
  constructor({ userStorage, logger = null, idFactory } = {}) {
    if (!userStorage) throw new Error('RadioLibrary benötigt userStorage');
    this.userStorage = userStorage;
    this.logger = logger;
    this.idFactory = idFactory;
  }

  getSources() {
    let sources;
    try {
      sources = this.userStorage.readJson('radioSources', []);
    } catch (error) {
      if (this.logger) this.logger.warn('Radio-Sender konnten nicht geladen werden:', error.message);
      sources = [];
    }
    return logic.ensureCustomSource(Array.isArray(sources) ? sources : []);
  }

  saveSources(sources) {
    this.userStorage.writeJson('radioSources', sources);
    return sources;
  }

  addCustom(input) {
    const result = logic.addCustomStation(this.getSources(), input, this.idFactory ? { idFactory: this.idFactory } : undefined);
    this.saveSources(result.sources);
    return result;
  }

  updateCustom(stationId, patch) {
    return this.saveSources(logic.updateCustomStation(this.getSources(), stationId, patch));
  }

  removeCustom(stationId) {
    return this.saveSources(logic.removeCustomStation(this.getSources(), stationId));
  }

  setFavorite(sourceId, stationId, favorite) {
    const before = this.getSources();
    const after = logic.setStationFavorite(before, sourceId, stationId, favorite);
    return after === before ? before : this.saveSources(after);
  }

  setFavoriteOrder(list) {
    return this.saveSources(logic.setFavoriteOrder(this.getSources(), list));
  }

  /** Effektiver Sender (mit Overrides) oder null. */
  getStation(key) {
    return logic.findStation(this.getSources(), key);
  }

  /** Favoriten in globaler Reihenfolge als [{ sourceId, id }]. */
  getFavoriteKeys() {
    return logic.favoriteKeys(this.getSources());
  }

  getSettings() {
    try {
      return normalizeRadioSettings(this.userStorage.readJson('radioSettings', {}));
    } catch (error) {
      if (this.logger) this.logger.warn('Radio-Einstellungen konnten nicht geladen werden:', error.message);
      return normalizeRadioSettings({});
    }
  }

  updateSettings(patch) {
    const next = applyRadioSettingsPatch(this.getSettings(), patch);
    this.userStorage.writeJson('radioSettings', next);
    return next;
  }
}

module.exports = { RadioLibrary };
