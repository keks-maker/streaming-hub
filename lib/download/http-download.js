'use strict';

// Direktdownload einer progressiven MP4-Datei per HTTP mit Range-Resume, Bandbreitenlimit und Leerlauf-Zeitlimit. Der Transport
// ist injizierbar (Tests laufen gegen einen lokalen Server). Fehlermeldungen enthalten nie die Adresse (Tokens).

const fs = require('node:fs');
const { nodeFetch, fetchFollow, discardBody } = require('../radio/radio-http.js');
const { USER_AGENT } = require('../mediathek/http.js');

const IDLE_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;
const MAX_ATTEMPTS = 4;

function downloadError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(downloadError('Abgebrochen', 'aborted'));
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(downloadError('Abgebrochen', 'aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Größe der vorhandenen Teildatei (0, wenn es keine gibt). */
function existingSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** "bytes 100-199/200" -> { start, end, total }; null bei anderem Format. */
function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(value || '').trim());
  return match ? { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) } : null;
}

/** Einmaliger Abruf ab Offset start. Gibt { bytes (gesamt in der Datei), total, etag } zurück. */
async function pullOnce({ url, dest, start, etag, bytesPerSecond, signal, onProgress, fetchImpl, lookup, guardUrl, idleTimeoutMs, userAgent }) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw downloadError('Abgebrochen', 'aborted');
    signal.addEventListener('abort', forwardAbort, { once: true });
  }
  let idleTimer = null;
  let idled = false;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idled = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  let handle = null;
  try {
    const headers = { 'User-Agent': userAgent, Accept: '*/*' };
    if (start > 0) {
      headers.Range = `bytes=${start}-`;
      if (etag) headers['If-Range'] = etag;
    }
    armIdle();
    let response;
    try {
      ({ response } = await fetchFollow(url, { fetchImpl, signal: controller.signal, headers, maxRedirects: MAX_REDIRECTS, lookup, guardUrl }));
    } catch (error) {
      if (signal && signal.aborted) throw downloadError('Abgebrochen', 'aborted');
      if (idled) throw downloadError('Zeitüberschreitung beim Laden', 'timeout');
      if (error && (error.code === 'forbidden-host' || error.code === 'forbidden-address')) throw error;
      throw downloadError('Verbindung zum Server fehlgeschlagen', 'network');
    }
    const status = response.status;
    if (status === 416) {
      // Bereich nicht erfüllbar: Datei ist (angeblich) schon komplett
      await discardBody(response);
      const range = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
      const total = range ? Number(range[1]) : null;
      if (total !== null && total === start) return { bytes: start, total, etag };
      throw downloadError('Teildatei passt nicht zur Quelle', 'range-mismatch');
    }
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      await discardBody(response);
      throw downloadError(`Server verweigert den Abruf (HTTP ${status})`, 'expired', { status });
    }
    if (status !== 200 && status !== 206) {
      await discardBody(response);
      throw downloadError(`Server antwortete mit HTTP ${status}`, 'http', { status });
    }
    let offset = start;
    let total = null;
    if (status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.start !== start) {
        await discardBody(response);
        throw downloadError('Server liefert den falschen Bereich', 'range-mismatch');
      }
      total = range.total;
    } else {
      // 200: Server ignoriert Range (oder If-Range passt nicht) -> von vorn
      offset = 0;
      const length = Number(response.headers.get('content-length'));
      total = Number.isFinite(length) && length > 0 ? length : null;
    }
    const newEtag = response.headers.get('etag') || response.headers.get('last-modified') || null;
    handle = await fs.promises.open(dest, offset > 0 ? 'a' : 'w');
    const reader = response.body.getReader();
    const startedAt = Date.now();
    let received = 0;
    let bytes = offset;
    for (;;) {
      armIdle();
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal && signal.aborted) throw downloadError('Abgebrochen', 'aborted');
        if (idled) throw downloadError('Zeitüberschreitung beim Laden', 'timeout');
        throw downloadError('Verbindung abgebrochen', 'network');
      }
      if (chunk.done) break;
      const buffer = Buffer.from(chunk.value);
      await handle.write(buffer);
      received += buffer.length;
      bytes += buffer.length;
      if (onProgress) onProgress({ bytes, total, received, elapsedMs: Date.now() - startedAt });
      if (bytesPerSecond > 0) {
        // Bandbreitenlimit: erlaubte Menge bis jetzt gegen tatsächliche vergleichen und gegebenenfalls warten (Rückstau auf den Server)
        const allowedMs = (received / bytesPerSecond) * 1000;
        const wait = allowedMs - (Date.now() - startedAt);
        if (wait > 5) await sleep(Math.min(wait, 2000), controller.signal).catch(() => { throw downloadError('Abgebrochen', 'aborted'); });
      }
    }
    if (total !== null && bytes !== total) throw downloadError('Download unvollständig', 'incomplete');
    return { bytes, total, etag: newEtag };
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Lädt url nach dest (Teildatei). Existiert dest schon, wird per Range fortgesetzt. Bei Verbindungsfehlern bis zu 4 Versuche mit
 * Fortsetzung. Optionen: signal (AbortSignal), bytesPerSecond (0 = unbegrenzt), onProgress({ bytes, total }), etag (Validator einer
 * früheren Teilladung), fetchImpl/lookup/guardUrl (Transport, Adress-Pinning und Host-Prüfung), idleTimeoutMs, userAgent.
 * Rückgabe { bytes, total, etag }. Fehlercodes: aborted, timeout, network, expired (403/404: Adresse neu auflösen), http,
 * range-mismatch, incomplete, forbidden-host, forbidden-address, disk.
 */
async function downloadFile(url, dest, { signal = null, bytesPerSecond = 0, onProgress = null, etag = null, fetchImpl = nodeFetch, lookup, guardUrl, idleTimeoutMs = IDLE_TIMEOUT_MS, userAgent = USER_AGENT, retryDelayMs = 1500 } = {}) {
  let lastError = null;
  let currentEtag = etag;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const start = existingSize(dest);
      const result = await pullOnce({ url, dest, start, etag: currentEtag, bytesPerSecond, signal, onProgress, fetchImpl, lookup, guardUrl, idleTimeoutMs, userAgent });
      return result;
    } catch (error) {
      lastError = error;
      if (error && error.code === 'range-mismatch') {
        // Teildatei verwerfen und neu beginnen
        try {
          fs.rmSync(dest, { force: true });
        } catch {
          // Datei nicht löschbar: der nächste Versuch scheitert sichtbar
        }
        currentEtag = null;
        continue;
      }
      if (error && ['network', 'timeout', 'incomplete'].includes(error.code)) {
        await sleep(retryDelayMs * (attempt + 1), signal);
        continue;
      }
      if (error && (error.code === 'ENOSPC' || error.code === 'EDQUOT')) throw downloadError('Speicherplatz voll', 'disk');
      throw error;
    }
  }
  throw lastError || downloadError('Download fehlgeschlagen', 'network');
}

module.exports = { downloadFile, parseContentRange, IDLE_TIMEOUT_MS };
