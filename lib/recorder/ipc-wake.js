// IPC-Brücke „Aufwecken erlauben“ (Konzept §4.3). Kanäle: wake:get-status,
// wake:enable, wake:disable — alle hinter requireMainRenderer, ohne Nutzlast
// (der Renderer liefert nie Pfade, Zeiten oder Befehle). Broadcast: wake:changed.

'use strict';

const { validateNoPayload } = require('../ipc-validation.js');

function registerWakeIpc({ ipcMain, requireMainRenderer, helper, wake, broadcast }) {
  if (!ipcMain || !helper || !wake || typeof requireMainRenderer !== 'function') {
    throw new Error('registerWakeIpc benötigt ipcMain, helper, wake und requireMainRenderer');
  }
  const publish = () => {
    const status = wake.getStatus();
    if (typeof broadcast === 'function') broadcast('wake:changed', status);
    return status;
  };

  ipcMain.handle('wake:get-status', (event, ...rest) => {
    requireMainRenderer(event);
    validateNoPayload(rest);
    return wake.getStatus();
  });

  ipcMain.handle('wake:enable', async (event, ...rest) => {
    requireMainRenderer(event);
    validateNoPayload(rest);
    if (!helper.isSupported()) return { ok: false, error: 'Nur auf macOS verfügbar', status: wake.getStatus() };
    const result = await helper.start();
    // Nach Aktivierung sofort alle bestehenden Planungen setzen
    if (result.ok) wake.reconcile();
    return { ok: result.ok, cancelled: !!result.cancelled, error: result.error || null, status: publish() };
  });

  ipcMain.handle('wake:disable', (event, ...rest) => {
    requireMainRenderer(event);
    validateNoPayload(rest);
    wake.cancelAll();
    helper.quit();
    return { ok: true, status: publish() };
  });
}

module.exports = { registerWakeIpc };
