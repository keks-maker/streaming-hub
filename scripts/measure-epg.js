#!/usr/bin/env node
// Messskript für das EPG-Datenmodell (Etappe 3.2; Messreport docs/aufnahme-etappe3-2-messreport.md)
//
// Nimmt eine LOKALE XMLTV-Datei (lädt nie aus dem Netz) und misst mit den echten Modulen:
//   1. Refresh: EpgService.refresh() gegen die Datei (Download-Seam → lokale Datei): Parse- und
//      Refresh-Zeit, Peak-RSS (gesampelt), Cachegröße (epg-cache.json), Ladezeit des Caches
//   2. Statistik (nur mit Zusatzfeldern ab 3.2): Feldabdeckung, Genre-Verteilung, Icon-Hosts
//
// Aufruf:
//   node scripts/measure-epg.js <epg.xml> [--lib-dir <lib>] [--now <ISO>] [--table <genre.json>]
//        [--write-categories <fixture.json>] [--json]
// --lib-dir wählt die Modulbasis (Default: lib/ dieses Repos); für „vorher“-Messungen zeigt sie auf
// einen Export des main-Standes (Cache v1; dann entfällt Schritt 2). Jeder Lauf misst genau EINE
// Variante — Peak-RSS ist nur dann aussagekräftig, wenn Vorher/Nachher in getrennten Prozessen laufen.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { TextDecoder } = require('node:util');

function parseArgs(argv) {
  const args = { file: null, libDir: path.join(__dirname, '..', 'lib'), now: Date.now(), table: null, writeCategories: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lib-dir') args.libDir = path.resolve(argv[++i]);
    else if (a === '--now') args.now = Date.parse(argv[++i]);
    else if (a === '--table') args.table = path.resolve(argv[++i]);
    else if (a === '--write-categories') args.writeCategories = path.resolve(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (!args.file) args.file = path.resolve(a);
  }
  if (!args.file || !Number.isFinite(args.now)) {
    console.error('Aufruf: node scripts/measure-epg.js <epg.xml> [--lib-dir <lib>] [--now <ISO>] [--table <genre.json>] [--write-categories <out.json>] [--json]');
    process.exit(2);
  }
  return args;
}

const pct = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);
const mb = bytes => Math.round((bytes / 1024 / 1024) * 10) / 10;

async function measureRefresh(args) {
  const { EpgService } = require(path.join(args.libDir, 'epg', 'EpgService.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-epg-'));
  const url = 'https://measure.invalid/epg.xml';
  const service = new EpgService({
    dir,
    getSources: () => [{ id: 'measure', epgUrl: url }],
    fetchImpl: async () => new Response(Readable.toWeb(fs.createReadStream(args.file)), { status: 200 }),
    validateUrl: u => u,
    maxBytes: 2 * 1024 * 1024 * 1024,
    now: () => args.now,
    autoRefresh: false,
    downloadTimeoutMs: 30 * 60 * 1000,
  });
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  const t0 = process.hrtime.bigint();
  const results = await service.refresh({ force: true });
  const refreshMs = Number(process.hrtime.bigint() - t0) / 1e6;
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (!results.length || !results[0].ok) throw new Error(`Refresh fehlgeschlagen: ${JSON.stringify(results)}`);
  const cacheFile = service.store.file;
  const cacheBytes = fs.statSync(cacheFile).size;
  // Ladezeit des fertigen Caches (neuer Store, wie beim App-Start)
  const { createEpgStore } = require(path.join(args.libDir, 'epg', 'EpgStore.js'));
  const fresh = createEpgStore({ dir });
  const l0 = process.hrtime.bigint();
  await fresh.load();
  const loadMs = Number(process.hrtime.bigint() - l0) / 1e6;
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    slots: results[0].slots,
    channels: results[0].channels,
    refreshMs: Math.round(refreshMs),
    cacheBytes,
    cacheMB: mb(cacheBytes),
    cacheLoadMs: Math.round(loadMs),
    baselineRssMB: mb(baselineRss),
    peakRssMB: mb(peakRss),
    peakRssGrowthMB: mb(peakRss - baselineRss),
  };
}

