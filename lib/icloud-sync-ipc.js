// iCloud-Abgleich: Schalter und Statusanzeige der Einstellungen.
// Kanäle (nur Haupt-Renderer, requireMainRenderer): icloud-sync:get-status, icloud-sync:set-enabled({ enabled }) → Status
// { supported, enabled, state, message, lastSync }; Push an den Renderer: icloud-sync:status.

'use strict';

const { validateIcloudSyncPatch } = require('./ipc-validation.js');

const SETTINGS_KIND = 'icloudSyncSettings';

function readEnabled(storage) {
  try {
    const saved = storage.readJson(SETTINGS_KIND, null);
    return Boolean(saved) && saved.enabled === true;
  } catch (_) {
    return false;
  }
}

function registerIcloudSyncIpc({ ipcMain, storage, requireMainRenderer, getSync }) {
  if (!ipcMain || !storage || typeof requireMainRenderer !== 'function' || typeof getSync !== 'function') {
    throw new Error('registerIcloudSyncIpc benötigt ipcMain, storage, requireMainRenderer und getSync');
  }
  ipcMain.handle('icloud-sync:get-status', event => {
    requireMainRenderer(event);
    return getSync().getStatus();
  });
  ipcMain.handle('icloud-sync:set-enabled', async (event, patch) => {
    requireMainRenderer(event);
    const { enabled } = validateIcloudSyncPatch(patch);
    storage.writeJson(SETTINGS_KIND, { enabled });
    return getSync().setEnabled(enabled);
  });
}

module.exports = { registerIcloudSyncIpc, readEnabled };
