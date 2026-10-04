// IPC-Brücke des Main-EpgService (Etappe 1; Konzept §3.8)
//
// Kanäle: epg:range(channelKey, fromMs, toMs), epg:find(channelKey, atMs),
// epg:range-many(channelKeys, fromMs, toMs) (schlanke Slots, Etappe 3.1),
// epg:search(channelKeys, query, fromMs, toMs, limit, options) (gefaltet, Etappe 3.1; options.full = volle Projektion, 3.2),
// epg:status, epg:refresh. Ereignis Main → Renderer: epg:changed (main.js). Alle hinter requireMainRenderer (nur das
// Hauptfenster), Eingaben über lib/ipc-validation.js. Die Texte der Antworten
// stammen aus fremden EPG-Daten: Konsumenten rendern sie nur als Text.

'use strict';

const { validateEpgRange, validateEpgFind, validateEpgRangeMany, validateEpgSearch } = require('../ipc-validation.js');

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

  ipcMain.handle('epg:range-many', (event, channelKeys, fromMs, toMs) => {
    requireMainRenderer(event);
    const q = validateEpgRangeMany(channelKeys, fromMs, toMs);
    return epg.rangeMany(q.channelKeys, q.fromMs, q.toMs);
  });

  ipcMain.handle('epg:search', async (event, channelKeys, query, fromMs, toMs, limit, options) => {
    requireMainRenderer(event);
    const q = validateEpgSearch(channelKeys, query, fromMs, toMs, limit, options);
    return epg.search(q.channelKeys, q.query, q.fromMs, q.toMs, { limit: q.limit, includeDesc: q.includeDesc, full: q.full });
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
