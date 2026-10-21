'use strict';

// Schema-Prüfung aller mediathek:*-Kanäle (Eingaben aus dem Renderer sind nicht vertrauenswürdig): feste Feldlisten,
// Längen- und Typgrenzen. Rückgabe sind frische, bereinigte Objekte (unbekannte Felder werden abgelehnt, nicht durchgereicht).
// Adressen aus dem Renderer werden hier nur formal geprüft; der Abruf prüft sie zusätzlich gegen die Host-Allowlist.

const { makeEntry } = require('./util.js');
const { SOURCE_IDS } = require('./sources.js');
const { normalizeSeries } = require('./favorites.js');
const { isValidArteApiUrl } = require('./parser-arte.js');
const { isValidGenreId, isArdWidgetUrl } = require('./genre-pages.js');

const TEXT_MAX = 2000;
const QUERY_MAX = 200;
const MAX_PAGE = 200;
const MAX_SECONDS = 24 * 3600;

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} ist ungültig`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`Unbekanntes Feld: ${extra[0]}`);
}

function text(value, field, { max = TEXT_MAX, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} fehlt`);
    return null;
  }
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} ist ungültig`);
  return value;
}

function sourceId(value) {
  if (!SOURCE_IDS.includes(value)) throw new Error('Mediathek ist ungültig');
  return value;
}

function seconds(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) throw new Error(`${field} ist ungültig`);
  return value;
}

function optionalNumber(value, field, { integer = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9 || (integer && !Number.isInteger(value))) throw new Error(`${field} ist ungültig`);
  return value;
}

const ENTRY_KEYS = ['id', 'title', 'subtitle', 'description', 'imageUrl', 'duration', 'sourceId', 'airedAt', 'partner', 'season', 'episode', 'regionRestricted', 'originalVersionId', 'audioDescriptionId', 'availableUntil', 'fsk'];

/** Folge (Karte) aus dem Renderer; streamUrl kommt nie vom Renderer (wird im Main frisch aufgelöst). */
function validateEntry(value) {
  onlyKeys(value, ENTRY_KEYS, 'Folge');
  return makeEntry({
    id: text(value.id, 'Folgen-ID', { required: true, max: 500 }),
    title: text(value.title, 'Titel', { required: true }),
    subtitle: text(value.subtitle, 'Untertitel'),
    description: text(value.description, 'Beschreibung'),
    imageUrl: text(value.imageUrl, 'Bild'),
    duration: optionalNumber(value.duration, 'Dauer'),
    sourceId: sourceId(value.sourceId),
    airedAt: text(value.airedAt, 'Sendedatum', { max: 40 }),
    partner: text(value.partner, 'Partner', { max: 60 }),
    season: optionalNumber(value.season, 'Staffel', { integer: true }),
    episode: optionalNumber(value.episode, 'Folge', { integer: true }),
    regionRestricted: value.regionRestricted === true,
    originalVersionId: text(value.originalVersionId, 'OV-ID', { max: 500 }),
    audioDescriptionId: text(value.audioDescriptionId, 'AD-ID', { max: 500 }),
    availableUntil: text(value.availableUntil, 'Verfügbar bis', { max: 40 }),
    fsk: typeof value.fsk === 'number' ? value.fsk : null,
  });
}

/** Serie aus dem Renderer: alle sechs Felder des Apple-Modells, nichts darüber hinaus. */
function validateSeries(value) {
  onlyKeys(value, ['id', 'title', 'imageUrl', 'description', 'sourceId', 'groupingURL'], 'Serie');
  for (const field of ['id', 'title', 'imageUrl', 'description', 'groupingURL']) text(value[field], field, { max: TEXT_MAX });
  const series = normalizeSeries(value);
  if (!series) throw new Error('Serie ist ungültig');
  return series;
}

function validateHome(value) {
  onlyKeys(value, ['source'], 'Anfrage');
  return { source: sourceId(value.source) };
}

function validateSearch(value) {
  onlyKeys(value, ['query', 'source', 'page'], 'Suche');
  const query = text(value.query, 'Suchbegriff', { max: QUERY_MAX, required: true }).trim();
  if (!query) throw new Error('Suchbegriff fehlt');
  const page = value.page === undefined ? 0 : value.page;
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) throw new Error('Seite ist ungültig');
  return { query, source: sourceId(value.source), page };
}

function validateSeriesRequest(value) {
  onlyKeys(value, ['series'], 'Anfrage');
  return { series: validateSeries(value.series) };
}

const MAX_SERIES_PAGES = 50;

/** Folgenliste der Serienseite: Serie, optional Seitenzahl (ARD, 1..50) oder Staffel (1..1899). */
function validateSeriesPage(value) {
  onlyKeys(value, ['series', 'pages', 'season'], 'Anfrage');
  const pages = value.pages === undefined ? 1 : value.pages;
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_SERIES_PAGES) throw new Error('Seitenzahl ist ungültig');
  const season = value.season === undefined || value.season === null ? null : value.season;
  if (season !== null && (!Number.isInteger(season) || season < 1 || season > 1899)) throw new Error('Staffel ist ungültig');
  return { series: validateSeries(value.series), pages, season };
}

function validateGenre(value) {
  onlyKeys(value, ['genre'], 'Anfrage');
  onlyKeys(value.genre, ['id', 'title', 'imageUrl', 'sourceId'], 'Genre');
  const source = sourceId(value.genre.sourceId);
  const id = text(value.genre.id, 'Genre-ID', { required: true, max: 160 });
  if (!isValidGenreId(source, id)) throw new Error('Genre-ID ist ungültig');
  return { genre: { id, title: text(value.genre.title, 'Titel', { max: 300 }) || id, imageUrl: text(value.genre.imageUrl, 'Bild'), sourceId: source } };
}

function validateLoadMore(value) {
  onlyKeys(value, ['section'], 'Anfrage');
  onlyKeys(value.section, ['title', 'nextPage'], 'Reihe');
  const nextPage = text(value.section.nextPage, 'Adresse', { required: true });
  if (!isValidArteApiUrl(nextPage) && !isArdWidgetUrl(nextPage)) throw new Error('Adresse ist ungültig');
  return { section: { title: text(value.section.title, 'Titel', { max: 300 }) || '', nextPage } };
}

function validateResolvePlayback(value) {
  onlyKeys(value, ['entry', 'series'], 'Anfrage');
  return { entry: validateEntry(value.entry), series: value.series === undefined || value.series === null ? null : validateSeries(value.series) };
}

function validateFavoriteToggle(value) {
  return validateSeriesRequest(value);
}

function validateWatchProgress(value) {
  onlyKeys(value, ['sourceId', 'title', 'position', 'duration'], 'Fortschritt');
  return { sourceId: sourceId(value.sourceId), title: text(value.title, 'Titel', { required: true }), position: seconds(value.position, 'Position'), duration: seconds(value.duration, 'Dauer') };
}

function validateProgressQuery(value) {
  onlyKeys(value, ['sourceId', 'title'], 'Anfrage');
  return { sourceId: sourceId(value.sourceId), title: text(value.title, 'Titel', { required: true }) };
}

module.exports = {
  validateEntry,
  validateSeries,
  validateHome,
  validateSearch,
  validateSeriesRequest,
  validateSeriesPage,
  validateGenre,
  validateLoadMore,
  validateResolvePlayback,
  validateFavoriteToggle,
  validateWatchProgress,
  validateProgressQuery,
};
