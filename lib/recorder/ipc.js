// v0.5.8 – IPC-Brücke der Aufnahme-Engine (Aufnahme Phase 1b, t_17ee2ca5)
//
// Verdrahtet die Recorder-Kanäle mit ipcMain (Konzept §2.5):
//   recording:start, recording:stop, recording:list, recording:status
//   Progress-/Status-Events: recording:progress, recording:status,
//   recording:reconnecting, recording:changed
// Der Renderer (Folgekarte) konsumiert nur — keine Aufnahme-Logik dort.
//
// Sicherheit: requireMainRenderer (Muster main.js) — nur das Hauptfenster.
// Beim ersten recording:start wird der Speicherort eingerichtet (Default
// ~/Videos/Streaming Hub), damit Aufnahmen ohne Settings-Karte sofort
// funktionieren; die Settings-Karte (Folgekarte) überschreibt den Root.

'use strict';

const paths = require('./paths.js');

function registerRecorderIpc({ ipcMain, recorder, mainWindow }) {
  if (!ipcMain || !recorder) throw new Error('registerRecorderIpc benötigt ipcMain und recorder');
  if (!recorder.storageRoot) throw new Error('Recorder ohne storageRoot (main.js setzen)');

  function requireMainRenderer(event) {
    if (!mainWindow || event?.sender !== mainWindow.webContents) {
      throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    }
  }

  function broadcast(channel, payload) {
    try {
      mainWindow?.webContents?.send(channel, payload);
    } catch (_) {
      // Fenster zwischendurch geschlossen — kein Grund zu sterben
    }
  }

  // Events der Engine an den Renderer
  recorder.on('recording:progress', payload => broadcast('recording:progress', payload));
  recorder.on('recording:reconnecting', payload => broadcast('recording:reconnecting', payload));
  recorder.on('recording:changed', payload => broadcast('recording:changed', payload));
  recorder.on('recording:status', payload => broadcast('recording:status', payload));
  // Auto-Stopp im Main (Sendungsende/Höchstdauer/Speicher voll): Hinweis an die App
  recorder.on('recording:auto-stopped', payload => broadcast('recording:auto-stopped', payload));

  ipcMain.handle('recording:start', async (event, request) => {
    requireMainRenderer(event);
    // force: Parallel-Limit bewusst überschreiten („Trotzdem aufnehmen“, L2)
    const force = !!request && typeof request === 'object' && request.force === true;
    try {
      return await recorder.start(request, { force });
    } catch (e) {
      // Electron reicht über invoke nur die Message durch — das Soft-Limit
      // kommt daher als unterscheidbares Ergebnis statt als Wurf zurück.
      if (e && e.code === 'PARALLEL_LIMIT') {
        return { code: 'PARALLEL_LIMIT', limit: e.limit, active: e.active, message: e.message };
      }
      throw e;
    }
  });

  ipcMain.handle('recording:stop', async (event, recId) => {
    requireMainRenderer(event);
    if (typeof recId !== 'string' || !/^rec_[A-Za-z0-9._-]+$/.test(recId)) {
      throw new Error('Ungültige Aufnahme-ID');
    }
    return recorder.stop(recId);
  });

  ipcMain.handle('recording:list', event => {
    requireMainRenderer(event);
    return recorder.store.listAll();
  });

  ipcMain.handle('recording:status', event => {
    requireMainRenderer(event);
    return recorder.status();
  });

  return { broadcast };
}

/**
 * Stellt sicher, dass der Speicherort existiert (Default ~/Videos/Streaming Hub).
 * Wird vom App-Start aufgerufen — vor der ersten Aufnahme, nicht beim Modul-Load.
 */
function ensureDefaultStorageRoot(logger = console) {
  const root = paths.defaultRecordingsRoot();
  const check = paths.validateStorageRoot(root);
  if (!check.ok) {
    const fn = logger.warn || logger.error || (() => {});
    fn.call(logger, `[recorder] Default-Speicherort nicht nutzbar: ${check.error}`);
  }
  return root;
}

module.exports = { registerRecorderIpc, ensureDefaultStorageRoot };
