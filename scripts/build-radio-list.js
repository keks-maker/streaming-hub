#!/usr/bin/env node
'use strict';

// Erzeugt radiosources.json (Konzept §3.1) aus dem offenen Verzeichnis radio-browser.info:
// Land DE, hidebroken, Votes-Sortierung, Dubletten (stationuuid, Name, Stream-Adresse), Mindest-Votes,
// Streams ohne Zugangsdaten/Token, Erreichbarkeitsprüfung über lib/radio/radio-resolve.js.
// Bestehende Sender-IDs und Stream-URLs bleiben unverändert (stabile IDs für Favoriten/Merge).
// Netzwerk (DNS, HTTP, Prüfung) ist injizierbar; Tests laufen offline mit Fixtures. Rohdaten werden nicht geschrieben.
//
// Aufruf: node scripts/build-radio-list.js [--target 250] [--min-votes 100] [--pool 1500] [--concurrency 8]
//                                          [--timeout 8000] [--existing radiosources.json] [--out radiosources.json] [--dry-run]

const fs = require('node:fs');
const path = require('node:path');
const { probeStream } = require('../lib/radio/radio-resolve.js');
const { REQUIRED } = require('./radio-list-curated.js');
const {
  normName,
  httpsLogo,
  streamKey,
  normalizeCandidate,
  resolveApiServers,
  createApiClient,
  fetchPool,
  searchByName,
} = require('../lib/radio/radio-browser.js');

const SOURCE_ID = 'deutsche-radiosender';

function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'sender'
  );
}

// ---------- Aufbau ----------

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function stationFrom(parts) {
  const out = { id: parts.id, name: parts.name, streamUrl: parts.streamUrl };
  if (parts.rbUuid) out.rbUuid = parts.rbUuid;
  if (parts.logo) out.logo = parts.logo;
  if (parts.genre) out.genre = parts.genre;
  if (parts.region) out.region = parts.region;
  out.country = 'DE';
  if (parts.codec) out.codec = parts.codec;
  if (parts.bitrate) out.bitrate = parts.bitrate;
  if (parts.homepage) out.homepage = parts.homepage;
  return out;
}

/**
 * Baut die Senderliste.
 *   existing:  bisherige Quelle (IDs/URLs bleiben), pool: Roh-Einträge des Verzeichnisses,
 *   api:       { getJson } für Namenssuchen, probe(url) -> { ok }, required: Pflichtliste (curated).
 * Liefert { source, report } mit report = { count, required: {found, missing}, unreachableExisting, probed }.
 */
