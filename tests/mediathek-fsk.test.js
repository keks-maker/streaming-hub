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
  assert.equal(await service.fetchFsk({ ...entry, sourceId: 'arte' }), null, 'arte nennt die Einstufung in der Stream-Info nicht');
  assert.equal(calls, 1);
  // ARD: maturityContentRating des item-Widgets (0/6 zählen), sonst fskRating der Seite; bekannte Werte ohne Abruf
  const item = { widgets: [{ type: 'player_ondemand', maturityContentRating: 'FSK6' }] };
  assert.equal(parser.parseFsk(JSON.stringify(item), 'ard'), 6);
  assert.equal(parser.parseFsk(JSON.stringify({ fskRating: 'FSK0', widgets: [] }), 'ard'), 0);
  assert.equal(parser.parseFsk(JSON.stringify({ widgets: [{ maturityContentRating: 'NONE' }] }), 'ard'), null);
  let ardCalls = 0;
  let running = 0;
  let peak = 0;
  const ardService = createMediathekService({ http: { getText: async () => { ardCalls += 1; running += 1; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 5)); running -= 1; return JSON.stringify(item); } } });
  const ardEntries = Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, title: 'T', sourceId: 'ard', partner: 'ard', fsk: null }));
  assert.deepEqual(await Promise.all(ardEntries.map(e => ardService.fetchFsk(e))), [6, 6, 6, 6, 6, 6]);
  assert.ok(peak <= 2, 'höchstens zwei Abfragen gleichzeitig');
  assert.equal(ardService.knownFsk(ardEntries[0]), 6);
  assert.equal(ardService.knownFsk({ id: 'x', sourceId: 'ard' }), null);
  await ardService.fetchFsk(ardEntries[0]);
  assert.equal(ardCalls, 6, 'Cache je Eintrag');
  const failing = createMediathekService({ http: { getText: async () => { throw new Error('x'); } } });
  assert.equal(await failing.fetchFsk(entry), null);
});

test('Download-Datensatz speichert die Freigabe; ältere ohne Feld bleiben null', () => {
  const { minimalEntry } = require('../lib/download/records.js');
  assert.equal(minimalEntry({ id: 'a', title: 'T', sourceId: 'zdf', fsk: 12 }).fsk, 12);
  assert.equal(minimalEntry({ id: 'a', title: 'T', sourceId: 'zdf' }).fsk, null);
  assert.equal(minimalEntry({ id: 'a', title: 'T', sourceId: 'zdf', fsk: 7 }).fsk, null);
});

// ── Nachladen und Badges in der Oberfläche (mediathek-fsk-loader.js, mediathek-cards.js) ──

function fakeDoc() {
  const make = tag => {
    const node = { tag, className: '', textContent: '', children: [], dataset: {}, style: { setProperty() {} }, ownerDocument: null };
    node.ownerDocument = doc; // eslint-disable-line no-use-before-define
    node.appendChild = child => { node.children.push(child); return child; };
    node.append = (...kids) => kids.forEach(kid => node.appendChild(kid));
    node.setAttribute = () => {};
    node.addEventListener = () => {};
    node.querySelector = selector => node.children.find(child => selector === `.${child.className.split(' ').pop()}` || (child.className.split(' ').includes(selector.slice(1)))) || null;
    node.querySelectorAll = selector => {
      const found = [];
      const walk = parent => parent.children.forEach(child => { if (child.className.split(' ').includes(selector.slice(1))) found.push(child); walk(child); });
      walk(node);
      return found;
    };
    return node;
  };
  const doc = { createElement: make };
  return doc;
}

test('Karten: Badge für jede Einstufung (auch FSK 0/6), keiner ohne Angabe', () => {
  const { createEntryCard } = require('../mediathek-cards.js');
  const doc = fakeDoc();
  const texts = fsk => {
    const card = createEntryCard(doc, { id: 'a', title: 'T', sourceId: 'ard', fsk }, { blocked: false });
    return card.querySelectorAll('.mediathek-pill-fsk').map(node => node.textContent);
  };
  assert.deepEqual([0, 6, 12, 18].map(texts), [['FSK 0'], ['FSK 6'], ['FSK 12'], ['FSK 18']]);
  assert.deepEqual(texts(null), []);
});

test('Loader: Badges für bekannte, gestaffelt nachgeladene Einträge; Cache, Obergrenze, nur ZDF/ARD, Fehler ohne Wiederholung', async () => {
  const { createFskLoader } = require('../mediathek-fsk-loader.js');
  const { createEntryCard } = require('../mediathek-cards.js');
  const doc = fakeDoc();
  const root = doc.createElement('div');
  const asked = [];
  let running = 0;
  let peak = 0;
  const loader = createFskLoader({
    fetchFsk: async entry => {
      asked.push(entry.id);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 2));
      running -= 1;
      if (entry.id === 'bad') return { ok: false };
      return { ok: true, fsk: entry.id === 'none' ? null : 6 };
    },
  });
  const entries = ['z1', 'z2', 'none', 'bad', 'z5', 'z6'].map(id => ({ id, title: id, sourceId: 'zdf', fsk: null }));
  entries.push({ id: 'arte1', title: 'a', sourceId: 'arte', fsk: null }, { id: 'known', title: 'k', sourceId: 'ard', fsk: 16 });
  for (const entry of entries) root.appendChild(createEntryCard(doc, entry, {}));
  let changes = 0;
  loader.onChange(() => { changes += 1; });
  loader.decorate(root, { max: 5 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(asked.sort(), ['bad', 'none', 'z1', 'z2', 'z5'], 'höchstens 5, arte und bekannte nicht');
  assert.ok(peak <= 2);
  assert.equal(entries[0].fsk, 6, 'Ergebnis im Eintrag');
  assert.equal(entries[5].fsk, null, 'außerhalb der Obergrenze');
  const badges = root.querySelectorAll('.mediathek-pill-fsk').map(node => node.textContent);
  assert.equal(badges.filter(text => text === 'FSK 6').length, 3);
  assert.ok(badges.includes('FSK 16'));
  assert.equal(changes, 4);
  loader.decorate(root, { max: 12 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(asked.filter(id => id === 'z1' || id === 'bad' || id === 'none').length, 3, 'Cache und Fehler: keine Wiederholung');
  assert.ok(asked.includes('z6'));
  assert.equal(await loader.lookup({ id: 'z1', sourceId: 'zdf', fsk: null }), 6);
  assert.equal(await loader.lookup({ id: 'arte1', sourceId: 'arte', fsk: null }), null);
});
