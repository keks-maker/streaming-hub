'use strict';

// IPC der Mediathek-Downloads (Muster lib/mediathek/ipc.js): alle downloads:*-Kanäle nur für das Hauptfenster (requireMainRenderer)
// mit Schema-Prüfung (validation.js). Der Renderer erhält nie Dateipfade oder Stream-Adressen; play-info liefert nur die dl://-Adresse.
// Fachliche Fehler kommen als { ok: false, code, message } zurück, ungültige Eingaben werfen.
//
// Kanäle (Eingabe -> Ergebnis):
//   downloads:settings-get       -                                   -> Einstellungen (+ effectiveStorageRoot, options)
//   downloads:settings-set       { <Feld>: Wert, ... }               -> { ok, ...Einstellungen, clamped } | { ok: false, error }
//   downloads:settings-defaults  -                                   -> Standard-Einstellungen
//   downloads:validate-root      { root }                            -> { ok, error, freeBytes, network }
//   downloads:plan               { entry, series?, overrides? }      -> { ok, plan, available, freeBytes, enoughSpace, duplicate, restricted, ... }
//   downloads:enqueue            { entry, series?, overrides? }      -> { ok, id, status } | { ok: false, code: 'duplicate'|'storage'|..., message }
//   downloads:enqueue-many       { series, entryIds, overrides? }    -> { ok, results: [{ entryId, ok, id?, code? }], added }
//   downloads:list               -                                   -> { ok, items, summary, root, freeBytes }
//   downloads:pause|resume|cancel|retry { id }                       -> { ok } | { ok: false, code, message }
//   downloads:remove             { id, deleteFile? }                 -> { ok }
//   downloads:pick-folder        -                                   -> { ok, root } (Ordnerdialog; root null = abgebrochen)
//   downloads:reveal             { id }                              -> { ok }
//   downloads:play-info          { id }                              -> { ok, url (dl://), container, title, historyTitle, seriesTitle, sourceId, entryId, durationSec, start }
//   Event downloads:changed      { items: [Ansicht], removed: [id], summary }   (Fortschritt gedrosselt, höchstens 4 je Sekunde)

const { validateNoPayload } = require('../ipc-validation.js');
const path = require('node:path');
const v = require('./validation.js');
const { playbackUrl } = require('./protocol.js');

const PROGRESS_INTERVAL_MS = 250;

