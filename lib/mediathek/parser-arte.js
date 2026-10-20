'use strict';

// arte (Emac-API api.arte.tv/api/emac/v3/de/web): Teaser-Klassifikation, Genre-Seiten, Reihen mit Nachladen, Sammlungen
// (Serien) und Stream-Auflösung zum Abspielen. Reine Parser ohne Netz (Port von MediathekARTEParser.swift).
//
// Teaser-Arten (kind.code):
// - EXTERNAL: Weblink/Genre bzw. Unterthema; nur mit ermittelbarem Seitencode ein Genre, sonst verworfen (nie ein Eintrag).
// - Sammlungen (TV_SERIES, TOPIC, MAGAZINE, EVENT, programId "RC-..."): Serie.
// - alles Übrige mit programId (SHOW, BONUS, MANUAL_CLIP ...): abspielbarer Eintrag.

const { dicts, isObject, nonEmpty, number, isoDate, dedupe, makeEntry, makeSeries, makeSection } = require('./util.js');

const ARTE_BASE = 'https://api.arte.tv/api/emac/v3/de/web/';

/** Rückfall, wenn der Teaser keinen arte://emac/<CODE>-Deeplink trägt: URL-Slug -> Seitencode. */
const SLUG_CODES = {
  'aktuelles-und-gesellschaft': 'ACT',
  'dokumentationen-und-reportagen': 'DOR',
  'fernsehfilme-und-serien': 'SER',
  kino: 'CIN',
  sendungen: 'EMI',
  'entdeckung-der-welt': 'DEC',
  'kultur-und-pop': 'CPO',
  geschichte: 'HIS',
  wissenschaft: 'SCI',
  kunst: 'ART',
  'arte-concert': 'ARTE_CONCERT',
  'concert-konzerte-live-und-im-replay': 'ARTE_CONCERT',
};

function isValidArteCode(code) {
  return typeof code === 'string' && code.length > 0 && code.length <= 40 && /^[A-Za-z0-9_-]+$/.test(code);
}

/** Seitencode eines EXTERNAL-Teasers: Deeplink arte://emac/<CODE>, sonst URL-Slug (www.arte.tv). */
function arteGenreCode(deeplink, url) {
  if (typeof deeplink === 'string') {
    const at = deeplink.indexOf('arte://emac/');
    if (at >= 0) {
      const code = deeplink.slice(at + 'arte://emac/'.length).toUpperCase();
      if (isValidArteCode(code)) return code;
    }
  }
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'www.arte.tv') return null;
  const slug = parsed.pathname.split('/').filter(Boolean).pop();
  return (slug && SLUG_CODES[slug.toLowerCase()]) || null;
}

/** Emac-Seiten-URL zu einem Seitencode (Genre DOR, Sammlung RC-023814); null bei ungültigem Code. */
function arteGenrePageUrl(code) {
  return isValidArteCode(code) ? `${ARTE_BASE}pages/${code}/` : null;
}

/** Nur Nachlade-/Seiten-URLs der Emac-API (https, api.arte.tv, Pfad unter /api/emac/v3/de/web/). */
function isValidArteApiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.arte.tv' && url.pathname.startsWith('/api/emac/v3/de/web/');
  } catch {
    return false;
  }
}

function arteImage(resolutions) {
  const sorted = [...resolutions].sort((a, b) => (number(a.w) || 0) - (number(b.w) || 0));
  const pick = sorted.find(item => (number(item.w) || 0) >= 400) || sorted[sorted.length - 1];
  return pick && typeof pick.url === 'string' ? pick.url : null;
}

function landscapeImage(item) {
  const landscape = isObject(item.images) && isObject(item.images.landscape) ? item.images.landscape : null;
  return landscape && Array.isArray(landscape.resolutions) ? arteImage(dicts(landscape.resolutions)) : null;
}

/** Klassifiziert einen Teaser als { entry } | { series } | { genre }; null für nicht Darstellbares. */
function arteTeaser(item) {
  if (typeof item.type === 'string' && item.type !== 'teaser') return null;
  const title = nonEmpty(item.title);
  if (!title) return null;
  const kindObject = isObject(item.kind) ? item.kind : null;
  const kind = kindObject ? nonEmpty(kindObject.code) : null;
  const deeplink = nonEmpty(item.deeplink);
  const image = landscapeImage(item);

  if (kind === 'EXTERNAL') {
    const code = arteGenreCode(deeplink, nonEmpty(item.url));
    return code ? { genre: { id: code, title, imageUrl: image, sourceId: 'arte' } } : null;
  }

  const programId = nonEmpty(item.programId);
  let collectionCode = null;
  if (programId && programId.startsWith('RC-')) collectionCode = programId;
  else if (deeplink && deeplink.includes('arte://collection/')) collectionCode = deeplink.slice(deeplink.indexOf('arte://collection/') + 'arte://collection/'.length);
  if (collectionCode !== null || (kindObject && kindObject.isCollection === true)) {
    const pageUrl = collectionCode ? arteGenrePageUrl(collectionCode) : null;
    if (!collectionCode || !pageUrl) return null;
    return { series: makeSeries({ id: collectionCode, title, imageUrl: image, description: nonEmpty(item.shortDescription), sourceId: 'arte', groupingURL: pageUrl }) };
  }

  // Ohne kind (ältere Antworten/Suche) darf die Teaser-ID der Fallback sein; mit kind nur programId.
  const id = programId || (kind === null ? nonEmpty(item.id) : null);
  if (!id) return null;
  const availability = isObject(item.availability) ? item.availability : {};
  return {
    entry: makeEntry({
      id,
      title,
      subtitle: nonEmpty(item.subtitle),
      description: nonEmpty(item.shortDescription),
      imageUrl: image,
      duration: number(item.duration),
      sourceId: 'arte',
      airedAt: isoDate(availability.start),
      availableUntil: isoDate(availability.end),
    }),
  };
}

