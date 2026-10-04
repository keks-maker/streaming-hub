'use strict';

// Tests: XMLTV-Streaming-Parser (Etappe 1; Konzept §3.2, §5):
// Zeitzonen/Sommerzeit, Entities/CDATA, Chunk-Grenzen, Fenster, defekte Einträge.
// Lokale Test-XMLTV-Datei, kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  XmltvStreamParser,
  parseXmltvTime,
  decodeXmlEntities,
  LIMITS,
} = require('../lib/epg/xmltv-stream-parser.js');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'epg-sample.xml'), 'utf-8');

function parseAll(text, { chunkSize = 0, fromMs, toMs } = {}) {
  const out = [];
  const parser = new XmltvStreamParser({ onProgramme: p => out.push(p), fromMs, toMs });
  if (!chunkSize) parser.write(text);
  else for (let i = 0; i < text.length; i += chunkSize) parser.write(text.slice(i, i + chunkSize));
  parser.end();
  return { items: out, stats: parser.stats };
}

const byTitle = (items, title) => items.find(p => p.title === title);

test('parseXmltvTime: Offsets, Z, ohne Offset (UTC), Kurzformen, Fehler', () => {
  assert.equal(parseXmltvTime('20261005201500 +0200'), Date.UTC(2026, 9, 5, 18, 15, 0));
  assert.equal(parseXmltvTime('20261005201500 -0530'), Date.UTC(2026, 9, 6, 1, 45, 0));
  assert.equal(parseXmltvTime('20261005201500+0200'), Date.UTC(2026, 9, 5, 18, 15, 0));
  assert.equal(parseXmltvTime('20261005201500'), Date.UTC(2026, 9, 5, 20, 15, 0), 'ohne Offset = UTC');
  assert.equal(parseXmltvTime('20261005201500 Z'), Date.UTC(2026, 9, 5, 20, 15, 0));
  assert.equal(parseXmltvTime('202610052015'), Date.UTC(2026, 9, 5, 20, 15, 0));
  assert.equal(parseXmltvTime('20261005'), Date.UTC(2026, 9, 5, 0, 0, 0));
  for (const bad of ['', 'kaputt', '2026-10-05', null, undefined, 12345, '20261005201500 +2']) {
    assert.ok(Number.isNaN(parseXmltvTime(bad)), `ungültig: ${bad}`);
  }
});

test('Sommerzeit-Ende (Europe/Berlin 25.10.2026): Sendung über die doppelte Stunde dauert 2 h', () => {
  const { items } = parseAll(FIXTURE);
  const p = byTitle(items, 'Nachtprogramm Zeitumstellung');
  assert.equal(p.start, Date.UTC(2026, 9, 24, 23, 30, 0)); // 01:30 CEST
  assert.equal(p.stop, Date.UTC(2026, 9, 25, 1, 30, 0)); // 02:30 CET
  assert.equal((p.stop - p.start) / 3600000, 2);
});

test('Sommerzeit-Beginn (29.03.2026): Sendung über die ausfallende Stunde dauert 1 h', () => {
  const { items } = parseAll(FIXTURE);
  const p = byTitle(items, 'Nachtprogramm Frühling');
  assert.equal(p.start, Date.UTC(2026, 2, 29, 0, 30, 0)); // 01:30 CET
  assert.equal(p.stop, Date.UTC(2026, 2, 29, 1, 30, 0)); // 03:30 CEST
  assert.equal((p.stop - p.start) / 3600000, 1);
});

test('Ergebnis ist unabhängig von der Systemzeitzone des Prozesses', () => {
  const script = `
    const { parseXmltvTime } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'epg', 'xmltv-stream-parser.js'))});
    process.stdout.write(JSON.stringify([
      parseXmltvTime('20261025013000 +0200'), parseXmltvTime('20261025023000 +0100'),
      parseXmltvTime('20260329013000 +0100'), parseXmltvTime('20260329033000 +0200'),
    ]));`;
  const results = ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Pacific/Auckland'].map(tz => {
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(new Set(results).size, 1, `abweichende Ergebnisse je TZ: ${results.join(' | ')}`);
});

