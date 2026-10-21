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
  updateService: (id, svc) => ipcRenderer.invoke('update-service', id, svc),
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
  setFavoriteOrder: order => ipcRenderer.invoke('set-favorite-order', order),
  pickM3uFile: () => ipcRenderer.invoke('pick-m3u-file'),
  fetchAndParseM3U: urlOrPath => ipcRenderer.invoke('fetch-and-parse-m3u', urlOrPath),
  onTvSourcesChanged: cb => {
    const handler = (_e, sources) => cb(sources);
    ipcRenderer.on('tv-sources-changed', handler);
    return () => ipcRenderer.removeListener('tv-sources-changed', handler);
  },

  // Wochen-EPG im Main (Etappe 1): Abfrage-API. Antworttexte sind fremde
  // Daten — nur als Text rendern (kein innerHTML).
  getEpgRange: (channelKey, fromMs, toMs) => ipcRenderer.invoke('epg:range', channelKey, fromMs, toMs),
  findEpg: (channelKey, atMs) => ipcRenderer.invoke('epg:find', channelKey, atMs),
  // Raster/Liste: schlanke Slots {start, stop, title, genre} je Kanal; Suche gefaltet (Etappe 3.1)
  getEpgRangeMany: (channelKeys, fromMs, toMs) => ipcRenderer.invoke('epg:range-many', channelKeys, fromMs, toMs),
  searchEpg: (channelKeys, query, fromMs, toMs, limit, options) =>
    ipcRenderer.invoke('epg:search', channelKeys, query, fromMs, toMs, limit, options),
  // Jetzt/Nächste je Kanal und Kanalliste für die Settings-Zuordnung (Etappe 3.7)
  getEpgNowNext: channelKeys => ipcRenderer.invoke('epg:now-next', channelKeys),
  getEpgChannels: () => ipcRenderer.invoke('epg:channels'),
  onEpgChanged: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('epg:changed', handler);
    return () => ipcRenderer.removeListener('epg:changed', handler);
  },
  // Programmführer-Einstellungen (Etappe 3.5): Startansicht (auto | list | grid | jng), im Main validiert
  getEpgViewSettings: () => ipcRenderer.invoke('epg-view:get-settings'),
  setEpgViewSettings: patch => ipcRenderer.invoke('epg-view:set-settings', patch),
  getEpgStatus: () => ipcRenderer.invoke('epg:status'),
  refreshEpgCache: () => ipcRenderer.invoke('epg:refresh'),

  // Planung geplanter Aufnahmen (Etappe 2a): feste Whitelist, nichts Generisches.
  addSchedule: input => ipcRenderer.invoke('schedule:add', input),
  updateSchedule: (id, patch) => ipcRenderer.invoke('schedule:update', id, patch),
  removeSchedule: id => ipcRenderer.invoke('schedule:remove', id),
  listSchedules: () => ipcRenderer.invoke('schedule:list'),
  // Aufwecken für geplante Aufnahmen (macOS, Konzept §4.3)
  getWakeStatus: () => ipcRenderer.invoke('wake:get-status'),
  enableWake: () => ipcRenderer.invoke('wake:enable'),
  disableWake: () => ipcRenderer.invoke('wake:disable'),
  onWakeChanged: callback => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('wake:changed', handler);
    return () => ipcRenderer.removeListener('wake:changed', handler);
  },
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
  // Payload: { tab: 'library' | 'planned' } (Tray: „Aufnahmen-Bibliothek“ / „Planung öffnen“)
  onOpenRecordings: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recordings:open', handler);
    return () => ipcRenderer.removeListener('recordings:open', handler);
  },
  onShutdownWarning: cb => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('recording:shutdown-warning', handler);
    return () => ipcRenderer.removeListener('recording:shutdown-warning', handler);
  },
});

