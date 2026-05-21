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
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  getServices: () => ipcRenderer.invoke('get-services'),
  addService: (svc) => ipcRenderer.invoke('add-service', svc),
  removeService: (id) => ipcRenderer.invoke('remove-service', id),
  onServicesChanged: (cb) => {
    const handler = (_e, services) => cb(services);
    ipcRenderer.on('services-changed', handler);
    return () => ipcRenderer.removeListener('services-changed', handler);
  },
});