test('Entities und CDATA: Einzeldurchlauf, kein Doppel-Decode, Tags in CDATA bleiben Text', () => {
  const { items } = parseAll(FIXTURE);
  const tagesschau = byTitle(items, 'Tagesschau & Wetter');
  assert.ok(tagesschau);
  // &amp;lt; bleibt als "&lt;" (kein Doppel-Decode); numerische Entities werden dekodiert
  assert.equal(tagesschau.desc, 'Nachrichten live mit "Zitat" &lt; bleibt Text äö'.replace('Nachrichten live', 'Nachrichten <live>'));
  const film = byTitle(items, 'Film: Anna & <Bob>');
  assert.ok(film, 'CDATA-Titel mit & und <…> bleibt als Text erhalten');
  assert.equal(film.desc, 'Beschreibung mit <b>Tags</b> & Zeichen');
  assert.equal(decodeXmlEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeXmlEntities('&unknown; &#0; &#x110000;'), '&unknown;  ', 'unbekannt bleibt, ungültige Codepoints entfallen');
});

test('Einfache Anführungszeichen, fehlender Offset (UTC), Kurzformat', () => {
  const { items } = parseAll(FIXTURE);
  assert.equal(byTitle(items, 'Einfache Anführungszeichen').channel, 'ZDF.de');
  assert.equal(byTitle(items, 'Einfache Anführungszeichen').desc, 'Mit > im Text');
  assert.equal(byTitle(items, 'Ohne Offset gilt UTC').start, Date.UTC(2026, 9, 5, 21, 0, 0));
  const kurz = byTitle(items, 'Kurzformat ohne Sekunden');
  assert.equal(kurz.start, Date.UTC(2026, 9, 5, 22, 0, 0));
  assert.equal(kurz.stop, Date.UTC(2026, 9, 5, 23, 0, 0));
});

test('Defekte Einträge werden verworfen, gültige bleiben', () => {
  const { items, stats } = parseAll(FIXTURE);
  const titles = items.map(p => p.title);
  for (const bad of ['Stop vor Start', 'Ungültige Zeit', 'Ohne Kanal']) assert.ok(!titles.includes(bad), bad);
  assert.equal(items.length, 7);
  assert.equal(stats.emitted, 7);
  assert.equal(stats.skippedInvalid, 5, 'Stop<Start, ungültige Zeit, ohne Titel, ohne Kanal, selbstschließend');
});

test('Chunk-Grenzen: byteweises Füttern liefert dasselbe wie ein Block', () => {
  const whole = parseAll(FIXTURE).items;
  for (const size of [1, 2, 7, 33, 100, 4096]) {
    assert.deepEqual(parseAll(FIXTURE, { chunkSize: size }).items, whole, `chunkSize ${size}`);
  }
});

test('Zeitfenster: Sendungen außerhalb werden nicht geliefert', () => {
  const from = Date.UTC(2026, 9, 5, 0, 0, 0);
  const to = Date.UTC(2026, 9, 6, 0, 0, 0);
  const { items, stats } = parseAll(FIXTURE, { fromMs: from, toMs: to });
  assert.ok(items.every(p => p.stop > from && p.start < to));
  assert.ok(!items.some(p => p.title.startsWith('Nachtprogramm')));
  assert.equal(stats.skippedOutOfWindow, 2);
  // Randfälle: stop == from und start == to liegen außerhalb
  const edge = parseAll(
    '<tv><programme start="20261005180000 +0000" stop="20261005190000 +0000" channel="a"><title>A</title></programme></tv>',
    { fromMs: Date.UTC(2026, 9, 5, 19, 0, 0), toMs: Date.UTC(2026, 9, 5, 20, 0, 0) },
  );
  assert.equal(edge.items.length, 0);
});

