'use strict';

// Verständliche deutsche Fehlertexte für fehlgeschlagene M3U-Abrufe.
//
// Node-fetch (undici) meldet fast alles als "TypeError: fetch failed"; die eigentliche
// Ursache steckt in err.cause (Fehlercode, ggf. verschachtelt / AggregateError).
// Datenschutz: Die Ausgabe enthält NIE die URL, Zugangsdaten, Tokens oder Cause-Texte
// (undici-Meldungen wie "getaddrinfo ENOTFOUND host" enthalten den Hostnamen). Es werden
// nur feste Texte aus Fehlercodes/Namen zurückgegeben. Unbekannte Ursachen fallen auf
// err.message zurück (bei Node-fetch "fetch failed", ohne URL).

const MAX_DEPTH = 5;

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME']);
const REFUSED_CODES = new Set(['ECONNREFUSED']);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
const OFFLINE_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

function isTlsCode(code) {
  return (
    /^ERR_(TLS|SSL)_/.test(code) ||
    /^ERR_OSSL/.test(code) ||
    /CERT/.test(code) ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'EPROTO'
  );
}

// Sammelt Fehlerobjekte der gesamten Ursachenkette (cause, AggregateError.errors).
function collectChain(err) {
  const out = [];
  const seen = new Set();
  const walk = (e, depth) => {
    if (!e || typeof e !== 'object' || seen.has(e) || depth > MAX_DEPTH) return;
    seen.add(e);
    out.push(e);
    walk(e.cause, depth + 1);
    if (Array.isArray(e.errors)) e.errors.forEach(inner => walk(inner, depth + 1));
  };
  walk(err, 0);
  return out;
}

/**
 * @param {unknown} err
 * @returns {string} lesbarer Text ohne URL/Zugangsdaten
 */
function describeM3uFetchError(err) {
  const chain = collectChain(err);
  const codes = chain.map(e => (typeof e.code === 'string' ? e.code : '')).filter(Boolean);
  const names = chain.map(e => e.name);
  const messages = chain.map(e => (typeof e.message === 'string' ? e.message : ''));

  if (names.includes('TimeoutError') || names.includes('AbortError') || codes.some(c => TIMEOUT_CODES.has(c))) {
    return 'Zeitüberschreitung – der Server antwortet nicht';
  }
  if (messages.some(m => /unexpected redirect/i.test(m))) {
    return 'Weiterleitung nicht erlaubt – bitte die endgültige URL der Playlist eintragen';
  }
  if (codes.some(c => DNS_CODES.has(c))) return 'Host nicht gefunden (DNS-Auflösung fehlgeschlagen)';
  if (codes.some(c => REFUSED_CODES.has(c))) return 'Verbindung abgelehnt';
  if (codes.some(c => RESET_CODES.has(c))) return 'Verbindung vom Server unterbrochen';
  if (codes.some(c => OFFLINE_CODES.has(c))) return 'Server nicht erreichbar (kein Netzwerk?)';
  if (codes.some(isTlsCode)) return 'TLS-/Zertifikatsfehler – sichere Verbindung nicht möglich';

  const message = err && typeof err.message === 'string' && err.message ? err.message : String(err);
  return message;
}

module.exports = { describeM3uFetchError };
