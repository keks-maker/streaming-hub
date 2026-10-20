'use strict';

// Download-Einstellungen der Mediathek (Konzept §5): Defaults, Normalisierung und Clamp als reine Logik ohne I/O und ohne
// Electron (Muster lib/recorder/recording-settings.js). Persistenz: download-settings.json (user-storage, Schlüssel
// 'downloadSettings'). Die Reserve für freien Speicher kommt nicht hierher, sondern aus den Aufnahme-Einstellungen
// (gemeinsam, Aufnahmen haben Vorrang). Unbekannte Felder werden verworfen, ungültige Werte fallen auf den Default.

const path = require('node:path');

const MAX_HEIGHTS = ['best', '1080', '720', '540', '360'];
const CONTAINERS = ['mp4', 'mkv'];
const AUDIO_MODES = ['preferred', 'all'];
const AUDIO_DESCRIPTION_MODES = ['never', 'additional', 'fallback'];
const SUBTITLE_MODES = ['none', 'preferred', 'all'];
const SUBTITLE_DELIVERIES = ['embedded', 'external'];
/** Sprachen für Tonspur-/Untertitelwahl (ISO 639-2); 'orig' = Originalton, 'und' wird nie angeboten. */
const LANGUAGES = ['deu', 'orig', 'eng', 'fra', 'ita', 'spa', 'nld', 'pol', 'tur'];

const MIN_PARALLEL = 1;
const MAX_PARALLEL = 5;
const DEFAULT_PARALLEL = 2;
const MAX_BANDWIDTH_KBPS = 1000000; // 1 GB/s: Sanity-Obergrenze
const MAX_CLEANUP_DAYS = 3650;
const SCHEME_MAX = 120;
const MIN_CHECK_HOURS = 1;
const MAX_CHECK_HOURS = 24;
const DEFAULT_CHECK_HOURS = 6;
const MIN_PER_CHECK = 1;
const MAX_PER_CHECK = 100;
const DEFAULT_PER_CHECK = 10;

const DEFAULT_SCHEME = 'S{season2}E{episode2} - {title}';
const SCHEME_PLACEHOLDERS = ['title', 'series', 'season', 'season2', 'episode', 'episode2', 'date', 'year'];
const DEFAULT_SUBFOLDER = 'Mediathek';

const DEFAULTS = Object.freeze({
  storageRoot: null, // null = <Aufnahme-Speicherort>/Mediathek
  fileNameScheme: DEFAULT_SCHEME,
  seriesFolders: true,
  writeNfoCover: false,
  maxHeight: 'best',
  container: 'mp4',
  audioMode: 'preferred',
  audioLanguages: ['deu'],
  audioDescription: 'never',
  subtitleMode: 'preferred',
  subtitleLanguage: 'deu',
  subtitleDelivery: 'embedded',
  maxParallel: DEFAULT_PARALLEL,
  bandwidthKBps: 0,
  notifyOnDone: true,
  cleanupWatchedDays: 0,
  skipOptionsDialog: false,
  showDownloads: true,
  // Serien-Abos „Neue Folgen automatisch laden“
  autoDownloadEnabled: true,
  autoCheckIntervalHours: DEFAULT_CHECK_HOURS,
  maxPerCheck: DEFAULT_PER_CHECK,
});

/** Optionen, die der Dialog je Download überschreiben darf (Rest sind globale Einstellungen). */
const OVERRIDE_KEYS = ['maxHeight', 'container', 'audioMode', 'audioLanguages', 'audioDescription', 'subtitleMode', 'subtitleLanguage', 'subtitleDelivery'];

function toNumber(value) {
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return typeof value === 'number' ? value : NaN;
}

/** Ganzzahl auf [min, max]; ungültig -> fallback. Rückgabe { value, clamped }. */
function clampInt(raw, { min, max, fallback }) {
  const n = toNumber(raw);
  if (!Number.isFinite(n)) return { value: fallback, clamped: raw !== undefined && raw !== null };
  const value = Math.min(max, Math.max(min, Math.floor(n)));
  return { value, clamped: value !== n };
}

function oneOf(raw, allowed, fallback) {
  const value = typeof raw === 'number' ? String(raw) : raw;
  return allowed.includes(value) ? value : fallback;
}

