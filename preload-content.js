const { contextBridge, ipcRenderer } = require('electron');

Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
  value: undefined,
  writable: false,
  configurable: true,
});

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
});
