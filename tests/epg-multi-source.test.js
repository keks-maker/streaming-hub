'use strict';

// Tests: mehrere EPG-Quellen je Kanal (veraltete Quelle verdrängt die frische nicht),
// epgUrls-Zusatzquellen im EpgService, Migration der Standard-TV-Quelle (DE1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEpgStore } = require('../lib/epg/EpgStore.js');
const { EpgService } = require('../lib/epg/EpgService.js');
const {
  DEFAULT_TV_SOURCE_ID,
  DEFAULT_PRIMARY_EPG_URL,
  DEFAULT_EXTRA_EPG_URL,
  migrateDefaultEpgUrls,
} = require('../lib/tvsources-default-epg.js');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'epg-ms-'));
}

function slot(startH, stopH, title) {
  return { start: NOW + startH * HOUR, stop: NOW + stopH * HOUR, title, desc: '' };
}

test('Merge: frische Quelle ist maßgeblich, veraltete füllt nur Lücken', () => {
  const store = createEpgStore({ dir: tmpDir() });
  store.setSource('https://stale', {
    fetchedAt: NOW + 5 * HOUR,
    channelSlots: new Map([['DasErste.de@HD', [slot(-6, -3, 'Alt früh'), slot(-3, 0.5, 'Alt Überlappung'), slot(0.5, 1, 'Alt Ende')]]]),
  });
  store.setSource('https://fresh', {
    fetchedAt: NOW,
    channelSlots: new Map([['Das.Erste.de', [slot(-2, 0, 'Neu A'), slot(0, 2, 'Neu B'), slot(2, 30, 'Neu C')]]]),
  });
  // veraltet endet bei +1h, überlappt die frische Quelle abweichend
  const all = store.rangeMany(['DasErste.de@HD'], NOW - 8 * HOUR, NOW + 40 * HOUR)[0].slots;
  assert.deepEqual(all.map(s => s.title), ['Alt früh', 'Neu A', 'Neu B', 'Neu C']);
  // Jetzt/Nächste kommen aus der frischen Quelle, nicht aus der veralteten
  const nn = store.nowNext(['Das.Erste.de'], NOW)[0];
  assert.equal(nn.current.title, 'Neu B');
  assert.equal(nn.next.title, 'Neu C');
  // volle Projektion nutzt dieselbe Zusammenführung
  assert.deepEqual(store.range('DasErste.de', NOW, NOW + HOUR).map(s => s.title), ['Neu B']);
});

test('Merge: nur eine Quelle liefert unveränderte Slots; identische Slots werden dedupliziert', () => {
  const store = createEpgStore({ dir: tmpDir() });
  for (const url of ['https://a', 'https://b']) {
    store.setSource(url, { fetchedAt: NOW, channelSlots: new Map([['zdf.de', [slot(0, 1, 'Heute')]]]) });
  }
  assert.equal(store.range('ZDF.de', NOW - HOUR, NOW + 2 * HOUR).length, 1);
  const single = createEpgStore({ dir: tmpDir() });
  single.setSource('https://a', { fetchedAt: NOW, channelSlots: new Map([['zdf.de', [slot(0, 1, 'Heute')]]]) });
  assert.equal(single.range('zdf.de', NOW - HOUR, NOW + 2 * HOUR)[0].title, 'Heute');
});

test('Kanäle verschiedener Schreibweise fallen im Store zusammen (Das.Erste.de = DasErste.de@HD)', () => {
  const store = createEpgStore({ dir: tmpDir() });
  store.setSource('https://a', { fetchedAt: NOW, channelSlots: new Map([['Das.Erste.de', [slot(0, 1, 'Tagesschau')]]]) });
  assert.equal(store.find('DasErste.de@HD', NOW + HOUR / 2).title, 'Tagesschau');
});

test('EpgService: epgUrls-Zusatzquellen werden mit epgUrl geladen, Duplikate zusammengefasst', () => {
  const service = new EpgService({
    dir: tmpDir(),
    getSources: () => [
      { id: 'a', epgUrl: 'https://epg.example/a.xml', epgUrls: ['https://epg.example/b.xml.gz', 'https://epg.example/a.xml', '', 5] },
      { id: 'b', epgUrl: 'https://epg.example/b.xml.gz' },
      { id: 'c', epgUrls: ['ftp://bad'] },
    ],
    autoRefresh: false,
  });
  const { byUrl, invalid } = service._configuredUrls();
  assert.deepEqual([...byUrl.keys()], ['https://epg.example/a.xml', 'https://epg.example/b.xml.gz']);
  assert.deepEqual(byUrl.get('https://epg.example/a.xml'), ['a']);
  assert.deepEqual(byUrl.get('https://epg.example/b.xml.gz'), ['a', 'b']);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].sourceId, 'c');
});

test('Migration: Standard-Quelle bekommt DE1 nachgetragen, Nutzereinstellungen bleiben unberührt', () => {
  const base = { id: DEFAULT_TV_SOURCE_ID, url: 'u', favorites: ['x'], epgUrl: DEFAULT_PRIMARY_EPG_URL };
  const migrated = migrateDefaultEpgUrls([base, { id: 'free-tv', epgUrl: 'https://epgshare01.online/epgshare01/epg_ripper_AL1.xml.gz' }]);
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.sources[0].epgUrls, [DEFAULT_EXTRA_EPG_URL]);
  assert.deepEqual(migrated.sources[0].favorites, ['x']);
  assert.equal(migrated.sources[1].epgUrls, undefined);
  assert.equal(base.epgUrls, undefined, 'Eingabe wird nicht mutiert');
  // zweiter Lauf: nichts mehr zu tun
  assert.equal(migrateDefaultEpgUrls(migrated.sources).changed, false);
  // Nutzer hat epgUrl geändert / epgUrls bewusst geleert / Quelle fehlt → unverändert
  for (const src of [
    { ...base, epgUrl: 'https://mein.epg/x.xml' },
    { ...base, epgUrl: null },
    { ...base, epgUrls: [] },
    { ...base, epgUrls: ['https://eigene.epg/y.xml'] },
  ]) {
    const r = migrateDefaultEpgUrls([src]);
    assert.equal(r.changed, false);
    assert.equal(r.sources[0], src);
  }
  assert.equal(migrateDefaultEpgUrls([]).changed, false);
  assert.equal(migrateDefaultEpgUrls(null).changed, false);
});