function bool(raw, fallback) {
  return typeof raw === 'boolean' ? raw : fallback;
}

/** Schema nur mit bekannten Platzhaltern, ohne Pfadtrenner/Steuerzeichen; sonst Default. */
function normalizeScheme(raw) {
  if (typeof raw !== 'string') return DEFAULT_SCHEME;
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  if (!text || text.length > SCHEME_MAX || /[\u0000-\u001f\u007f/\\]/.test(text)) return DEFAULT_SCHEME;
  const unknown = [...text.matchAll(/\{([^}]*)\}/g)].some(match => !SCHEME_PLACEHOLDERS.includes(match[1]));
  if (unknown || /[{}]/.test(text.replace(/\{[a-z0-9]+\}/g, ''))) return DEFAULT_SCHEME;
  return text;
}

/** Sprachliste: nur bekannte Codes, ohne Dubletten, höchstens 6; leer -> Default. */
function normalizeLanguages(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const result = [];
  for (const item of list) {
    if (typeof item === 'string' && LANGUAGES.includes(item) && !result.includes(item)) result.push(item);
    if (result.length >= 6) break;
  }
  return result.length ? result : [...DEFAULTS.audioLanguages];
}

function normalizeRoot(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  if (!text || text.length > 1000 || /[\u0000-\u001f\u007f]/.test(text) || !path.isAbsolute(text)) return null;
  return path.resolve(text);
}

/**
 * Normalisiert gespeicherte/eingehende Einstellungen. Rückgabe: { settings, clamped: { maxParallel, bandwidthKBps, cleanupWatchedDays, autoCheckIntervalHours, maxPerCheck } }
 * (clamped = Eingabewert wurde geändert, die UI zeigt den tatsächlichen Wert).
 */
function normalizeDownloadSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const parallel = clampInt(src.maxParallel, { min: MIN_PARALLEL, max: MAX_PARALLEL, fallback: DEFAULTS.maxParallel });
  const bandwidth = clampInt(src.bandwidthKBps, { min: 0, max: MAX_BANDWIDTH_KBPS, fallback: DEFAULTS.bandwidthKBps });
  const cleanup = clampInt(src.cleanupWatchedDays, { min: 0, max: MAX_CLEANUP_DAYS, fallback: DEFAULTS.cleanupWatchedDays });
  const interval = clampInt(src.autoCheckIntervalHours, { min: MIN_CHECK_HOURS, max: MAX_CHECK_HOURS, fallback: DEFAULTS.autoCheckIntervalHours });
  const perCheck = clampInt(src.maxPerCheck, { min: MIN_PER_CHECK, max: MAX_PER_CHECK, fallback: DEFAULTS.maxPerCheck });
  const settings = {
    storageRoot: normalizeRoot(src.storageRoot),
    fileNameScheme: normalizeScheme(src.fileNameScheme),
    seriesFolders: bool(src.seriesFolders, DEFAULTS.seriesFolders),
    writeNfoCover: bool(src.writeNfoCover, DEFAULTS.writeNfoCover),
    maxHeight: oneOf(src.maxHeight, MAX_HEIGHTS, DEFAULTS.maxHeight),
    container: oneOf(src.container, CONTAINERS, DEFAULTS.container),
    audioMode: oneOf(src.audioMode, AUDIO_MODES, DEFAULTS.audioMode),
    audioLanguages: normalizeLanguages(src.audioLanguages),
    audioDescription: oneOf(src.audioDescription, AUDIO_DESCRIPTION_MODES, DEFAULTS.audioDescription),
    subtitleMode: oneOf(src.subtitleMode, SUBTITLE_MODES, DEFAULTS.subtitleMode),
    subtitleLanguage: oneOf(src.subtitleLanguage, LANGUAGES.filter(code => code !== 'orig'), DEFAULTS.subtitleLanguage),
    subtitleDelivery: oneOf(src.subtitleDelivery, SUBTITLE_DELIVERIES, DEFAULTS.subtitleDelivery),
    maxParallel: parallel.value,
    bandwidthKBps: bandwidth.value,
    notifyOnDone: bool(src.notifyOnDone, DEFAULTS.notifyOnDone),
    cleanupWatchedDays: cleanup.value,
    skipOptionsDialog: bool(src.skipOptionsDialog, DEFAULTS.skipOptionsDialog),
    showDownloads: bool(src.showDownloads, DEFAULTS.showDownloads),
    autoDownloadEnabled: bool(src.autoDownloadEnabled, DEFAULTS.autoDownloadEnabled),
    autoCheckIntervalHours: interval.value,
    maxPerCheck: perCheck.value,
  };
  return { settings, clamped: { maxParallel: parallel.clamped, bandwidthKBps: bandwidth.clamped, cleanupWatchedDays: cleanup.clamped, autoCheckIntervalHours: interval.clamped, maxPerCheck: perCheck.clamped } };
}

