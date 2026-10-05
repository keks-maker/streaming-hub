// IPC für die Programmführer-Einstellungen (Etappe 3.5, P20) — Muster wie recording:get/set-settings.
//
// Kanäle: epg-view:get-settings → { startView }, epg-view:set-settings(patch) → { startView }.
// Beide hinter requireMainRenderer; der Patch wird in lib/ipc-validation.js gegen die feste Menge
// geprüft, nur normalisierte Werte werden gespeichert (nie das rohe Argument).

'use strict';

const { validateEpgViewSettingsPatch } = require('./ipc-validation.js');
const { normalizeEpgViewSettings } = require('./epg-view-settings.js');

const STORAGE_KIND = 'epgViewSettings';

function registerEpgViewSettingsIpc({ ipcMain, storage, requireMainRenderer }) {
  if (!ipcMain || !storage || typeof requireMainRenderer !== 'function') {
    throw new Error('registerEpgViewSettingsIpc benötigt ipcMain, storage und requireMainRenderer');
  }

  function load() {
    try {
      return normalizeEpgViewSettings(storage.readJson(STORAGE_KIND, null));
    } catch (_) {
      return normalizeEpgViewSettings(null); // unlesbare Datei → Standard, kein Absturz
    }
  }

  ipcMain.handle('epg-view:get-settings', event => {
    requireMainRenderer(event);
    return load();
  });

  ipcMain.handle('epg-view:set-settings', (event, patch) => {
    requireMainRenderer(event);
    const valid = validateEpgViewSettingsPatch(patch);
    const next = { ...load(), ...valid };
    storage.writeJson(STORAGE_KIND, next);
    return next;
  });
}

module.exports = { registerEpgViewSettingsIpc };