function collectStats(args) {
  const { XmltvStreamParser } = require(path.join(args.libDir, 'epg', 'xmltv-stream-parser.js'));
  let normalizeGenre;
  if (args.table) {
    const { createGenreNormalizer } = require(path.join(args.libDir, 'epg', 'genre.js'));
    normalizeGenre = createGenreNormalizer(JSON.parse(fs.readFileSync(args.table, 'utf-8')));
  } else {
    ({ normalizeGenre } = require(path.join(args.libDir, 'epg', 'genre.js')));
  }
  const stats = {
    total: 0,
    cat: 0,
    icon: 0,
    year: 0,
    episode: 0,
    credits: 0,
    director: 0,
    actor: 0,
    presenter: 0,
    subtitle: 0,
    rating: 0,
  };
  const genreCount = {};
  const categoryCount = new Map();
  const categorySets = new Map();
  const unmapped = new Map();
  const hosts = new Map();
  const iconUrls = new Set();
  let https = 0;
  let http = 0;
  let catOccurrences = 0;
  let catOccurrencesSonstiges = 0;
  const parser = new XmltvStreamParser({
    fromMs: args.now - 24 * 3600 * 1000,
    toMs: args.now + 10 * 24 * 3600 * 1000,
    onProgramme: p => {
      stats.total += 1;
      if (p.categories.length) stats.cat += 1;
      if (p.year) stats.year += 1;
      if (p.episode) stats.episode += 1;
      const c = p.credits;
      if (c.director.length || c.actor.length || c.presenter.length) stats.credits += 1;
      if (c.director.length) stats.director += 1;
      if (c.actor.length) stats.actor += 1;
      if (c.presenter.length) stats.presenter += 1;
      if (p.subtitle) stats.subtitle += 1;
      if (p.rating) stats.rating += 1;
      if (p.icon) {
        stats.icon += 1;
        iconUrls.add(p.icon);
        try {
          const u = new URL(p.icon);
          hosts.set(u.host, (hosts.get(u.host) || 0) + 1);
          if (u.protocol === 'https:') https += 1;
          else http += 1;
        } catch (_) {
          // vom Parser bereits validiert
        }
      }
      const genre = normalizeGenre(p.categories);
      genreCount[genre || '(keine)'] = (genreCount[genre || '(keine)'] || 0) + 1;
      if (p.categories.length) {
        const setKey = JSON.stringify(p.categories);
        categorySets.set(setKey, (categorySets.get(setKey) || 0) + 1);
      }
      for (const cat of p.categories) {
        categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
        catOccurrences += 1;
        if (normalizeGenre([cat]) === 'sonstiges') {
          catOccurrencesSonstiges += 1;
          unmapped.set(cat, (unmapped.get(cat) || 0) + 1);
        }
      }
    },
  });
  const fd = fs.openSync(args.file, 'r');
  const buf = Buffer.alloc(1 << 20);
  const decoder = new TextDecoder('utf-8');
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) break;
    parser.write(decoder.decode(buf.subarray(0, n), { stream: true }));
  }
  parser.write(decoder.decode());
  parser.end();
  fs.closeSync(fd);

  const sonstiges = genreCount.sonstiges || 0;
  const sorted = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (args.writeCategories) {
    const out = {
      _hinweis: 'Distinkte category-Werte der EPG-Quelle (Parser-Ausgabe, max. 3 je Sendung, je <= 40 Zeichen) mit Haeufigkeit (values) und distinkte Kategorie-Kombinationen je Sendung mit Haeufigkeit (sets); Grundlage des Genre-Tests (>= 90 % der Sendungen mit Kategorie). Erzeugt mit scripts/measure-epg.js --write-categories.',
      programmes: stats.total,
      withCategory: stats.cat,
      values: sorted(categoryCount),
      sets: sorted(categorySets).map(([key, count]) => [JSON.parse(key), count]),
    };
    fs.writeFileSync(args.writeCategories, `${JSON.stringify(out)}\n`);
  }
  return {
    programmes: stats.total,
    coverage: Object.fromEntries(
      Object.entries(stats)
        .filter(([k]) => k !== 'total')
        .map(([k, v]) => [k, { count: v, percent: pct(v, stats.total) }]),
    ),
    genre: {
      distribution: Object.fromEntries(sorted(new Map(Object.entries(genreCount))).map(([k, v]) => [k, { count: v, percent: pct(v, stats.total) }])),
      sonstigesPercentOfCategorised: pct(sonstiges, stats.cat),
      sonstigesCount: sonstiges,
      categorised: stats.cat,
      occurrences: catOccurrences,
      sonstigesOccurrencePercent: pct(catOccurrencesSonstiges, catOccurrences),
      distinctCategories: categoryCount.size,
      unmappedDistinct: unmapped.size,
      unmappedTop: sorted(unmapped).slice(0, 40),
      unmappedAll: sorted(unmapped),
    },
    icons: {
      programmesWithIcon: stats.icon,
      distinctUrls: iconUrls.size,
      httpsPercent: pct(https, stats.icon),
      httpPercent: pct(http, stats.icon),
      hosts: sorted(hosts).map(([host, count]) => ({ host, count, percent: pct(count, stats.icon) })),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = { file: args.file, fileMB: mb(fs.statSync(args.file).size), libDir: args.libDir, now: new Date(args.now).toISOString() };
  out.refresh = await measureRefresh(args);
  if (fs.existsSync(path.join(args.libDir, 'epg', 'genre.js'))) out.stats = collectStats(args);
  else out.stats = 'nicht verfuegbar (Modulstand ohne Zusatzfelder)';
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Quelle ${out.fileMB} MB, Fenster ab ${out.now}`);
    console.log('Refresh:', JSON.stringify(out.refresh));
    if (typeof out.stats === 'object') {
      console.log('Abdeckung:', JSON.stringify(out.stats.coverage));
      console.log('Genre:', JSON.stringify({ ...out.stats.genre, unmappedAll: undefined }));
      console.log('Icons:', JSON.stringify({ ...out.stats.icons, hosts: out.stats.icons.hosts.slice(0, 10) }));
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
