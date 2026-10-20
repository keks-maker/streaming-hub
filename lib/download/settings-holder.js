'use strict';

// Hält die Download-Einstellungen im Speicher und schreibt Änderungen über read/write (user-storage 'downloadSettings').
// Der Dienst liest get() bei jedem Start eines Downloads; Änderungen wirken damit auf alle noch nicht gestarteten Downloads.

const { normalizeDownloadSettings, applyDownloadSettingsPatch, DEFAULTS, buildSettingsResponse } = require('./download-settings.js');

function createSettingsHolder({ read, write, getRecordingRoot }) {
  let cache = null;

  function raw() {
    try {
      return read();
    } catch {
      return {}; // unlesbare Datei: Standardwerte, beim nächsten Speichern ersetzt
    }
  }

  function get() {
    if (!cache) cache = normalizeDownloadSettings(raw()).settings;
    return cache;
  }

  /** Wendet einen Patch an und speichert. Rückgabe { settings, clamped }. */
  function patch(change) {
    const result = applyDownloadSettingsPatch(get(), change);
    write(result.settings);
    cache = result.settings;
    return result;
  }

  const response = (result = { settings: get(), clamped: {} }) => buildSettingsResponse(result, getRecordingRoot());
  const defaults = () => buildSettingsResponse({ settings: normalizeDownloadSettings(DEFAULTS).settings, clamped: {} }, getRecordingRoot());

  return { get, patch, response, defaults };
}

module.exports = { createSettingsHolder };
