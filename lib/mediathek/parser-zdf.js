'use strict';

// ZDF-Mediathek (zdf-prod-futura.zdf.de/mediathekV2): Teaser (nur einzelne Videos), Home-Abschnitte und Stream-Auflösung
// zum Abspielen. Reine Parser ohne Netz (Port von MediathekParser.swift).

const { dicts, isObject, nonEmpty, number, fskLevel, isoDate, dedupe, makeEntry, makeSeries, makeSection } = require('./util.js');
const { mergeOriginalVersions } = require('./entries.js');
const { isValidGenreId } = require('./genre-pages.js');
const { germanDateTime } = require('./download-info.js');

const ZDF_API = 'https://zdf-prod-futura.zdf.de/mediathekV2/';
/** Teaser-Arten, die eine Serie (Folgenliste in document/<id>) darstellen: Marke/Sendung, Themenreihe, Staffel. */
const SERIES_TYPES = new Set(['brand', 'topic', 'season']);
/** Staffelzahlen ab 1900 sind Jahre (Magazine): keine Staffel. */
const MAX_SEASON = 1900;

/** Dokument-Adresse einer Kennung (document/<id>); null bei ungültiger Kennung. */
function zdfDocumentUrl(id) {
  return isValidGenreId('zdf', id) ? `${ZDF_API}document/${encodeURIComponent(id)}` : null;
}

/** Nur die Dokument-Adresse einer Serie (https, Host der API, Pfad document/<gültige Kennung>). */
function isZdfDocumentUrl(value) {
  try {
    const url = new URL(value);
    const match = /^\/mediathekV2\/document\/([^/]+)$/.exec(url.pathname);
    return url.protocol === 'https:' && url.hostname === 'zdf-prod-futura.zdf.de' && !url.search && Boolean(match) && isValidGenreId('zdf', decodeURIComponent(match[1]));
  } catch {
    return false;
  }
}

/** Nachlade-Adresse der ZDF-Suche (nextPageUrl): nur Host der API und Pfad mediathekV2/search. */
function isZdfSearchUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'zdf-prod-futura.zdf.de' && url.pathname === '/mediathekV2/search' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Staffel/Folge eines Teasers ("seasonNumber"/"episodeNumber" als Text); Jahre (>1900) und Nullen ergeben keine Staffel. */
function zdfSeasonEpisode(item) {
  const season = Number.parseInt(item.seasonNumber, 10);
  if (!Number.isInteger(season) || season <= 0 || season > MAX_SEASON) return { season: null, episode: null };
  const episode = Number.parseInt(item.episodeNumber, 10);
  return { season, episode: Number.isInteger(episode) && episode > 0 ? episode : null };
}

function zdfImage(images) {
  if (!isObject(images)) return null;
  for (const key of ['768', '640', '960', '600', '1280']) {
    const url = isObject(images[key]) ? images[key].url : null;
    if (typeof url === 'string' && url) return url;
  }
  for (const value of Object.values(images)) if (isObject(value) && typeof value.url === 'string') return value.url;
  return null;
}

/** Teaser als Einträge. Nur einzelne Videos (episode/clip); brand/topic/category/livevideo/news sind Sammlungen ohne eigenen Stream. numbers: Staffel/Folge übernehmen (Serienseite). */
function zdfEntries(items, { numbers = false } = {}) {
  const entries = [];
  for (const item of items) {
    if (item.hasVideo === false) continue;
    if (!(item.type === 'video' || item.contentType === 'episode' || item.contentType === 'clip')) continue;
    // Dokument-ID (id), nicht videoId: nur sie löst mediathekV2/document/<id> auf.
    const id = nonEmpty(item.id);
    const title = nonEmpty(item.titel) || nonEmpty(item.headline);
    if (!id || !title) continue;
    const brand = nonEmpty(item.brandTitle);
    const { season, episode } = numbers ? zdfSeasonEpisode(item) : { season: null, episode: null };
    const visible = germanDateTime(item.visibleFrom);
    entries.push(
      makeEntry({
        id,
        title,
        subtitle: (brand !== title ? brand : null) || nonEmpty(item.channel),
        description: nonEmpty(item.beschreibung),
        imageUrl: zdfImage(item.teaserBild || item.image),
        duration: number(item.length),
        sourceId: 'zdf',
        availableUntil: isoDate(item.offlineAvailability),
        airedAt: visible ? visible.iso : null,
        season,
        episode,
        fsk: item.fsk,
      })
    );
  }
  return mergeOriginalVersions(dedupe(entries));
}

