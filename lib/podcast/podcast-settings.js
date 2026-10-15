'use strict';

// Podcast-Einstellungen (podcast-settings.json, Konzept §5): Wiedergabe-Standards, Prüfintervall, Lautstärke.
// Rein: normalisiert beliebige Dateiinhalte auf bekannte Felder mit Standardwerten (fehlerhafte Werte fallen zurück);
// applyPodcastSettingsPatch lehnt unbekannte oder ungültige Felder ab (IPC podcast:set-settings).

const { clampRate, clampVolume, DEFAULT_RATE, DEFAULT_VOLUME } = require('./podcast-playback-state.js');

const SKIP_VALUES = Object.freeze([10, 15, 30, 45, 60]);
const REFRESH_INTERVAL_VALUES = Object.freeze([30, 60, 120]); // Minuten; Minimum 30
const RATE_VALUES = Object.freeze([0.75, 1, 1.25, 1.5, 1.75, 2]);

const DEFAULT_PODCAST_SETTINGS = Object.freeze({
  rate: DEFAULT_RATE, // Standardgeschwindigkeit je neu gestarteter Episode
  skipBack: 15,
  skipForward: 30,
  autoPlayNext: false, // nach Ende die nächste ungehörte Episode derselben Sendung abspielen
  refreshIntervalMinutes: 60,
  autoMarkPlayed: true, // ab 95 % automatisch „gehört“
  volume: DEFAULT_VOLUME,
});

const BOOLEAN_FIELDS = ['autoPlayNext', 'autoMarkPlayed'];

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf(values, value, fallback) {
  return values.includes(value) ? value : fallback;
}

function normalizePodcastSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = DEFAULT_PODCAST_SETTINGS;
  return {
    rate: source.rate === undefined ? defaults.rate : oneOf(RATE_VALUES, clampRate(source.rate), defaults.rate),
    skipBack: oneOf(SKIP_VALUES, source.skipBack, defaults.skipBack),
    skipForward: oneOf(SKIP_VALUES, source.skipForward, defaults.skipForward),
    autoPlayNext: bool(source.autoPlayNext, defaults.autoPlayNext),
    refreshIntervalMinutes: oneOf(REFRESH_INTERVAL_VALUES, source.refreshIntervalMinutes, defaults.refreshIntervalMinutes),
    autoMarkPlayed: bool(source.autoMarkPlayed, defaults.autoMarkPlayed),
    volume: source.volume === undefined ? defaults.volume : clampVolume(source.volume),
  };
}

/** Prüft einen Patch (nur bekannte Felder, gültige Werte); wirft bei Fehlern. Liefert den bereinigten Patch. */
function validatePodcastSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Podcast-Einstellungen sind ungültig');
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error('Podcast-Einstellungen sind leer');
  const allowed = Object.keys(DEFAULT_PODCAST_SETTINGS);
  const result = {};
  for (const key of keys) {
    if (!allowed.includes(key)) throw new Error(`Unbekanntes Feld: ${key}`);
    const value = patch[key];
    if (BOOLEAN_FIELDS.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} muss ein Boolean sein`);
    } else if (key === 'rate') {
      if (!RATE_VALUES.includes(value)) throw new Error('Geschwindigkeit ist ungültig');
    } else if (key === 'skipBack' || key === 'skipForward') {
      if (!SKIP_VALUES.includes(value)) throw new Error('Sprungweite ist ungültig');
    } else if (key === 'refreshIntervalMinutes') {
      if (!REFRESH_INTERVAL_VALUES.includes(value)) throw new Error('Prüfintervall ist ungültig');
    } else if (key === 'volume') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Lautstärke ist ungültig');
    }
    result[key] = value;
  }
  return result;
}

function applyPodcastSettingsPatch(current, patch) {
  return normalizePodcastSettings({ ...current, ...validatePodcastSettingsPatch(patch) });
}

module.exports = {
  SKIP_VALUES,
  REFRESH_INTERVAL_VALUES,
  RATE_VALUES,
  DEFAULT_PODCAST_SETTINGS,
  normalizePodcastSettings,
  validatePodcastSettingsPatch,
  applyPodcastSettingsPatch,
};
