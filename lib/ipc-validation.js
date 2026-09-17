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

module.exports = {
  normalizeWebviewKeydown,
  validateDownloadSize,
  validateReleaseMetadata,
  validateUpdateAssetUrl,
  validateVersion,
};
