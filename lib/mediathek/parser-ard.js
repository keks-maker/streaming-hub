'use strict';

// ARD-Mediathek (api.ardmediathek.de/page-gateway): Teaser (Folge oder Serie), Home-Abschnitte, Suche mit Paging,
// Serienfolgen und die Stream-Auflösung zum Abspielen. Reine Parser ohne Netz (Port von MediathekParser.swift).
//
// Home-Teaser-IDs ("<hash>:<zahl>") sind KEINE Item-IDs (item-Endpunkt -> HTTP 400): die abspielbare ID steht im Ziel-Link
// (links.target.href). Serien (/grouping/) haben keinen eigenen Stream und werden als Serie geliefert.

const { dicts, isObject, nonEmpty, number, isoDate, dedupe, makeEntry, makeSeries, makeSection } = require('./util.js');
const { mergeOriginalVersions, seasonEpisodeInTitle } = require('./entries.js');

const SKIPPED_TYPES = new Set(['live', 'channel', 'banner', 'external', 'editorialPage', 'compilation']);

function pathParts(href) {
  try {
    return new URL(href).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

/** Wert nach dem Segment key im Pfad (z. B. "item" -> Item-ID); null, wenn das Segment fehlt oder nichts folgt. */
function partAfter(href, key) {
  const parts = pathParts(href);
  const index = parts.indexOf(key);
  return index >= 0 && index + 1 < parts.length ? nonEmpty(parts[index + 1]) : null;
}

const ardGroupingId = href => partAfter(href, 'grouping');
const ardItemId = href => partAfter(href, 'item');
const ardPartner = href => partAfter(href, 'pages');

/** Grouping-Link mit embedded=true (sonst liefert die API nur ein Gerüst). */
function ardGroupingUrl(href) {
  try {
    const url = new URL(href);
    if (!url.searchParams.has('embedded')) url.searchParams.append('embedded', 'true');
    return url.toString();
  } catch {
    return href;
  }
}

function teaserImage(teaser) {
  const src = isObject(teaser.images) && isObject(teaser.images.aspect16x9) ? teaser.images.aspect16x9.src : null;
  return typeof src === 'string' ? src.replace('{width}', '480') : null;
}

/** Ein ARD-Teaser (Home/Suche/Grouping) als { entry } oder { series }; null für alles Übrige. */
function ardTeaser(teaser) {
  let id = nonEmpty(teaser.id);
  if (!id) return null;
  if (typeof teaser.type === 'string' && SKIPPED_TYPES.has(teaser.type)) return null;
  const title = nonEmpty(teaser.longTitle) || nonEmpty(teaser.mediumTitle) || nonEmpty(teaser.shortTitle);
  if (!title) return null;
  const image = teaserImage(teaser);
  let partner = null;
  const target = isObject(teaser.links) && isObject(teaser.links.target) ? teaser.links.target : null;
  const href = target && typeof target.href === 'string' ? target.href : null;
  if (href) {
    const groupingId = ardGroupingId(href);
    if (groupingId) {
      const imageTitle = isObject(teaser.images) && isObject(teaser.images.aspect16x9) ? nonEmpty(teaser.images.aspect16x9.title) : null;
      const description = nonEmpty(teaser.shortSynopsis) || nonEmpty(teaser.synopsis) || imageTitle;
      return { series: makeSeries({ id: groupingId, title, imageUrl: image, description: description === title ? null : description, sourceId: 'ard', groupingURL: ardGroupingUrl(href) }) };
    }
    const itemId = ardItemId(href);
    if (!itemId) return null;
    id = itemId;
    partner = ardPartner(href);
  } else if (teaser.type === 'show') {
    return null; // Serie ohne Link: kein Ziel
  }
  const service = isObject(teaser.publicationService) ? nonEmpty(teaser.publicationService.name) : null;
  const seasonEpisode = seasonEpisodeInTitle(title);
  return {
    entry: makeEntry({
      id,
      title,
      subtitle: service,
      imageUrl: image,
      duration: number(teaser.duration),
      sourceId: 'ard',
      airedAt: isoDate(teaser.broadcastedOn),
      partner,
      season: seasonEpisode ? seasonEpisode.season : null,
      episode: seasonEpisode ? seasonEpisode.episode : null,
      availableUntil: isoDate(teaser.availableTo),
    }),
  };
}

const entriesOf = teasers => teasers.map(ardTeaser).filter(item => item && item.entry).map(item => item.entry);

function ardTeasers(root) {
  const teasers = [...dicts(root.vodResults), ...dicts(root.showResults)];
  for (const widget of dicts(root.widgets)) teasers.push(...dicts(widget.teasers));
  return teasers;
}

/** Home: widgets[].teasers[]; Suche: vodResults[] (Serien in showResults[] entfallen hier, siehe parseArdSearchPage). */
function parseArd(root) {
  return mergeOriginalVersions(dedupe(entriesOf(ardTeasers(root))));
}

/** Suchseite: showResults (nur Seite 0) als Serien, vodResults als Folgen (OV zusammengefasst). vodPageNumber ist 0-basiert. */
function parseArdSearchPage(root, page = 0) {
  const series = [];
  const seen = new Set();
  if (page === 0) {
    for (const teaser of dicts(root.showResults)) {
      const item = ardTeaser(teaser);
      if (item && item.series && !seen.has(item.series.id)) {
        seen.add(item.series.id);
        series.push(item.series);
      }
    }
  }
  const size = Math.trunc(number(root.vodPageSize) || 0);
  const total = Math.trunc(number(root.vodTotal) || 0);
  return { series, entries: mergeOriginalVersions(dedupe(entriesOf(dicts(root.vodResults)))), page, hasMore: size > 0 && (page + 1) * size < total };
}

/** Folgen einer Serie aus pages/<partner>/grouping/<id>; ohne Trailer/Bonus (coreAssetType EXTRA_*), OV zusammengefasst. */
function parseArdGrouping(root) {
  const entries = [];
  for (const widget of dicts(root.widgets)) {
    for (const teaser of dicts(widget.teasers)) {
      if (typeof teaser.coreAssetType === 'string' && teaser.coreAssetType.startsWith('EXTRA_')) continue;
      const item = ardTeaser(teaser);
      if (item && item.entry) entries.push(item.entry);
    }
  }
  return mergeOriginalVersions(dedupe(entries));
}

/** Home-Abschnitte: je Widget mit Titel eine Reihe aus Folgen und Serien; leere Reihen entfallen. */
function parseArdSections(root) {
  const sections = [];
  for (const widget of dicts(root.widgets)) {
    const title = nonEmpty(widget.title);
    if (!title) continue;
    let entries = [];
    let series = [];
    for (const teaser of dicts(widget.teasers)) {
      const item = ardTeaser(teaser);
      if (!item) continue;
      if (item.entry) entries.push(item.entry);
      else series.push(item.series);
    }
    entries = mergeOriginalVersions(dedupe(entries));
    series = dedupe(series);
    if (entries.length || series.length) sections.push(makeSection({ title, entries, series }));
  }
  return sections;
}

function normalizeScheme(url) {
  return url.startsWith('//') ? `https:${url}` : url;
}

/** true, wenn die Tonspur des Medien-Eintrags die Standardspur ist (audios[0].kind); ohne Angabe gilt sie als Standard. */
function isStandardAudio(media) {
  const audios = dicts(media.audios);
  return audios.length === 0 || audios[0].kind === undefined || audios[0].kind === 'standard';
}

/** Medien-Einträge der Hauptstreams (kind main, keine Gebärdensprache). */
function mainMedia(embedded) {
  const media = [];
  for (const stream of dicts(embedded && embedded.streams)) {
    if ((typeof stream.kind === 'string' ? stream.kind : 'main') === 'main') media.push(...dicts(stream.media));
  }
  return media;
}

/**
 * Stream zum Abspielen aus pages/<partner>/item/<id>: nur Hauptstream mit Standardton (die Reihenfolge der media[]-Einträge ist
 * nicht stabil, bei Kindersendungen kam die Audiodeskription zuerst), HLS vor progressivem MP4.
 * isGeoBlocked heißt bei ARD nur "regional beschränkt": Streams werden trotzdem gelesen, geoBlocked nur ohne Stream.
 * Ergebnis: { resolution: { kind: 'playable'|'geoBlocked'|'ageRestricted'|'unavailable', url?, rating? }, regionRestricted }.
 */
function parseArdStreamDetail(root) {
  let geoBlocked = false;
  let fskRating = null;
  for (const widget of dicts(root.widgets)) {
    if (widget.blockedByFsk === true) fskRating = nonEmpty(widget.maturityContentRating) || nonEmpty(root.fskRating) || 'FSK';
    const collection = isObject(widget.mediaCollection) ? widget.mediaCollection : null;
    const embedded = collection && isObject(collection.embedded) ? collection.embedded : null;
    const flagged = Boolean(embedded) && embedded.isGeoBlocked === true;
    if (flagged) geoBlocked = true;
    const all = mainMedia(embedded);
    const standard = all.filter(isStandardAudio);
    const media = standard.length ? standard : all;
    const urlOf = mime => nonEmpty((media.find(item => item.mimeType === mime) || {}).url);
    const url = urlOf('application/vnd.apple.mpegurl') || urlOf('video/mp4');
    if (url) return { resolution: { kind: 'playable', url: normalizeScheme(url) }, regionRestricted: flagged };
  }
  if (fskRating) return { resolution: { kind: 'ageRestricted', rating: fskRating }, regionRestricted: false };
  return { resolution: { kind: geoBlocked ? 'geoBlocked' : 'unavailable' }, regionRestricted: false };
}

module.exports = {
  ardTeaser,
  parseArd,
  parseArdSearchPage,
  parseArdGrouping,
  parseArdSections,
  parseArdStreamDetail,
  ardItemId,
  ardGroupingId,
  ardPartner,
  ardGroupingUrl,
  mainMedia,
  isStandardAudio,
  normalizeScheme,
};
