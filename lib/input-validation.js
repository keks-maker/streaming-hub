'use strict';

const MAX_TEXT_LENGTH = 4096;
const MAX_PLAYLIST_BYTES = 25 * 1024 * 1024;
const MAX_EPG_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

function text(value, field, max = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`${field} ist ungültig`);
  }
  return value.trim();
}

function httpUrl(value, field) {
  const parsed = new URL(text(value, field));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field} benötigt HTTP oder HTTPS`);
  }
  if (parsed.username || parsed.password) throw new Error(`${field} darf keine Zugangsdaten enthalten`);
  return parsed.toString();
}

function optionalHttpUrl(value, field) {
  if (value === undefined || value === null || value === '') return value ?? null;
  return httpUrl(value, field);
}

function service(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dienst ist ungültig');
  return {
    name: text(value.name, 'Dienstname', 200),
    url: httpUrl(value.url, 'Dienst-URL'),
    icon: text(value.icon || 'icons/default.svg', 'Dienst-Icon', 500),
    color: value.color === undefined ? undefined : text(value.color, 'Dienstfarbe', 32),
    group: value.group === undefined ? undefined : text(value.group, 'Dienstgruppe', 32),
  };
}

function tvSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TV-Quelle ist ungültig');
  const type = value.type === 'file' ? 'file' : 'url';
  const result = {
    name: text(value.name, 'Quellenname', 200),
    url: type === 'file' ? text(value.url, 'M3U-Dateipfad', 4096) : httpUrl(value.url, 'M3U-URL'),
    type,
    color: value.color === undefined ? undefined : text(value.color, 'Quellenfarbe', 32),
    epgUrl: optionalHttpUrl(value.epgUrl, 'EPG-URL'),
  };
  if (Array.isArray(value.sortOrder))
    result.sortOrder = value.sortOrder.filter(item => typeof item === 'string').slice(0, 5000);
  return result;
}

function tvSourceUpdates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TV-Quellenänderung ist ungültig');
  const allowed = ['name', 'url', 'type', 'color', 'epgUrl', 'sortOrder', 'favorites', 'channelOverrides'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unbekanntes Feld: ${key}`);
  }
  const result = {};
  if (value.name !== undefined) result.name = text(value.name, 'Quellenname', 200);
  if (value.url !== undefined)
    result.url = value.type === 'file' ? text(value.url, 'M3U-Dateipfad', 4096) : httpUrl(value.url, 'M3U-URL');
  if (value.type !== undefined && value.type !== 'file' && value.type !== 'url')
    throw new Error('Quellentyp ist ungültig');
  if (value.type !== undefined) result.type = value.type;
  if (value.color !== undefined) result.color = text(value.color, 'Quellenfarbe', 32);
  if (value.epgUrl !== undefined) result.epgUrl = optionalHttpUrl(value.epgUrl, 'EPG-URL');
  if (value.sortOrder !== undefined) {
    if (!Array.isArray(value.sortOrder)) throw new Error('Sortierung ist ungültig');
    result.sortOrder = value.sortOrder.filter(item => typeof item === 'string').slice(0, 5000);
  }
  if (value.favorites !== undefined) {
    if (!Array.isArray(value.favorites)) throw new Error('Favoriten sind ungültig');
    result.favorites = value.favorites.filter(item => typeof item === 'string').slice(0, 5000);
  }
  if (value.channelOverrides !== undefined) {
    if (!value.channelOverrides || typeof value.channelOverrides !== 'object' || Array.isArray(value.channelOverrides))
      throw new Error('Kanalüberschreibungen sind ungültig');
    result.channelOverrides = value.channelOverrides;
  }
  return result;
}

function fetchOptions(maxBytes) {
  return { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), maxBytes };
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('Antwort ist zu groß');
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error('Antwort ist zu groß');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = {
  MAX_EPG_BYTES,
  MAX_PLAYLIST_BYTES,
  REQUEST_TIMEOUT_MS,
  httpUrl,
  optionalHttpUrl,
  readResponseText,
  service,
  text,
  tvSource,
  tvSourceUpdates,
  fetchOptions,
};
