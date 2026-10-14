#!/usr/bin/env node
'use strict';

// Ergänzt in radiosources.json die Sender-Logos (nur das Feld `logo`; IDs, Stream-URLs, Reihenfolge bleiben).
// Es werden nur Links gesetzt, keine Bilddateien ins Repo kopiert. Reihenfolge je Sender ohne (brauchbares) Logo:
//   (a) Favicon aus dem radio-browser-Verzeichnis (https; http wird auf https hochgestuft und geprüft),
//   (b) Icon der Sender-Homepage (apple-touch-icon / link rel=icon / Standardpfade), nur https,
//   (c) Google-Favicon-Dienst für den Homepage-Host (https://www.google.com/s2/favicons?domain=<host>&sz=128),
//       nur wenn ein echtes Bild kommt (der Standard-Globus wird per Hash eines Abrufs für eine nicht existierende Domain erkannt).
// Jeder gesetzte Link wird auf eine echte Bild-Antwort geprüft (Content-Type image/*, Dateikopf, Größenlimit).
// Bestehende Logos werden erneut geprüft; kaputte werden ersetzt oder entfernt (Platzhalter im Client).
// Netzwerk ist injizierbar (net.get); Tests laufen offline mit Fixtures. Die Suche selbst liegt in lib/radio/radio-logo-finder.js.
//
// Aufruf: node scripts/enrich-radio-logos.js [--file radiosources.json] [--concurrency 6] [--timeout 8000]
//                                            [--report report.json] [--dry-run]

const fs = require('node:fs');
const path = require('node:path');
const { USER_AGENT } = require('../lib/radio/radio-http.js');
const { resolveApiServers, createApiClient, fetchByUuids } = require('../lib/radio/radio-browser.js');
const finder = require('../lib/radio/radio-logo-finder.js');
const { imageInfo, minEdge, toHttps, checkImage, iconCandidates, homepageIcon, googleFaviconUrl, googlePlaceholderHash, findLogo, createNet } = finder;

const SOURCE_ID = 'deutsche-radiosender';

// ---------- Anreicherung ----------

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

/**
 * stations: Senderliste (wird nicht verändert); rawByUuid: Map stationuuid -> Verzeichniseintrag (favicon, homepage).
 * Liefert { stations, report } mit report = { total, before, after, bySource, brokenExisting, noLogo }.
 */
async function enrichLogos({ stations, rawByUuid = new Map(), net, concurrency = 6, log = () => {} }) {
  const placeholder = await googlePlaceholderHash(net);
  if (!placeholder) log('Google-Standard-Platzhalter nicht ermittelbar: Google-Fallback deaktiviert');
  const bySource = { bestehend: 0, verzeichnis: 0, 'https-upgrade': 0, homepage: 0, google: 0 };
  const report = { total: stations.length, before: stations.filter(s => s.logo).length, bySource, brokenExisting: [], noLogo: [] };

  const results = await mapLimited(stations, concurrency, async station => {
    const raw = rawByUuid.get(station.rbUuid) || {};
    const homepage = station.homepage || raw.homepage || null;
    if (station.logo) {
      let keep = await checkImage(station.logo, net);
      if (!keep.ok) keep = await checkImage(station.logo, net); // ein Wiederholversuch gegen kurzzeitige Ausfälle
      if (keep.ok) return { station, logo: station.logo, source: 'bestehend' };
      report.brokenExisting.push(station.id);
    }
    // (a) Verzeichnis-Favicon
    const favicon = String(raw.favicon || '').trim();
    if (favicon) {
      const https = toHttps(favicon);
      if (https) {
        const result = await checkImage(https, net);
        if (result.ok) return { station, logo: result.url, source: /^https:/i.test(favicon) ? 'verzeichnis' : 'https-upgrade' };
      }
    }
    // (b) Homepage-Icon, (c) Google-Favicon-Dienst (nur mit erkanntem Platzhalter), sonst schwaches Homepage-Icon
    if (homepage) {
      const found = await findLogo({ homepage, net, placeholder });
      if (found.logo) return { station, logo: found.logo, source: found.source };
    }
    return { station, logo: null, source: null };
  });

  const out = results.map(({ station, logo, source }) => {
    const next = { ...station };
    if (logo) next.logo = logo;
    else delete next.logo;
    if (source) bySource[source] = (bySource[source] || 0) + 1;
    else report.noLogo.push(station.id);
    return next;
  });
  report.after = out.filter(s => s.logo).length;
  return { stations: out, report };
}

function parseArgs(argv) {
  const options = { file: path.join(__dirname, '..', 'radiosources.json'), concurrency: 6, timeout: 8000, report: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--file') options.file = path.resolve(argv[++i]);
    else if (arg === '--report') options.report = path.resolve(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--timeout') options.timeout = Number(argv[++i]);
    else throw new Error(`Unbekannte Option: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sources = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  const source = sources.find(entry => entry && entry.id === SOURCE_ID);
  if (!source) throw new Error(`Quelle ${SOURCE_ID} nicht gefunden`);
  const servers = await resolveApiServers();
  const api = createApiClient({ servers });
  console.log(`radio-browser-Server: ${servers.join(', ')} (User-Agent: ${USER_AGENT})`);
  const raw = await fetchByUuids(api, source.stations.map(s => s.rbUuid).filter(Boolean));
  const rawByUuid = new Map(raw.map(entry => [entry.stationuuid, entry]));
  const { stations, report } = await enrichLogos({
    stations: source.stations,
    rawByUuid,
    net: createNet({ timeoutMs: options.timeout }),
    concurrency: options.concurrency,
    log: message => console.log(message),
  });
  console.log(JSON.stringify({ ...report, noLogo: report.noLogo.length }, null, 2));
  if (options.report) fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  if (options.dryRun) return;
  const next = sources.map(entry => (entry === source ? { ...source, stations } : entry));
  fs.writeFileSync(options.file, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Geschrieben: ${options.file}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { imageInfo, minEdge, toHttps, checkImage, iconCandidates, homepageIcon, googleFaviconUrl, googlePlaceholderHash, enrichLogos, createNet, parseArgs, main };
