'use strict';

// Radio-Einstellungen (radio-settings.json): zuletzt gehörter Sender, Lautstärke und Wiedergabe-Optionen.
// Rein: normalisiert beliebige Dateiinhalte auf bekannte Felder mit Standardwerten (fehlerhafte Werte fallen zurück).

const { clampVolume, DEFAULT_VOLUME } = require('./radio-state.js');

// Anzeige neben dem Tray-Symbol (macOS-Menüleiste): aus, nur Sender, Sender und Titel
const TRAY_DISPLAY_VALUES = Object.freeze(['off', 'station', 'station-title']);

const DEFAULT_RADIO_SETTINGS = Object.freeze({
  volume: DEFAULT_VOLUME,
  lastStation: null,
  resumeOnStart: false,
  pauseOnTv: true,
  keepPlayingWhenClosed: true,
  trayDisplay: 'station-title',
  trayScroll: true, // lange Texte neben dem Tray-Symbol durchlaufen lassen
});

function normalizeKey(value) {
  if (!value || typeof value !== 'object') return null;
  const { sourceId, id } = value;
  if (typeof sourceId !== 'string' || typeof id !== 'string' || !sourceId || !id || sourceId.length > 200 || id.length > 500) return null;
  return { sourceId, id };
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function trayDisplay(value, fallback) {
  return TRAY_DISPLAY_VALUES.includes(value) ? value : fallback;
}

function normalizeRadioSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    volume: source.volume === undefined ? DEFAULT_RADIO_SETTINGS.volume : clampVolume(source.volume),
    lastStation: normalizeKey(source.lastStation),
    resumeOnStart: bool(source.resumeOnStart, DEFAULT_RADIO_SETTINGS.resumeOnStart),
    pauseOnTv: bool(source.pauseOnTv, DEFAULT_RADIO_SETTINGS.pauseOnTv),
    keepPlayingWhenClosed: bool(source.keepPlayingWhenClosed, DEFAULT_RADIO_SETTINGS.keepPlayingWhenClosed),
    trayDisplay: trayDisplay(source.trayDisplay, DEFAULT_RADIO_SETTINGS.trayDisplay),
    trayScroll: bool(source.trayScroll, DEFAULT_RADIO_SETTINGS.trayScroll),
  };
}

/** Patch auf die aktuellen Einstellungen; unbekannte Felder werden abgelehnt. */
function applyRadioSettingsPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Ungültige Radio-Einstellungen');
  const allowed = Object.keys(DEFAULT_RADIO_SETTINGS);
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) throw new Error(`Unbekanntes Feld: ${key}`);
  }
  for (const key of ['resumeOnStart', 'pauseOnTv', 'keepPlayingWhenClosed', 'trayScroll']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error(`${key} muss ein Boolean sein`);
  }
  if (patch.trayDisplay !== undefined && !TRAY_DISPLAY_VALUES.includes(patch.trayDisplay)) throw new Error('Anzeige neben dem Symbol ist ungültig');
  if (patch.volume !== undefined && (typeof patch.volume !== 'number' || !Number.isFinite(patch.volume))) {
    throw new Error('Lautstärke ist ungültig');
  }
  if (patch.lastStation !== undefined && patch.lastStation !== null && !normalizeKey(patch.lastStation)) {
    throw new Error('Zuletzt gehörter Sender ist ungültig');
  }
  return normalizeRadioSettings({ ...current, ...patch });
}

module.exports = { TRAY_DISPLAY_VALUES, DEFAULT_RADIO_SETTINGS, normalizeRadioSettings, applyRadioSettingsPatch };