/** Wendet einen Patch (UI/IPC) auf die gespeicherten Rohdaten an; nur bekannte Felder zählen, das Ergebnis ist normalisiert. */
function applyDownloadSettingsPatch(raw, patch) {
  const current = normalizeDownloadSettings(raw).settings;
  const src = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = { ...current };
  for (const key of Object.keys(DEFAULTS)) if (src[key] !== undefined) merged[key] = src[key];
  const result = normalizeDownloadSettings(merged);
  // nur die im Patch gelieferten Felder melden
  const clamped = {};
  for (const key of Object.keys(result.clamped)) if (src[key] !== undefined) clamped[key] = result.clamped[key];
  return { settings: result.settings, clamped };
}

/** Überschreibungen aus dem Optionen-Dialog: nur erlaubte Felder, normalisiert. Ergebnis enthält nur gesetzte Felder. */
function normalizeOverrides(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const picked = {};
  for (const key of OVERRIDE_KEYS) if (src[key] !== undefined) picked[key] = src[key];
  const normalized = normalizeDownloadSettings(picked).settings;
  const result = {};
  for (const key of Object.keys(picked)) result[key] = normalized[key];
  return result;
}

/** Wirksame Optionen eines Downloads: Einstellungen, überlagert von den Überschreibungen. */
function effectiveOptions(settings, overrides) {
  return { ...settings, ...normalizeOverrides(overrides) };
}

/** Standard-Speicherort: Unterordner "Mediathek" des Aufnahme-Speicherorts. */
function defaultDownloadRoot(recordingRoot) {
  return path.join(recordingRoot, DEFAULT_SUBFOLDER);
}

/** Wirksamer Speicherort (eigener oder Standard). */
function resolveStorageRoot(settings, recordingRoot) {
  return settings.storageRoot || defaultDownloadRoot(recordingRoot);
}

/** Antwort der Kanäle downloads:settings-get/-set: gespeicherte Werte plus Metadaten für die Oberfläche. */
function buildSettingsResponse({ settings, clamped = {} }, recordingRoot) {
  return {
    ...settings,
    effectiveStorageRoot: resolveStorageRoot(settings, recordingRoot),
    isDefaultStorageRoot: !settings.storageRoot,
    signLanguage: 'never',
    options: { maxHeights: MAX_HEIGHTS, containers: CONTAINERS, audioModes: AUDIO_MODES, audioDescriptionModes: AUDIO_DESCRIPTION_MODES, subtitleModes: SUBTITLE_MODES, subtitleDeliveries: SUBTITLE_DELIVERIES, languages: LANGUAGES, minParallel: MIN_PARALLEL, maxParallel: MAX_PARALLEL, minCheckHours: MIN_CHECK_HOURS, maxCheckHours: MAX_CHECK_HOURS, minPerCheck: MIN_PER_CHECK, maxPerCheck: MAX_PER_CHECK },
    clamped,
  };
}

module.exports = {
  DEFAULTS,
  DEFAULT_SCHEME,
  SCHEME_PLACEHOLDERS,
  MAX_HEIGHTS,
  CONTAINERS,
  AUDIO_MODES,
  AUDIO_DESCRIPTION_MODES,
  SUBTITLE_MODES,
  SUBTITLE_DELIVERIES,
  LANGUAGES,
  OVERRIDE_KEYS,
  normalizeScheme,
  normalizeDownloadSettings,
  applyDownloadSettingsPatch,
  normalizeOverrides,
  effectiveOptions,
  defaultDownloadRoot,
  resolveStorageRoot,
  buildSettingsResponse,
};
