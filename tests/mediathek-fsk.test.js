'use strict';

// Tests: Altersfreigabe (FSK) im Eintragsmodell, Anzeige-Texte und Hinweis bei leerer Folgenliste. Kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fskLevel, makeEntry } = require('../lib/mediathek/util.js');
const parser = require('../lib/mediathek/parser.js');
const { emptySeriesNote } = require('../lib/mediathek/restrictions.js');
const { fskText, seriesFsk } = require('../mediathek-format.js');
const { detailInfo } = require('../mediathek-detail-model.js');
const { validateEntry } = require('../lib/mediathek/validation.js');

test('fskLevel: gültige Stufen als Zahl, alles andere null', () => {
  assert.deepEqual(['FSK12', 'fsk16', 'fsk 6', 'FSK18', 12, '0'].map(fskLevel), [12, 16, 6, 18, 12, 0]);
  assert.deepEqual(['none', 'NONE', null, undefined, '', 'fsk99', 7, {}, '2026'].map(fskLevel), [null, null, null, null, null, null, null, null, null]);
  assert.equal(fskLevel({ code: 'FSK16' }), 16);
  assert.equal(makeEntry({ id: 'a', title: 'T', sourceId: 'ard' }).fsk, null);
});

test('ARD-Teaser: maturityContentRating wird Eintragsfeld fsk', () => {
  const root = { vodResults: [{ id: 'x', longTitle: 'Schweigen', maturityContentRating: 'FSK12', links: { target: { href: 'https://api.ardmediathek.de/page-gateway/pages/ndr/item/abc?devicetype=pc&embedded=true' } } }, { id: 'y', longTitle: 'Ohne', links: { target: { href: 'https://api.ardmediathek.de/page-gateway/pages/ndr/item/def' } } }] };
  const entries = parser.parse(JSON.stringify(root), 'ard');
  assert.deepEqual(entries.map(e => e.fsk), [12, null]);
});

test('ZDF-Teaser: fsk-Feld ("fsk16"/"none"); arte: ageRating (Zahl, Objekt, null)', () => {
  const zdf = { results: [{ id: 'a', type: 'video', titel: 'A', fsk: 'fsk16' }, { id: 'b', type: 'video', titel: 'B', fsk: 'none' }] };
  assert.deepEqual(parser.parse(JSON.stringify(zdf), 'zdf').map(e => e.fsk), [16, null]);
  const arte = { data: [{ id: '1', programId: '100-000-A', title: 'A', kind: { code: 'SHOW' }, ageRating: '16' }, { id: '2', programId: '101-000-A', title: 'B', kind: { code: 'SHOW' }, ageRating: null }] };
  assert.deepEqual(parser.parse(JSON.stringify(arte), 'arte').map(e => e.fsk), [16, null]);
});

test('Anzeige: Texte, höchste Serien-Freigabe, Detail-Modell, Validierung', () => {
  assert.equal(fskText(12), 'FSK 12');
  assert.equal(fskText(0), 'FSK 0');
  assert.equal(fskText(null), null);
  assert.equal(seriesFsk([{ entries: [{ fsk: 12 }, { fsk: null }] }, { entries: [{ fsk: 16 }] }]), 16);
  assert.equal(seriesFsk([{ entries: [{ fsk: null }] }]), null);
  assert.equal(detailInfo({ id: 'a', title: 'T', sourceId: 'ard', fsk: 12 }).fsk, 'FSK 12');
  assert.equal(detailInfo({ id: 'a', title: 'T', sourceId: 'ard', fsk: null }).fsk, null);
  assert.equal(validateEntry({ id: 'a', title: 'T', sourceId: 'ard', fsk: 16 }).fsk, 16);
  assert.equal(validateEntry({ id: 'a', title: 'T', sourceId: 'ard', fsk: 'x' }).fsk, null);
});

test('Leere Folgenliste: Erklärung mit Zeitfenstern; Konto-Hinweis nur ohne Anmeldung', () => {
  const base = emptySeriesNote(null);
  assert.match(base, /^Keine Folgen verfügbar\. Sind die Folgen dieser Serie FSK-eingestuft \(FSK 16\/18\), sind sie erst ab 22 Uhr \(FSK 16\) bzw\. 23 Uhr \(FSK 18\) abrufbar\.$/);
  assert.match(emptySeriesNote('signedOut'), /Mit Konto \(Einstellungen ▸ Mediatheken ▸ Konten\) auch tagsüber\.$/);
  assert.match(emptySeriesNote('expired'), /Mit Konto/);
  assert.match(emptySeriesNote('signedIn'), /Auch mit Konto liefert der Sender derzeit keine Folgen\.$/);
  assert.ok(!/Konto/.test(base));
});

test('ZDF-Dokument: Freigabe aus der Infozeile (Vorrang) oder dem Feld fsk; service.fetchFsk cached und fragt nur ohne Angabe', async () => {
  const doc = { document: { fsk: 'none', videoInfo: '88 min | FSK 12 | 31.12.2025 | UT - AD' } };
  assert.equal(parser.parseZdfFsk(JSON.stringify(doc)), 12);
  assert.equal(parser.parseZdfFsk(JSON.stringify({ document: { fsk: 'fsk16' } })), 16);
  assert.equal(parser.parseZdfFsk(JSON.stringify({ document: { fsk: 'none' } })), null);
  assert.equal(parser.parseZdfFsk('kein json'), null);

  const { createMediathekService } = require('../lib/mediathek/service.js');
  let calls = 0;
  const service = createMediathekService({ http: { getText: async () => { calls += 1; return JSON.stringify(doc); } } });
  const entry = { id: 'der-schwarze-schwan-102', title: 'T', sourceId: 'zdf', fsk: null };
  assert.equal(await service.fetchFsk(entry), 12);
  assert.equal(await service.fetchFsk(entry), 12);
  assert.equal(calls, 1);
  assert.equal(await service.fetchFsk({ ...entry, fsk: 16 }), 16);
  assert.equal(await service.fetchFsk({ ...entry, sourceId: 'ard' }), null);
  assert.equal(calls, 1);
  const failing = createMediathekService({ http: { getText: async () => { throw new Error('x'); } } });
  assert.equal(await failing.fetchFsk(entry), null);
});

test('Download-Datensatz speichert die Freigabe; ältere ohne Feld bleiben null', () => {
  const { minimalEntry } = require('../lib/download/records.js');
  assert.equal(minimalEntry({ id: 'a', title: 'T', sourceId: 'zdf', fsk: 12 }).fsk, 12);
  assert.equal(minimalEntry({ id: 'a', title: 'T', sourceId: 'zdf' }).fsk, null);
  assert.equal(minimalEntry({ id: 'a', title: 'T', sourceId: 'zdf', fsk: 7 }).fsk, null);
});