test('Streaming: großes Dokument wird in Chunks verarbeitet, ohne das Gesamtdokument zu puffern', () => {
  const parts = ['<?xml version="1.0"?><tv>'];
  for (let i = 0; i < 20000; i += 1) {
    const h = String(i % 24).padStart(2, '0');
    parts.push(
      `<programme start="202610${String(1 + (i % 28)).padStart(2, '0')}${h}0000 +0200" ` +
        `stop="202610${String(1 + (i % 28)).padStart(2, '0')}${h}3000 +0200" channel="c${i % 50}">` +
        `<title>Sendung ${i}</title><desc>${'x'.repeat(100)}</desc></programme>\n`,
    );
  }
  parts.push('</tv>');
  const text = parts.join('');
  let maxBuffer = 0;
  const out = [];
  const parser = new XmltvStreamParser({ onProgramme: p => out.push(p) });
  for (let i = 0; i < text.length; i += 65536) {
    parser.write(text.slice(i, i + 65536));
    maxBuffer = Math.max(maxBuffer, parser.buf.length);
  }
  parser.end();
  assert.equal(out.length, 20000);
  assert.ok(maxBuffer < 200000, `Puffer bleibt klein (max ${maxBuffer} Zeichen bei ${text.length} Gesamtzeichen)`);
});

test('Defektes/bösartiges Dokument: überlanges offenes Element wird verworfen, kein Absturz', () => {
  const parser = new XmltvStreamParser({ onProgramme: () => assert.fail('darf nichts liefern') });
  parser.write('<tv><programme start="20261005201500 +0200" stop="20261005204500 +0200" channel="x"><title>');
  for (let i = 0; i < 20; i += 1) parser.write('A'.repeat(64 * 1024));
  parser.end();
  assert.ok(parser.stats.discardedOversized >= 1);
  assert.ok(parser.buf.length === 0);
});

test('Titel/Beschreibung werden längenbegrenzt', () => {
  const { items } = parseAll(
    `<tv><programme start="20261005201500 +0200" stop="20261005204500 +0200" channel="x">` +
      `<title>${'T'.repeat(1000)}</title><desc>${'D'.repeat(5000)}</desc></programme></tv>`,
  );
  assert.equal(items[0].title.length, 300);
  assert.equal(items[0].desc.length, 2000);
});

// ── Etappe 3.2 (Datenmodell B): Zusatzfelder ──

const B_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'epg-b-fields.xml'), 'utf-8');
const EMPTY_CREDITS = { director: [], actor: [], presenter: [] };

function bItem(title, opts) {
  const { items } = parseAll(B_FIXTURE, opts);
  const item = byTitle(items, title);
  assert.ok(item, `Sendung „${title}“ im Fixture`);
  return item;
}

function oneProgramme(inner, attrs = 'start="20261005201500 +0200" stop="20261005204500 +0200" channel="x"') {
  const { items } = parseAll(`<tv><programme ${attrs}><title>T</title>${inner}</programme></tv>`);
  assert.equal(items.length, 1);
  return items[0];
}

test('B-1: alle Felder, Grenzen (Kategorien ≤ 3, Regie ≤ 2, Darsteller ≤ 8, Moderation ≤ 2), mehrere credits-Blöcke', () => {
  const p = bItem('Voll belegt');
  assert.equal(p.subtitle, 'Der Untertitel & mehr');
  assert.deepEqual(p.categories, ['Krimi', 'Drama', 'Sports']);
  assert.equal(p.icon, 'https://img.example.org/p/1.jpg?w=300&h=200');
  assert.equal(p.year, 2019);
  assert.equal(p.episode, 'S2 E3');
  assert.deepEqual(p.credits.director, ['Regie Eins', 'Regie Zwei']);
  assert.deepEqual(p.credits.actor, Array.from({ length: 8 }, (_, i) => `Darsteller ${i + 1}`), 'über beide credits-Blöcke, max. 8');
  assert.deepEqual(p.credits.presenter, ['Moderator Eins', 'Moderator Zwei']);
  assert.equal(p.rating, 'FSK 12', 'rating: value, nicht das Icon darin');
  assert.equal(p.desc, 'Beschreibung mit Zeilen umbruch.');
});

test('B-1: fehlende Felder → leer (\'\', [], year 0), Sendung bleibt gültig', () => {
  const p = bItem('Nur Titel');
  assert.deepEqual(
    { subtitle: p.subtitle, categories: p.categories, icon: p.icon, year: p.year, episode: p.episode, credits: p.credits, rating: p.rating },
    { subtitle: '', categories: [], icon: '', year: 0, episode: '', credits: EMPTY_CREDITS, rating: '' },
  );
});

