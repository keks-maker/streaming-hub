'use strict';

const { isStartView } = require('./epg-view-settings.js');

const ALLOWED_WEBCONTEXT_KEYS = new Set([
  'Escape',
  'F11',
  '?',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'Tab',
  'p',
  'P',
  'h',
  'H',
  't',
  'T',
]);

function validateVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('Ungültige Versionsnummer');
  }
  return value;
}

function validateUpdateAssetUrl(value, origin, expectedPathPrefix) {
  if (typeof value !== 'string' || typeof origin !== 'string') throw new Error('Ungültige Update-Download-URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error('Ungültige Update-Download-URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== origin ||
    (expectedPathPrefix && !parsed.pathname.startsWith(expectedPathPrefix))
  ) {
    throw new Error('Update-Download-URL verweist auf einen nicht autorisierten Origin oder Pfad');
  }
  return parsed.toString();
}

function validateReleaseMetadata(release, requestedVersion, origin, expectedPathPrefix) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('Ungültige Release-Metadaten');
  }
  if (typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('Ungültiger Release-Tag');
  }
  const version = release.tag_name.replace(/^v/, '');
  if (requestedVersion !== undefined && version !== requestedVersion) {
    throw new Error('Release-Version stimmt nicht mit der angeforderten Version überein');
  }
  if (!Array.isArray(release.assets)) throw new Error('Ungültige Release-Assets');
  const appImages = release.assets.filter(asset => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
    return typeof asset.name === 'string' && /^\S+\.AppImage$/.test(asset.name);
  });
  if (appImages.length !== 1) throw new Error('Release muss genau ein AppImage enthalten');
  const asset = appImages[0];
  const downloadUrl = validateUpdateAssetUrl(asset.browser_download_url, origin, expectedPathPrefix);
  return { version, asset: { name: asset.name, browser_download_url: downloadUrl } };
}

function validateDownloadSize(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Ungültiges Download-Limit');
  if (value === undefined || value === null || value === '') return 0;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error('Update-Datei ist zu groß');
  return size;
}

function normalizeWebviewKeydown(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.key !== 'string' || !ALLOWED_WEBCONTEXT_KEYS.has(data.key)) return null;
  const fields = ['ctrlKey', 'shiftKey', 'metaKey', 'altKey'];
  if (!fields.every(field => typeof data[field] === 'boolean')) return null;
  return {
    key: data.key,
    ctrlKey: data.ctrlKey,
    shiftKey: data.shiftKey,
    metaKey: data.metaKey,
    altKey: data.altKey,
  };
}

// ── EPG-Abfragen (Main-EpgService, Etappe 1) ──

const EPG_MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000; // Cache reicht ohnehin nur ~10 Tage
const EPG_MAX_EPOCH_MS = 4102444800000; // 2100-01-01

function validateEpgChannelKey(value) {
  if (typeof value !== 'string') throw new Error('Ungültiger EPG-Kanal');
  const key = value.trim();
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('Ungültiger EPG-Kanal');
  return key;
}

function validateEpgTimestamp(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > EPG_MAX_EPOCH_MS) {
    throw new Error(`${field} ist ungültig`);
  }
  return value;
}

function validateEpgRange(channelKey, fromMs, toMs) {
  const key = validateEpgChannelKey(channelKey);
  const from = validateEpgTimestamp(fromMs, 'Startzeit');
  const to = validateEpgTimestamp(toMs, 'Endzeit');
  if (to <= from) throw new Error('Endzeit muss nach der Startzeit liegen');
  if (to - from > EPG_MAX_RANGE_MS) throw new Error('Zeitraum ist zu groß (max. 14 Tage)');
  return { channelKey: key, fromMs: from, toMs: to };
}

function validateEpgFind(channelKey, atMs) {
  return { channelKey: validateEpgChannelKey(channelKey), atMs: validateEpgTimestamp(atMs, 'Zeitpunkt') };
}

// ── Raster-/Suche-API (Etappe 3.1; EPG-Konzept §4 A-1) ──

