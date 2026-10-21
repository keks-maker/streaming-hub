'use strict';

// ZDF-Mediathek (zdf-prod-futura.zdf.de/mediathekV2): Teaser (nur einzelne Videos), Home-Abschnitte und Stream-Auflösung
// zum Abspielen. Reine Parser ohne Netz (Port von MediathekParser.swift).

const { dicts, isObject, nonEmpty, number, fskLevel, isoDate, dedupe, makeEntry, makeSection } = require('./util.js');
const { mergeOriginalVersions } = require('./entries.js');
const { isValidGenreId } = require('./genre-pages.js');

function zdfImage(images) {
  if (!isObject(images)) return null;
  for (const key of ['768', '640', '960', '600', '1280']) {
    const url = isObject(images[key]) ? images[key].url : null;
    if (typeof url === 'string' && url) return url;
  }
  for (const value of Object.values(images)) if (isObject(value) && typeof value.url === 'string') return value.url;
  return null;
}

/** Teaser als Einträge. Nur einzelne Videos (episode/clip); brand/topic/category/livevideo/news sind Sammlungen ohne eigenen Stream. */
function zdfEntries(items) {
  const entries = [];
  for (const item of items) {
    if (item.hasVideo === false) continue;
    if (!(item.type === 'video' || item.contentType === 'episode' || item.contentType === 'clip')) continue;
    // Dokument-ID (id), nicht videoId: nur sie löst mediathekV2/document/<id> auf.
    const id = nonEmpty(item.id);
    const title = nonEmpty(item.titel) || nonEmpty(item.headline);
    if (!id || !title) continue;
    const brand = nonEmpty(item.brandTitle);
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
        fsk: item.fsk,
      })
    );
  }
  return mergeOriginalVersions(dedupe(entries));
}

/** Home: stage[] + cluster[].teaser[]; Suche: results[]. */
function parseZdf(root) {
  const items = [...dicts(root.results), ...dicts(root.stage)];
  for (const cluster of dicts(root.cluster)) items.push(...dicts(cluster.teaser));
  return zdfEntries(items);
}

const RUBRICS_TITLE = 'Rubriken';

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

/**
 * Abschnitte: "Empfohlen" (stage) und je Cluster eine Reihe; leere entfallen. Startseite: der Cluster "Rubriken" ist die
 * Kachel-Reihe der Rubriken (steht zuerst). Rubrikseite (options.page, document/<rubrik-id>): Unterrubriken ("category"-Teaser)
 * werden Kacheln in der jeweiligen Reihe (ohne die Rubrik selbst). Ein Cluster ohne Teaser (nur Empfehlungs-Verweis) entfällt.
 */
function parseZdfSections(root, { page = false } = {}) {
  const sections = [];
  const selfId = page && isObject(root.document) ? nonEmpty(root.document.id) : null;
  const stage = zdfEntries(dicts(root.stage));
  if (stage.length) sections.push(makeSection({ title: 'Empfohlen', entries: stage }));
  for (const cluster of dicts(root.cluster)) {
    const name = nonEmpty(cluster.name);
    if (!name) continue;
    const teasers = dicts(cluster.teaser);
    const entries = zdfEntries(teasers);
    const genres = page || name === RUBRICS_TITLE ? zdfGenres(teasers, selfId) : [];
    if (entries.length || genres.length) sections.push(makeSection({ title: name, entries, genres }));
  }
  const isRubrics = section => section.title === RUBRICS_TITLE && section.genres.length > 0;
  return [...sections.filter(isRubrics), ...sections.filter(section => !isRubrics(section))];
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

module.exports = { zdfEntries, zdfGenres, parseZdf, parseZdfSections, parseZdfStream, parseZdfFsk };