test('B-1: Überlängen werden gekürzt, nie abgelehnt; zu lange Icon-URL bleibt leer', () => {
  const p = bItem('Ueberlaengen');
  assert.equal(p.subtitle.length, LIMITS.MAX_SUBTITLE_LENGTH);
  assert.equal(p.categories[0].length, LIMITS.MAX_CATEGORY_LENGTH);
  assert.equal(p.episode.length, LIMITS.MAX_EPISODE_LENGTH);
  assert.equal(p.credits.actor[0].length, LIMITS.MAX_PERSON_LENGTH);
  assert.equal(p.rating.length, LIMITS.MAX_RATING_LENGTH);
  assert.equal(p.icon, '', 'eine gekürzte URL wäre kaputt');
  const exactly = `https://example.org/${'a'.repeat(LIMITS.MAX_ICON_LENGTH - 'https://example.org/'.length)}`;
  assert.equal(exactly.length, LIMITS.MAX_ICON_LENGTH);
  assert.equal(oneProgramme(`<icon src="${exactly}"/>`).icon, exactly, '512 Zeichen sind erlaubt');
  assert.equal(oneProgramme(`<icon src="${exactly}x"/>`).icon, '', '513 nicht');
});

test('B-1: Icon nur http/https; javascript:/data:/ftp: → leer; nur das erste <icon> zählt', () => {
  assert.equal(bItem('Icon javascript').icon, '');
  assert.equal(bItem('Icon data').icon, '', 'erstes Icon unzulässig → leer, kein Weitersuchen');
  assert.equal(bItem('Icon ftp').icon, '');
  assert.equal(bItem('Icon http').icon, 'http://img.example.org/ok-http.png');
  assert.equal(oneProgramme('<icon src="HTTPS://img.example.org/x.png"/>').icon, 'HTTPS://img.example.org/x.png');
  for (const bad of ['', '//img.example.org/x.png', 'img.example.org/x.png', 'https://', 'https://a b.example/x', ' javascript:alert(1)', 'file:///etc/passwd', 'https://a.example/\u0001']) {
    assert.equal(oneProgramme(`<icon src="${bad}"/>`).icon, '', `ungültig: ${JSON.stringify(bad)}`);
  }
  assert.equal(oneProgramme('<icon/>').icon, '');
  assert.equal(oneProgramme(`<icon src='https://img.example.org/single.png'></icon>`).icon, 'https://img.example.org/single.png');
});

test('B-1: Entities (auch numerische) in Credits/Kategorien einmal dekodiert, kein Doppel-Decode, CDATA bleibt Text', () => {
  const p = bItem('Entities in Credits');
  assert.deepEqual(p.credits.director, ['Björn Büttner']);
  assert.deepEqual(p.credits.actor, ['René & Zoe', 'A &lt; B', 'Cdata <Name>']);
  assert.deepEqual(p.credits.presenter, ['José 😀']);
  assert.deepEqual(p.categories, ['Kinder & Jugend', 'Fußball']);
  assert.equal(oneProgramme('<sub-title>&amp;lt;b&amp;gt;</sub-title>').subtitle, '&lt;b&gt;');
  assert.equal(oneProgramme('<category>&#x41;&#66;&#0;&#xFFFFFFF;</category>').categories[0], 'AB', 'ungültige Codepoints entfallen');
});

test('B-1: Episode — onscreen unverändert, xmltv_ns → "S2 E3", andere Systeme ignoriert, ≤ 20 Zeichen', () => {
  assert.equal(bItem('xmltv_ns 1.2.').episode, 'S2 E3');
  assert.equal(bItem('xmltv_ns mit Gesamtzahl').episode, 'S1 E5');
  assert.equal(bItem('xmltv_ns nur Folge').episode, 'E6');
  assert.equal(bItem('xmltv_ns leer').episode, '', 'leer; dd_progid wird nicht übernommen');
  assert.equal(bItem('Episode nur E').episode, 'E826');
  assert.equal(oneProgramme('<episode-num system="xmltv_ns">0.0.</episode-num>').episode, 'S1 E1');
  assert.equal(oneProgramme('<episode-num system="xmltv_ns">3.</episode-num>').episode, 'S4');
  assert.equal(oneProgramme('<episode-num system="xmltv_ns">x.y.z</episode-num>').episode, '');
  assert.equal(oneProgramme('<episode-num system="onscreen">Folge 12</episode-num>').episode, 'Folge 12');
  assert.equal(oneProgramme('<episode-num system="thetvdb.com">12345</episode-num>').episode, '');
});

