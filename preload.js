const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),
  navigate: (url) => ipcRenderer.send('navigate', url),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  getCurrentUrl: () => ipcRenderer.sendSync('get-current-url'),
  onSidebarState: (cb) => ipcRenderer.on('sidebar-state', (_e, c) => cb(c)),
});
