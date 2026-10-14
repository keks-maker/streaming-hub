'use strict';

// „Liste aktualisieren“ (Konzept §3.1): fragt für mitgelieferte Sender mit rbUuid die aktuelle Stream-Adresse bei
// radio-browser.info ab und merkt abweichende, erreichbare Adressen getrennt von Nutzer-Overrides (RadioLibrary:
// radio-stream-refresh.json). Nutzer-Overrides der Stream-URL bleiben unberührt. Netzwerk injizierbar (api, probe).

const { fetchByUuids, normalizeCandidate } = require('./radio-browser.js');
const { effectiveStation } = require('./radio-sources-logic.js');

const DEFAULT_LIMIT = 300;
const DEFAULT_CONCURRENCY = 6;

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * options: sources (mit Overlay), refreshed ({ sourceId: { stationId: url } }), api ({ getJson }), probe(url) -> { ok },
 *          limit, concurrency. Liefert { refreshed (neue Map), checked, updated, reverted, failed }. Wirft bei nicht erreichbarem Verzeichnis.
 */
async function refreshStreamUrls({ sources, refreshed = {}, api, probe, limit = DEFAULT_LIMIT, concurrency = DEFAULT_CONCURRENCY }) {
  const targets = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || source.type === 'user' || !Array.isArray(source.stations)) continue;
    const overrides = source.stationOverrides && typeof source.stationOverrides === 'object' ? source.stationOverrides : {};
    for (const station of source.stations) {
      if (targets.length >= limit) break;
      if (!station || typeof station.rbUuid !== 'string' || !station.rbUuid) continue;
      if (overrides[station.id] && overrides[station.id].streamUrl) continue; // Nutzerwunsch hat Vorrang
      targets.push({ source, station });
    }
  }
  const entries = await fetchByUuids(api, [...new Set(targets.map(t => t.station.rbUuid))]);
  const byUuid = new Map(entries.map(normalizeCandidate).filter(Boolean).map(candidate => [candidate.rbUuid, candidate]));

  const next = {};
  for (const [sourceId, map] of Object.entries(refreshed)) next[sourceId] = { ...map };
  const result = { checked: targets.length, updated: 0, reverted: 0, failed: 0 };

  const outcomes = await mapLimited(targets, concurrency, async ({ source, station }) => {
    const candidate = byUuid.get(station.rbUuid);
    if (!candidate) return { source, station, action: 'none' };
    const current = effectiveStation(source, station).streamUrl;
    if (candidate.streamUrl === station.streamUrl) return { source, station, action: candidate.streamUrl === current ? 'none' : 'revert' };
    if (candidate.streamUrl === current) return { source, station, action: 'none' };
    const check = await probe(candidate.streamUrl);
    return check && check.ok ? { source, station, action: 'update', url: candidate.streamUrl } : { source, station, action: 'failed' };
  });
  for (const { source, station, action, url } of outcomes) {
    if (action === 'update') {
      next[source.id] = { ...(next[source.id] || {}), [station.id]: url };
      result.updated += 1;
    } else if (action === 'revert') {
      if (next[source.id]) delete next[source.id][station.id];
      result.reverted += 1;
    } else if (action === 'failed') {
      result.failed += 1;
    }
  }
  for (const sourceId of Object.keys(next)) if (!Object.keys(next[sourceId]).length) delete next[sourceId];
  return { ...result, refreshed: next };
}

module.exports = { refreshStreamUrls, DEFAULT_LIMIT };