test('B-1: Kategorien Sport/Sports bleiben getrennte Werte, Duplikate und Leerwerte entfallen', () => {
  assert.deepEqual(bItem('Sportschau').categories, ['Sport', 'Sports']);
  assert.deepEqual(oneProgramme('<category></category><category> </category><category>A</category><category>A</category>').categories, ['A']);
});

test('B-1: Jahr — erste vier Ziffern, 1900–2100, sonst 0', () => {
  assert.equal(bItem('Jahr 1850').year, 0);
  assert.equal(bItem('Jahr kein Zahl').year, 0);
  assert.equal(bItem('Jahr aus ISO-Datum').year, 2023);
  assert.equal(bItem('Jahr 2150').year, 0);
  assert.equal(oneProgramme('<date>1900</date>').year, 1900);
  assert.equal(oneProgramme('<date>2100</date>').year, 2100);
  assert.equal(oneProgramme('<date>2101</date>').year, 0);
  assert.equal(oneProgramme('<date>1899</date>').year, 0);
  assert.equal(oneProgramme('<date>  1999-12-31 </date>').year, 1999);
  assert.equal(oneProgramme('<date>12</date>').year, 0);
});

test('B-1: fehlende/verschachtelte Tags — unabgeschlossene Elemente, Felder in CDATA, Tags im Text', () => {
  const open = bItem('Defekte Felder');
  assert.deepEqual(open.categories, [], 'unabgeschlossenes <category> liefert nichts');
  assert.deepEqual(open.credits.actor, ['Nach offenem Tag'], 'Felder danach werden weiter gelesen');
  assert.equal(open.icon, 'https://img.example.org/nach-defekt.png');
  const cdata = bItem('Versteckt in CDATA');
  assert.deepEqual(cdata.categories, ['Echt'], 'Felder im CDATA der Beschreibung zählen nicht');
  assert.deepEqual(cdata.credits.actor, []);
  assert.equal(cdata.icon, '');
  assert.ok(cdata.desc.includes('<category>Falsch</category>'));
  const nested = bItem('Verschachtelt');
  assert.deepEqual(nested.categories, ['FettText'], 'eingebettete Tags werden entfernt');
  assert.deepEqual(nested.credits.actor, ['Innen']);
});

test('B-1: Chunk-Grenzen mitten in Tags/Entities liefern dasselbe wie ein Block', () => {
  const whole = parseAll(B_FIXTURE).items;
  for (const chunkSize of [1, 3, 7, 61]) {
    assert.deepEqual(parseAll(B_FIXTURE, { chunkSize }).items, whole, `chunkSize ${chunkSize}`);
  }
});

test('B-1: Zeitfenster-Filterung unverändert (Felder ändern nichts am Fenster)', () => {
  const from = Date.UTC(2026, 9, 5, 19, 0, 0);
  const { items, stats } = parseAll(B_FIXTURE, { fromMs: from, toMs: Date.UTC(2026, 9, 5, 21, 0, 0) });
  assert.deepEqual(items.map(p => p.title), ['Nur Titel', 'Ueberlaengen']);
  assert.ok(stats.skippedOutOfWindow > 10);
});