/** Marken/Sendungen/Themenreihen (brand, topic, season) als Serien; groupingURL = Dokument der Serie (Staffel-Cluster mit Folgen). */
function zdfSeries(items) {
  const seen = new Set();
  const list = [];
  for (const item of items) {
    if (!SERIES_TYPES.has(item.type) && !SERIES_TYPES.has(item.contentType)) continue;
    if (item.hasVideo === false) continue;
    const id = nonEmpty(item.id);
    const title = nonEmpty(item.titel) || nonEmpty(item.headline);
    const groupingURL = id ? zdfDocumentUrl(id) : null;
    if (!id || !title || !groupingURL || seen.has(id)) continue;
    seen.add(id);
    list.push(makeSeries({ id, title, imageUrl: zdfImage(item.teaserBild || item.image), description: nonEmpty(item.beschreibung), sourceId: 'zdf', groupingURL }));
  }
  return list;
}

/** Home: stage[] + cluster[].teaser[]; Suche: results[]. */
function parseZdf(root) {
  const items = [...dicts(root.results), ...dicts(root.stage)];
  for (const cluster of dicts(root.cluster)) items.push(...dicts(cluster.teaser));
  return zdfEntries(items);
}

const RUBRICS_TITLE = 'Rubriken';
const AZ_TYPE = 'brandsAlphabetical';
const AZ_TITLE = 'Sendungen A–Z';

/** Rubrik-Teaser (type/contentType "category") als { id, title, imageUrl, sourceId: 'zdf' }; id = Dokument-ID der Rubrik. */
function zdfGenres(items, selfId = null) {
  const seen = new Set();
  const genres = [];
  for (const item of items) {
    if (item.type !== 'category' && item.contentType !== 'category') continue;
    const id = nonEmpty(item.id);
    const title = nonEmpty(item.titel) || nonEmpty(item.headline);
    if (!id || !title || id === selfId || !isValidGenreId('zdf', id) || seen.has(id)) continue;
    seen.add(id);
    genres.push({ id, title, imageUrl: zdfImage(item.teaserBild || item.image), sourceId: 'zdf' });
  }
  return genres;
}

/** A–Z-Verzeichnis der Sendungen (Teaser type "brandsAlphabetical", Dokument sendungen-100) als Seitenkachel; sonst null. */
function zdfAlphabetical(items) {
  const item = items.find(entry => entry.type === AZ_TYPE);
  const id = item ? nonEmpty(item.id) : null;
  return id && isValidGenreId('zdf', id) ? { id, title: AZ_TITLE, imageUrl: null, sourceId: 'zdf' } : null;
}

/**
 * Abschnitte: "Empfohlen" (stage) und je Cluster eine Reihe aus Folgen und Serien (Marken/Sendungen/Themen); leere entfallen.
 * Startseite: der Cluster "Rubriken" ist die Kachel-Reihe der Rubriken (steht zuerst), das A–Z-Verzeichnis (falls verlinkt) ist
 * dort die letzte Kachel. Rubrikseite (options.page, document/<rubrik-id>): Unterrubriken ("category"-Teaser) werden Kacheln in der
 * jeweiligen Reihe (ohne die Rubrik selbst); das A–Z-Dokument liefert eine Reihe je Buchstabe. Ein Cluster ohne Teaser entfällt.
 */
function parseZdfSections(root, { page = false } = {}) {
  const sections = [];
  const selfId = page && isObject(root.document) ? nonEmpty(root.document.id) : null;
  const stageItems = dicts(root.stage);
  const stage = zdfEntries(stageItems);
  const stageSeries = zdfSeries(stageItems);
  if (stage.length || stageSeries.length) sections.push(makeSection({ title: 'Empfohlen', entries: stage, series: stageSeries }));
  let alphabetical = null;
  for (const cluster of dicts(root.cluster)) {
    const name = nonEmpty(cluster.name);
    const teasers = dicts(cluster.teaser);
    if (!page && !alphabetical) alphabetical = zdfAlphabetical(teasers);
    if (!name) continue;
    const entries = zdfEntries(teasers);
    const series = zdfSeries(teasers);
    const genres = page || name === RUBRICS_TITLE ? zdfGenres(teasers, selfId) : [];
    if (entries.length || series.length || genres.length) sections.push(makeSection({ title: name, entries, series, genres }));
  }
  if (alphabetical) {
    const rubrics = sections.find(section => section.title === RUBRICS_TITLE && section.genres.length > 0);
    if (rubrics) rubrics.genres.push(alphabetical);
    else sections.unshift(makeSection({ title: RUBRICS_TITLE, genres: [alphabetical] }));
  }
  const isRubrics = section => section.title === RUBRICS_TITLE && section.genres.length > 0;
  return [...sections.filter(isRubrics), ...sections.filter(section => !isRubrics(section))];
}

