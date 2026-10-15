'use strict';

// Defensiver RSS-Parser für Podcast-Feeds (Konzept §12, Spike P0), ohne Abhängigkeit und ohne DOM.
// - Kein XXE/Entity-Expansion: DOCTYPE wird verworfen, benutzerdefinierte Entities werden nie aufgelöst
//   (nur die fünf XML-Standard-Entities und numerische Zeichen); externe Ressourcen werden nie geladen.
// - Nur audio/*-Enclosures (Video-Podcasts werden verworfen), `length` wird ignoriert.
// - Episoden-ID = guid; fehlende oder doppelte guid -> Hash der Enclosure-URL; Duplikate werden zusammengefasst.
// - Texte werden zu reinem Text bereinigt (kein HTML), mit Längenlimit. Feed-Größe max. 20 MB, Episoden max. 200.

const { episodeIdFromEnclosure } = require('./podcast-ids.js');
const { normalizeChapters } = require('./chapters.js');

const MAX_FEED_CHARS = 20 * 1024 * 1024;
const MAX_EPISODES = 200;
const MAX_RAW_ITEMS = 5000; // Obergrenze der überhaupt geparsten Items (größter gemessener Feed: 2191)
const MAX_NOTES_CHARS = 20000; // Shownotes je Episode
const MAX_DURATION_SECONDS = 48 * 3600;
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/i;

// XML-Standard-Entities plus die in Shownotes üblichen HTML-Namen (nur Zeichen, nie Markup); alles andere entfällt
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', euro: '€', copy: '©', szlig: 'ß',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{0,31});/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      try {
        return code === 0 ? '' : String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    const known = Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : NAMED_ENTITIES[entity.toLowerCase()];
    return known === undefined ? '' : known; // unbekannte/eigene Entities nie auflösen
  });
}

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Link <a href="https://x">Text</a> -> "Text (https://x)" (nur http/https; Text, der die Adresse schon enthält, bleibt). */
function anchorToText(html) {
  return html.replace(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (match, dq, sq, inner) => {
    const href = decodeEntities(dq !== undefined ? dq : sq).trim();
    const label = inner.replace(/<[^>]*>/g, '').trim();
    if (!/^https?:\/\//i.test(href) || href.length > 500) return label;
    return !label || label.includes(href) ? href : `${label} (${href})`;
  });
}

/**
 * Rohinhalt eines Elements (evtl. CDATA/HTML) -> reiner Text, höchstens max Zeichen. Mit options.notes (Shownotes) bleiben
 * Absätze (Leerzeile), Listenpunkte ("• ") und Linkadressen (als Text in Klammern) erhalten; es entsteht nie HTML.
 */
function cleanText(raw, max = 2000, { notes = false } = {}) {
  if (raw === null || raw === undefined) return '';
  let value = String(raw);
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  value = cdata ? cdata[1] : decodeEntities(value);
  if (/<\/?[a-z][^>]*>/i.test(value)) {
    value = value.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '');
    if (notes) {
      value = anchorToText(value)
        .replace(/<(?:ul|ol)(?:\s[^>]*)?>/gi, '\n')
        .replace(/<li(?:\s[^>]*)?>/gi, '• ')
        .replace(/<br\s*\/?>|<\/li>/gi, '\n')
        .replace(/<\/(?:p|div|h[1-6]|ul|ol|blockquote)>/gi, '\n\n');
    } else {
      value = value.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n');
    }
    value = value.replace(/<[^>]*>/g, '');
    value = decodeEntities(value);
  }
  value = value
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
}

/** Rohinhalt des ersten Elements <name> (mit Namensraum-Präfix), sonst null. */
function elementRaw(block, name) {
  const n = escapeRegExp(name);
  const match = new RegExp(`<${n}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${n}\\s*>)`, 'i').exec(block);
  return match ? (match[1] === undefined ? '' : match[1]) : null;
}

