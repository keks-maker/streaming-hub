// IPC-Brücke der Planung (Etappe 2a; Konzept §3.8)
//
// Kanäle: schedule:add, schedule:update, schedule:remove, schedule:list,
// schedule:check-conflicts. Alle hinter requireMainRenderer (nur das
// Hauptfenster); Eingaben über lib/ipc-validation.js, Geschäftsregeln (Zukunfts-
// Regel gegen die Systemuhr des Main, Limits, Konflikte) im Scheduler.
// Der Renderer liefert nie Pfade oder Befehle; Titel/Beschreibung sind fremder
// EPG-Text und werden nur als Text gerendert.
//
// Ergebnisse, die der Renderer unterscheiden muss (Konflikt), kommen als Objekt
// zurück { ok:false, code:'CONFLICT', … } — Electron reicht über invoke nur die
// Message eines Wurfs durch (Muster recording:start).
//
// Broadcast: 'schedule:changed' ({reason, id, notice}) bei jeder Änderung.

'use strict';

const {
  validateScheduleInput,
  validateScheduleUpdate,
  validateScheduleId,
} = require('../ipc-validation.js');

function registerScheduleIpc({ ipcMain, scheduler, requireMainRenderer, broadcast, now = () => Date.now() }) {
  if (!ipcMain || !scheduler || typeof requireMainRenderer !== 'function') {
    throw new Error('registerScheduleIpc benötigt ipcMain, scheduler und requireMainRenderer');
  }

  if (typeof broadcast === 'function') {
    scheduler.on('schedule:changed', payload => broadcast('schedule:changed', payload));
  }

  ipcMain.handle('schedule:list', event => {
    requireMainRenderer(event);
    return scheduler.list();
  });

  ipcMain.handle('schedule:check-conflicts', (event, input) => {
    requireMainRenderer(event);
    return scheduler.checkConflicts(validateScheduleInput(input, { nowMs: now() }));
  });

  ipcMain.handle('schedule:add', (event, input) => {
    requireMainRenderer(event);
    return scheduler.addEntry(validateScheduleInput(input, { nowMs: now() }));
  });

  ipcMain.handle('schedule:update', (event, id, patch) => {
    requireMainRenderer(event);
    const clean = validateScheduleUpdate(id, patch, { nowMs: now() });
    return scheduler.updateEntry(id, clean);
  });

  ipcMain.handle('schedule:remove', (event, id) => {
    requireMainRenderer(event);
    return scheduler.cancelEntry(validateScheduleId(id));
  });
}

module.exports = { registerScheduleIpc };
