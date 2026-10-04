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
