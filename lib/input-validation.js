'use strict';

const MAX_TEXT_LENGTH = 4096;
const MAX_PLAYLIST_BYTES = 25 * 1024 * 1024;
const MAX_EPG_BYTES = 200 * 1024 * 1024;
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

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa', '.localdomain'];

function isPrivateIpv4Octets(octets) {
  const [a, b] = octets;
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

// IPv6-Adresse (ohne Klammern) in 8 Gruppen à 16 Bit; null bei ungültiger Eingabe.
// Unterstützt "::"-Kürzung und eingebettetes IPv4 am Ende (z. B. ::ffff:127.0.0.1).
function parseIpv6(address) {
  let text = address.split('%')[0];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some(n => n > 255)) return null;
    text = text.slice(0, v4.index) + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map(g => parseInt(g, 16));
}

function isPrivateIpv6(address) {
  const g = parseIpv6(address);
  if (!g) return true; // nicht auswertbar -> sicherheitshalber ablehnen
  const embedded = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every(x => x === 0)) return true; // :: (unspecified)
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIpv4Octets(embedded(g[6], g[7])); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateIpv4Octets(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateIpv4Octets(embedded(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host.includes(':')) return isPrivateIpv6(host);
  if (host === 'localhost' || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return isPrivateIpv4Octets(octets);
  }
  // Einteilige Hostnamen (ohne Punkt, z. B. "intranet") sind nur im lokalen Netz auflösbar.
  if (!host.includes('.')) return true;
  return false;
}

function remoteHttpUrl(value, field, { allowOrigin } = {}) {
  const normalized = httpUrl(value, field);
  const parsed = new URL(normalized);
  if (isPrivateHostname(parsed.hostname) && parsed.origin !== allowOrigin) {
    throw new Error(`${field} darf kein lokales oder privates Ziel verwenden`);
  }
  return normalized;
}

function optionalHttpUrl(value, field) {
  if (value === undefined || value === null || value === '') return value ?? null;
  return httpUrl(value, field);
}

function service(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dienst ist ungültig');
  return {
    name: text(value.name, 'Dienstname', 200),
    url: remoteHttpUrl(value.url, 'Dienst-URL'),
    icon: text(value.icon || 'icons/default.svg', 'Dienst-Icon', 500),
    color: value.color === undefined ? undefined : text(value.color, 'Dienstfarbe', 32),
    group: value.group === undefined ? undefined : text(value.group, 'Dienstgruppe', 32),
  };
}

// Logo eines Sender-Overrides: http/https oder sicherer relativer Pfad (wird gegen die
// Playlist-Basis aufgelöst). Abgelehnt: file:/javascript:/data: u. a. Schemata, protokollrelative
// Adressen (//host/x), Backslash-/UNC-Pfade, Whitespace/Steuerzeichen. Liefert Fehlertext oder null.
function channelLogoError(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) return 'Logo-URL ist ungültig';
  if ([...value].some(ch => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127)) return 'Logo-URL darf keine Leer- oder Steuerzeichen enthalten';
  if (value.includes('\\') || value.startsWith('//')) return 'Logo-URL darf kein Netzwerk-/UNC-Pfad sein';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return 'Logo-URL ist ungültig';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Logo-URL muss mit http:// oder https:// beginnen (oder ein relativer Pfad sein)';
    }
  }
  return null;
}

// Stream-URL eines Sender-Overrides: http/https, keine Zugangsdaten, keine lokalen/privaten Ziele.
function channelStreamUrlError(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) return 'Stream-URL ist ungültig';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'Stream-URL muss mit http:// oder https:// beginnen';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Stream-URL muss mit http:// oder https:// beginnen';
  if (parsed.username || parsed.password) return 'Stream-URL darf keine Zugangsdaten enthalten';
  if (isPrivateHostname(parsed.hostname)) return 'Stream-URL darf kein lokales oder privates Ziel verwenden';
  return null;
}

