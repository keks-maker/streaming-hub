'use strict';

process.env.TZ = 'Europe/Berlin';

// Integration (Etappe 3.2, AUF-Plan T3/P18): Schedule-Plausibilisierung und Slip arbeiten mit einem
// v1-Cache (alter Cache, Zusatzfelder leer) UND mit einem v2-Cache (Zusatzfelder gefüllt) unverändert.
// Echter EpgService + Scheduler mit injizierter Uhr; XMLTV zur Laufzeit, kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EpgService } = require('../lib/epg/EpgService.js');
const { channelKey, CACHE_FILE } = require('../lib/epg/EpgStore.js');
const { SLIP_WARN_PREFIX } = require('../lib/recorder/Scheduler.js');
const logic = require('../lib/recorder/schedule-logic.js');
const { makeClock, makeScheduler, input, MIN } = require('./helpers/schedule-fakes.js');

const URL = 'https://epg.example/q1.xml';
const T = iso => Date.parse(iso);

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

const PROGRAMMES = [
  { title: 'Tagesschau', start: '2026-10-05T20:00:00+02:00', stop: '2026-10-05T20:15:00+02:00' },
  { title: 'Filler', start: '2026-10-05T23:00:00+02:00', stop: '2026-10-05T23:30:00+02:00' },
];

function xmltv(programmes) {
  const body = programmes
    .map(
      p =>
        `<programme start="${xmltvTime(T(p.start))}" stop="${xmltvTime(T(p.stop))}" channel="DasErste.de"><title>${p.title}</title>` +
        `<category>Nachrichten</category><icon src="https://img.example.org/${p.title}.jpg"/><date>2026</date>` +
        `<credits><actor>Jan Hofer</actor></credits></programme>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="DasErste.de"><display-name>X</display-name></channel>${body}</tv>`;
}

/** Cache im Format v1 (4-Element-Zeilen) direkt auf die Platte schreiben. */
function writeV1Cache(dir, fetchedAt) {
  const rows = PROGRAMMES.map(p => [T(p.start), T(p.stop), p.title, '']);
  fs.writeFileSync(
    path.join(dir, CACHE_FILE),
    JSON.stringify({ version: 1, sources: { [URL]: { fetchedAt, sourceIds: ['q1'], channels: { [channelKey('DasErste.de')]: rows } } } }),
  );
}

async function setup(version) {
  const clock = makeClock('2026-10-05T19:00:00+02:00');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cache-ver-'));
  const xml = { value: xmltv(PROGRAMMES) };
  const fetched = [];
  const make = () =>
    new EpgService({
      dir,
      getSources: () => [{ id: 'q1', name: 'Quelle', epgUrl: URL }],
      fetchImpl: async url => {
        fetched.push(url);
        return new Response(Buffer.from(xml.value), { status: 200 });
      },
      validateUrl: u => u,
      now: () => clock.t,
      autoRefresh: false,
    });
  if (version === 'v2') await make().refresh({ force: true });
  else writeV1Cache(dir, clock.t);
  fetched.length = 0;
  // „App-Start“: Cache laden (autoRefresh aus → kein automatischer Upgrade-Refresh, Stand bleibt wie geschrieben)
  const epg = make();
  await epg.start();
  const refreshCalls = [];
  const ctx = makeScheduler({
    clock,
    epgLookup: ({ key, atMs }) => epg.find(key, atMs),
    refreshEpg: async ({ entry }) => {
      refreshCalls.push(entry.id);
      return epg.refreshForSource(entry.sourceId);
    },
    epgRange: ({ key, fromMs, toMs }) => epg.range(key, fromMs, toMs),
    slipRetryMs: 3 * MIN,
  });
  return { ...ctx, epg, xml, fetched, refreshCalls };
}

const kinds = events => events.filter(e => e[0] === 'notify').map(e => e[1].kind);

for (const version of ['v1', 'v2']) {
  test(`${version}-Cache: Ausgangslage — Format, Felder`, async () => {
    const ctx = await setup(version);
    assert.equal(ctx.epg.store.isLegacy(URL), version === 'v1');
    const slot = ctx.epg.find('DasErste.de', T('2026-10-05T20:05:00+02:00'));
    assert.equal(slot.title, 'Tagesschau');
    assert.deepEqual(slot.categories, version === 'v2' ? ['Nachrichten'] : []);
    assert.equal(slot.icon, version === 'v2' ? 'https://img.example.org/Tagesschau.jpg' : '');
    assert.equal(ctx.fetched.length, 0, 'Laden des Caches braucht kein Netz');
  });

  test(`${version}-Cache: Plausibilisierung (passend, abweichend, unbekannter Kanal)`, async () => {
    const ctx = await setup(version);
    assert.equal(ctx.scheduler.addEntry(input()).ok, true);
    assert.throws(
      () => ctx.scheduler.addEntry(input({ title: 'Anderer', epgStart: '2026-10-05T20:10:00+02:00', epgStop: '2026-10-05T20:25:00+02:00' })),
      { code: 'EPG_MISMATCH' },
    );
    assert.throws(() => ctx.scheduler.addEntry(input({ tvgId: 'Unbekannt.de', channelId: 'unbekannt' })), { code: 'NO_EPG' });
  });

  test(`${version}-Cache: Slip nach hinten wird erkannt, Refresh läuft einmal und stellt den Cache auf v2`, async () => {
    const ctx = await setup(version);
    const added = ctx.scheduler.addEntry(input());
    assert.equal(added.ok, true);
    ctx.xml.value = xmltv([{ ...PROGRAMMES[0], start: '2026-10-05T20:10:00+02:00', stop: '2026-10-05T20:25:00+02:00' }, PROGRAMMES[1]]);
    ctx.clock.set('2026-10-05T19:48:30+02:00');
    await ctx.scheduler.checkSlips();
    const updated = ctx.store.get(added.entry.id);
    assert.equal(logic.parseIsoWithOffset(updated.epgStart), T('2026-10-05T20:10:00+02:00'));
    assert.equal(logic.parseIsoWithOffset(updated.epgStop), T('2026-10-05T20:25:00+02:00'));
    assert.deepEqual(kinds(ctx.events), ['slip']);
    assert.equal(ctx.refreshCalls.length, 1);
    assert.equal(ctx.fetched.length, 1, 'genau ein Download der Quelle');
    assert.equal(ctx.epg.store.isLegacy(URL), false, 'nach dem Refresh liegt v2 vor');
    assert.equal(JSON.parse(fs.readFileSync(ctx.epg.store.file, 'utf-8')).version, 2);
  });

  test(`${version}-Cache: Slip — Sendung entfernt → Warnung statt Löschen; unverändert → keine Meldung`, async () => {
    const removed = await setup(version);
    const entry = removed.scheduler.addEntry(input()).entry;
    removed.xml.value = xmltv([PROGRAMMES[1]]);
    removed.clock.set('2026-10-05T19:49:00+02:00');
    await removed.scheduler.checkSlips();
    const kept = removed.store.get(entry.id);
    assert.equal(kept.state, 'scheduled');
    assert.ok(kept.note.startsWith(SLIP_WARN_PREFIX));
    assert.deepEqual(kinds(removed.events), ['slip-removed']);

    const same = await setup(version);
    same.scheduler.addEntry(input());
    same.clock.set('2026-10-05T19:49:00+02:00');
    await same.scheduler.checkSlips();
    assert.deepEqual(kinds(same.events), []);
  });
}
