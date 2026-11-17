// EPG-Vorschaubild-Cache (Senderkachel, Schritt S2): lädt das Bild der laufenden Sendung im Main-Prozess, verkleinert
// es (processImage, in der App nativeImage.resize) und legt es als JPEG im Cache-Ordner ab. Dateiname = Hash der URL.
// Die Datei-mtime ist das Sendungsende: daraus folgen beide Aufräumregeln (seit einem Tag beendet → löschen; über dem
// Limit → älteste zuerst). Der Ordner liegt im Cache-Pfad der App und darf folgenlos gelöscht werden.
// Antwort an den Renderer ist eine data:-URL (CSP erlaubt data:, kein Pfad verlässt den Main-Prozess).

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchEpgResponse } = require('./download.js');
const { remoteHttpUrl } = require('../input-validation.js');

const DEFAULT_LIMIT_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_URL_LENGTH = 512;
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;
const FAIL_RETRY_MS = 10 * 60 * 1000;
const IMAGE_TYPE_RE = /^image\/(jpeg|jpg|png|webp|gif)\b/i;
const FILE_RE = /^[0-9a-f]{64}\.jpg$/;

/** Dateiname-Hash einer Bild-URL (SHA-256, hex). */
function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

/** Prüft die Anfrage des Renderers (nur http/https, begrenzte Länge); wirft bei Fehlern. */
function validateImageUrl(value, validateUrl = remoteHttpUrl) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) throw new Error('Bild-URL ist ungültig');
  return validateUrl(value, 'Bild-URL');
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Bild ist zu groß');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error('Bild ist zu groß');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function createEpgImageCache({
  dir,
  processImage,
  fetchImpl = fetch,
  validateUrl = remoteHttpUrl,
  now = Date.now,
  limitBytes = DEFAULT_LIMIT_BYTES,
  maxDownloadBytes = MAX_DOWNLOAD_BYTES,
  timeoutMs = 10_000,
  maxConcurrent = 3,
  logger = null,
} = {}) {
  if (!dir || typeof processImage !== 'function') throw new Error('createEpgImageCache benötigt dir und processImage');
  const inflight = new Map();
  const failedUntil = new Map();
  let active = 0;
  const waiting = [];

  const fileFor = hash => path.join(dir, `${hash}.jpg`);
  const toDataUrl = buf => `data:image/jpeg;base64,${buf.toString('base64')}`;
  const stopToSeconds = (stopMs, fallbackMs) => (Number.isFinite(stopMs) && stopMs > 0 ? stopMs : fallbackMs) / 1000;

  async function slot() {
    if (active >= maxConcurrent) await new Promise(resolve => waiting.push(resolve));
    active += 1;
  }
  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  async function download(url, hash, stopMs) {
    const response = await fetchEpgResponse(url, { fetchImpl, validateUrl, timeoutMs });
    if (!IMAGE_TYPE_RE.test(response.headers.get('content-type') || '')) throw new Error('Antwort ist kein Bild');
    const jpeg = await processImage(await readLimited(response, maxDownloadBytes));
    if (!Buffer.isBuffer(jpeg) || !jpeg.length) throw new Error('Bild nicht verarbeitbar');
    fs.mkdirSync(dir, { recursive: true });
    const target = fileFor(hash);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, jpeg);
    fs.renameSync(tmp, target);
    const sec = stopToSeconds(stopMs, now());
    fs.utimesSync(target, sec, sec);
    enforceLimit();
    return jpeg;
  }

  /**
   * Bild der Sendung als data:-URL oder null (ungültige URL, Ladefehler, kein Bild). stopMs = Sendungsende.
   * Fehlversuche werden 10 min nicht wiederholt.
   */
  async function get(rawUrl, stopMs) {
    let url;
    try {
      url = validateImageUrl(rawUrl, validateUrl);
    } catch (_) {
      return null;
    }
    const hash = hashUrl(url);
    const file = fileFor(hash);
    try {
      const stat = fs.statSync(file);
      const wantSec = stopToSeconds(stopMs, 0);
      if (wantSec * 1000 > stat.mtimeMs) fs.utimesSync(file, wantSec, wantSec);
      return toDataUrl(fs.readFileSync(file));
    } catch (_) {
      // nicht im Cache: laden
    }
    if ((failedUntil.get(hash) || 0) > now()) return null;
    if (!inflight.has(hash)) {
      const job = (async () => {
        await slot();
        try {
          return toDataUrl(await download(url, hash, stopMs));
        } catch (err) {
          failedUntil.set(hash, now() + FAIL_RETRY_MS);
          if (logger && logger.debug) logger.debug('EPG-Bild nicht geladen:', err.message);
          return null;
        } finally {
          release();
          inflight.delete(hash);
        }
      })();
      inflight.set(hash, job);
    }
    return inflight.get(hash);
  }

  function listFiles() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) out.push({ name, full, size: st.size, mtimeMs: st.mtimeMs });
      } catch (_) {
        // zwischenzeitlich entfernt
      }
    }
    return out;
  }

  function remove(file) {
    try {
      fs.unlinkSync(file.full);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Über dem Limit: älteste zuerst löschen. */
  function enforceLimit() {
    const files = listFiles().filter(f => FILE_RE.test(f.name));
    let total = files.reduce((sum, f) => sum + f.size, 0);
    let removed = 0;
    for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= limitBytes) break;
      if (remove(f)) {
        total -= f.size;
        removed += 1;
      }
    }
    return removed;
  }

  /** Beim Start: fremde/unfertige Dateien und seit einem Tag beendete Sendungen löschen, dann das Limit durchsetzen. */
  function cleanup() {
    let removed = 0;
    const cutoff = now() - EXPIRE_AFTER_MS;
    for (const f of listFiles()) {
      if ((!FILE_RE.test(f.name) || f.mtimeMs < cutoff) && remove(f)) removed += 1;
    }
    return removed + enforceLimit();
  }

  return { get, cleanup, enforceLimit, dir };
}

module.exports = { createEpgImageCache, hashUrl, validateImageUrl, DEFAULT_LIMIT_BYTES, MAX_DOWNLOAD_BYTES };