async function buildList({ existing, pool, api, probe, required = REQUIRED, target = 250, minVotes = 100, concurrency = 8, log = () => {} }) {
  const existingStations = existing && Array.isArray(existing.stations) ? existing.stations : [];
  const existingById = new Map(existingStations.map(station => [station.id, station]));
  const candidates = pool.map(normalizeCandidate).filter(Boolean);
  const taken = { uuid: new Set(), name: new Set(), stream: new Set(), id: new Set() };
  const entries = []; // { station, votes }
  const report = { required: { found: [], missing: [] }, unreachableExisting: [], probed: 0 };

  const checkOk = async url => {
    report.probed += 1;
    const result = await probe(url);
    return Boolean(result && result.ok);
  };
  const take = (station, votes) => {
    entries.push({ station, votes });
    taken.uuid.add(station.rbUuid);
    taken.name.add(normName(station.name));
    taken.stream.add(streamKey(station.streamUrl));
    taken.id.add(station.id);
  };
  async function lookup(predicate, searchTerm) {
    let found = candidates.filter(predicate).sort((a, b) => b.votes - a.votes)[0];
    if (!found && searchTerm && api) {
      try {
        found = (await searchByName(api, searchTerm)).map(normalizeCandidate).filter(Boolean).filter(predicate).sort((a, b) => b.votes - a.votes)[0];
      } catch (error) {
        log(`Suche "${searchTerm}" fehlgeschlagen: ${error.message}`);
      }
    }
    return found || null;
  }

  // 1. Pflichtsender (ÖR-Landeswellen) und 2. übrige bestehende Sender: IDs und URLs der bestehenden bleiben
  const requiredIds = new Set(required.map(entry => entry.id));
  const jobs = [
    ...required.map(entry => ({ entry, old: existingById.get(entry.id) || null })),
    ...existingStations.filter(station => !requiredIds.has(station.id)).map(station => ({ entry: null, old: station })),
  ];
  const resolved = await mapLimited(jobs, concurrency, async ({ entry, old }) => {
    const matcher = entry ? c => entry.match.test(c.name) : c => normName(c.name) === normName(old.name);
    const found = await lookup(matcher, entry ? entry.search : old.name);
    const options = [];
    if (old && old.streamUrl) options.push(old.streamUrl);
    if (found) options.push(found.streamUrl);
    if (entry && entry.fallbackUrl) options.push(entry.fallbackUrl);
    let streamUrl = null;
    for (const url of [...new Set(options)]) {
      if (await checkOk(url)) {
        streamUrl = url;
        break;
      }
    }
    return { entry, old, found, streamUrl };
  });
  for (const { entry, old, found, streamUrl } of resolved) {
    const label = entry ? entry.id : old.id;
    if (!streamUrl && !old) {
      report.required.missing.push(label);
      continue;
    }
    if (!streamUrl) report.unreachableExisting.push(label);
    const base = old || {};
    const station = stationFrom({
      id: label,
      name: entry ? entry.name : old.name,
      streamUrl: streamUrl || old.streamUrl,
      rbUuid: found ? found.rbUuid : base.rbUuid,
      logo: httpsLogo(base.logo) || (found && found.logo),
      genre: base.genre || (entry && entry.genre) || (found && found.genre),
      region: base.region || (entry && entry.region) || (found && found.region),
      codec: base.codec || (found && found.codec),
      bitrate: base.bitrate || (found && found.bitrate),
      homepage: base.homepage || (found && found.homepage),
    });
    if (entry) report.required.found.push(label);
    if (station.rbUuid && taken.uuid.has(station.rbUuid)) continue;
    take(station, found ? found.votes : 0);
  }
  // Pflichtsender, die schon vorhanden sind, nicht erneut als "missing" führen
  report.required.missing = report.required.missing.filter(id => !taken.id.has(id));
  report.required.found = required.map(entry => entry.id).filter(id => taken.id.has(id));

  // 3. Rest nach Votes, bis Zielgröße erreicht (geprüft in Blöcken)
  const rest = candidates
    .filter(c => c.votes >= minVotes)
    .sort((a, b) => b.votes - a.votes)
    .filter(c => !taken.uuid.has(c.rbUuid));
  for (let offset = 0; offset < rest.length && entries.length < target; offset += concurrency * 4) {
    const batch = [];
    for (const candidate of rest.slice(offset, offset + concurrency * 4)) {
      if (taken.uuid.has(candidate.rbUuid) || taken.name.has(normName(candidate.name)) || taken.stream.has(streamKey(candidate.streamUrl))) continue;
      batch.push(candidate);
    }
    const ok = await mapLimited(batch, concurrency, candidate => checkOk(candidate.streamUrl));
    for (let i = 0; i < batch.length && entries.length < target; i += 1) {
      const candidate = batch[i];
      if (!ok[i]) continue;
      if (taken.uuid.has(candidate.rbUuid) || taken.name.has(normName(candidate.name)) || taken.stream.has(streamKey(candidate.streamUrl))) continue;
      let id = slug(candidate.name);
      if (taken.id.has(id)) id = `${id}-${candidate.rbUuid.slice(0, 6)}`;
      take(stationFrom({ ...candidate, id }), candidate.votes);
    }
    log(`geprüft: ${report.probed}, übernommen: ${entries.length}`);
  }

  entries.sort((a, b) => b.votes - a.votes);
  const stations = entries.map(entry => entry.station);
  const source = {
    id: existing && existing.id ? existing.id : SOURCE_ID,
    name: existing && existing.name ? existing.name : 'Deutsche Radiosender',
    type: 'bundled',
    stations,
    sortOrder: stations.map(station => station.id),
  };
  report.count = stations.length;
  return { source, report };
}

function parseArgs(argv) {
  const options = { existing: path.join(__dirname, '..', 'radiosources.json'), target: 250, minVotes: 100, pool: 1500, concurrency: 8, timeout: 8000, out: path.join(__dirname, '..', 'radiosources.json'), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--target') options.target = Number(argv[++i]);
    else if (arg === '--min-votes') options.minVotes = Number(argv[++i]);
    else if (arg === '--pool') options.pool = Number(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--timeout') options.timeout = Number(argv[++i]);
    else if (arg === '--existing') options.existing = path.resolve(argv[++i]);
    else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else throw new Error(`Unbekannte Option: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const readExisting = () => {
    try {
      const data = JSON.parse(fs.readFileSync(options.existing, 'utf8'));
      return Array.isArray(data) ? data.find(source => source && source.id === SOURCE_ID) || null : null;
    } catch {
      return null;
    }
  };
  const existing = readExisting();
  const servers = await resolveApiServers();
  const api = createApiClient({ servers });
  console.log(`radio-browser-Server: ${servers.join(', ')}`);
  const pool = await fetchPool(api, { pool: options.pool });
  console.log(`Verzeichnis: ${pool.length} Einträge`);
  const probe = url => probeStream(url, { timeoutMs: options.timeout });
  const { source, report } = await buildList({
    existing,
    pool,
    api,
    probe,
    target: options.target,
    minVotes: options.minVotes,
    concurrency: options.concurrency,
    log: message => console.log(message),
  });
  console.log(`Sender: ${report.count}; Pflichtsender gefunden: ${report.required.found.length}, fehlend: ${report.required.missing.join(', ') || '-'}`);
  if (report.unreachableExisting.length) console.log(`Bestehende Sender aktuell nicht erreichbar (ID bleibt): ${report.unreachableExisting.join(', ')}`);
  if (options.dryRun) return;
  fs.writeFileSync(options.out, `${JSON.stringify([source], null, 2)}\n`);
  console.log(`Geschrieben: ${options.out}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildList, parseArgs, main };
