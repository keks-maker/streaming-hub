'use strict';

// Zugriff auf das offene Verzeichnis radio-browser.info (Konzept §3.1): Serverwahl per DNS mit Zufallsreihenfolge und
// Failover, sprechender User-Agent, Normalisierung der Verzeichniseinträge (Streams ohne Zugangsdaten/Token).
// Netzwerk (DNS, fetch) ist injizierbar. Genutzt von scripts/build-radio-list.js und „Liste aktualisieren“ (radio-refresh.js).

const API_HOST = 'all.api.radio-browser.info';
const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'at1.api.radio-browser.info'];
const USER_AGENT = 'StreamingHub/1.0 (+https://github.com/keks-maker/streaming-hub; build-radio-list)';
const STATE_REGION = {
  'baden-württemberg': 'BW',
  bayern: 'BY',
  berlin: 'BE',
  brandenburg: 'BB',
  bremen: 'HB',
  hamburg: 'HH',
  hessen: 'HE',
  'mecklenburg-vorpommern': 'MV',
  niedersachsen: 'NI',
  'nordrhein-westfalen': 'NRW',
  'rheinland-pfalz': 'RP',
  saarland: 'SL',
  sachsen: 'SN',
  'sachsen-anhalt': 'ST',
  'schleswig-holstein': 'SH',
  thüringen: 'TH',
};

// Reihenfolge = Priorität; erste passende Verzeichnis-Tag bestimmt das Genre
const GENRE_RULES = [
  [/schlager|volksmusik/, 'Schlager'],
  [/metal/, 'Metal'],
  [/rock|alternative|indie|punk/, 'Rock'],
  [/classical|klassik|opera/, 'Klassik'],
  [/jazz|blues|soul/, 'Jazz'],
  [/chillout|lounge|ambient|relax/, 'Chillout'],
  [/hip.?hop|rap|urban|rnb/, 'HipHop'],
  [/electro|dance|house|techno|trance|edm|club/, 'Electro'],
  [/oldies|80s|90s|70s|60s|retro|classic hits/, 'Oldies'],
  [/news|talk|info|politic|nachrichten/, 'Information'],
  [/kultur|culture/, 'Kultur'],
  [/country|folk/, 'Country'],
  [/reggae|latin|world/, 'Weltmusik'],
  [/christian|religio/, 'Religion'],
  [/children|kids|kinder/, 'Kinder'],
  [/pop|hits|top ?40|charts|music/, 'Pop'],
];

const SENSITIVE_PARAMS = /^(token|tvf|sid|cid|key|apikey|api_key|password|passwd|pass|pwd|auth|sig|signature|session|sessionid|secret|user|username|login)$/i;

function normName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Logo nur als https-Adresse (die Content-Security-Policy der App lädt keine http-Bilder). */
function httpsLogo(value) {
  const parsed = value ? parseHttp(value) : null;
  return parsed && parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
}