const EPG_RANGE_MANY_MAX_CHANNELS = 100;
const EPG_SEARCH_MAX_CHANNELS = 600;
const EPG_SEARCH_MIN_QUERY = 2;
const EPG_SEARCH_MAX_QUERY = 80;
const EPG_SEARCH_DEFAULT_LIMIT = 50;
const EPG_SEARCH_MAX_LIMIT = 200;

/** Kanalliste: nicht leeres Array gültiger Kanal-Schlüssel, max. maxCount, Duplikate entfernt. */
function validateEpgChannelKeys(value, maxCount) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Kanalliste ist ungültig');
  if (value.length > maxCount) throw new Error(`Zu viele Kanäle (max. ${maxCount})`);
  return [...new Set(value.map(validateEpgChannelKey))];
}

function validateEpgTimeWindow(fromMs, toMs) {
  const from = validateEpgTimestamp(fromMs, 'Startzeit');
  const to = validateEpgTimestamp(toMs, 'Endzeit');
  if (to <= from) throw new Error('Endzeit muss nach der Startzeit liegen');
  if (to - from > EPG_MAX_RANGE_MS) throw new Error('Zeitraum ist zu groß (max. 14 Tage)');
  return { fromMs: from, toMs: to };
}

function validateEpgRangeMany(channelKeys, fromMs, toMs) {
  return {
    channelKeys: validateEpgChannelKeys(channelKeys, EPG_RANGE_MANY_MAX_CHANNELS),
    ...validateEpgTimeWindow(fromMs, toMs),
  };
}

/** options: undefined oder { includeDesc?: boolean } — Beschreibung mitdurchsuchen (Default aus). */
function validateEpgSearch(channelKeys, query, fromMs, toMs, limit, options) {
  const keys = validateEpgChannelKeys(channelKeys, EPG_SEARCH_MAX_CHANNELS);
  if (typeof query !== 'string') throw new Error('Suchbegriff ist ungültig');
  const text = query.trim();
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('Suchbegriff ist ungültig');
  if (text.length < EPG_SEARCH_MIN_QUERY) throw new Error(`Suchbegriff ist zu kurz (min. ${EPG_SEARCH_MIN_QUERY} Zeichen)`);
  if (text.length > EPG_SEARCH_MAX_QUERY) throw new Error(`Suchbegriff ist zu lang (max. ${EPG_SEARCH_MAX_QUERY} Zeichen)`);
  const window = validateEpgTimeWindow(fromMs, toMs);
  let max = EPG_SEARCH_DEFAULT_LIMIT;
  if (limit !== undefined && limit !== null) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Limit ist ungültig');
    if (limit > EPG_SEARCH_MAX_LIMIT) throw new Error(`Limit ist zu groß (max. ${EPG_SEARCH_MAX_LIMIT})`);
    max = limit;
  }
  let includeDesc = false;
  let full = false;
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) throw new Error('Suchoptionen sind ungültig');
    if (options.includeDesc !== undefined && typeof options.includeDesc !== 'boolean') {
      throw new Error('Suchoptionen sind ungültig');
    }
    includeDesc = options.includeDesc === true;
    if (options.full !== undefined && typeof options.full !== 'boolean') throw new Error('Suchoptionen sind ungültig');
    full = options.full === true;
  }
  return { channelKeys: keys, query: text, ...window, limit: max, includeDesc, full };
}

// ── Einstellungen des Programmführers (Etappe 3.5, P20) ──

/**
 * Patch der Programmführer-Einstellungen: einfaches Objekt mit genau den bekannten Feldern.
 * startView muss aus der festen Menge stammen (auto | list | grid | jng); alles andere wird abgelehnt.
 */
function validateEpgViewSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Ungültige Programmführer-Einstellungen');
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => key !== 'startView')) throw new Error('Ungültige Programmführer-Einstellungen');
  if (!isStartView(patch.startView)) throw new Error('Ungültige Startansicht');
  return { startView: patch.startView };
}

// ── Planung (Etappe 2a; Konzept §3.8) ──