// Prüft die Overrides eines Senders (name, tvgId, tvgLogo, url); unbekannte Felder bleiben unangetastet.
function channelOverrideEntryError(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'Sender-Anpassung ist ungültig';
  for (const key of ['name', 'tvgId']) {
    if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key].length > 200)) {
      return `${key === 'name' ? 'Sendername' : 'tvg-id'} ist ungültig (max. 200 Zeichen)`;
    }
  }
  if (entry.url !== undefined) {
    const error = channelStreamUrlError(entry.url);
    if (error) return error;
  }
  if (entry.tvgLogo !== undefined) {
    const error = channelLogoError(entry.tvgLogo);
    if (error) return error;
  }
  return null;
}

// Beim SCHREIBEN von channelOverrides: nur neue oder geänderte Einträge werden geprüft,
// unveränderte Bestandsdaten (z. B. aus iOS/tvOS-kompatiblen Dateien) bleiben unberührt.
function channelOverrides(value, existing) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kanalüberschreibungen sind ungültig');
  const previous = existing && typeof existing === 'object' ? existing : {};
  for (const [channelId, entry] of Object.entries(value)) {
    if (channelId.length > 500) throw new Error('Kanal-ID ist zu lang');
    if (JSON.stringify(entry) === JSON.stringify(previous[channelId])) continue;
    const error = channelOverrideEntryError(entry);
    if (error) throw new Error(error);
  }
  return value;
}

function tvSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TV-Quelle ist ungültig');
  const type = value.type === 'file' ? 'file' : 'url';
  const result = {
    name: text(value.name, 'Quellenname', 200),
    url: type === 'file' ? text(value.url, 'M3U-Dateipfad', 4096) : remoteHttpUrl(value.url, 'M3U-URL'),
    type,
    color: value.color === undefined ? undefined : text(value.color, 'Quellenfarbe', 32),
    epgUrl:
      value.epgUrl === undefined || value.epgUrl === null || value.epgUrl === ''
        ? null
        : remoteHttpUrl(value.epgUrl, 'EPG-URL'),
  };
  if (Array.isArray(value.sortOrder))
    result.sortOrder = value.sortOrder.filter(item => typeof item === 'string').slice(0, 5000);
  return result;
}

// existingType: Typ der bestehenden Quelle — bei Teil-Updates ohne `type` entscheidet
// er, ob `url` ein Dateipfad oder eine Remote-URL ist.
function tvSourceUpdates(value, existingType, existingOverrides) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TV-Quellenänderung ist ungültig');
  const allowed = ['name', 'url', 'type', 'color', 'epgUrl', 'sortOrder', 'favorites', 'channelOverrides'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unbekanntes Feld: ${key}`);
  }
  const result = {};
  if (value.name !== undefined) result.name = text(value.name, 'Quellenname', 200);
  const effectiveType = value.type !== undefined ? value.type : existingType;
  if (value.url !== undefined)
    result.url = effectiveType === 'file' ? text(value.url, 'M3U-Dateipfad', 4096) : remoteHttpUrl(value.url, 'M3U-URL');
  if (value.type !== undefined && value.type !== 'file' && value.type !== 'url')
    throw new Error('Quellentyp ist ungültig');
  if (value.type !== undefined) result.type = value.type;
  if (value.color !== undefined) result.color = text(value.color, 'Quellenfarbe', 32);
  if (value.epgUrl !== undefined)
    result.epgUrl = value.epgUrl === null || value.epgUrl === '' ? null : remoteHttpUrl(value.epgUrl, 'EPG-URL');
  if (value.sortOrder !== undefined) {
    if (!Array.isArray(value.sortOrder)) throw new Error('Sortierung ist ungültig');
    result.sortOrder = value.sortOrder.filter(item => typeof item === 'string').slice(0, 5000);
  }
  if (value.favorites !== undefined) {
    if (!Array.isArray(value.favorites)) throw new Error('Favoriten sind ungültig');
    result.favorites = value.favorites.filter(item => typeof item === 'string').slice(0, 5000);
  }
  if (value.channelOverrides !== undefined) {
    result.channelOverrides = channelOverrides(value.channelOverrides, existingOverrides);
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
  isPrivateHostname,
  channelLogoError,
  channelStreamUrlError,
  channelOverrideEntryError,
  channelOverrides,
  remoteHttpUrl,
  optionalHttpUrl,
  readResponseText,
  service,
  text,
  tvSource,
  tvSourceUpdates,
  fetchOptions,
};
