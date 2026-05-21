const { contextBridge, ipcRenderer } = require('electron');

let pipCb = null;

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  togglePip: (url) => ipcRenderer.send('toggle-pip', url),
  onPipState: (cb) => {
    pipCb = (_e, state) => cb(state);
    ipcRenderer.on('pip-state', pipCb);
    return () => ipcRenderer.removeListener('pip-state', pipCb);
  },
});
