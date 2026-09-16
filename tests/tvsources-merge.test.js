// Unit-Tests für die tvsources-3-way-Merge-Logik des Updaters.
// Ausführen: npm run test:updater  (node --test, keine externen Dependencies)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mergeTvsources } = require('../lib/tvsources-merge');

// ── Fixtures ────────────────────────────────────────────────────────────────
// base = zuletzt auf dem Gerät committeter Stand (v0.4.82)
// old  = Geräte-Kopie mit User-Daten
// neu  = committeter Stand des neuen Tags (v0.4.83)

const BASE = [
  {
    id: 'deutsche-oeffentlich-rechtliche',
    name: 'Deutsche Öffentlich-Rechtliche',
    url: 'https://iptv-org.github.io/iptv/countries/de.m3u',
    sortOrder: ['ZDF.de@HD', 'DasErste.de@HD', 'MDRFernsehen.de@Thuringen'],
    favorites: ['ZDF.de@HD'],
    channelOverrides: {
      'ZDF.de@HD': { url: 'https://zdf-hls-15.akamaized.net/hls/live/2016498/de/high/master.m3u8' },
      '3sat.de@HD': { url: 'https://zdf-hls-18.akamaized.net/hls/live/2016501/dach/veryhigh/master.m3u8' },
    },
  },
];

const OLD_USER_FAVS = [
  {
    ...BASE[0],
    // User hat per App-UI einen Favoriten ergänzt und die Sortierung verändert:
    favorites: ['ZDF.de@HD', 'DasErste.de@HD'],
    sortOrder: ['DasErste.de@HD', 'ZDF.de@HD', 'MDRFernsehen.de@Thuringen'],
  },
];

const NEU = [
  {
    ...BASE[0],
    // Release ergänzt kaputte ARD-URLs (u. a. MDR Thüringen) und ändert die Defaults:
    sortOrder: ['ZDF.de@HD', 'DasErste.de@HD', 'MDRFernsehen.de@Thuringen', 'phoenix.de@HD'],
    favorites: ['ZDF.de@HD', 'phoenix.de@HD'],
    channelOverrides: {
      'ZDF.de@HD': { url: 'https://zdf-hls-15.akamaized.net/hls/live/2016498/de/high/master.m3u8' },
      '3sat.de@HD': { url: 'https://zdf-hls-18.akamaized.net/hls/live/2016501/dach/veryhigh/master.m3u8' },
      'MDRFernsehen.de@Thuringen': {
        url: 'https://mdrtvthhls.akamaized.net/hls/live/2016880/mdrtvth/master.m3u8',
        tvgId: 'MDRThuringen.de',
      },
      'WDRFernsehen.de@Koln': { url: 'https://wdrfs247.akamaized.net/hls/live/681509/wdr_msl4_fs247/index.m3u8' },
      // im Release entfernt (war in base vorhanden):
      // '3sat.de@HD' bleibt bewusst drin – siehe Test "Override-Entfernung".
    },
  },
];

// ── Kern-Szenario (der gemeldete Bug) ───────────────────────────────────────

test('Kern-Bugfix: neue channelOverrides kommen durch, User-Favoriten bleiben erhalten', () => {
  const r = mergeTvsources(BASE, OLD_USER_FAVS, NEU);
  assert.equal(r.ok, true, `Merge sollte ok sein: ${r.reason || ''}`);
  assert.equal(r.keepOld, false);
  const src = r.value[0];

  // Der Fix, der die Ursache des Bugs war: MDR Thüringen override muss ankommen.
  assert.equal(src.channelOverrides['MDRFernsehen.de@Thuringen'].url,
    'https://mdrtvthhls.akamaized.net/hls/live/2016880/mdrtvth/master.m3u8');
  assert.equal(src.channelOverrides['WDRFernsehen.de@Koln'].url,
    'https://wdrfs247.akamaized.net/hls/live/681509/wdr_msl4_fs247/index.m3u8');
  // Base-Overrides, die der User nicht angetastet hat, folgen dem neuen Tag.
  assert.deepEqual(src.channelOverrides['ZDF.de@HD'], NEU[0].channelOverrides['ZDF.de@HD']);

  // User-Daten unangetastet:
  assert.deepEqual(src.favorites, OLD_USER_FAVS[0].favorites);
  assert.deepEqual(src.sortOrder, OLD_USER_FAVS[0].sortOrder);
});

