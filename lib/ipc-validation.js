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

function validateUpdateAssetUrl(value, origin) {
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
    parsed.origin !== origin
  ) {
    throw new Error('Update-Download-URL verweist auf einen nicht autorisierten Origin');
  }
  return parsed.toString();
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

module.exports = { normalizeWebviewKeydown, validateUpdateAssetUrl, validateVersion };