/**
 * Suchseite: results[] als Serien (brand/topic) und Folgen. Weitere Treffer meldet nextPage (true) mit nextPageUrl (nur die
 * ZDF-Suche der API wird übernommen). Ergebnis { series, entries, page, hasMore, nextPageUrl }; page ist 0-basiert.
 */
function parseZdfSearchPage(root, page = 0) {
  const results = dicts(root.results);
  const next = typeof root.nextPageUrl === 'string' && isZdfSearchUrl(root.nextPageUrl) ? root.nextPageUrl : null;
  return { series: zdfSeries(results), entries: zdfEntries(results), page, hasMore: root.nextPage === true && next !== null && results.length > 0, nextPageUrl: next };
}

/** Clustername einer Folgenliste: "Staffel N - alle verfügbaren Folgen", "Die restlichen verfügbaren Folgen", "<Reihe> - Staffel N". */
const EPISODE_CLUSTER = /staffel\s*\d+|verfügbaren\s+folgen|alle\s+folgen/i;

/**
 * Folgen einer Serie aus document/<brand-id>: Cluster der Staffeln (und namenlose Folgen-Cluster einer Themenreihe) mit
 * episode-Teasern inkl. Staffel/Folge; Extras (clip, Backstage), "Weitere Serien" und fremde Marken entfallen.
 */
function parseZdfEpisodes(root) {
  const doc = isObject(root.document) ? root.document : {};
  const ownId = doc.type === 'brand' ? nonEmpty(doc.id) : null;
  const teasers = [];
  for (const cluster of dicts(root.cluster)) {
    const name = nonEmpty(cluster.name);
    if (name ? !EPISODE_CLUSTER.test(name) : cluster.type !== 'teaser') continue;
    for (const item of dicts(cluster.teaser)) {
      if (item.contentType !== 'episode') continue;
      if (ownId && nonEmpty(item.brandId) && item.brandId !== ownId) continue;
      teasers.push(item);
    }
  }
  return zdfEntries(teasers, { numbers: true });
}

/**
 * Stream aus mediathekV2/document/<id> (document.formitaeten[]): HLS-Master vor MP4. Das Dokument ist ohne Token abrufbar;
 * geoLocation ist nur Hinweis, kein Sperrgrund. Ohne Formitäten aber mit fskCheck: Jugendschutz (Stream nur über getokente API).
 */
function parseZdfStream(root) {
  const doc = isObject(root.document) ? root.document : null;
  if (!doc) return { kind: 'unavailable' };
  const all = dicts(doc.formitaeten).filter(format => typeof format.url === 'string' && format.url.startsWith('http'));
  const formats = all.filter(format => format.class !== 'ad'); // jede Qualität gibt es doppelt (main/ad): Audiodeskription nicht als Standard
  const urlOf = match => nonEmpty((formats.find(format => match(String(format.type || ''))) || {}).url);
  const url = urlOf(type => type.includes('m3u8')) || urlOf(type => type.includes('mp4'));
  if (url) return { kind: 'playable', url };
  if (doc.fskCheck === true) return { kind: 'ageRestricted', rating: nonEmpty(doc.fsk) || 'FSK' };
  return { kind: 'unavailable' };
}

/**
 * Altersfreigabe aus mediathekV2/document/<id>: Suchtreffer tragen oft fsk "none", obwohl die Infozeile (videoInfo,
 * z. B. "88 min | FSK 12 | ...") eine Freigabe nennt. Vorrang hat die Infozeile, dann das Feld fsk; sonst null.
 */
function parseZdfFsk(root) {
  const doc = isObject(root.document) ? root.document : null;
  if (!doc) return null;
  const match = /FSK\s*(\d{1,2})/i.exec(String(doc.videoInfo || ''));
  return (match ? fskLevel(match[1]) : null) ?? fskLevel(doc.fsk);
}

module.exports = { zdfEntries, zdfSeries, zdfGenres, zdfDocumentUrl, isZdfDocumentUrl, isZdfSearchUrl, zdfSeasonEpisode, parseZdf, parseZdfSections, parseZdfSearchPage, parseZdfEpisodes, parseZdfStream, parseZdfFsk };
