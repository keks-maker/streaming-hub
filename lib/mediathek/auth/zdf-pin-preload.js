'use strict';

// Preload des PIN-Fensters (sandbox): reicht genau drei Aufrufe an den Main-Prozess weiter. Keine weiteren Rechte.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zdfPin', {
  init: () => ipcRenderer.invoke('mediathek:zdf-pin-init'),
  submit: value => ipcRenderer.invoke('mediathek:zdf-pin-submit', value),
  cancel: () => ipcRenderer.invoke('mediathek:zdf-pin-cancel'),
});
