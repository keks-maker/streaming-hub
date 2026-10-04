// v0.3.6.
const { contextBridge, ipcRenderer } = require('electron');

let pipCb = null;

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  chromeVersion: process.versions.chrome,
  togglePip: url => ipcRenderer.send('toggle-pip', url),
  onMediaKey: cb => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('media-key', handler);
    return () => ipcRenderer.removeListener('media-key', handler);
  },
  onPipState: cb => {
    pipCb = (_e, state) => cb(state);
    ipcRenderer.on('pip-state', pipCb);
    return () => ipcRenderer.removeListener('pip-state', pipCb);
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  onFullscreenState: cb => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('fullscreen-state', handler);
    return () => ipcRenderer.removeListener('fullscreen-state', handler);
  },
  getServices: () => ipcRenderer.invoke('get-services'),
  addService: svc => ipcRenderer.invoke('add-service', svc),
  removeService: id => ipcRenderer.invoke('remove-service', id),
  onServicesChanged: cb => {
    const handler = (_e, services) => cb(services);
    ipcRenderer.on('services-changed', handler);
    return () => ipcRenderer.removeListener('services-changed', handler);
  },
  onWebviewKeydown: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('webview-keydown', handler);
    return () => ipcRenderer.removeListener('webview-keydown', handler);
  },
  saveHistoryEntry: entry => ipcRenderer.invoke('save-history-entry', entry),
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // TV Sources
  getTvSources: () => ipcRenderer.invoke('get-tv-sources'),
  addTvSource: source => ipcRenderer.invoke('add-tv-source', source),
  removeTvSource: id => ipcRenderer.invoke('remove-tv-source', id),
  updateTvSource: (id, updates) => ipcRenderer.invoke('update-tv-source', id, updates),
  pickM3uFile: () => ipcRenderer.invoke('pick-m3u-file'),
  fetchAndParseM3U: urlOrPath => ipcRenderer.invoke('fetch-and-parse-m3u', urlOrPath),
  fetchEPG: url => ipcRenderer.invoke('fetch-epg', url),
  onTvSourcesChanged: cb => {
    const handler = (_e, sources) => cb(sources);
    ipcRenderer.on('tv-sources-changed', handler);
    return () => ipcRenderer.removeListener('tv-sources-changed', handler);
  },

  // Wochen-EPG im Main (Etappe 1): Abfrage-API. Antworttexte sind fremde
  // Daten — nur als Text rendern (kein innerHTML).
  getEpgRange: (channelKey, fromMs, toMs) => ipcRenderer.invoke('epg:range', channelKey, fromMs, toMs),
  findEpg: (channelKey, atMs) => ipcRenderer.invoke('epg:find', channelKey, atMs),
  getEpgStatus: () => ipcRenderer.invoke('epg:status'),
  refreshEpgCache: () => ipcRenderer.invoke('epg:refresh'),

  // Planung geplanter Aufnahmen (Etappe 2a): feste Whitelist, nichts Generisches.
  addSchedule: input => ipcRenderer.invoke('schedule:add', input),
  updateSchedule: (id, patch) => ipcRenderer.invoke('schedule:update', id, patch),
  removeSchedule: id => ipcRenderer.invoke('schedule:remove', id),
  listSchedules: () => ipcRenderer.invoke('schedule:list'),
  checkScheduleConflicts: input => ipcRenderer.invoke('schedule:check-conflicts', input),
  onScheduleChanged: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('schedule:changed', handler);
    return () => ipcRenderer.removeListener('schedule:changed', handler);
  },

  // Autoupdate
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  applyUpdate: version => ipcRenderer.invoke('apply-update', version),
  onUpdateStatus: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },

  // Backup / Restore
  backupSettings: () => ipcRenderer.invoke('backup-settings'),
  restoreSettings: () => ipcRenderer.invoke('restore-settings'),

  // Aufnahme (Konzept §2.5) — Renderer konsumiert nur
  startRecording: request => ipcRenderer.invoke('recording:start', request),
  stopRecording: recId => ipcRenderer.invoke('recording:stop', recId),
  listRecordings: () => ipcRenderer.invoke('recording:list'),
  getRecordingStatus: () => ipcRenderer.invoke('recording:status'),
  onRecordingProgress: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:progress', handler);
    return () => ipcRenderer.removeListener('recording:progress', handler);
  },
  onRecordingStatus: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:status', handler);
    return () => ipcRenderer.removeListener('recording:status', handler);
  },
  onRecordingReconnecting: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:reconnecting', handler);
    return () => ipcRenderer.removeListener('recording:reconnecting', handler);
  },
  onRecordingChanged: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:changed', handler);
    return () => ipcRenderer.removeListener('recording:changed', handler);
  },
  // Karte t_f36663be (Meldung 4): DVR-Rückstand > Fenster → Degrade-Hinweis
  onRecordingSeekDegraded: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:seek-degraded', handler);
    return () => ipcRenderer.removeListener('recording:seek-degraded', handler);
  },

  // Auto-Stopp im Main (Sendungsende, Höchstdauer, Speicher voll, Speicherort weg)
  onRecordingAutoStopped: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:auto-stopped', handler);
    return () => ipcRenderer.removeListener('recording:auto-stopped', handler);
  },

  // Aufnahme-UI (Phase 1c): Bibliothek + Settings
  getRecordingFile: recId => ipcRenderer.invoke('recording:get-file', recId),
  deleteRecording: recId => ipcRenderer.invoke('recording:delete', recId),
  getRecordingStorageRoot: () => ipcRenderer.invoke('recording:get-storage-root'),
  setRecordingStorageRoot: root => ipcRenderer.invoke('recording:set-storage-root', root),
  pickRecordingFolder: () => ipcRenderer.invoke('recording:pick-folder'),
  getRecordingSettings: () => ipcRenderer.invoke('recording:get-settings'),
  setRecordingSettings: patch => ipcRenderer.invoke('recording:set-settings', patch),
  checkFfmpegStatus: () => ipcRenderer.invoke('recording:ffmpeg-status'),
  getDefaultRecordingRoot: () => ipcRenderer.invoke('recording:get-default-root'),
  onOpenRecordings: cb => {
    const handler = () => cb();
    ipcRenderer.on('recordings:open', handler);
    return () => ipcRenderer.removeListener('recordings:open', handler);
  },
  onShutdownWarning: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:shutdown-warning', handler);
    return () => ipcRenderer.removeListener('recording:shutdown-warning', handler);
  },
});
