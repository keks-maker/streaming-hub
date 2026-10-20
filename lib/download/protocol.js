'use strict';

// Wiedergabe-Protokoll der Mediathek-Downloads: dl://local/<downloadId>.<mp4|mkv> streamt ausschließlich Dateien aus dem
// Download-Index (DownloadService.fileInfo) mit Range-Unterstützung (Spulen im <video>). Keine Pfade vom Renderer: die ID
// wird gegen das Muster und den Index geprüft, die Datei kommt aus dem Datensatz. Muster des rec://-Protokolls in main.js.

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { ID_PATTERN } = require('./records.js');

const DL_SCHEME = 'dl';
const DL_HOST = 'local';
const CONTENT_TYPES = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska' };

/** Privilegien des Schemas (vor app.ready über protocol.registerSchemesAsPrivileged zu registrieren). */
const DL_PRIVILEGES = Object.freeze({ standard: true, stream: true, supportFetchAPI: true, bypassCSP: false, corsEnabled: true });

/** Adresse für die Wiedergabe eines Downloads im Renderer. */
function playbackUrl(id, container) {
  return `${DL_SCHEME}://${DL_HOST}/${id}.${container === 'mkv' ? 'mkv' : 'mp4'}`;
}

/**
 * Range-Header (einzelner Bereich) -> { start, end } (inklusive), null = kein Header, 'invalid' = nicht erfüllbar.
 * Bereiche über das Dateiende werden gekürzt.
 */
function parseRange(header, size) {
  if (header === null || header === undefined || header === '') return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Download-ID aus der Adresse; null bei fremdem Host/Pfad. */
function idFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${DL_SCHEME}:` || url.hostname !== DL_HOST) return null;
  let name;
  try {
    name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const match = /^([A-Za-z0-9_-]+)\.(mp4|mkv)$/.exec(name);
  return match && ID_PATTERN.test(match[1]) ? match[1] : null;
}

/** getFileInfo(id) -> { path } | null (DownloadService.fileInfo). Ergebnis: Handler (Request -> Response). */
function createDownloadProtocolHandler({ getFileInfo, logger = null }) {
  const status = code => new Response(null, { status: code });
  return async function handler(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return status(405);
    try {
      const id = idFromUrl(request.url);
      if (!id) return status(404);
      const info = getFileInfo(id);
      if (!info || !info.path) return status(404);
      const stat = await fs.promises.stat(info.path);
      if (!stat.isFile()) return status(404);
      const type = CONTENT_TYPES[path.extname(info.path).toLowerCase()];
      if (!type) return status(404);
      const size = stat.size;
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
      const range = parseRange(request.headers.get('range'), size);
      if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      const code = range ? 206 : 200;
      if (request.method === 'HEAD' || size === 0) return new Response(null, { status: code, headers });
      return new Response(Readable.toWeb(fs.createReadStream(info.path, { start, end })), { status: code, headers });
    } catch (error) {
      if (error && error.code !== 'ENOENT' && logger) logger.error('[dl://] Wiedergabe fehlgeschlagen:', error.code || error.message);
      return status(404);
    }
  };
}

module.exports = { DL_SCHEME, DL_HOST, DL_PRIVILEGES, playbackUrl, parseRange, idFromUrl, createDownloadProtocolHandler };
