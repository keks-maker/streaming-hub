'use strict';

// Reine Aufbereitung der Stream-Info-Antworten für Downloads (Spike-Bericht docs/mediathek-spike-ergebnis.md): je Quelle
// Qualitätsstufen, Tonspuren, Untertitel, Sperren, "verfügbar bis" sowie Staffel/Folge/Sendedatum. Kein Netz; das Laden der
// arte-HLS-Master übernimmt der Service (service.js), hier kommen die geparsten Master als Eingabe.
//
// Ergebnisform (alle Quellen):
// { variants: [{ id, kind: 'progressive'|'hls', url, width, height, bitrate, codec, label }],
//   audioTracks: [{ id, kind: 'main'|'audio-description'|'clear-speech'|'original', language, label, isDefault, url, hlsUrl, uri, groupId }],
//   subtitles: [{ id, language, label, url, format: 'webvtt', kind: 'normal'|'hearing-impaired'|'forced' }],
//   restriction: null | { code: 'geo'|'age'|'unsupported'|'unavailable', message, rating?, window?, retryAt? },
//   availableUntil: ISO|null, season: Zahl|null, episode: Zahl|null, broadcastDate: 'YYYY-MM-DD'|null, seriesTitle, title, durationSeconds, isExtra }
// Variants gelten für die Standardspur; getrennte Tonspuren (ARD/ZDF: eigene Datei je Tonvariante) tragen ihre Adresse in url/hlsUrl,
// arte-Tonspuren sind EXT-X-MEDIA-Einträge (uri) desselben Masters.
// Nur WebVTT-Untertitel: ffmpeg liest TTML/EBU-TT-D nicht (Spike §3).

const { dicts, isObject, nonEmpty, number, isoDate, berlinDay } = require('./util.js');
const { seasonEpisodeInTitle } = require('./entries.js');
const { ageRestrictedMessage, fskWindow } = require('./restrictions.js');
const { mainMedia, normalizeScheme } = require('./parser-ard.js');
const { arteAgeRestriction } = require('./parser-arte.js');
const { sortVariants } = require('./hls-master.js');

const ZDF_FSK_UNSUPPORTED = 'Beiträge mit Jugendschutz-Prüfung (FSK) sind beim ZDF nur mit Zugangs-Token abrufbar und können nicht geladen werden.';

function baseInfo(entry) {
  return {
    variants: [],
    audioTracks: [],
    subtitles: [],
    restriction: null,
    availableUntil: entry.availableUntil || null,
    season: entry.season ?? null,
    episode: entry.episode ?? null,
    broadcastDate: berlinDay(entry.airedAt) || null,
    seriesTitle: null,
    title: entry.title || null,
    durationSeconds: entry.duration ?? null,
    isExtra: false,
  };
}

function ageRestriction(rating, retryAt = null) {
  return { code: 'age', rating, window: fskWindow(rating), message: ageRestrictedMessage(rating), retryAt };
}

/** Berlin-Ortszeit (Tag, Monat, Jahr, Stunde, Minute) als ISO-UTC-Zeitpunkt (Sommer-/Winterzeit über Intl). */
function berlinLocalToIso(day, month, year, hour = 0, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess));
  const get = type => Number(parts.find(part => part.type === type).value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (local - guess)).toISOString();
}

