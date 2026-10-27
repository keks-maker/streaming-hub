// YouTube-Werbeblocker im Main: Schalter (Persistenz, IPC), Netzsperre und Zustand für den Preload.
//
// Kanäle:
//  - youtube-adblock:get-settings / set-settings(patch) → { enabled }, nur vom Haupt-Renderer (requireMainRenderer),
//    Patch in lib/ipc-validation.js geprüft, gespeichert wird nur der normalisierte Wert.
//  - youtube-adblock:page-state (sendSync, vom Preload der YouTube-Webviews) → { active, css }.
//    active nur bei aktivem Blocker UND YouTube-Seite; sonst nie Skript oder CSS.
//  - Netzsperre: session.webRequest.onBeforeRequest der Streaming-Partition, sofort wirksam beim Umschalten.

'use strict';

const { validateYoutubeAdblockPatch } = require('./ipc-validation.js');
const {
  REQUEST_URL_FILTERS,
  AD_HIDE_CSS,
  isYouTubePageUrl,
  shouldBlockRequest,
  normalizeYoutubeAdblockSettings,
} = require('./youtube-adblock.js');

const STORAGE_KIND = 'youtubeAdblockSettings';
const STREAMING_PARTITION = 'persist:streaming';

function registerYoutubeAdblock({ ipcMain, session, storage, requireMainRenderer, logger }) {
  if (!ipcMain || !session || !storage || typeof requireMainRenderer !== 'function') {
    throw new Error('registerYoutubeAdblock benötigt ipcMain, session, storage und requireMainRenderer');
  }

  function load() {
    try {
      return normalizeYoutubeAdblockSettings(storage.readJson(STORAGE_KIND, null));
    } catch (_) {
      return normalizeYoutubeAdblockSettings(null); // unlesbare Datei → Standard
    }
  }

  let state = load();

  function topUrl(webContents) {
    try {
      return webContents && !webContents.isDestroyed?.() ? webContents.getURL() : '';
    } catch (_) {
      return '';
    }
  }

  const ses = session.fromPartition(STREAMING_PARTITION);
  ses.webRequest.onBeforeRequest({ urls: [...REQUEST_URL_FILTERS] }, (details, callback) => {
    try {
      if (state.enabled && shouldBlockRequest({ url: details.url, pageUrl: topUrl(details.webContents), enabled: state.enabled })) {
        callback({ cancel: true });
        return;
      }
    } catch (e) {
      logger?.warn?.('YouTube-Werbeblocker: Prüfung fehlgeschlagen:', e.message);
    }
    callback({});
  });

  ipcMain.on('youtube-adblock:page-state', event => {
    let active;
    try {
      active = state.enabled && isYouTubePageUrl(event.senderFrame?.url || topUrl(event.sender));
    } catch (_) {
      active = false;
    }
    event.returnValue = active ? { active: true, css: AD_HIDE_CSS } : { active: false, css: '' };
  });

  ipcMain.handle('youtube-adblock:get-settings', event => {
    requireMainRenderer(event);
    return { ...state };
  });

  ipcMain.handle('youtube-adblock:set-settings', (event, patch) => {
    requireMainRenderer(event);
    const valid = validateYoutubeAdblockPatch(patch);
    state = normalizeYoutubeAdblockSettings({ ...state, ...valid });
    storage.writeJson(STORAGE_KIND, state);
    return { ...state };
  });

  return { getState: () => ({ ...state }) };
}

module.exports = { registerYoutubeAdblock, STREAMING_PARTITION };
