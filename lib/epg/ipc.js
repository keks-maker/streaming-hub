// IPC-Brücke des Main-EpgService (Etappe 1; Konzept §3.8)
//
// Kanäle: epg:range(channelKey, fromMs, toMs), epg:find(channelKey, atMs),
// epg:status, epg:refresh. Alle hinter requireMainRenderer (nur das
// Hauptfenster), Eingaben über lib/ipc-validation.js. Die Texte der Antworten
// stammen aus fremden EPG-Daten: Konsumenten rendern sie nur als Text.

'use strict';

const { validateEpgRange, validateEpgFind } = require('../ipc-validation.js');

function registerEpgIpc({ ipcMain, epg, requireMainRenderer }) {
  if (!ipcMain || !epg || typeof requireMainRenderer !== 'function') {
    throw new Error('registerEpgIpc benötigt ipcMain, epg und requireMainRenderer');
  }

  ipcMain.handle('epg:range', (event, channelKey, fromMs, toMs) => {
    requireMainRenderer(event);
    const q = validateEpgRange(channelKey, fromMs, toMs);
    return epg.range(q.channelKey, q.fromMs, q.toMs);
  });

  ipcMain.handle('epg:find', (event, channelKey, atMs) => {
    requireMainRenderer(event);
    const q = validateEpgFind(channelKey, atMs);
    return epg.find(q.channelKey, q.atMs);
  });

  ipcMain.handle('epg:status', event => {
    requireMainRenderer(event);
    return epg.status();
  });

  ipcMain.handle('epg:refresh', async event => {
    requireMainRenderer(event);
    await epg.refresh({ force: true });
    return epg.status();
  });
}

module.exports = { registerEpgIpc };