/** "19.03.2026 01:00" (deutsch formatiert) -> { iso, day: '2026-03-19' }; null bei anderem Format. */
function germanDateTime(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return null;
  const [day, month, year, hour, minute] = match.slice(1).map(part => (part === undefined ? 0 : Number(part)));
  return { iso: berlinLocalToIso(day, month, year, hour, minute), day: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

// ── ARD ──

const ARD_AUDIO_KINDS = { standard: 'main', 'audio-description': 'audio-description', 'speech-optimized': 'clear-speech' };
const ARD_AUDIO_LABELS = { main: 'Standard', 'audio-description': 'Audiodeskription', 'clear-speech': 'Klare Sprache' };

function ardAudioKind(media) {
  const audios = dicts(media.audios);
  const kind = audios.length ? audios[0].kind : 'standard';
  return ARD_AUDIO_KINDS[kind === undefined ? 'standard' : kind] || null; // unbekannte Ton-Arten (z. B. Gebärdensprache) entfallen
}

function ardSubtitles(embedded) {
  const subtitles = [];
  for (const [index, subtitle] of dicts(embedded && embedded.subtitles).entries()) {
    const source = dicts(subtitle.sources).find(item => item.kind === 'webvtt' && nonEmpty(item.url));
    if (!source) continue; // TTML/EBU-TT-D wird nicht gelesen
    const language = nonEmpty(subtitle.languageCode) || 'de';
    const hearing = subtitle.kind === 'closed-captions';
    subtitles.push({ id: `ard-sub-${index}`, language, label: hearing ? 'Untertitel für Hörgeschädigte' : 'Untertitel', url: source.url, format: 'webvtt', kind: hearing ? 'hearing-impaired' : 'normal' });
  }
  return subtitles;
}

/** Download-Info aus pages/<partner>/item/<id> (ARD): nur Hauptstreams, Tonvarianten nach audios[0].kind getrennt. */
function ardDownloadInfo(root, entry) {
  const info = baseInfo(entry);
  const widgets = dicts(root.widgets);
  const widget = widgets.find(item => item.type === 'player_ondemand') || widgets.find(item => isObject(item.mediaCollection)) || widgets[0] || {};
  const meta = isObject(widget.meta) ? widget.meta : isObject(root.meta) ? root.meta : {};
  const collection = isObject(widget.mediaCollection) ? widget.mediaCollection : null;
  const embedded = collection && isObject(collection.embedded) ? collection.embedded : null;

  const title = nonEmpty(widget.title) || nonEmpty(meta.title);
  if (title) info.title = title;
  info.seriesTitle = nonEmpty(meta.seriesTitle) || (isObject(widget.show) ? nonEmpty(widget.show.title) : null);
  info.availableUntil = isoDate(widget.availableTo) || isoDate(meta.availableToDateTime) || info.availableUntil;
  info.broadcastDate = berlinDay(widget.broadcastedOn) || berlinDay(meta.broadcastedOnDateTime) || info.broadcastDate;
  info.durationSeconds = number(meta.durationSeconds) ?? info.durationSeconds;
  const parsedTitle = seasonEpisodeInTitle(title || entry.title);
  if (parsedTitle) {
    info.season = info.season ?? parsedTitle.season;
    info.episode = info.episode ?? parsedTitle.episode;
  }

  const byKind = new Map();
  for (const media of mainMedia(embedded)) {
    const kind = ardAudioKind(media);
    if (!kind || !nonEmpty(media.url)) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(media);
  }
  const mp4Best = list => list.filter(item => item.mimeType === 'video/mp4').sort((a, b) => (number(b.maxVResolutionPx) || 0) - (number(a.maxVResolutionPx) || 0))[0];
  const hlsOf = list => list.find(item => item.mimeType === 'application/vnd.apple.mpegurl');
  for (const [kind, list] of byKind) {
    const mp4 = mp4Best(list);
    const hls = hlsOf(list);
    const audios = dicts(list[0].audios);
    info.audioTracks.push({
      id: `ard-${kind}`,
      kind,
      language: (audios[0] && nonEmpty(audios[0].languageCode)) || 'deu',
      label: ARD_AUDIO_LABELS[kind],
      isDefault: kind === 'main',
      url: mp4 ? normalizeScheme(mp4.url) : null,
      hlsUrl: hls ? normalizeScheme(hls.url) : null,
      uri: null,
      groupId: null,
    });
  }
  info.audioTracks.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const standard = byKind.get('main') || [];
  const progressive = standard
    .filter(item => item.mimeType === 'video/mp4')
    .map(item => ({ item, height: number(item.maxVResolutionPx) }))
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  for (const { item, height } of progressive) {
    info.variants.push({ id: `ard-mp4-${height || 'x'}`, kind: 'progressive', url: normalizeScheme(item.url), width: number(item.maxHResolutionPx), height, bitrate: null, codec: /265|hevc/i.test(item.videoCodec || '') ? 'h265' : 'h264', label: nonEmpty(item.forcedLabel) });
  }
  const hls = hlsOf(standard);
  if (hls) info.variants.push({ id: 'ard-hls', kind: 'hls', url: normalizeScheme(hls.url), width: null, height: null, bitrate: null, codec: 'h264', label: 'Auto' });
  info.subtitles = ardSubtitles(embedded);

  if (!info.variants.length && !info.audioTracks.some(track => track.url || track.hlsUrl)) {
    const fsk = widgets.find(item => item.blockedByFsk === true);
    if (fsk) info.restriction = ageRestriction(nonEmpty(fsk.maturityContentRating) || nonEmpty(root.fskRating) || 'FSK');
    else if (embedded && embedded.isGeoBlocked === true) info.restriction = { code: 'geo', message: 'Dieser Beitrag ist in deiner Region nicht abrufbar (Geoblock).' };
    else info.restriction = { code: 'unavailable', message: 'Stream nicht verfügbar (abgelaufen oder vom Anbieter gesperrt).' };
  }
  return info;
}

// ── ZDF ──

/** Qualitätsstufe -> (ungefähre) Bildhöhe; die API nennt nur quality, die Höhe steht nicht im Feld (Spike §1). */
const ZDF_QUALITY_HEIGHT = { low: 270, med: 360, high: 480, veryhigh: 576, hd: 720, fhd: 1080, uhd: 2160 };

function zdfBitrate(url) {
  const match = /_(\d+)k_/.exec(String(url));
  return match ? Number(match[1]) * 1000 : null;
}

function zdfVariant(format) {
  const quality = String(format.quality || '');
  const height = ZDF_QUALITY_HEIGHT[quality] || null;
  const type = String(format.type || '');
  const hls = type.includes('m3u8');
  return {
    id: `zdf-${hls ? 'hls' : 'mp4'}-${quality || 'x'}-${/h265/.test(type) ? 'h265' : 'h264'}`,
    kind: hls ? 'hls' : 'progressive',
    url: format.url,
    width: height ? Math.round((height * 16) / 9 / 2) * 2 : null,
    height,
    bitrate: zdfBitrate(format.url),
    codec: /h265/.test(type) ? 'h265' : 'h264',
    label: quality || null,
  };
}

/** Download-Info aus mediathekV2/document/<id> (ZDF): formitaeten class main/ad, captions (WebVTT). */
function zdfDownloadInfo(root, entry) {
  const info = baseInfo(entry);
  const doc = isObject(root.document) ? root.document : {};
  info.title = nonEmpty(doc.titel) || nonEmpty(doc.title) || info.title;
  info.seriesTitle = nonEmpty(doc.brandTitle);
  info.durationSeconds = number(doc.length) ?? info.durationSeconds;
  const until = isoDate(doc.offlineAvailability);
  const timeToLive = germanDateTime(doc.timetolive);
  info.availableUntil = until || (timeToLive && timeToLive.iso) || info.availableUntil;
  const airtime = germanDateTime(doc.airtime);
  info.broadcastDate = (airtime && airtime.day) || berlinDay(doc.date) || info.broadcastDate;
  // seasonNumber > 1900 ist ein Jahr (Magazine): keine Staffel; Zweiteiler tragen teils dieselbe Folgennummer
  const season = Number.parseInt(doc.seasonNumber, 10);
  const episode = Number.parseInt(doc.episodeNumber, 10);
  if (Number.isInteger(season) && season > 0 && season <= 1900) {
    info.season = season;
    info.episode = Number.isInteger(episode) && episode > 0 ? episode : info.episode;
  }
  info.isExtra = doc.contentType === 'clip'; // Extras (Clips) gehören nicht zur Folgenliste

  const formats = dicts(doc.formitaeten).filter(format => typeof format.url === 'string' && format.url.startsWith('http'));
  const seen = new Set();
  const mainVariants = [];
  const adVariants = [];
  for (const format of formats) {
    const variant = zdfVariant(format);
    const target = format.class === 'ad' ? adVariants : mainVariants;
    const key = `${variant.id}`;
    if (seen.has(`${format.class}|${key}`)) continue; // zweiter Mirror-Host derselben Stufe
    seen.add(`${format.class}|${key}`);
    target.push(variant);
  }
  const byHeight = (a, b) => (b.height || 0) - (a.height || 0) || (a.kind === 'progressive' ? -1 : 1);
  info.variants = mainVariants.sort(byHeight);
  const bestMp4 = list => list.filter(variant => variant.kind === 'progressive' && variant.codec === 'h264').sort(byHeight)[0] || list.find(variant => variant.kind === 'progressive');
  const hlsOf = list => list.find(variant => variant.kind === 'hls' && /auto/.test(variant.id));
  if (mainVariants.length) {
    const language = nonEmpty((formats.find(format => format.class !== 'ad') || {}).language) || 'deu';
    info.audioTracks.push({ id: 'zdf-main', kind: 'main', language, label: 'TV Ton', isDefault: true, url: (bestMp4(mainVariants) || {}).url || null, hlsUrl: (hlsOf(mainVariants) || {}).url || null, uri: null, groupId: null });
  }
  if (adVariants.length) {
    const language = nonEmpty((formats.find(format => format.class === 'ad') || {}).language) || 'deu';
    info.audioTracks.push({ id: 'zdf-ad', kind: 'audio-description', language, label: 'Audiodeskription', isDefault: false, url: (bestMp4(adVariants) || {}).url || null, hlsUrl: (hlsOf(adVariants) || {}).url || null, uri: null, groupId: null });
  }
  for (const [index, caption] of dicts(doc.captions).entries()) {
    if (!/webvtt/i.test(String(caption.format || '')) || !nonEmpty(caption.uri)) continue; // TTML (ebu-tt-d) wird ignoriert
    info.subtitles.push({ id: `zdf-sub-${index}`, language: nonEmpty(caption.language) || 'deu', label: 'Untertitel für Hörgeschädigte', url: caption.uri, format: 'webvtt', kind: 'hearing-impaired' });
  }

  if (!mainVariants.length) {
    if (doc.fskCheck === true) {
      const rating = nonEmpty(doc.fsk) || 'FSK';
      info.restriction = { code: 'unsupported', message: ZDF_FSK_UNSUPPORTED, rating, window: fskWindow(rating) };
    } else {
      info.restriction = { code: 'unavailable', message: 'Stream nicht verfügbar (abgelaufen oder vom Anbieter gesperrt).' };
    }
  }
  return info;
}

// ── arte ──

function arteAudioKind(medium) {
  const text = `${medium.name} ${medium.characteristics}`;
  if (/describes-video|audiodeskription|audiodescription/i.test(text)) return 'audio-description';
  if (/enhances-speech|klare sprache/i.test(text)) return 'clear-speech';
  const version = /tv\.arte\.audio\.version\.([A-Za-z]+)/.exec(medium.characteristics);
  if (version && /^VO/i.test(version[1])) return 'original';
  return 'main';
}

function arteSubtitleKind(medium) {
  if (medium.forced) return 'forced';
  if (/transcribes-spoken-dialog/i.test(medium.characteristics) && /describes-music-and-sound/i.test(medium.characteristics)) return 'hearing-impaired';
  return 'normal';
}

/** Streams der Player-Antwort, die als HLS-Master geladen werden sollen: [{ url, versions }] (deutsche Version zuerst). */
function arteMasterStreams(root) {
  const attributes = isObject(root.data) && isObject(root.data.attributes) ? root.data.attributes : {};
  const hls = dicts(attributes.streams).filter(stream => typeof stream.protocol === 'string' && stream.protocol.includes('HLS') && nonEmpty(stream.url));
  const isGerman = stream => dicts(stream.versions).some(version => version.shortLabel === 'DE');
  return [...hls.filter(isGerman), ...hls.filter(stream => !isGerman(stream))].map(stream => ({ url: stream.url, versions: dicts(stream.versions) }));
}

/**
 * Download-Info aus der arte-Player-Antwort. masters: geparste HLS-Master zu arteMasterStreams (gleiche Reihenfolge,
 * Einträge null bei Ladefehler); der erste liefert die Videovarianten, alle zusammen Tonspuren und Untertitel.
 */
function arteDownloadInfo(root, entry, masters = []) {
  const info = baseInfo(entry);
  const attributes = isObject(root.data) && isObject(root.data.attributes) ? root.data.attributes : {};
  const metadata = isObject(attributes.metadata) ? attributes.metadata : {};
  const rights = isObject(attributes.rights) ? attributes.rights : {};
  info.title = nonEmpty(metadata.title) || info.title;
  info.seriesTitle = nonEmpty(metadata.title);
  info.durationSeconds = number(isObject(metadata.duration) ? metadata.duration.seconds : null) ?? info.durationSeconds;
  info.availableUntil = isoDate(rights.end) || info.availableUntil;
  info.broadcastDate = berlinDay(rights.begin) || info.broadcastDate;
  const label = `${nonEmpty(metadata.subtitle) || ''} ${nonEmpty(metadata.title) || ''} ${entry.title || ''}`;
  const episode = /\((\d+)\/\d+\)/.exec(label);
  if (info.episode === null && episode) info.episode = Number(episode[1]);
  const season = /Staffel\s+(\d+)/i.exec(label);
  if (info.season === null && season) info.season = Number(season[1]);

  const streams = arteMasterStreams(root);
  const loaded = masters.filter(Boolean);
  if (loaded.some(master => master.parsed.encrypted)) {
    info.restriction = { code: 'unsupported', message: 'Dieser Stream ist verschlüsselt (DRM) und kann nicht geladen werden.' };
    return info;
  }
  masters.forEach((master, streamIndex) => {
    if (!master) return;
    const { parsed } = master;
    if (streamIndex === 0) {
      info.variants = sortVariants(parsed.variants).map(variant => ({
        id: `arte-${variant.height || 'x'}-${variant.codec || 'x'}-${variant.bandwidth}`,
        kind: 'hls',
        url: variant.uri,
        width: variant.width,
        height: variant.height,
        bitrate: variant.averageBandwidth || variant.bandwidth || null,
        codec: variant.codec,
        label: variant.height ? `${variant.height}p` : null,
        audioGroup: variant.audio,
      }));
    }
    for (const [index, medium] of parsed.media.entries()) {
      if (medium.type === 'AUDIO') {
        info.audioTracks.push({ id: `arte-${streamIndex}-a${index}`, kind: arteAudioKind(medium), language: medium.language, label: medium.name, isDefault: medium.isDefault && streamIndex === 0, url: null, hlsUrl: null, uri: medium.uri, groupId: medium.groupId });
      } else if (medium.type === 'SUBTITLES' && medium.uri) {
        info.subtitles.push({ id: `arte-${streamIndex}-s${index}`, language: medium.language, label: medium.name, url: medium.uri, format: 'webvtt', kind: arteSubtitleKind(medium) });
      }
    }
  });

  if (!info.variants.length) {
    const age = arteAgeRestriction(root);
    const restriction = isObject(attributes.restriction) ? attributes.restriction : {};
    const geoblocking = isObject(restriction.geoblocking) ? restriction.geoblocking : null;
    if (age) {
      info.restriction = ageRestriction(age.rating, age.timeSlot && age.timeSlot.startDate);
      if (age.message) info.restriction.detail = age.message;
    } else if (geoblocking && geoblocking.restrictedArea) {
      info.restriction = { code: 'geo', message: 'Dieser Beitrag ist in deiner Region nicht abrufbar (Geoblock).' };
    } else {
      info.restriction = { code: 'unavailable', message: streams.length ? 'Der Stream konnte nicht geladen werden.' : 'Stream nicht verfügbar (abgelaufen oder vom Anbieter gesperrt).' };
    }
  }
  return info;
}

module.exports = { ardDownloadInfo, zdfDownloadInfo, arteDownloadInfo, arteMasterStreams, germanDateTime, berlinLocalToIso, ZDF_QUALITY_HEIGHT };
