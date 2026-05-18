const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  togglePip: (url) => ipcRenderer.send('toggle-pip', url),
  onPipState: (cb) => ipcRenderer.on('pip-state', (_e, state) => cb(state)),
});