function registerDownloadIpc({ ipcMain, service, settings, mediathek, requireMainRenderer, sendToMain, validateRoot, showItemInFolder, getProgress = null, onPlay = null, pickFolder = null, isNetworkPath = () => false, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(), logger = null }) {
  const main = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event);
      return handler(...args);
    });
  };
  const failure = (error, fallback) => ({ ok: false, code: (error && error.code) || 'error', message: (error && error.message) || fallback });

  // Ereignisse bündeln: Zustandswechsel gehen sofort raus, Fortschritt höchstens alle 250 ms
  const pending = new Map();
  const removed = new Set();
  let lastSent = 0;
  let timer = null;
  const flush = () => {
    if (timer) clearTimer(timer);
    timer = null;
    if (!pending.size && !removed.size) return;
    const payload = { items: [...pending.values()], removed: [...removed], summary: service.summary() };
    pending.clear();
    removed.clear();
    lastSent = now();
    sendToMain('downloads:changed', payload);
  };
  service.on('changed', ({ view, reason }) => {
    pending.set(view.id, view);
    removed.delete(view.id);
    if (reason !== 'progress' || now() - lastSent >= PROGRESS_INTERVAL_MS) return flush();
    if (!timer) timer = setTimer(flush, PROGRESS_INTERVAL_MS - (now() - lastSent));
    return undefined;
  });
  service.on('removed', ({ id }) => {
    pending.delete(id);
    removed.add(id);
    flush();
  });

  main('downloads:settings-get', (...rest) => {
    validateNoPayload(rest);
    return settings.response();
  });

  main('downloads:settings-set', value => {
    const patch = v.validateSettingsPatch(value);
    if (patch.storageRoot) {
      const check = validateRoot(patch.storageRoot);
      if (!check.ok) return { ok: false, error: check.error };
    }
    const result = settings.patch(patch);
    return { ok: true, ...settings.response(result) };
  });

  main('downloads:settings-defaults', (...rest) => {
    validateNoPayload(rest);
    return settings.defaults();
  });

  main('downloads:validate-root', value => {
    const { root } = v.validateRoot(value);
    const check = validateRoot(root);
    return { ok: check.ok, error: check.error, freeBytes: check.freeBytes, network: Boolean(isNetworkPath(root)) };
  });

  main('downloads:plan', async value => {
    const input = v.validatePlan(value);
    try {
      return await service.preview(input);
    } catch (error) {
      if (logger) logger.warn('Download-Vorschau fehlgeschlagen:', error && error.code);
      return failure(error, 'Vorschau nicht möglich');
    }
  });

  main('downloads:enqueue', value => service.enqueue(v.validateEnqueue(value)));

  main('downloads:enqueue-many', async value => {
    const { series, entryIds, overrides } = v.validateEnqueueMany(value);
    let episodes;
    try {
      episodes = await mediathek.fetchEpisodes(series);
    } catch (error) {
      return { ok: false, code: (error && error.code) || 'error', message: 'Die Folgen der Serie konnten nicht geladen werden.', results: [], added: 0 };
    }
    const wanted = new Set(entryIds);
    const entries = episodes.filter(entry => wanted.has(entry.id));
    const result = service.enqueueMany({ series, entries, overrides });
    const found = new Set(entries.map(entry => entry.id));
    for (const entryId of entryIds) if (!found.has(entryId)) result.results.push({ entryId, ok: false, code: 'unknown-entry', id: null, message: 'Folge nicht in der Serie gefunden.' });
    return result;
  });

  main('downloads:list', (...rest) => {
    validateNoPayload(rest);
    const root = service.storageRoot();
    return { ok: true, items: service.list(), summary: service.summary(), root, freeBytes: service.freeBytes(root) };
  });

  for (const action of ['pause', 'resume', 'cancel', 'retry']) {
    main(`downloads:${action}`, value => service[action](v.validateId(value).id));
  }

  main('downloads:remove', value => {
    const { id, deleteFile } = v.validateRemove(value);
    return service.remove(id, { deleteFile });
  });

  main('downloads:pick-folder', async (...rest) => {
    validateNoPayload(rest);
    if (!pickFolder) return { ok: false, root: null };
    const root = await pickFolder(settings.response().effectiveStorageRoot);
    return { ok: true, root: typeof root === 'string' && root ? root : null };
  });

  main('downloads:reveal', value => {
    const { id } = v.validateId(value);
    const file = service.fileInfo(id);
    if (!file) return { ok: false, code: 'missing', message: 'Die Datei ist nicht mehr vorhanden.' };
    showItemInFolder(file.path);
    return { ok: true };
  });

  main('downloads:play-info', value => {
    const { id } = v.validateId(value);
    const file = service.fileInfo(id);
    if (!file) return { ok: false, code: 'missing', message: 'Die Datei ist nicht mehr vorhanden.' };
    const { record } = file;
    const progress = getProgress ? getProgress(record) : null;
    if (onPlay) {
      try {
        onPlay(record);
      } catch (error) {
        if (logger) logger.warn('Verlauf für Download-Wiedergabe nicht geschrieben:', error && error.message);
      }
    }
    return { ok: true, url: playbackUrl(id, path.extname(file.path).slice(1)), container: path.extname(file.path).slice(1), title: record.title, historyTitle: record.entry.title, seriesTitle: record.seriesTitle, sourceId: record.entry.sourceId, entryId: record.entry.id, durationSec: record.durationSec, start: progress ? progress.start : null };
  });

  return { flush };
}

module.exports = { registerDownloadIpc, PROGRESS_INTERVAL_MS };
