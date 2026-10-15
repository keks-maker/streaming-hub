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

const MAX_CLEAN_INPUT = 50000; // Eingabe vor der HTML-Bereinigung (Endlimit je Feld bleibt)
const MAX_ATTR_CHARS = 8000;
const MAX_TAG_ATTEMPTS = 2000;
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * HTML -> Text in einem linearen Durchlauf (kein Regex über offene Tags, daher kein ReDoS). Entfernt Tags und script/style
 * samt Inhalt. Mit notes: Absätze, Listenpunkte und Links "Text (Adresse)" (nur http/https; Text mit Adresse bleibt).
 * Liefert null, wenn kein Tag vorkam (dann bleibt der Text unverändert).
 */
function htmlToText(value, notes) {
  const parts = [];
  const noClose = new Set();
  let pos = 0;
  let sawTag = false;
  let anchor = null; // { href, at } des ersten offenen Links
  for (let lt = value.indexOf('<'); lt >= 0; lt = value.indexOf('<', pos)) {
    const gt = value.indexOf('>', lt + 1);
    if (gt < 0) break;
    parts.push(value.slice(pos, lt));
    pos = gt + 1;
    const tag = value.slice(lt + 1, gt);
    const head = /^(\/?)([a-z][a-z0-9:-]*)/i.exec(tag.slice(0, 64));
    if (!head) continue;
    sawTag = true;
    const closing = head[1] === '/';
    const name = head[2].toLowerCase();
    if (!closing && (name === 'script' || name === 'style') && !noClose.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'gi');
      closeRe.lastIndex = gt + 1;
      if (closeRe.exec(value)) {
        pos = closeRe.lastIndex;
        continue;
      }
      noClose.add(name);
    }
    if (notes && name === 'a') {
      if (closing) {
        if (anchor && /^\/a\s*$/i.test(tag)) {
          const label = parts.splice(anchor.at).join('').replace(/<[^>]*>/g, '').trim();
          const href = decodeEntities(anchor.href).trim();
          if (!/^https?:\/\//i.test(href) || href.length > 500) parts.push(label);
          else parts.push(!label || label.includes(href) ? href : `${label} (${href})`);
          anchor = null;
        }
      } else if (!anchor && /^a\s/i.test(tag)) {
        const m = HREF_RE.exec(tag.slice(0, 1500));
        if (m) anchor = { href: m[1] !== undefined ? m[1] : m[2], at: parts.length };
      }
      continue;
    }
    if (notes) {
      if (!closing && (name === 'ul' || name === 'ol')) parts.push('\n');
      else if (!closing && name === 'li') parts.push('• ');
      else if (name === 'br' || (closing && name === 'li')) parts.push('\n');
      else if (closing && /^(?:p|div|h[1-6]|ul|ol|blockquote)$/.test(name)) parts.push('\n\n');
    } else if (name === 'br' || (closing && /^(?:p|div|li)$/.test(name))) {
      parts.push('\n');
    }
  }
  if (!sawTag) return null;
  parts.push(value.slice(pos));
  return parts.join('');
}

/**
 * Rohinhalt eines Elements (evtl. CDATA/HTML) -> reiner Text, höchstens max Zeichen. Mit options.notes (Shownotes) bleiben
 * Absätze (Leerzeile), Listenpunkte ("• ") und Linkadressen (als Text in Klammern) erhalten; es entsteht nie HTML.
 */