/** Teaser einer Zone/Seite getrennt nach Einträgen, Serien und Genres (Reihenfolge erhalten, ohne Dubletten). */
function arteContent(items) {
  const entries = [];
  const series = [];
  const genres = [];
  for (const item of items) {
    const classified = arteTeaser(item);
    if (!classified) continue;
    if (classified.entry) entries.push(classified.entry);
    else if (classified.series) series.push(classified.series);
    else genres.push(classified.genre);
  }
  return { entries: dedupe(entries), series: dedupe(series), genres: dedupe(genres) };
}

/** Suche: data[]; Home: zones[].data[]. Nur abspielbare Teaser (Sammlungen und Genre-Weblinks nie). */
function parseArte(root) {
  const items = dicts(root.data);
  for (const zone of dicts(root.zones)) items.push(...dicts(zone.data));
  return arteContent(items).entries;
}

const validNext = value => (typeof value === 'string' && isValidArteApiUrl(value) ? value : null);

/**
 * Zonen einer Home- oder Genre-Seite als Reihen. Genre-Kacheln liegen in eigenen Reihen; die Home-Zone der Genres heißt
 * "Genres" und steht ganz oben. Leere Zonen entfallen.
 */
function arteSections(root) {
  const sections = [];
  for (const zone of dicts(root.zones)) {
    let title = nonEmpty(zone.title);
    if (!title) continue;
    const content = arteContent(dicts(zone.data));
    if (!content.entries.length && !content.series.length && !content.genres.length) continue;
    if (isObject(zone.code) && zone.code.name === 'genres_HOME') title = 'Genres';
    sections.push(makeSection({ title, ...content, nextPage: validNext(zone.nextPage) }));
  }
  return [...sections.filter(section => section.title === 'Genres'), ...sections.filter(section => section.title !== 'Genres')];
}

/** Nachgeladene Reihe (data/MANUAL_TEASERS|VIDEO_LISTING|...): { data: [...], nextPage }. */
function parseArteMore(root, title) {
  return makeSection({ title, ...arteContent(dicts(root.data)), nextPage: validNext(root.nextPage) });
}

/** Suche: Sammlungen als Serien (nur Seite 0), Videos als Einträge; arte liefert nur eine Seite. */
function parseArteSearchPage(root) {
  const content = arteContent(dicts(root.data));
  return { series: content.series, entries: content.entries, page: 0, hasMore: false };
}

/**
 * Sammlungsseite (pages/RC-.../): Zonen collection_videos (Folgen) und collection_subcollection (Unterreihen/Staffeln)
 * mit Nachlade-URL. Hero- und Zusatzzonen bleiben außen vor.
 */
function parseArteCollection(root) {
  const zones = [];
  for (const zone of dicts(root.zones)) {
    const name = isObject(zone.code) ? zone.code.name : null;
    if (name !== 'collection_videos' && name !== 'collection_subcollection') continue;
    zones.push({ isSubcollection: name === 'collection_subcollection', entries: arteContent(dicts(zone.data)).entries, nextPage: validNext(zone.nextPage) });
  }
  return zones;
}

/**
 * Stream zum Abspielen aus api/player/v2/config/de/<programId>: nur HLS-Protokolle, deutsche Version (shortLabel DE) bevorzugt.
 * Kein streams (abgelaufen/gesperrt) -> unavailable; Jugendschutz (error.code ERROR_AGE_RESTRICTION_<n>) -> ageRestricted.
 */
function parseArteStream(root) {
  const attributes = isObject(root.data) && isObject(root.data.attributes) ? root.data.attributes : null;
  if (!attributes) return { kind: 'unavailable' };
  const hls = dicts(attributes.streams).filter(stream => typeof stream.protocol === 'string' && stream.protocol.includes('HLS') && nonEmpty(stream.url));
  const isGerman = stream => dicts(stream.versions).some(version => version.shortLabel === 'DE');
  const pick = hls.find(isGerman) || hls[0];
  if (pick) return { kind: 'playable', url: nonEmpty(pick.url) };
  const age = arteAgeRestriction(root);
  return age ? { kind: 'ageRestricted', rating: age.rating } : { kind: 'unavailable' };
}

/** Jugendschutz-Sperre der Player-Antwort: { rating: 'FSK16', timeSlot: { startDate, endDate }|null, message } oder null. */
function arteAgeRestriction(root) {
  const attributes = isObject(root.data) && isObject(root.data.attributes) ? root.data.attributes : {};
  const error = [attributes.error, root.error].find(isObject);
  const code = error ? nonEmpty(error.code) : null;
  const match = code ? /^ERROR_AGE_RESTRICTION_(\d+)$/.exec(code) : null;
  if (!match) return null;
  const restriction = isObject(attributes.restriction) ? attributes.restriction : {};
  const slot = isObject(restriction.timeSlot) ? restriction.timeSlot : null;
  return {
    rating: `FSK${match[1]}`,
    timeSlot: slot ? { startDate: isoDate(slot.startDate), endDate: isoDate(slot.endDate) } : null,
    message: nonEmpty(error.message),
  };
}

module.exports = {
  ARTE_BASE,
  arteTeaser,
  arteContent,
  arteSections,
  arteGenreCode,
  arteGenrePageUrl,
  isValidArteApiUrl,
  parseArte,
  parseArteMore,
  parseArteSearchPage,
  parseArteCollection,
  parseArteStream,
  arteAgeRestriction,
};
