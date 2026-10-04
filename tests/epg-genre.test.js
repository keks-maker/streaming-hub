'use strict';

// Tests: Genre-Normalisierung (Etappe 3.2; EPG-Konzept B3, AUF-Plan P13).
// Datengetrieben: lib/epg/genre-table.json; Werteliste der echten Quelle als Fixture
// (tests/fixtures/epg-category-values.json, erzeugt mit scripts/measure-epg.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGenre, createGenreNormalizer, compileGenreTable, GENRE_TABLE } = require('../lib/epg/genre.js');
const fixture = require('./fixtures/epg-category-values.json');

const GROUPS = ['film', 'serie', 'news', 'sport', 'doku', 'kinder', 'show', 'musik', 'sonstiges'];

test('Keine Kategorie → leer; nur Leerwerte zählen nicht', () => {
  assert.equal(normalizeGenre([]), '');
  assert.equal(normalizeGenre(undefined), '');
  assert.equal(normalizeGenre(null), '');
  assert.equal(normalizeGenre(['', '  ', 5, null]), '');
});

test('Konzept-Tabelle (B3): Beispiele je Gruppe', () => {
  const expected = {
    news: ['Nachrichten', 'Politik', 'Aktuelles', 'Regionalinfos', 'Regionalmagazin'],
    sport: ['Sport', 'Sports', 'Fußball', 'Eishockey', 'Basketball', 'American Football', 'Rugby', 'Motorsport', 'Sportmagazin', 'Sportdoku'],
    doku: ['Dokumentation', 'Doku', 'Dokus', 'Dokureihe', 'Wissen', 'Natur und Tiere', 'Reisen', 'Reportage', 'Reisereportage', 'Geschichte', 'Report'],
    kinder: ['Kinder', 'Kinder & Jugend', 'Animation', 'Zeichentrickserie', 'Animationsserie'],
    serie: ['Serie', 'Serien', 'Krimiserie', 'Comedyserie', 'Soap', 'Daily Soap', 'Sitcom', 'Gerichtssoap', 'Dokusoap'],
    film: ['Film', 'Filme', 'Drama', 'Krimi', 'Action', 'Thriller', 'Komödie', 'Horror', 'Western', 'Romantik', 'Fantasy', 'ScienceFiction', 'Abenteuer', 'Erotischer Film'],
    show: ['Unterhaltung', 'Show', 'Talkshow', 'Gerichtsshow', 'Reality', 'Comedy'],
    musik: ['Musik', 'Music'],
    sonstiges: ['Magazin', 'Gesellschaft', 'Ratgeber', 'Lifestyle', 'Kochen', 'Auto', 'Kultur', 'Werbesendung', 'Irgendwas Unbekanntes'],
  };
  for (const [group, values] of Object.entries(expected)) {
    for (const value of values) assert.equal(normalizeGenre([value]), group, `${value} → ${group}`);
  }
});

test('Prioritätsliste entscheidet bei mehreren Kategorien, nicht die Quellreihenfolge', () => {
  assert.deepEqual(GENRE_TABLE.priority, ['news', 'sport', 'kinder', 'doku', 'serie', 'film', 'show', 'musik', 'sonstiges']);
  assert.equal(normalizeGenre(['Drama', 'Nachrichten']), 'news');
  assert.equal(normalizeGenre(['Nachrichten', 'Drama']), 'news');
  assert.equal(normalizeGenre(['Unterhaltung', 'Sport', 'Krimi']), 'sport');
  assert.equal(normalizeGenre(['Krimi', 'Kinder']), 'kinder');
  assert.equal(normalizeGenre(['Drama', 'Dokumentation']), 'doku');
  assert.equal(normalizeGenre(['Krimi', 'Serie']), 'serie');
  assert.equal(normalizeGenre(['Show', 'Musik']), 'show');
  // sonstiges ist nur Auffangwert: eine zuordenbare Kategorie schlägt eine unbekannte
  assert.equal(normalizeGenre(['Magazin', 'Musik']), 'musik');
  assert.equal(normalizeGenre(['Magazin', 'Ratgeber']), 'sonstiges');
});