function parseHttp(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** true, wenn die Adresse Zugangsdaten (user:pass@) oder Token-/Sitzungsparameter enthält. */
function hasCredentials(url) {
  const parsed = parseHttp(url);
  if (!parsed) return true;
  if (parsed.username || parsed.password) return true;
  for (const key of parsed.searchParams.keys()) if (SENSITIVE_PARAMS.test(key)) return true;
  return false;
}

/** Entfernt Aggregator-Markierungen (aggregator=…), die das Verzeichnis anhängt. */
function cleanStreamUrl(url) {
  const parsed = parseHttp(url);
  if (!parsed) return null;
  parsed.searchParams.delete('aggregator');
  return parsed.toString();
}

function pickStreamUrl(raw) {
  for (const candidate of [raw.url_resolved, raw.url]) {
    const cleaned = candidate && cleanStreamUrl(candidate);
    if (cleaned && !hasCredentials(cleaned)) return cleaned;
  }
  return null;
}

function streamKey(url) {
  const parsed = parseHttp(url);
  return parsed ? `${parsed.hostname}${parsed.pathname}`.toLowerCase() : String(url);
}

function cleanName(name) {
  return String(name || '')
    .replace(/\s*[|[].*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-_\s]+|[-_\s]+$/g, '');
}

function genreOf(tags) {
  const list = String(tags || '').toLowerCase();
  for (const [pattern, genre] of GENRE_RULES) if (pattern.test(list)) return genre;
  return null;
}

function codecOf(codec) {
  const value = String(codec || '').toLowerCase().replace(/\+$/, '');
  return value && value !== 'unknown' ? value : null;
}

/** Verzeichniseintrag -> Kandidat (null, wenn unbrauchbar). */
function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object' || !raw.stationuuid) return null;
  if (raw.lastcheckok !== undefined && Number(raw.lastcheckok) !== 1) return null;
  const streamUrl = pickStreamUrl(raw);
  const name = cleanName(raw.name);
  if (!streamUrl || !name || name.length > 60) return null;
  const logo = httpsLogo(raw.favicon);
  const homepage = raw.homepage && parseHttp(raw.homepage) ? String(raw.homepage) : null;
  return {
    rbUuid: String(raw.stationuuid),
    name,
    streamUrl,
    votes: Number(raw.votes) || 0,
    logo,
    homepage,
    genre: genreOf(raw.tags),
    region: STATE_REGION[String(raw.state || '').toLowerCase()] || null,
    codec: codecOf(raw.codec),
    bitrate: Number(raw.bitrate) > 0 ? Number(raw.bitrate) : null,
  };
}

// ---------- radio-browser-Zugriff (Etikette: sprechender User-Agent, DNS-Serverliste, Zufallswahl, Failover) ----------

async function resolveApiServers({ resolveHosts, fallback = FALLBACK_SERVERS } = {}) {
  const lookup =
    resolveHosts ||
    (async () => {
      const dns = require('node:dns').promises;
      const addresses = await dns.resolve4(API_HOST);
      const names = await Promise.all(addresses.map(address => dns.reverse(address).then(list => list[0], () => null)));
      return names.filter(Boolean);
    });
  try {
    const hosts = (await lookup()).filter(host => /\.radio-browser\.info$/i.test(host));
    if (hosts.length) return [...new Set(hosts)];
  } catch {
    // Failover auf die feste Liste
  }
  return [...fallback];
}

function shuffled(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Client mit Zufallsreihenfolge und Failover über alle Server. getJson(path) liefert geparstes JSON. */
function createApiClient({ servers, fetchImpl = globalThis.fetch, random = Math.random, userAgent = USER_AGENT, timeoutMs = 20000 } = {}) {
  const order = shuffled(servers, random);
  return {
    async getJson(pathAndQuery) {
      let lastError = null;
      for (const server of order) {
        try {
          const response = await fetchImpl(`https://${server}${pathAndQuery}`, {
            headers: { 'User-Agent': userAgent, Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json();
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`radio-browser nicht erreichbar: ${lastError ? lastError.message : 'keine Server'}`);
    },
  };
}

function fetchPool(api, { pool = 1500 } = {}) {
  return api.getJson(`/json/stations/search?countrycode=DE&hidebroken=true&order=votes&reverse=true&limit=${pool}`);
}

function searchByName(api, name) {
  return api.getJson(`/json/stations/search?countrycode=DE&hidebroken=true&order=votes&reverse=true&limit=25&name=${encodeURIComponent(name)}`);
}


/** Aktuelle Verzeichniseinträge zu Sender-UUIDs (in Blöcken, damit die Adresse kurz bleibt). */
async function fetchByUuids(api, uuids, { chunk = 40 } = {}) {
  const out = [];
  for (let i = 0; i < uuids.length; i += chunk) {
    const part = uuids.slice(i, i + chunk).map(encodeURIComponent).join(',');
    const list = await api.getJson(`/json/stations/byuuid?uuids=${part}`);
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}

module.exports = {
  API_HOST,
  USER_AGENT,
  normName,
  httpsLogo,
  streamKey,
  normalizeCandidate,
  hasCredentials,
  cleanStreamUrl,
  resolveApiServers,
  createApiClient,
  fetchPool,
  searchByName,
  fetchByUuids,
};