test('B-1 bösartig: riesige credits-Liste, unabgeschlossene Tags, Überlängen — begrenzt und schnell', () => {
  // ~400 KB credits (unter MAX_OPEN_ELEMENT_CHARS): Obergrenzen greifen, nichts wird abgelehnt
  const actors = Array.from({ length: 20000 }, (_, i) => `<actor>Name ${i}</actor>`).join('');
  const dirs = Array.from({ length: 50 }, (_, i) => `<director>Regie ${i}</director>`).join('');
  const t0 = Date.now();
  const p = oneProgramme(`<credits>${dirs}${actors}</credits>`);
  assert.equal(p.credits.actor.length, LIMITS.MAX_ACTORS);
  assert.equal(p.credits.director.length, LIMITS.MAX_DIRECTORS);
  assert.deepEqual(p.credits.actor.slice(0, 2), ['Name 0', 'Name 1']);

  // Tausende unabgeschlossene Tags: kein quadratisches Verhalten
  const unclosed = '<actor>x'.repeat(20000) + '<category>y'.repeat(10000);
  const q = oneProgramme(unclosed);
  assert.ok(q.credits.actor.length <= LIMITS.MAX_ACTORS);
  assert.ok(q.categories.length <= LIMITS.MAX_CATEGORIES);

  // Elementgrenze: Felder nach MAX_BODY_ELEMENTS Fremdelementen werden nicht mehr gelesen
  const junk = '<x/>'.repeat(LIMITS.MAX_BODY_ELEMENTS + 10);
  assert.deepEqual(oneProgramme(`${junk}<category>Spät</category>`).categories, []);
  assert.deepEqual(oneProgramme('<x/>'.repeat(100) + '<category>Früh</category>').categories, ['Früh']);

  // sehr lange Felder
  const big = oneProgramme(
    `<sub-title>${'s'.repeat(100000)}</sub-title><category>${'c'.repeat(100000)}</category>` +
      `<rating><value>${'r'.repeat(100000)}</value></rating><episode-num>${'e'.repeat(100000)}</episode-num>`,
  );
  assert.equal(big.subtitle.length, LIMITS.MAX_SUBTITLE_LENGTH);
  assert.equal(big.categories[0].length, LIMITS.MAX_CATEGORY_LENGTH);
  assert.equal(big.rating.length, LIMITS.MAX_RATING_LENGTH);
  assert.equal(big.episode.length, LIMITS.MAX_EPISODE_LENGTH);
  assert.ok(Date.now() - t0 < 5000, 'bösartige Eingaben bleiben schnell');
});

test('B-1 bösartig: Attribute mit > und Entities, Selbstschließer, Tag-Fragmente, Kommentare', () => {
  const p = oneProgramme(
    `<!-- <category>Kommentar</category> --><icon src="https://img.example.org/a>b.png" alt='x>y'/>` +
      `<category lang="de" note="a>b">Echt</category><actor/><director></director><date/><episode-num/><rating/><sub-title/>` +
      `< << 5 < 6 <actor>Tag-Fragment</actor>`,
  );
  assert.equal(p.icon, 'https://img.example.org/a>b.png');
  assert.deepEqual(p.categories, ['Echt']);
  assert.deepEqual(p.credits.actor, ['Tag-Fragment']);
  assert.equal(p.rating, '');
  assert.equal(p.year, 0);
});

test('B-1 Streaming: Speicher wächst nicht mit der Dateigröße (Puffer klein, Ergebnis nicht gehalten)', () => {
  const programme = i =>
    `<programme start="20261005${String(i % 24).padStart(2, '0')}0000 +0000" stop="20261005${String(i % 24).padStart(2, '0')}3000 +0000" channel="c${i % 40}">` +
    `<title>Sendung ${i}</title><desc>${'d'.repeat(200)}</desc><category>Krimi</category><category>Drama</category>` +
    `<credits><director>R ${i}</director>${'<actor>Darsteller Name</actor>'.repeat(8)}</credits>` +
    `<date>2020</date><episode-num system="xmltv_ns">1.${i % 20}.</episode-num>` +
    `<icon src="https://img.example.org/${i}.jpg"/></programme>\n`;
  const measure = count => {
    let max = 0;
    let n = 0;
    const parser = new XmltvStreamParser({ onProgramme: () => (n += 1) });
    parser.write('<tv>');
    let pending = '';
    for (let i = 0; i < count; i += 1) {
      pending += programme(i);
      if (pending.length > 65536) {
        parser.write(pending);
        pending = '';
        max = Math.max(max, parser.buf.length);
      }
    }
    parser.write(`${pending}</tv>`);
    parser.end();
    assert.equal(n, count);
    return max;
  };
  const small = measure(2000);
  const large = measure(40000);
  assert.ok(large < 200000, `Puffer bleibt klein (max ${large} Zeichen)`);
  assert.ok(large <= small * 1.5 + 1000, `Puffer wächst nicht mit der Eingabe (${small} → ${large})`);
});
