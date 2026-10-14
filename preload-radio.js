// Preload des unsichtbaren Radio-Player-Fensters: minimale IPC-Schnittstelle zum Main-Prozess
// (Befehle vom RadioController empfangen, Ereignisse zurückmelden). Keine weiteren Rechte.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radioPlayer', {
  onCmd: cb => {
    const handler = (_event, command) => cb(command);
    ipcRenderer.on('radio-player:cmd', handler);
    return () => ipcRenderer.removeListener('radio-player:cmd', handler);
  },
  report: message => ipcRenderer.send('radio-player:report', message),
});