test('Ohne User-Änderungen gilt exakt der Stand des neuen Tags', () => {
  const r = mergeTvsources(BASE, BASE, NEU);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, NEU);
});

// ── channelOverrides: User-vs-Release ───────────────────────────────────────

test('Vom User geänderter Override gewinnt gegen den Release-Stand', () => {
  const old = [{
    ...BASE[0],
    channelOverrides: {
      ...BASE[0].channelOverrides,
      'ZDF.de@HD': { url: 'https://mein-eigener-zdf-proxy.example/master.m3u8' },
    },
  }];
  const r = mergeTvsources(BASE, old, NEU);
  const src = r.value[0];
  // User-URL bleibt, MDR-Fix kommt trotzdem durch:
  assert.equal(src.channelOverrides['ZDF.de@HD'].url, 'https://mein-eigener-zdf-proxy.example/master.m3u8');
  assert.equal(src.channelOverrides['MDRFernsehen.de@Thuringen'].url,
    'https://mdrtvthhls.akamaized.net/hls/live/2016880/mdrtvth/master.m3u8');
});

test('Override, den nur der User gesetzt hat (nicht in base), bleibt erhalten', () => {
  const old = [{
    ...BASE[0],
    channelOverrides: {
      ...BASE[0].channelOverrides,
      'MeinKanal.de@HD': { url: 'https://example.local/live.m3u8' },
    },
  }];
  const r = mergeTvsources(BASE, old, NEU);
  assert.deepEqual(r.value[0].channelOverrides['MeinKanal.de@HD'], { url: 'https://example.local/live.m3u8' });
});

test('Override, das im Release entfernt wurde und nicht vom User stammt, fällt weg', () => {
  const neu = [{
    ...NEU[0],
    channelOverrides: {
      'ZDF.de@HD': NEU[0].channelOverrides['ZDF.de@HD'],
      'MDRFernsehen.de@Thuringen': NEU[0].channelOverrides['MDRFernsehen.de@Thuringen'],
    },
  }];
  const r = mergeTvsources(BASE, BASE, neu);
  assert.equal(r.value[0].channelOverrides['3sat.de@HD'], undefined);
});

test('Override, das im Release entfernt wurde, aber vom User geändert war, bleibt erhalten', () => {
  const old = [{
    ...BASE[0],
    channelOverrides: {
      'ZDF.de@HD': { url: 'https://user-zdf.example/master.m3u8' },
      '3sat.de@HD': { url: 'https://user-3sat.example/master.m3u8' },
    },
  }];
  const neu = [{
    ...NEU[0],
    channelOverrides: { 'ZDF.de@HD': NEU[0].channelOverrides['ZDF.de@HD'] },
  }];
  const r = mergeTvsources(BASE, old, neu);
  assert.deepEqual(r.value[0].channelOverrides['3sat.de@HD'], { url: 'https://user-3sat.example/master.m3u8' });
});

test('Nur umsortierte Override-Keys gelten NICHT als User-Änderung (Release gewinnt)', () => {
  // tvgId/url in umgekehrter Reihenfolge – inhaltlich identisch zu base:
  const old = [{
    ...BASE[0],
    channelOverrides: {
      '3sat.de@HD': { url: 'https://zdf-hls-18.akamaized.net/hls/live/2016501/dach/veryhigh/master.m3u8' },
      'ZDF.de@HD': { url: 'https://zdf-hls-15.akamaized.net/hls/live/2016498/de/high/master.m3u8' },
    },
  }];
  const neu = [{
    ...NEU[0],
    channelOverrides: {
      'ZDF.de@HD': { url: 'https://NEUES-ZDF.example/master.m3u8' },
    },
  }];
  const r = mergeTvsources(BASE, old, neu);
  // identisch zu base => Release-Eintrag muss übernehmen:
  assert.equal(r.value[0].channelOverrides['ZDF.de@HD'].url, 'https://NEUES-ZDF.example/master.m3u8');
  // 3sat: identisch zu base und im Release entfernt => weg.
  assert.equal(r.value[0].channelOverrides['3sat.de@HD'], undefined);
});

test('Unerwartetes channelOverrides-Format: Quelle unverändert aus Geräte-Stand + Warnung', () => {
  const warnings = [];
  const old = [{ ...BASE[0], channelOverrides: 'kaputt' }];
  const r = mergeTvsources(BASE, old, NEU, { warn: w => warnings.push(w) });
  assert.deepEqual(r.value[0], old[0]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unerwartetes Format/);
});

