// EPG-Download: Validierung + Redirect-Handling (geteilt) und Streaming-Parse
// (Etappe 1; Konzept §3.2)
//
// fetchEpgResponse ist die aus dem fetch-epg-Handler (main.js) herausgelöste
// Download-Validierung: nur öffentliche http(s)-URLs (remoteHttpUrl), Redirects
// manuell (max. 5), jedes Redirect-Ziel wird erneut validiert. Der Renderer-
// Handler und der Main-EpgService nutzen dieselbe Funktion.
//
// gzip: Node/undici-fetch sendet `Accept-Encoding: gzip, deflate` und dekodiert
// Content-Encoding transparent (gemessen: 51,8 MB → 11,4 MB, −78 %). Zusätzlich
// erkennt parseXmltvResponse rohe .gz-Antworten (Magic 1f 8b, z. B. epg-de.xml.gz
// mit Content-Type application/gzip) und entpackt sie per Stream. Die Größen-
// grenze (MAX_EPG_BYTES) gilt für die übertragenen UND die entpackten Bytes
// (Schutz vor Dekompressionsbomben).

'use strict';

const zlib = require('zlib');
const { TextDecoder } = require('util');
const { setImmediate } = require('timers');
const { pipeline, Readable } = require('stream');
const { remoteHttpUrl, MAX_EPG_BYTES } = require('../input-validation.js');
const { XmltvStreamParser } = require('./xmltv-stream-parser.js');

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/**
 * Lädt eine EPG-URL mit Validierung und manuellem Redirect-Handling.
 * options: fetchImpl (Default global fetch), validateUrl (Default remoteHttpUrl),
 * timeoutMs, signal (zusätzlicher Abbruch).
 */
async function fetchEpgResponse(
  url,
  { fetchImpl = fetch, validateUrl = remoteHttpUrl, timeoutMs = 20_000, signal = null } = {},
) {
  let epgUrl = validateUrl(url, 'EPG-URL');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let response;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    response = await fetchImpl(epgUrl, { signal: combined, redirect: 'manual' });
    if (!REDIRECT_STATUSES.includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location) throw new Error(`HTTP ${response.status} ohne Redirect-Ziel`);
    if (redirectCount === MAX_REDIRECTS) throw new Error('Zu viele Redirects');
    epgUrl = validateUrl(new URL(location, epgUrl).toString(), 'EPG-Redirect-Ziel');
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function* rawChunks(body, maxBytes) {
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Antwort ist zu groß');
      yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      // bereits geschlossen
    }
  }
}

function chooseTextDecoder(headBytes) {
  const head = headBytes.subarray(0, 200).toString('latin1');
  const m = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  const label = m ? m[1].toLowerCase() : 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false });
  } catch (_) {
    return new TextDecoder('utf-8', { fatal: false });
  }
}

/**
 * Parst eine XMLTV-Antwort als Stream. Rückgabe: parser.stats.
 * options: maxBytes (Default MAX_EPG_BYTES), fromMs/toMs (Fenster), onProgramme.
 */
async function parseXmltvResponse(response, { maxBytes = MAX_EPG_BYTES, fromMs, toMs, onProgramme } = {}) {
  if (!response.body) throw new Error('Antwort ohne Inhalt');
  const iterator = rawChunks(response.body, maxBytes)[Symbol.asyncIterator]();

  // Mindestens 2 Bytes für die gzip-Erkennung lesen (Chunks können winzig sein)
  const head = [];
  let headLen = 0;
  let exhausted = false;
  while (headLen < 2 && !exhausted) {
    const { done, value } = await iterator.next();
    if (done) exhausted = true;
    else {
      head.push(value);
      headLen += value.length;
    }
  }
  const first = Buffer.concat(head);
  async function* allChunks() {
    if (first.length) yield first;
    if (exhausted) return;
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) return;
      yield value;
    }
  }

  const isGzip = first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b;
  let source = Readable.from(allChunks(), { objectMode: false });
  let gunzip = null;
  if (isGzip) {
    gunzip = zlib.createGunzip();
    pipeline(source, gunzip, () => {}); // Fehler landen als Stream-Fehler im for-await unten
    source = gunzip;
  }

  const parser = new XmltvStreamParser({ onProgramme, fromMs, toMs });
  let decoder = null;
  let decodedBytes = 0;
  try {
    for await (const chunk of source) {
      decodedBytes += chunk.length;
      if (decodedBytes > maxBytes) throw new Error('Antwort ist zu groß (entpackt)');
      if (!decoder) decoder = chooseTextDecoder(chunk);
      parser.write(decoder.decode(chunk, { stream: true }));
      // Event-Loop freigeben: der Main-Prozess bedient währenddessen IPC/Timer
      await new Promise(resolve => setImmediate(resolve));
    }
    if (decoder) parser.write(decoder.decode());
    parser.end();
  } finally {
    source.destroy();
    if (gunzip) gunzip.destroy();
  }
  return { ...parser.stats, gzip: isGzip, decodedBytes };
}

module.exports = { fetchEpgResponse, parseXmltvResponse };
