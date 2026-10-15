'use strict';

// Podcast-Einstellungen im Betrieb: lesen, ändern (validiert, gespeichert) und auf die laufenden Teile anwenden
// (PodcastController: Sprungweiten, Standardgeschwindigkeit, Autoplay; Prüf-Zeitplan; Oberfläche per Event).
// Die Lautstärke wird beim Ziehen des Reglers nur verzögert gespeichert (ein Schreibvorgang pro Geste).

const VOLUME_SAVE_DELAY_MS = 600;

/** options: library (getSettings/updateSettings), controller (settingsChanged), onChanged(settings), logger, setTimer/clearTimer. */
function createPodcastSettingsService({ library, controller = null, onChanged = null, logger = null, setTimer = setTimeout, clearTimer = clearTimeout, volumeDelayMs = VOLUME_SAVE_DELAY_MS }) {
  let cache = null;
  let volumeTimer = null;
  let pendingVolume = null;

  function get() {
    if (!cache) cache = library.getSettings();
    return cache;
  }

  function apply(next) {
    cache = next;
    if (controller && typeof controller.settingsChanged === 'function') controller.settingsChanged();
    if (typeof onChanged === 'function') {
      try {
        onChanged(next);
      } catch (error) {
        if (logger) logger.warn('Podcast-Einstellungen: Folgeaktion fehlgeschlagen:', error.message);
      }
    }
    return next;
  }

  function update(patch) {
    flushVolume(); // ein früherer Lautstärke-Wert darf den neuen Patch nicht überschreiben
    return apply(library.updateSettings(patch));
  }

  function flushVolume() {
    if (volumeTimer) clearTimer(volumeTimer);
    volumeTimer = null;
    if (pendingVolume === null) return;
    const volume = pendingVolume;
    pendingVolume = null;
    try {
      cache = library.updateSettings({ volume });
    } catch (error) {
      if (logger) logger.warn('Podcast-Lautstärke nicht gespeichert:', error.message);
    }
  }

  /** Lautstärke merken (0–1); Speichern verzögert, damit der Regler nicht bei jedem Pixel schreibt. */
  function rememberVolume(volume) {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    pendingVolume = Math.min(1, Math.max(0, volume));
    if (volumeTimer) clearTimer(volumeTimer);
    volumeTimer = setTimer(flushVolume, volumeDelayMs);
    if (volumeTimer && typeof volumeTimer.unref === 'function') volumeTimer.unref();
  }

  /** Nach einem Backup-Restore o. Ä.: Datei neu lesen und anwenden. */
  function reload() {
    cache = null;
    return apply(get());
  }

  return { get, update, rememberVolume, flushVolume, reload };
}

module.exports = { createPodcastSettingsService, VOLUME_SAVE_DELAY_MS };