// Radio (Konzept §7): Fernbedienung für den RadioController im Main; Zustand kommt per radio:state.
const radioListener = channel => cb => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('radio', {
  getSources: () => ipcRenderer.invoke('radio:get-sources'),
  addCustom: input => ipcRenderer.invoke('radio:add-custom', input),
  updateCustom: (id, patch) => ipcRenderer.invoke('radio:update-custom', id, patch),
  removeCustom: id => ipcRenderer.invoke('radio:remove-custom', id),
  // key: { sourceId, stationId }
  setFavorite: (key, favorite) => ipcRenderer.invoke('radio:set-favorite', key, favorite),
  // patch: { name?, logo?, streamUrl? } (leer/null = Feld zurücksetzen); nur für gelieferte Sender, eigene über updateCustom
  setOverride: (key, patch) => ipcRenderer.invoke('radio:set-override', key, patch),
  clearOverride: key => ipcRenderer.invoke('radio:clear-override', key),
  // order: [{ sourceId, id }] in gewünschter globaler Reihenfolge
  setFavoriteOrder: order => ipcRenderer.invoke('radio:set-favorite-order', order),
  // key: { sourceId, stationId }; ohne Argument: fortsetzen bzw. letzter Sender
  play: key => ipcRenderer.invoke('radio:play', key),
  pause: () => ipcRenderer.invoke('radio:pause'),
  stop: () => ipcRenderer.invoke('radio:stop'),
  next: () => ipcRenderer.invoke('radio:next'),
  prev: () => ipcRenderer.invoke('radio:prev'),
  setVolume: volume => ipcRenderer.invoke('radio:set-volume', volume),
  probe: url => ipcRenderer.invoke('radio:probe', url),
  findLogo: query => ipcRenderer.invoke('radio:find-logo', query),
  refreshStreamUrls: () => ipcRenderer.invoke('radio:refresh-stream-urls'),
  getState: () => ipcRenderer.invoke('radio:get-state'),
  // Wiedergabe-Optionen (lastStation, resumeOnStart, pauseOnTv, keepPlayingWhenClosed, trayDisplay, trayScroll, volume); setSettings nimmt die Schalter (inkl. trayScroll) und trayDisplay
  getSettings: () => ipcRenderer.invoke('radio:get-settings'),
  setSettings: patch => ipcRenderer.invoke('radio:set-settings', patch),
  onState: radioListener('radio:state'),
  onSourcesChanged: radioListener('radio:sources-changed'),
  // Tray „Radio-Dashboard öffnen“: Renderer zeigt das Radio-Dashboard
  onOpen: radioListener('radio:open'),
});

// Mediathek (nativ, Core ohne UI): alle Kanäle laufen im Main; Ergebnisse { ok, ... } bzw. { ok: false, error, code }
contextBridge.exposeInMainWorld('mediathek', {
  home: source => ipcRenderer.invoke('mediathek:home', { source }),
  search: (query, source, page) => ipcRenderer.invoke('mediathek:search', { query, source, page }),
  series: series => ipcRenderer.invoke('mediathek:series', { series }),
  genre: genre => ipcRenderer.invoke('mediathek:genre', { genre }),
  loadMore: section => ipcRenderer.invoke('mediathek:load-more', { section }),
  resolvePlayback: (entry, series) => ipcRenderer.invoke('mediathek:resolve-playback', { entry, series }),
  getFavorites: () => ipcRenderer.invoke('mediathek:favorites-get'),
  toggleFavorite: series => ipcRenderer.invoke('mediathek:favorites-toggle', { series }),
  onFavoritesChanged: radioListener('mediathek:favorites-changed'),
  saveWatchProgress: input => ipcRenderer.invoke('mediathek:watch-progress', input),
  getWatchProgress: input => ipcRenderer.invoke('mediathek:get-progress', input),
  getResumeList: () => ipcRenderer.invoke('mediathek:resume-list'),
  getSettings: () => ipcRenderer.invoke('mediathek:get-settings'),
  setSettings: patch => ipcRenderer.invoke('mediathek:set-settings', patch),
  onSettingsChanged: radioListener('mediathek:settings-changed'),
  // Konten (experimentell): nur Zustände, nie Token
  accounts: {
    status: () => ipcRenderer.invoke('mediathek:accounts-status'),
    login: sender => ipcRenderer.invoke('mediathek:accounts-login', { sender }),
    logout: sender => ipcRenderer.invoke('mediathek:accounts-logout', { sender }),
    test: sender => ipcRenderer.invoke('mediathek:accounts-test', { sender }),
    onChanged: radioListener('mediathek:accounts-changed'),
  },
});

