const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  toggleFullscreen: (state) => ipcRenderer.send('toggle-fullscreen', state),
  navigate: (url, provider) => ipcRenderer.send('navigate', url, provider),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  getCurrentUrl: () => ipcRenderer.sendSync('get-current-url'),
  onFullscreenState: (cb) => ipcRenderer.on('fullscreen-state', (_e, state) => cb(state)),
});