// ── favorites / sortOrder ───────────────────────────────────────────────────

test('Unveränderte User-Favoriten werden durch die Defaults des Tags ersetzt', () => {
  const r = mergeTvsources(BASE, BASE, NEU);
  assert.deepEqual(r.value[0].favorites, NEU[0].favorites);
  assert.deepEqual(r.value[0].sortOrder, NEU[0].sortOrder);
});

test('Favoriten bleiben erhalten, auch wenn nur sortOrder geändert wurde (pro Feld entschieden)', () => {
  const old = [{ ...BASE[0], sortOrder: ['ZDF.de@HD'] }]; // nur sortOrder geändert
  const r = mergeTvsources(BASE, old, NEU);
  assert.deepEqual(r.value[0].sortOrder, ['ZDF.de@HD']);
  // favorites: old == base => Tag-Stand gilt
  assert.deepEqual(r.value[0].favorites, NEU[0].favorites);
});

// ── Quellen-Ebene ───────────────────────────────────────────────────────────

test('Neue Quelle im Tag wird angehängt', () => {
  const neueQuelle = { id: 'neue-plattform', name: 'Neu', url: 'https://example/m3u' };
  const neu = [...NEU, neueQuelle];
  const r = mergeTvsources(BASE, OLD_USER_FAVS, neu);
  assert.equal(r.value.length, 2);
  assert.deepEqual(r.value[1], neueQuelle);
});

test('Vom User ergänzte Quelle (nicht im Tag) bleibt erhalten', () => {
  const userSource = { id: 'meine-playlist', name: 'Meine Playlist', url: 'https://example.local/list.m3u' };
  const old = [...OLD_USER_FAVS, userSource];
  const r = mergeTvsources(BASE, old, NEU);
  assert.equal(r.value.length, 2);
  assert.deepEqual(r.value[1], userSource);
});

test('Quelle ohne id wird unverändert übernommen', () => {
  const odd = { name: 'keine id' };
  const r = mergeTvsources([], [odd], []);
  assert.deepEqual(r.value, [odd]);
});

// ── Randfälle: NIE Datenverlust ─────────────────────────────────────────────

test('Keine Geräte-Kopie (frische Installation): committeter Stand des Tags gilt', () => {
  const r = mergeTvsources(BASE, null, NEU);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, NEU);
});

test('Kein base (Git-Info fehlt): Merge läuft als 2-way (User-Daten behalten, Release-Neuheiten kommen durch)', () => {
  const r = mergeTvsources(null, OLD_USER_FAVS, NEU);
  assert.equal(r.ok, true);
  const src = r.value[0];
  // ohne base gilt jeder Override aus der Geräte-Kopie als User-authored -> erhalten
  assert.deepEqual(src.channelOverrides['ZDF.de@HD'], OLD_USER_FAVS[0].channelOverrides['ZDF.de@HD']);
  // Release-only-Overrides (kannten kein base) kommen trotzdem durch:
  assert.equal(src.channelOverrides['MDRFernsehen.de@Thuringen'].url,
    'https://mdrtvthhls.akamaized.net/hls/live/2016880/mdrtvth/master.m3u8');
  assert.deepEqual(src.favorites, OLD_USER_FAVS[0].favorites);
  assert.deepEqual(src.sortOrder, OLD_USER_FAVS[0].sortOrder);
});

test('Struktur-Konflikt: alte Datei kein Array -> keepOld, keine Datenänderung', () => {
  const r = mergeTvsources(BASE, { kaputt: true }, NEU);
  assert.equal(r.ok, false);
  assert.equal(r.keepOld, true);
  assert.equal(r.value, undefined);
  assert.match(r.reason, /Array-Format/);
});

test('Struktur-Konflikt: neue Version ohne tvsources -> keepOld', () => {
  const r = mergeTvsources(BASE, OLD_USER_FAVS, null);
  assert.equal(r.ok, false);
  assert.equal(r.keepOld, true);
});

test('Merge ohne Warn-Option (Default no-op) wirft nicht', () => {
  const old = [{ ...BASE[0], channelOverrides: 42 }];
  assert.doesNotThrow(() => mergeTvsources(BASE, old, NEU));
});