test('Matching gefaltet: Groß-/Kleinschreibung, Umlaute, Akzente, ß', () => {
  assert.equal(normalizeGenre(['fußball']), 'sport');
  assert.equal(normalizeGenre(['FUSSBALL']), 'sport');
  assert.equal(normalizeGenre(['KOMÖDIE']), 'film');
  assert.equal(normalizeGenre(['komoedie']), 'film');
  assert.equal(normalizeGenre(['Komodie']), 'film');
  assert.equal(normalizeGenre(['  Nachrichten  ']), 'news');
  assert.equal(normalizeGenre(['Telenovela']), 'serie');
});

test('Teilstring-Regeln: zusammengesetzte Kategorien, exakter Treffer geht vor', () => {
  assert.equal(normalizeGenre(['Kochshow']), 'show');
  assert.equal(normalizeGenre(['Actionserie']), 'serie');
  assert.equal(normalizeGenre(['Wassersport']), 'sport');
  assert.equal(normalizeGenre(['Nachrichtenmagazin']), 'news');
  assert.equal(normalizeGenre(['Kinder-Wissensmagazin']), 'kinder');
  assert.equal(normalizeGenre(['Fußballreportage']), 'sport');
  // exakter Eintrag überstimmt Teilstring (Dokusoap würde sonst „doku“)
  assert.equal(normalizeGenre(['Dokusoap']), 'serie');
  assert.equal(normalizeGenre(['Doku-Soap']), 'serie');
  assert.equal(normalizeGenre(['Politdrama']), 'film');
});

test('Rückgabe ist immer ein Wert der festen Gruppenliste oder leer', () => {
  for (const [value] of fixture.values) {
    const group = normalizeGenre([value]);
    assert.ok(GROUPS.includes(group), `${value} → ${group}`);
  }
});

test('Datengetrieben: eigene Tabelle ohne Logikänderung, unbekannte Gruppen/Einträge werden ignoriert', () => {
  const normalize = createGenreNormalizer({
    priority: ['b', 'a', 'sonstiges'],
    exact: { a: ['Eins'], b: ['Zwei'], unbekannt: ['Drei'] },
    contains: { a: ['xyz'] },
  });
  assert.equal(normalize(['Eins']), 'a');
  assert.equal(normalize(['Eins', 'Zwei']), 'b');
  assert.equal(normalize(['abcXYZ']), 'a');
  assert.equal(normalize(['Drei']), 'sonstiges');
  assert.equal(normalize([]), '');
  const compiled = compileGenreTable({ priority: ['a'], exact: { a: ['Ä'] } });
  assert.equal(compiled.exact.get('a'), 'a', 'Tabelleneinträge werden gefaltet');
});

test('Tabelle: nur bekannte Gruppen, keine leeren Einträge', () => {
  for (const section of ['exact', 'contains']) {
    for (const [group, entries] of Object.entries(GENRE_TABLE[section])) {
      assert.ok(GENRE_TABLE.priority.includes(group), `${section}.${group} fehlt in priority`);
      for (const entry of entries) assert.ok(typeof entry === 'string' && entry.trim(), `${section}.${group} enthält Leerwert`);
    }
  }
});

test('Abnahme an der echten Werteliste (333-Werte-Fixture): Anteil „sonstiges“', () => {
  assert.ok(fixture.values.length > 300, 'Werteliste der Quelle vorhanden');
  // je Sendung mit Kategorie (Kombinationen der Quelle, Prioritätsliste wirkt)
  let withCategory = 0;
  let sonstiges = 0;
  for (const [categories, count] of fixture.sets) {
    withCategory += count;
    if (normalizeGenre(categories) === 'sonstiges') sonstiges += count;
  }
  assert.equal(withCategory, fixture.withCategory);
  const share = sonstiges / withCategory;
  assert.ok(share <= 0.1, `„sonstiges“ ≤ 10 % der Sendungen mit Kategorie (ist ${(share * 100).toFixed(1)} %)`);
  // je einzelnem Kategorie-Vorkommen ist der Anteil höher (Magazin/Gesellschaft/Ratgeber …) — zur Dokumentation
  let occurrences = 0;
  let occSonstiges = 0;
  for (const [value, count] of fixture.values) {
    occurrences += count;
    if (normalizeGenre([value]) === 'sonstiges') occSonstiges += count;
  }
  assert.ok(occSonstiges / occurrences < 0.2, 'Vorkommen-Anteil bleibt unter 20 %');
});