const SCHEDULE_ID_PATTERN = /^sch_[A-Za-z0-9._-]+$/;
const SCHEDULE_MAX_BUFFER_SEC = 30 * 60;
const SCHEDULE_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const SCHEDULE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const SCHEDULE_CONTROL_CHARS_G = /[\u0000-\u001f\u007f]/g;

function validateScheduleId(value) {
  if (typeof value !== 'string' || !SCHEDULE_ID_PATTERN.test(value) || value.length > 100) {
    throw new Error('Ungültige Planungs-ID');
  }
  return value;
}

/** Strikter ISO-8601-Parser mit Pflicht-Offset (Z oder ±hh:mm); liefert ms oder wirft. */
function parseScheduleTime(value, field) {
  if (typeof value !== 'string' || value.length > 40) throw new Error(`${field} ist ungültig`);
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) throw new Error(`${field} muss ISO-8601 mit Zeitzonen-Offset sein`);
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    throw new Error(`${field} ist ungültig`);
  }
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d)) throw new Error(`${field} ist ungültig`);
  let offsetMin = 0;
  if (zone !== 'Z') {
    if (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4, 6)) > 59) throw new Error(`${field} ist ungültig`);
    offsetMin = (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), frac ? Number(frac.padEnd(3, '0')) : 0);
  return ms - offsetMin * 60000;
}

function scheduleText(value, field, { max, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} fehlt`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${field} ist ungültig`);
  // Steuerzeichen (auch Zeilenumbrüche) → Leerzeichen, Whitespace zusammenfassen
  const text = value.replace(SCHEDULE_CONTROL_CHARS_G, ' ').replace(/\s+/g, ' ').trim();
  if (required && !text) throw new Error(`${field} fehlt`);
  if (text.length > max) throw new Error(`${field} ist zu lang (max. ${max} Zeichen)`);
  return text;
}

function scheduleIdentifier(value, field) {
  if (typeof value === 'string' && SCHEDULE_CONTROL_CHARS.test(value)) throw new Error(`${field} enthält Steuerzeichen`);
  return scheduleText(value, field, { max: 200 });
}

function scheduleBuffer(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > SCHEDULE_MAX_BUFFER_SEC) {
    throw new Error(`${field} muss eine ganze Zahl von 0 bis ${SCHEDULE_MAX_BUFFER_SEC} Sekunden sein (max. 30 Minuten)`);
  }
  return value;
}

/**
 * Validiert Zeiten (strikt, Offset Pflicht, Stopp nach Start, max. 24 h Dauer,
 * Plausibilitätsgrenzen). Die „nur Zukunft“-Regel (epgStart > jetzt) prüft der
 * Main im Scheduler gegen seine Systemuhr; hier nur grobe Grenzen, damit
 * offensichtlicher Unsinn früh scheitert.
 */
function validateScheduleTimes(epgStart, epgStop, nowMs) {
  const startMs = parseScheduleTime(epgStart, 'Startzeit');
  const stopMs = parseScheduleTime(epgStop, 'Endzeit');
  if (stopMs <= startMs) throw new Error('Das Ende der Sendung muss nach dem Start liegen');
  if (stopMs - startMs > SCHEDULE_MAX_DURATION_MS) throw new Error('Eine Aufnahme darf höchstens 24 Stunden dauern');
  if (startMs < nowMs - 366 * 24 * 3600 * 1000 || startMs > nowMs + SCHEDULE_MAX_AHEAD_MS + 24 * 3600 * 1000) {
    throw new Error('Die Startzeit liegt außerhalb des planbaren Bereichs');
  }
  return { startMs, stopMs };
}

