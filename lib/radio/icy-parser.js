'use strict';

// ICY-Metadaten (Now Playing) für Radio: reine Parser + Zweitverbindung im Main.
// Der <audio>-Player gibt keine ICY-Daten heraus (R0). Der Main öffnet daher kurz eine zweite Verbindung mit
// "Icy-MetaData: 1", liest bis zum ersten nicht leeren StreamTitle und bricht ab (Größenlimit), danach
// schließt er die Verbindung. Bewusst "best effort": Sender ohne Titel sind kein Fehler.

const { TextDecoder } = require('util');
const { DEFAULT_TIMEOUT_MS, fetchFollow, nodeFetch, discardBody, withDeadline } = require('./radio-http.js');

const MAX_METAINT = 1024 * 1024;
const MAX_TITLE_LENGTH = 300;
const MIN_READ_LIMIT = 32 * 1024;
const MAX_READ_LIMIT = 256 * 1024;

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function decodeMetadata(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return buffer.toString('latin1'); // ältere Sender senden ISO-8859-1
  }
}

function cleanTitle(value) {
  const text = String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!text || /^-+$/.test(text)) return null;
  return text.slice(0, MAX_TITLE_LENGTH);
}

/** Extrahiert StreamTitle aus einem Metadaten-String; null, wenn nicht vorhanden oder leer. */
function parseStreamTitle(meta) {
  // eslint-disable-next-line no-control-regex -- Metadatenblöcke sind mit NUL aufgefüllt
  const match = /StreamTitle='(.*?)';?(?=\s*(?:[A-Za-z]+='|$))/s.exec(String(meta).replace(/\u0000+$/, ''));
  return match ? cleanTitle(match[1]) : null;
}

/** "Interpret - Titel" → { artist, title }; ohne Trenner ist alles der Titel. */
function splitArtistTitle(raw) {
  const text = cleanTitle(raw);
  if (!text) return { artist: '', title: '' };
  const index = text.indexOf(' - ');
  if (index <= 0 || index + 3 >= text.length) return { artist: '', title: text };
  return { artist: text.slice(0, index).trim(), title: text.slice(index + 3).trim() };
}

/**
 * Inkrementeller Extraktor: feed(chunk) liefert { done, title } sobald ein nicht leerer StreamTitle
 * gelesen wurde (done=true). Leere Metadatenblöcke werden übersprungen. metaint = Bytes zwischen Blöcken.
 */
function createIcyExtractor(metaint) {
  if (!Number.isInteger(metaint) || metaint <= 0 || metaint > MAX_METAINT) throw new Error('Ungültiges icy-metaint');
  let state = 'audio';
  let audioLeft = metaint;
  let metaLeft = 0;
  let metaChunks = [];
  let blocks = 0;
  return {
    get blocks() {
      return blocks;
    },
    feed(chunk) {
      let pos = 0;
      while (pos < chunk.length) {
        if (state === 'audio') {
          const take = Math.min(audioLeft, chunk.length - pos);
          pos += take;
          audioLeft -= take;
          if (audioLeft === 0) state = 'length';
        } else if (state === 'length') {
          metaLeft = chunk[pos] * 16;
          pos += 1;
          blocks += 1;
          if (metaLeft === 0) {
            state = 'audio';
            audioLeft = metaint;
          } else {
            state = 'meta';
            metaChunks = [];
          }
        } else {
          const take = Math.min(metaLeft, chunk.length - pos);
          metaChunks.push(Buffer.from(chunk.subarray(pos, pos + take)));
          pos += take;
          metaLeft -= take;
          if (metaLeft === 0) {
            const title = parseStreamTitle(decodeMetadata(Buffer.concat(metaChunks)));
            state = 'audio';
            audioLeft = metaint;
            if (title) return { done: true, title };
          }
        }
      }
      return { done: false, title: null };
    },
  };
}

/**
 * Zweitverbindung: liest den aktuellen Titel. Rückgabe { title, artist, raw, icyName, metaint }
 * (title/artist leer, wenn der Sender keinen Titel liefert). Wirft bei Verbindungsfehlern.
 * options: fetch, timeoutMs, maxBytes (Leselimit, Standard max(32 KiB, 3 × metaint), höchstens 256 KiB).
 */
async function readIcyTitle(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return withDeadline(
    timeoutMs,
    async signal => {
      const { response } = await fetchFollow(url, {
        fetchImpl: options.fetch || nodeFetch,
        signal,
        headers: { 'Icy-MetaData': '1' },
      });
      const result = { title: '', artist: '', raw: '', icyName: response.headers.get('icy-name') || '', metaint: 0 };
      if (response.status >= 400) {
        await discardBody(response);
        throw new Error(`Server antwortet mit HTTP ${response.status}`);
      }
      const metaint = parseInt(response.headers.get('icy-metaint') || '0', 10);
      if (!Number.isInteger(metaint) || metaint <= 0 || metaint > MAX_METAINT || !response.body) {
        await discardBody(response);
        return result;
      }
      result.metaint = metaint;
      const limit = Math.min(MAX_READ_LIMIT, options.maxBytes || Math.max(MIN_READ_LIMIT, metaint * 3));
      const extractor = createIcyExtractor(metaint);
      const reader = response.body.getReader();
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          const step = extractor.feed(Buffer.from(value));
          if (step.done) {
            result.raw = step.title;
            Object.assign(result, splitArtistTitle(step.title));
            break;
          }
          if (total >= limit) break;
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // bereits beendet
        }
      }
      return result;
    },
    options
  );
}

module.exports = { parseStreamTitle, splitArtistTitle, createIcyExtractor, readIcyTitle, decodeMetadata };
