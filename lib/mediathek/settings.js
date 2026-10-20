'use strict';

// Einstellungen der nativen Mediathek (Einstellungen ▸ Mediatheken): welche Quellen (ARD/ZDF/arte) erscheinen und die
// Wiedergabe-Vorgaben. Reine Normalisierung/Validierung; Persistenz (user-storage 'mediathekSettings') übernimmt main.js.

const { SOURCE_IDS } = require('./sources.js');

const QUALITIES = ['auto', '1080', '720', '540'];
const LANGUAGES = ['de', 'original'];
const SUBTITLES = ['off', 'de', 'original'];

const DEFAULT_SETTINGS = Object.freeze({
  sources: Object.freeze({ ard: true, zdf: true, arte: true }),
  quality: 'auto',
  audioLanguage: 'de',
  subtitles: 'off',
});

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** Gespeicherte (unsichere) Werte auf ein gültiges Einstellungsobjekt abbilden; Unbekanntes fällt auf den Standard zurück. */
function normalizeMediathekSettings(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const stored = input.sources && typeof input.sources === 'object' && !Array.isArray(input.sources) ? input.sources : {};
  const sources = {};
  for (const id of SOURCE_IDS) sources[id] = typeof stored[id] === 'boolean' ? stored[id] : true;
  return {
    sources,
    quality: pick(input.quality, QUALITIES, DEFAULT_SETTINGS.quality),
    audioLanguage: pick(input.audioLanguage, LANGUAGES, DEFAULT_SETTINGS.audioLanguage),
    subtitles: pick(input.subtitles, SUBTITLES, DEFAULT_SETTINGS.subtitles),
  };
}

/** Teiländerung aus dem Renderer prüfen und anwenden; ungültige/unbekannte Felder werfen. */
function applyMediathekSettingsPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Einstellungen sind ungültig');
  const next = normalizeMediathekSettings(current);
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (key === 'sources') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Quellen sind ungültig');
      for (const id of Object.keys(value)) {
        if (!SOURCE_IDS.includes(id) || typeof value[id] !== 'boolean') throw new Error('Quellen sind ungültig');
        next.sources[id] = value[id];
      }
    } else if (key === 'quality' || key === 'audioLanguage' || key === 'subtitles') {
      const allowed = key === 'quality' ? QUALITIES : key === 'audioLanguage' ? LANGUAGES : SUBTITLES;
      if (!allowed.includes(value)) throw new Error(`${key} ist ungültig`);
      next[key] = value;
    } else {
      throw new Error(`Unbekanntes Feld: ${key}`);
    }
  }
  return next;
}

/** Dienst mit read()/write() (user-storage); get() liefert immer gültige Einstellungen, update(patch) speichert. */
function createMediathekSettings({ read, write, logger = null }) {
  let settings = normalizeMediathekSettings(null);
  try {
    settings = normalizeMediathekSettings(read());
  } catch (error) {
    if (logger) logger.warn('Mediathek-Einstellungen konnten nicht geladen werden:', error.message);
  }
  return {
    get: () => normalizeMediathekSettings(settings),
    update(patch) {
      settings = applyMediathekSettingsPatch(settings, patch);
      write(settings);
      return normalizeMediathekSettings(settings);
    },
  };
}

module.exports = { QUALITIES, LANGUAGES, SUBTITLES, DEFAULT_SETTINGS, normalizeMediathekSettings, applyMediathekSettingsPatch, createMediathekSettings };