function validateScheduleInput(input, { nowMs = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ungültige Planungs-Anfrage');
  const channelId = scheduleIdentifier(input.channelId, 'Kanal-ID');
  const channelName = scheduleIdentifier(input.channelName, 'Kanalname');
  if (!channelId && !channelName) throw new Error('Planung benötigt channelId oder channelName');
  validateScheduleTimes(input.epgStart, input.epgStop, nowMs);
  const result = {
    channelId,
    channelName,
    tvgId: scheduleIdentifier(input.tvgId, 'tvg-id'),
    sourceId: scheduleIdentifier(input.sourceId, 'Quellen-ID'),
    title: scheduleText(input.title, 'Titel', { max: 300, required: true }),
    description: scheduleText(input.description, 'Beschreibung', { max: 2000 }),
    epgStart: input.epgStart,
    epgStop: input.epgStop,
  };
  if (input.sourceUrlSnapshot !== undefined && input.sourceUrlSnapshot !== null && input.sourceUrlSnapshot !== '') {
    const url = String(input.sourceUrlSnapshot);
    if (!/^https?:\/\//i.test(url) || url.length > 4096) throw new Error('Ungültige Stream-URL (nur http/https)');
    result.sourceUrlSnapshot = url;
  }
  const before = scheduleBuffer(input.bufferBeforeSec, 'Vorlauf');
  const after = scheduleBuffer(input.bufferAfterSec, 'Nachlauf');
  if (before !== undefined) result.bufferBeforeSec = before;
  if (after !== undefined) result.bufferAfterSec = after;
  if (input.allowOverLimit !== undefined) {
    if (typeof input.allowOverLimit !== 'boolean') throw new Error('allowOverLimit muss ein Boolean sein');
    result.allowOverLimit = input.allowOverLimit;
  }
  if (input.mergeWithId !== undefined && input.mergeWithId !== null) {
    result.mergeWithId = validateScheduleId(input.mergeWithId);
  }
  return result;
}

function validateScheduleUpdate(id, patch, { nowMs = Date.now() } = {}) {
  validateScheduleId(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Ungültige Planungs-Änderung');
  const allowed = new Set(['bufferBeforeSec', 'bufferAfterSec', 'epgStart', 'epgStop', 'allowOverLimit']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Feld "${key}" darf nicht geändert werden`);
  }
  const result = {};
  const before = scheduleBuffer(patch.bufferBeforeSec, 'Vorlauf');
  const after = scheduleBuffer(patch.bufferAfterSec, 'Nachlauf');
  if (before !== undefined) result.bufferBeforeSec = before;
  if (after !== undefined) result.bufferAfterSec = after;
  if (patch.allowOverLimit !== undefined) {
    if (typeof patch.allowOverLimit !== 'boolean') throw new Error('allowOverLimit muss ein Boolean sein');
    result.allowOverLimit = patch.allowOverLimit;
  }
  if (patch.epgStart !== undefined || patch.epgStop !== undefined) {
    if (patch.epgStart === undefined || patch.epgStop === undefined) {
      throw new Error('Start- und Endzeit müssen gemeinsam geändert werden');
    }
    validateScheduleTimes(patch.epgStart, patch.epgStop, nowMs);
    result.epgStart = patch.epgStart;
    result.epgStop = patch.epgStop;
  }
  return result;
}

module.exports = {
  SCHEDULE_ID_PATTERN,
  SCHEDULE_MAX_BUFFER_SEC,
  parseScheduleTime,
  validateScheduleId,
  validateScheduleInput,
  validateScheduleUpdate,
  validateScheduleTimes,
  EPG_MAX_RANGE_MS,
  validateEpgChannelKey,
  validateEpgFind,
  validateEpgRange,
  validateEpgChannelKeys,
  validateEpgRangeMany,
  validateEpgSearch,
  validateEpgViewSettingsPatch,
  EPG_RANGE_MANY_MAX_CHANNELS,
  EPG_SEARCH_MAX_CHANNELS,
  EPG_SEARCH_MIN_QUERY,
  EPG_SEARCH_MAX_QUERY,
  EPG_SEARCH_DEFAULT_LIMIT,
  EPG_SEARCH_MAX_LIMIT,
  normalizeWebviewKeydown,
  validateDownloadSize,
  validateReleaseMetadata,
  validateUpdateAssetUrl,
  validateVersion,
};
