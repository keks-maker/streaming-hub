'use strict';

// Preload der Übernehmen-Leiste im Anmeldefenster (sandbox): genau zwei Ereignisse hinaus (accept, cancel), eine Statusmeldung herein.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loginBar', {
  accept: () => ipcRenderer.send('mediathek:login-accept'),
  cancel: () => ipcRenderer.send('mediathek:login-cancel'),
  onStatus: callback => {
    ipcRenderer.on('mediathek:login-status', (_event, code) => {
      if (typeof code === 'string') callback(code);
    });
  },
});
