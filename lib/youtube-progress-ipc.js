// YouTube-Wiedergabefortschritt im Main: Ablage (youtube-progress.json), Seitenzustand für den Preload und Meldungen der Seite.
//
// Kanäle (nur Webviews der Partition persist:streaming im Hauptfenster (nicht Bild-in-Bild), Hauptframe, YouTube-Seite):
//  - youtube-progress:page-state (sendSync, Preload der YouTube-Webviews) → { active, script }
//  - youtube-progress:report({ id, t, d })    Meldung der Seite (validiert in lib/ipc-validation.js); geschrieben wird nur bei Änderung
//  - youtube-progress:get-position(id)        gemerkte Startposition in Sekunden (0 = von vorn)

'use strict';

const { validateYoutubeProgressReport } = require('./ipc-validation.js');
const { isVideoId } = require('./youtube-url.js');
const { isYouTubePageUrl } = require('./youtube-adblock.js');
const { buildProgressScript } = require('./youtube-progress-page.js');
const { recording, resumePosition, normalizeEntries, sameEntries } = require('./youtube-progress.js');

const STORAGE_KIND = 'youtubeProgress';
const STREAMING_PARTITION = 'persist:streaming';

function registerYoutubeProgress({ ipcMain, session, storage, getMainContents = () => null, now = () => Date.now() / 1000, logger = null }) {
  if (!ipcMain || !session || !storage) throw new Error('registerYoutubeProgress benötigt ipcMain, session und storage');
  const ses = session.fromPartition(STREAMING_PARTITION);

  let entries;
  try {
    entries = normalizeEntries(storage.readJson(STORAGE_KIND, []));
  } catch (_) {
    entries = []; // unlesbare Datei → leer
  }

  // Nur Hauptframe einer YouTube-Seite in einer Streaming-Webview des Hauptfensters
  const isTrusted = event => {
    try {
      const sender = event.sender;
      const frameUrl = event.senderFrame?.url || (sender && !sender.isDestroyed?.() ? sender.getURL() : '');
      const main = getMainContents();
      const mainFrame = !event.senderFrame || !event.senderFrame.parent;
      return Boolean(main) && mainFrame && sender?.session === ses && sender.hostWebContents === main && isYouTubePageUrl(frameUrl);
    } catch (_) {
      return false;
    }
  };

  ipcMain.on('youtube-progress:page-state', event => {
    event.returnValue = isTrusted(event) ? { active: true, script: buildProgressScript() } : { active: false, script: '' };
  });

  ipcMain.on('youtube-progress:report', (event, report) => {
    if (!isTrusted(event)) return;
    let valid;
    try {
      valid = validateYoutubeProgressReport(report);
    } catch (_) {
      return;
    }
    const next = recording(entries, valid.id, valid.t, valid.d, now());
    if (sameEntries(next, entries)) return;
    entries = next;
    try {
      storage.writeJson(STORAGE_KIND, entries);
    } catch (error) {
      logger?.warn?.('YouTube-Fortschritt konnte nicht gespeichert werden:', error.message); // nur Komfort
    }
  });

  ipcMain.handle('youtube-progress:get-position', (event, id) => {
    if (!isTrusted(event) || !isVideoId(id)) return 0;
    return resumePosition(entries.find(entry => entry.id === id));
  });

  return { getEntries: () => entries.map(entry => ({ ...entry })) };
}

module.exports = { registerYoutubeProgress };
