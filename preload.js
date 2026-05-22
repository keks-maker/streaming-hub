const { contextBridge, ipcRenderer } = require('electron');

let pipCb = null;

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  togglePip: (url) => ipcRenderer.send('toggle-pip', url),
  onMediaKey: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('media-key', handler);
    return () => ipcRenderer.removeListener('media-key', handler);
  },
  onPipState: (cb) => {
    pipCb = (_e, state) => cb(state);
    ipcRenderer.on('pip-state', pipCb);
    return () => ipcRenderer.removeListener('pip-state', pipCb);
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  getServices: () => ipcRenderer.invoke('get-services'),
  addService: (svc) => ipcRenderer.invoke('add-service', svc),
  removeService: (id) => ipcRenderer.invoke('remove-service', id),
  onServicesChanged: (cb) => {
    const handler = (_e, services) => cb(services);
    ipcRenderer.on('services-changed', handler);
    return () => ipcRenderer.removeListener('services-changed', handler);
  },
  onWebviewKeydown: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('webview-keydown', handler);
    return () => ipcRenderer.removeListener('webview-keydown', handler);
  },
  saveHistoryEntry: (entry) => ipcRenderer.invoke('save-history-entry', entry),
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // TV Sources
  getTvSources: () => ipcRenderer.invoke('get-tv-sources'),
  addTvSource: (source) => ipcRenderer.invoke('add-tv-source', source),
  removeTvSource: (id) => ipcRenderer.invoke('remove-tv-source', id),
  updateTvSource: (id, updates) => ipcRenderer.invoke('update-tv-source', id, updates),
  pickM3uFile: () => ipcRenderer.invoke('pick-m3u-file'),
  fetchAndParseM3U: (urlOrPath) => ipcRenderer.invoke('fetch-and-parse-m3u', urlOrPath),
  fetchEPG: (url) => ipcRenderer.invoke('fetch-epg', url),
  onTvSourcesChanged: (cb) => {
    const handler = (_e, sources) => cb(sources);
    ipcRenderer.on('tv-sources-changed', handler);
    return () => ipcRenderer.removeListener('tv-sources-changed', handler);
  },

  // Autoupdate
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  applyUpdate: (version) => ipcRenderer.invoke('apply-update', version),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
