'use strict';

// Gemeinsame HTTP-Bausteine für Radio im Main-Prozess (Playlist-Auflösung, Stream-Probe, ICY-Titel):
// nur http/https, begrenzte Redirects, harter Gesamt-Timeout über AbortController, Größenlimit beim Lesen.
// Der globale fetch ist injizierbar (Tests); Redirects werden manuell verfolgt, damit jedes Ziel geprüft wird.

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = 'StreamingHub-Radio/1.0 (+https://github.com/keks-maker/streaming-hub)';

/** Macht Netzwerkfehler (undici: "fetch failed" + cause.code) lesbar. */
function describeFetchError(error) {
  const code = error && error.cause && error.cause.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Server nicht gefunden';
  if (code === 'ECONNREFUSED') return 'Verbindung abgelehnt';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'Verbindung abgebrochen';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'Zeitüberschreitung beim Verbinden';
  if (error && error.message === 'fetch failed') return 'Stream nicht erreichbar';
  return (error && error.message) || 'Stream nicht erreichbar';
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Ungültige Stream-URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Nur http:// und https:// sind erlaubt');
  }
  return url;
}

/**
 * Führt fn(signal) mit hartem Gesamt-Timeout aus. Bei Ablauf wird abgebrochen und
 * "Zeitüberschreitung" geworfen (auch wenn fn eine andere Abbruchmeldung liefert).
 */
async function withDeadline(timeoutMs, fn, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimer(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut) throw new Error(`Zeitüberschreitung nach ${timeoutMs} ms`);
    throw new Error(describeFetchError(error));
  } finally {
    clearTimer(timer);
  }
}

/**
 * GET mit begrenztem Redirect-Folgen. Liefert { response, finalUrl, hops }; die Antwort ist nie ein
 * Redirect. Redirect-Antworten werden verworfen (Body abgebrochen), jedes Ziel muss http/https sein.
 */
async function fetchFollow(url, { fetchImpl = globalThis.fetch, signal, headers = {}, maxRedirects = DEFAULT_MAX_REDIRECTS } = {}) {
  let current = parseHttpUrl(url).toString();
  for (let hops = 0; ; hops += 1) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': USER_AGENT, ...headers },
    });
    const location = response.headers && response.headers.get ? response.headers.get('location') : null;
    if (response.status >= 300 && response.status < 400 && location) {
      await discardBody(response);
      if (hops >= maxRedirects) throw new Error('Zu viele Weiterleitungen');
      current = parseHttpUrl(new URL(location, current)).toString();
      continue;
    }
    return { response, finalUrl: current, hops };
  }
}

async function discardBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch {
    // Body schon geschlossen
  }
}

/** Liest höchstens maxBytes aus dem Body und bricht danach ab. Liefert { buffer, truncated }. */
async function readLimited(response, maxBytes = DEFAULT_MAX_BYTES) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const all = Buffer.from(await response.arrayBuffer());
    return { buffer: all.subarray(0, maxBytes), truncated: all.length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream bereits beendet
    }
  }
  return { buffer: Buffer.concat(chunks).subarray(0, maxBytes), truncated };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  USER_AGENT,
  describeFetchError,
  parseHttpUrl,
  withDeadline,
  fetchFollow,
  discardBody,
  readLimited,
};