function cleanText(raw, max = 2000, { notes = false } = {}) {
  if (raw === null || raw === undefined) return '';
  let value = String(raw);
  const trimmed = value.trim();
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>') && trimmed.length >= 12) {
    value = trimmed.slice(9, -3).slice(0, MAX_CLEAN_INPUT);
  } else {
    value = decodeEntities(value.slice(0, MAX_CLEAN_INPUT));
  }
  const text = htmlToText(value, notes);
  if (text !== null) value = decodeEntities(text);
  value = value
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Entfernt <name ...>...</name>-Blöcke linear (ohne schließendes Tag bleibt der Rest unverändert). */
function removeBlocks(text, name) {
  const startRe = new RegExp(`<${name}(?=[\\s>])`, 'gi');
  const closeRe = new RegExp(`</${name}\\s*>`, 'gi');
  const parts = [];
  let pos = 0;
  for (let m = startRe.exec(text); m; m = startRe.exec(text)) {
    const gt = text.indexOf('>', m.index);
    if (gt < 0) break;
    closeRe.lastIndex = gt + 1;
    if (!closeRe.exec(text)) break;
    parts.push(text.slice(pos, m.index));
    pos = closeRe.lastIndex;
    startRe.lastIndex = pos;
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

/** Entfernt Kommentare <!-- ... --> linear. */
function removeComments(text) {
  const parts = [];
  let pos = 0;
  for (let i = text.indexOf('<!--'); i >= 0; i = text.indexOf('<!--', pos)) {
    const end = text.indexOf('-->', i + 4);
    if (end < 0) break;
    parts.push(text.slice(pos, i));
    pos = end + 3;
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

/** Entfernt die erste DOCTYPE-Deklaration (samt internem Subset). */
function removeDoctype(text) {
  const i = text.search(/<!DOCTYPE/i);
  if (i < 0) return text;
  const re = /<!DOCTYPE(?:[^>[]*\[[\s\S]*?\]\s*>|[^>]*>)/iy;
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? text.slice(0, i) + text.slice(i + m[0].length) : text;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
}

/** Rohinhalt des ersten Elements <name> (mit Namensraum-Präfix), sonst null. Linear: je Aufruf höchstens ein Durchlauf. */
function elementRaw(block, name) {
  const n = escapeRegExp(name);
  const startRe = new RegExp(`<${n}(?=[\\s/>])`, 'i');
  const start = startRe.exec(block);
  if (!start) return null;
  const gt = block.indexOf('>', start.index);
  if (gt < 0) return null;
  if (block[gt - 1] === '/') return '';
  const closeRe = new RegExp(`</${n}\\s*>`, 'gi');
  closeRe.lastIndex = gt + 1;
  const close = closeRe.exec(block);
  return close ? block.slice(gt + 1, close.index) : null;
}

/** Attribut-Text der Tags <name ...> (höchstens limit), jeweils ohne abschließendes "/". Ein Durchlauf vorwärts. */
function* tagAttrStrings(block, name, limit = MAX_TAG_ATTEMPTS) {
  const startRe = new RegExp(`<${escapeRegExp(name)}(?=[\\s/>])`, 'gi');
  let count = 0;
  for (let m = startRe.exec(block); m && count < limit; m = startRe.exec(block)) {
    const gt = block.indexOf('>', m.index);
    if (gt < 0) return;
    count += 1;
    let attrs = block.slice(m.index + name.length + 1, gt);
    if (attrs.endsWith('/')) attrs = attrs.slice(0, -1);
    yield attrs;
    startRe.lastIndex = gt + 1;
  }
}

function parseAttrs(text) {
  const attrs = {};
  for (const a of text.slice(0, MAX_ATTR_CHARS).matchAll(/(?<![\w:.-])([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[a[1].toLowerCase()] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
  }
  return attrs;
}

/** Attribute des ersten Elements <name ...> als Objekt (Schlüssel klein), sonst null. */
function elementAttrs(block, name) {
  const first = tagAttrStrings(block, name, 1).next();
  return first.done ? null : parseAttrs(first.value);
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
  for (const text of tagAttrStrings(block, 'enclosure')) {
    const attrs = parseAttrs(text);
    const url = httpUrlOrNull(attrs.url);
    if (!url) continue;
    const type = (attrs.type || '').trim().toLowerCase();
    if (type ? type.startsWith('audio/') : AUDIO_EXTENSIONS.test(url)) return { url, type: type || null };
  }
  return null;
}

function parseChannel(head) {
  const withoutImage = removeBlocks(head, 'image');
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
    for (const text of tagAttrStrings(inline, 'psc:chapter')) {
      if (list.length >= 400) break;
      const chapter = parseAttrs(text);
      list.push({ start: chapter.start, title: chapter.title });
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
  const text = removeComments(removeDoctype(xml.replace(/^\uFEFF/, '')));
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
    const startGt = text.indexOf('>', start.index);
    if (startGt < 0) break;
    const bodyStart = startGt + 1;
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