// Mediathek-Downloads (Konzept §3/§4): Queue, Bibliothek, Einstellungen; Fortschritt kommt gedrosselt als Event.
contextBridge.exposeInMainWorld('downloads', {
  getSettings: () => ipcRenderer.invoke('downloads:settings-get'),
  setSettings: patch => ipcRenderer.invoke('downloads:settings-set', patch),
  getDefaults: () => ipcRenderer.invoke('downloads:settings-defaults'),
  validateRoot: root => ipcRenderer.invoke('downloads:validate-root', { root }),
  pickFolder: () => ipcRenderer.invoke('downloads:pick-folder'),
  plan: (entry, overrides, series) => ipcRenderer.invoke('downloads:plan', { entry, overrides, series }),
  enqueue: input => ipcRenderer.invoke('downloads:enqueue', input),
  enqueueMany: input => ipcRenderer.invoke('downloads:enqueue-many', input),
  list: () => ipcRenderer.invoke('downloads:list'),
  pause: id => ipcRenderer.invoke('downloads:pause', { id }),
  resume: id => ipcRenderer.invoke('downloads:resume', { id }),
  cancel: id => ipcRenderer.invoke('downloads:cancel', { id }),
  retry: id => ipcRenderer.invoke('downloads:retry', { id }),
  remove: (id, options) => ipcRenderer.invoke('downloads:remove', { id, deleteFile: Boolean(options && options.deleteFile) }),
  reveal: id => ipcRenderer.invoke('downloads:reveal', { id }),
  playInfo: id => ipcRenderer.invoke('downloads:play-info', { id }),
  onChanged: radioListener('downloads:changed'),
  // Serien-Abos „Neue Folgen automatisch laden“
  subscriptions: {
    list: () => ipcRenderer.invoke('subscriptions:list'),
    add: input => ipcRenderer.invoke('subscriptions:add', input),
    update: input => ipcRenderer.invoke('subscriptions:update', input),
    remove: id => ipcRenderer.invoke('subscriptions:remove', { id }),
    checkNow: id => ipcRenderer.invoke('subscriptions:check-now', id ? { id } : {}),
    onChanged: radioListener('subscriptions:changed'),
  },
});

// Podcasts (Konzept §7): Abos, Feeds, Suche und Hörzustand im Main; Änderungen kommen als Events.
contextBridge.exposeInMainWorld('podcasts', {
  search: query => ipcRenderer.invoke('podcast:search', query),
  getCatalog: () => ipcRenderer.invoke('podcast:catalog'),
  getCover: url => ipcRenderer.invoke('podcast:cover', url),
  list: () => ipcRenderer.invoke('podcast:list'),
  subscribe: input => ipcRenderer.invoke('podcast:subscribe', input),
  unsubscribe: id => ipcRenderer.invoke('podcast:unsubscribe', id),
  episodes: id => ipcRenderer.invoke('podcast:episodes', id),
  episodeDetails: key => ipcRenderer.invoke('podcast:episode-details', key),
  // Shownotes: Bild einer Episode ({ podcastId, episodeId, url }) über den Main; Link nach Klick im Standardbrowser öffnen
  getShownoteImage: input => ipcRenderer.invoke('podcast:shownote-image', input),
  openLink: url => ipcRenderer.invoke('podcast:open-link', url),
  refresh: options => ipcRenderer.invoke('podcast:refresh', options),
  probeFeed: url => ipcRenderer.invoke('podcast:probe-feed', url),
  setPlayed: input => ipcRenderer.invoke('podcast:set-played', input),
  savePosition: input => ipcRenderer.invoke('podcast:save-position', input),
  // Verwaltung (Einstellungen → Podcasts): Reihenfolge { order: [id] }, Anpassung { id, title?, cover? } (leer = zurücksetzen)
  reorder: input => ipcRenderer.invoke('podcast:reorder', input),
  setOverride: input => ipcRenderer.invoke('podcast:set-override', input),
  // Podcast-Einstellungen: rate, skipBack, skipForward, autoPlayNext, refreshIntervalMinutes, autoMarkPlayed, volume
  getSettings: () => ipcRenderer.invoke('podcast:get-settings'),
  setSettings: patch => ipcRenderer.invoke('podcast:set-settings', patch),
  onSettingsChanged: radioListener('podcast:settings-changed'),
  // Tray „Podcasts öffnen“: Renderer zeigt das Podcast-Dashboard (bzw. die Sendung der laufenden Episode)
  onOpen: radioListener('podcast:open'),
  onSubscriptionsChanged: radioListener('podcast:subscriptions-changed'),
  onRefreshed: radioListener('podcast:refreshed'),
  onStateChanged: radioListener('podcast:state-changed'),
  // Wiedergabe (P2): Fernbedienung für den PodcastController im Main; Zustand kommt per podcast:state
  player: {
    play: (key, startPosition) => ipcRenderer.invoke('podcast:play', startPosition === undefined ? key : { ...key, startPosition }),
    pause: () => ipcRenderer.invoke('podcast:pause'),
    resume: () => ipcRenderer.invoke('podcast:resume'),
    stop: () => ipcRenderer.invoke('podcast:stop'),
    seek: position => ipcRenderer.invoke('podcast:seek', position),
    skip: delta => ipcRenderer.invoke('podcast:skip', delta),
    setRate: rate => ipcRenderer.invoke('podcast:rate', rate),
    setVolume: volume => ipcRenderer.invoke('podcast:volume', volume),
    getState: () => ipcRenderer.invoke('podcast:get-state'),
    onState: radioListener('podcast:state'),
  },
});
