'use strict';

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

module.exports = {
  EPG_MAX_RANGE_MS,
  validateEpgChannelKey,
  validateEpgFind,
  validateEpgRange,
  normalizeWebviewKeydown,
  validateDownloadSize,
  validateReleaseMetadata,
  validateUpdateAssetUrl,
  validateVersion,
};
