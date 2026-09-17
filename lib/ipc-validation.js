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

module.exports = { normalizeWebviewKeydown, validateVersion };
