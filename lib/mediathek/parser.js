'use strict';

// Einstieg der reinen Mediathek-Parser (Port von MediathekParser.swift): Eingabe ist der rohe Antworttext (String/Buffer)
// oder ein bereits geparstes Objekt; keine Netzzugriffe. Ungültiges JSON wirft einen Error mit code 'invalidJSON'; fehlende
// oder unerwartete Strukturen ergeben leere Listen bzw. übersprungene Einträge, nie einen Absturz.

const { isObject, makeSection } = require('./util.js');
const ard = require('./parser-ard.js');
const zdf = require('./parser-zdf.js');
const arte = require('./parser-arte.js');
const { mergeOriginalVersions, groupBySeason } = require('./entries.js');

function invalidJson() {
  return Object.assign(new Error('Antwort ist kein gültiges JSON'), { code: 'invalidJSON' });
}

/** Antworttext (oder Objekt) als JSON-Objekt; wirft bei allem anderen. */
function toRoot(input) {
  let value = input;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    try {
      value = JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : input);
    } catch {
      throw invalidJson();
    }
  }
  if (!isObject(value)) throw invalidJson();
  return value;
}

/** Home- oder Such-Antwort einer Quelle als flache Einträge. */
function parse(input, sourceId) {
  const root = toRoot(input);
  if (sourceId === 'ard') return ard.parseArd(root);
  if (sourceId === 'zdf') return zdf.parseZdf(root);
  if (sourceId === 'arte') return arte.parseArte(root);
  return [];
}

/**
 * Home-Antwort als benannte Abschnitte (ARD: Widgets, ZDF: Cluster, arte: Zonen). Leere Abschnitte entfallen; ohne erkennbare
 * Struktur eine Sektion "Neu & beliebt".
 */
function parseSections(input, sourceId) {
  const root = toRoot(input);
  let sections = [];
  if (sourceId === 'ard') sections = ard.parseArdSections(root);
  else if (sourceId === 'zdf') sections = zdf.parseZdfSections(root);
  else if (sourceId === 'arte') sections = arte.arteSections(root);
  if (!sections.length) {
    const all = parse(root, sourceId);
    if (all.length) sections = [makeSection({ title: 'Neu & beliebt', entries: all })];
  }
  return sections;
}

/** Suchseite einer Quelle: { series, entries, page, hasMore }. ZDF liefert nur Seite 0 ohne Serien. */
function parseSearchPage(input, sourceId, page = 0) {
  const root = toRoot(input);
  if (sourceId === 'ard') return ard.parseArdSearchPage(root, page);
  if (sourceId === 'arte') return arte.parseArteSearchPage(root);
  return { series: [], entries: page === 0 ? parse(root, sourceId) : [], page, hasMore: false };
}

const parseArdGrouping = input => ard.parseArdGrouping(toRoot(input));
const parseArteGenrePage = input => arte.arteSections(toRoot(input));
const parseArteMore = (input, title) => arte.parseArteMore(toRoot(input), title);
const parseArteCollection = input => arte.parseArteCollection(toRoot(input));

/** Stream-Auflösung zum Abspielen mit Regionshinweis: { resolution: { kind, url?, rating? }, regionRestricted }. */
function parseStreamDetail(input, sourceId) {
  let root;
  try {
    root = toRoot(input);
  } catch {
    return { resolution: { kind: 'unavailable' }, regionRestricted: false };
  }
  if (sourceId === 'ard') return ard.parseArdStreamDetail(root);
  if (sourceId === 'zdf') return { resolution: zdf.parseZdfStream(root), regionRestricted: false };
  if (sourceId === 'arte') return { resolution: arte.parseArteStream(root), regionRestricted: false };
  return { resolution: { kind: 'unavailable' }, regionRestricted: false };
}

/** Altersfreigabe (0/6/12/16/18|null) aus dem ZDF-Dokument. */
const parseZdfFsk = input => {
  try {
    return zdf.parseZdfFsk(toRoot(input));
  } catch {
    return null;
  }
};

/** Altersfreigabe (0/6/12/16/18|null) aus der Stream-Info einer Folge (ARD item, ZDF document); arte nennt sie dort nicht. */
function parseFsk(input, sourceId) {
  try {
    const root = toRoot(input);
    if (sourceId === 'zdf') return zdf.parseZdfFsk(root);
    if (sourceId === 'ard') return ard.parseArdFsk(root);
  } catch {
    // unlesbare Antwort: keine Angabe
  }
  return null;
}

module.exports = {
  toRoot,
  parseFsk,
  parseZdfFsk,
  parse,
  parseSections,
  parseSearchPage,
  parseArdGrouping,
  parseArteGenrePage,
  parseArteMore,
  parseArteCollection,
  parseStreamDetail,
  mergeOriginalVersions,
  groupBySeason,
  isValidArteApiUrl: arte.isValidArteApiUrl,
  arteGenrePageUrl: arte.arteGenrePageUrl,
};
