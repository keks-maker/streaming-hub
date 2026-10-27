// YouTube-Mini-Player im Main: Einstellungen und Playlist (Persistenz, IPC), Rollen der Webviews und Zustand für den Preload.
//
// Kanäle (get/set nur vom Haupt-Renderer, Eingaben in lib/ipc-validation.js geprüft, gespeichert wird der normalisierte Stand):
//  - youtube-mini:get-settings / set-settings(patch)   → { enabled, clickBehavior }
//  - youtube-mini:get-playlist / set-playlist(list)    → [{ id, title }]
//  - youtube-mini:register-player(webContentsId)       die Player-Webview anmelden (Rolle 'player'); alle anderen Webviews sind 'browse'
//  - youtube-mini:resolve-title({ id })                 Titel über die öffentliche oEmbed-Adresse von YouTube (nur Video-ID wird gesendet)
//  - youtube-mini:page-state (sendSync, Preload der YouTube-Webviews) → { active, role, script }
//    active nur bei eingeschaltetem Mini-Player, Sender in persist:streaming im Hauptfenster (nicht Bild-in-Bild) UND YouTube-Seite im Hauptframe.

'use strict';

const {
  validateYoutubeMiniPatch,
  validateYoutubePlaylist,
  validateYoutubeVideoRef,
  validateWebContentsId,
} = require('./ipc-validation.js');
const { normalizeYoutubeMiniSettings } = require('./youtube-mini-settings.js');
const { normalizePlaylist, cleanTitle } = require('./youtube-playlist.js');
const { isYouTubePageUrl } = require('./youtube-adblock.js');
const { buildPageScript } = require('./youtube-mini-page.js');
const { watchUrl } = require('./youtube-url.js');

const SETTINGS_KIND = 'youtubeMiniSettings';
const PLAYLIST_KIND = 'youtubePlaylist';
const STREAMING_PARTITION = 'persist:streaming';
const TITLE_TIMEOUT_MS = 6000;
const TITLE_CACHE_MAX = 200;

function registerYoutubeMini({ ipcMain, session, webContents, storage, requireMainRenderer, getMainContents = () => null, net = null, logger = null }) {
  if (!ipcMain || !session || !webContents || !storage || typeof requireMainRenderer !== 'function') {
    throw new Error('registerYoutubeMini benötigt ipcMain, session, webContents, storage und requireMainRenderer');
  }
  const ses = session.fromPartition(STREAMING_PARTITION);

  function loadSettings() {
    try {
      return normalizeYoutubeMiniSettings(storage.readJson(SETTINGS_KIND, null));
    } catch (_) {
      return normalizeYoutubeMiniSettings(null); // unlesbare Datei → Standard
    }
  }
  function loadPlaylist() {
    try {
      return normalizePlaylist(storage.readJson(PLAYLIST_KIND, null));
    } catch (_) {
      return [];
    }
  }

  let settings = loadSettings();
  let playerId = 0;
  const titleCache = new Map();

  ipcMain.handle('youtube-mini:get-settings', event => {
    requireMainRenderer(event);
    return { ...settings };
  });

  ipcMain.handle('youtube-mini:set-settings', (event, patch) => {
    requireMainRenderer(event);
    const valid = validateYoutubeMiniPatch(patch);
    settings = normalizeYoutubeMiniSettings({ ...settings, ...valid });
    storage.writeJson(SETTINGS_KIND, settings);
    return { ...settings };
  });

  ipcMain.handle('youtube-mini:get-playlist', event => {
    requireMainRenderer(event);
    return loadPlaylist();
  });

  ipcMain.handle('youtube-mini:set-playlist', (event, list) => {
    requireMainRenderer(event);
    const valid = validateYoutubePlaylist(list);
    storage.writeJson(PLAYLIST_KIND, { version: 1, items: valid });
    return valid;
  });

  ipcMain.handle('youtube-mini:register-player', (event, id) => {
    requireMainRenderer(event);
    const valid = validateWebContentsId(id);
    const contents = webContents.fromId(valid);
    if (!contents || contents.getType?.() !== 'webview' || contents.session !== ses) throw new Error('Keine Streaming-Webview');
    playerId = valid;
    return true;
  });

  ipcMain.handle('youtube-mini:resolve-title', async (event, ref) => {
    requireMainRenderer(event);
    const { id } = validateYoutubeVideoRef(ref);
    if (titleCache.has(id)) return titleCache.get(id);
    if (!net || typeof net.fetch !== 'function') return '';
    try {
      const target = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(id))}`;
      const response = await net.fetch(target, { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) });
      if (!response.ok) return '';
      const data = await response.json();
      const title = cleanTitle(data && data.title);
      if (title) {
        if (titleCache.size >= TITLE_CACHE_MAX) titleCache.delete(titleCache.keys().next().value);
        titleCache.set(id, title);
      }
      return title;
    } catch (error) {
      logger?.warn?.('YouTube-Titel konnte nicht geladen werden:', error.message);
      return '';
    }
  });

  // Nur Webviews des Hauptfensters (nicht Bild-in-Bild): dort gibt es keinen Mini-Player, Klicks dürfen nicht abgefangen werden
  const isMainHost = sender => {
    const main = getMainContents();
    return Boolean(main) && sender.hostWebContents === main;
  };

  ipcMain.on('youtube-mini:page-state', event => {
    let result = { active: false, role: 'browse', script: '' };
    try {
      const sender = event.sender;
      const frameUrl = event.senderFrame?.url || (sender && !sender.isDestroyed?.() ? sender.getURL() : '');
      const mainFrame = !event.senderFrame || !event.senderFrame.parent;
      if (settings.enabled && mainFrame && sender?.session === ses && isMainHost(sender) && isYouTubePageUrl(frameUrl)) {
        const role = sender.id === playerId ? 'player' : 'browse';
        result = {
          active: true,
          role,
          script: buildPageScript({ role, clickBehavior: settings.clickBehavior }),
        };
      }
    } catch (_) {
      result = { active: false, role: 'browse', script: '' };
    }
    event.returnValue = result;
  });

  return { getSettings: () => ({ ...settings }), getPlayerId: () => playerId };
}

module.exports = { registerYoutubeMini, STREAMING_PARTITION };
