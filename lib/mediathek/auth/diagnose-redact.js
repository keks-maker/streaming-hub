'use strict';

// Redaktion für die Diagnose-Aufzeichnung (rein): aus Anfragen und JSON-Antworten bleibt nur die Form übrig. Keine Werte von
// Query-Parametern oder Headern, keine Token, Cookies, Bodies oder personenbezogene Daten. Aus Item-Antworten werden nur
// Schlüsselnamen (rekursiv bis Tiefe 4) und wenige Jugendschutz-Felder mit kurzen Werten übernommen.

const { hostMatches } = require('./util.js');

const MAX_DEPTH = 4; // Tiefe der Schlüsselstruktur
const MAX_SCAN_DEPTH = 14; // Felder mit Werten werden tiefer gesucht (Item-Antworten sind tief verschachtelt)
const MAX_KEYS = 60;
const MAX_ARRAY_ITEMS = 3;
/** Felder, deren boolesche/kurze Enum-Werte übernommen werden (maturityContentRating ist ein Objekt: dessen Skalare). */
const VALUE_FIELDS = new Set(['blockedByFsk', 'isBlocked', 'isGeoBlocked', 'fskRating', 'kind']);
const MATURITY_FIELD = 'maturityContentRating';
const ENUM_PATTERN = /^[A-Za-z0-9_ .-]{1,24}$/;
/** Pfadsegmente nach diesen Wörtern sind Nutzer-/Profilkennungen. */
const ID_PARENTS = new Set(['users', 'user', 'mediathek', 'change', 'profiles', 'profile']);

/** true, wenn host zu einem aufzuzeichnenden Host gehört (Suffix-Liste, exakt oder Subdomain). */
function isRecordedHost(host, suffixes) {
  return typeof host === 'string' && suffixes.some(suffix => hostMatches(host.toLowerCase(), suffix));
}

function redactKey(key) {
  const text = String(key);
  return text.length > 40 || /[@\s]/.test(text) || /^[A-Za-z0-9]{24,}$/.test(text) ? '<key>' : text;
}

function redactSegment(segment, previous) {
  if (previous && ID_PARENTS.has(previous.toLowerCase())) return '<id>';
  if (/^[A-Za-z0-9]{28}$/.test(segment)) return '<id>';
  return segment.length > 200 ? '<long>' : segment;
}

/** { host, path, query: [Namen] } einer https-Adresse; null bei ungültiger Adresse. Werte der Parameter entfallen. */
function redactUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const segments = url.pathname.split('/');
  const path = segments.map((segment, index) => (segment ? redactSegment(decodeSafe(segment), segments[index - 1]) : segment)).join('/');
  return { host: url.hostname.toLowerCase(), path, query: [...new Set([...url.searchParams.keys()].map(redactKey))].slice(0, MAX_KEYS) };
}

function decodeSafe(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Header-Namen (klein geschrieben, ohne Duplikate); nie Werte. details: Objekt { Name: Wert } oder Liste von Namen. */
function headerNames(headers) {
  if (!headers || typeof headers !== 'object') return [];
  return [...new Set(Object.keys(headers).map(name => redactKey(name.toLowerCase())))].slice(0, MAX_KEYS);
}

function scalarValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1000) return value;
  if (typeof value === 'string' && ENUM_PATTERN.test(value)) return value;
  return undefined;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Struktur eines JSON-Wertes: { keys: { Name: Unterstruktur|null }, values: [{ path, field, value }] }.
 * keys enthält Schlüsselnamen bis Tiefe 4 (values: Suche bis Tiefe 14) (Arrays: Schlüssel der ersten Elemente zusammengeführt), values die erlaubten Felder.
 */
function summarizeJson(root) {
  const values = [];
  function walk(node, depth, path, insideMaturity) {
    if (Array.isArray(node)) {
      const merged = {};
      for (const item of node.slice(0, MAX_ARRAY_ITEMS)) {
        const part = walk(item, depth, `${path}[]`, insideMaturity);
        if (part) Object.assign(merged, part);
      }
      return Object.keys(merged).length ? merged : null;
    }
    if (!isObject(node)) return null;
    if (depth >= MAX_SCAN_DEPTH) return null;
    const keys = {};
    for (const key of Object.keys(node).slice(0, MAX_KEYS)) {
      const name = redactKey(key);
      const child = node[key];
      const childPath = `${path}.${name}`;
      if (VALUE_FIELDS.has(key) || (insideMaturity && !isObject(child) && !Array.isArray(child))) {
        const value = scalarValue(child);
        if (value !== undefined && values.length < 80) values.push({ path: childPath, field: key, value });
      }
      const sub = walk(child, depth + 1, childPath, key === MATURITY_FIELD);
      if (depth < MAX_DEPTH) keys[name] = sub;
    }
    return depth < MAX_DEPTH ? keys : null;
  }
  const keys = walk(root, 0, '', false);
  return { keys: keys || {}, values };
}

/** Wie summarizeJson, aber für Text; null bei ungültigem JSON. */
function summarizeJsonText(text) {
  try {
    return summarizeJson(JSON.parse(text));
  } catch {
    return null;
  }
}

/** true für Item-Antworten des Page-Gateways (…/page-gateway/pages/<partner>/item/<id>). */
function isItemUrl(value) {
  const parsed = redactUrl(value);
  return Boolean(parsed) && parsed.host === 'api.ardmediathek.de' && /^\/page-gateway\/pages\/[^/]+\/item\//.test(parsed.path);
}

module.exports = { isRecordedHost, redactUrl, headerNames, summarizeJson, summarizeJsonText, isItemUrl, MAX_DEPTH };