/** Attribute des ersten Elements <name ...> als Objekt (Schlüssel klein), sonst null. */
function elementAttrs(block, name) {
  const match = new RegExp(`<${escapeRegExp(name)}(\\s[^>]*?)?/?>`, 'i').exec(block);
  if (!match) return null;
  const attrs = {};
  for (const a of (match[1] || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[a[1].toLowerCase()] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
  }
  return attrs;
}

function httpUrlOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** "H:MM:SS", "MM:SS", "SS", "SS.fff", "PT1H2M3S" -> ganze Sekunden, sonst null. */
function parseDuration(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let seconds = null;
  const iso = /^P?T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    seconds = Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0);
  } else if (/^\d+(?:[.,]\d+)?$/.test(s)) {
    seconds = Number(s.replace(',', '.'));
  } else if (/^\d{1,3}(?::\d{1,2}){1,2}(?:[.,]\d+)?$/.test(s)) {
    const parts = s.replace(',', '.').split(':').map(Number);
    seconds = parts.reduce((total, part) => total * 60 + part, 0);
  }
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DURATION_SECONDS) return null;
  return Math.round(seconds);
}

function parseDate(value) {
  const time = Date.parse(cleanText(value, 100));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function audioEnclosure(block) {
  const re = /<enclosure(\s[^>]*?)?\/?>/gi;
  for (let match = re.exec(block); match; match = re.exec(block)) {
    const attrs = elementAttrs(match[0], 'enclosure');
    const url = attrs && httpUrlOrNull(attrs.url);
    if (!url) continue;
    const type = (attrs.type || '').trim().toLowerCase();
    if (type ? type.startsWith('audio/') : AUDIO_EXTENSIONS.test(url)) return { url, type: type || null };
  }
  return null;
}

function parseChannel(head) {
  const withoutImage = head.replace(/<image(?:\s[^>]*)?>[\s\S]*?<\/image\s*>/gi, '');
  const itunesImage = elementAttrs(head, 'itunes:image');
  const imageBlock = elementRaw(head, 'image');
  const imageUrl = imageBlock ? elementRaw(imageBlock, 'url') : null;
  return {
    title: cleanText(elementRaw(withoutImage, 'title'), 300),
    author: cleanText(elementRaw(withoutImage, 'itunes:author') || elementRaw(withoutImage, 'managingEditor'), 200),
    description: cleanText(elementRaw(withoutImage, 'description') || elementRaw(withoutImage, 'itunes:summary'), 2000),
    cover: httpUrlOrNull(itunesImage && itunesImage.href) || httpUrlOrNull(imageUrl === null ? null : cleanText(imageUrl, 2048)),
    language: cleanText(elementRaw(withoutImage, 'language'), 20),
  };
}

/** Shownotes: content:encoded, sonst description, sonst itunes:summary (erste nicht leere Fassung), als Text mit Absätzen. */
function itemNotes(block) {
  for (const name of ['content:encoded', 'description', 'itunes:summary']) {
    const text = cleanText(elementRaw(block, name), MAX_NOTES_CHARS, { notes: true });
    if (text) return text;
  }
  return '';
}

/** Kapitel eines Items: { chaptersUrl (podcast:chapters, JSON) | null, chapters (psc:chapters inline, normalisiert) }. */
function itemChapters(block) {
  const attrs = elementAttrs(block, 'podcast:chapters');
  const type = attrs && attrs.type ? attrs.type.trim().toLowerCase() : '';
  const chaptersUrl = attrs && (!type || type.includes('json')) ? httpUrlOrNull(attrs.url) : null;
  const inline = elementRaw(block, 'psc:chapters');
  const list = [];
  if (inline) {
    const re = /<psc:chapter(\s[^>]*?)?\/?>/gi;
    for (let match = re.exec(inline); match && list.length < 400; match = re.exec(inline)) {
      const chapter = elementAttrs(match[0], 'psc:chapter');
      if (chapter) list.push({ start: chapter.start, title: chapter.title });
    }
  }
  return { chaptersUrl, chapters: normalizeChapters(list) };
}

function parseItem(block) {
  const enclosure = audioEnclosure(block);
  if (!enclosure) return null;
  const guidRaw = elementRaw(block, 'guid');
  const guid = guidRaw === null ? '' : cleanText(guidRaw, 500);
  const cover = elementAttrs(block, 'itunes:image');
  const durationRaw = elementRaw(block, 'itunes:duration');
  return {
    guid: guid || null,
    title: cleanText(elementRaw(block, 'title'), 300) || 'Ohne Titel',
    description: cleanText(elementRaw(block, 'description') || elementRaw(block, 'itunes:summary') || elementRaw(block, 'content:encoded'), 2000),
    pubDate: parseDate(elementRaw(block, 'pubDate')),
    notes: itemNotes(block),
    ...itemChapters(block),
    duration: parseDuration(durationRaw === null ? null : cleanText(durationRaw, 50)),
    audioUrl: enclosure.url,
    audioType: enclosure.type,
    cover: httpUrlOrNull(cover && cover.href),
  };
}

/** Vergibt eindeutige IDs und fasst Duplikate (gleiche ID und gleiche Audio-Adresse) zusammen. */
function assignIds(items) {
  const guidCount = new Map();
  for (const item of items) if (item.guid) guidCount.set(item.guid, (guidCount.get(item.guid) || 0) + 1);
  const seen = new Set();
  const episodes = [];
  for (const item of items) {
    const unique = item.guid && guidCount.get(item.guid) === 1;
    const id = unique ? item.guid : episodeIdFromEnclosure(item.audioUrl);
    if (seen.has(id)) continue;
    seen.add(id);
    episodes.push({ id, ...item });
  }
  return episodes;
}

/**
 * Parst RSS-Text. Liefert { channel, episodes (neueste zuerst, höchstens maxEpisodes), totalItems, skipped }.
 * Wirft bei zu großer Eingabe oder wenn kein RSS-Feed erkennbar ist (kein <rss>/<channel>).
 */
function parseFeed(xml, { maxEpisodes = MAX_EPISODES } = {}) {
  if (typeof xml !== 'string') throw new Error('Feed ist kein Text');
  if (xml.length > MAX_FEED_CHARS) throw new Error('Feed ist zu groß');
  const text = xml.replace(/^\uFEFF/, '').replace(/<!DOCTYPE(?:[^>[]*\[[\s\S]*?\]\s*>|[^>]*>)/i, '').replace(/<!--[\s\S]*?-->/g, '');
  if (!/<(rss|channel)[\s>]/i.test(text)) throw new Error('Kein gültiger Podcast-Feed (RSS erwartet)');
  const firstItem = text.search(/<item[\s>]/i);
  const head = firstItem < 0 ? text : text.slice(0, firstItem);
  const channel = parseChannel(head);

  const items = [];
  let total = 0;
  let skipped = 0;
  // Ohne Regex über den ganzen Text: unvollständige <item>-Folgen dürfen nicht quadratisch laufen (20-MB-Limit)
  const startRe = /<item[\s>]/g;
  startRe.lastIndex = Math.max(0, firstItem);
  for (let start = firstItem < 0 ? null : startRe.exec(text); start && total < MAX_RAW_ITEMS; start = startRe.exec(text)) {
    const bodyStart = text.indexOf('>', start.index) + 1;
    const end = text.indexOf('</item', bodyStart);
    if (end < 0) break;
    total += 1;
    const item = parseItem(text.slice(bodyStart, end));
    if (item) items.push(item);
    else skipped += 1;
    startRe.lastIndex = end;
  }
  const withIds = assignIds(items);
  const allDated = withIds.length > 0 && withIds.every(episode => episode.pubDate);
  // neueste zuerst; ohne vollständige Datumsangaben bleibt die Feed-Reihenfolge (üblich: neueste zuerst)
  const ordered = (allDated ? withIds.map((episode, index) => ({ episode, index })).sort((a, b) => Date.parse(b.episode.pubDate) - Date.parse(a.episode.pubDate) || a.index - b.index).map(entry => entry.episode) : withIds).slice(0, Math.max(1, maxEpisodes));
  return { channel, episodes: ordered, totalItems: total, skipped };
}

module.exports = { parseFeed, parseDuration, cleanText, MAX_FEED_CHARS, MAX_EPISODES, MAX_NOTES_CHARS };
