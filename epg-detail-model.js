// Detail-Erweiterung des Programmführers (Etappe 3.6, EPG-E4/E7, M6) — rein und DOM-frei.
//
// Poster-URL-Prüfung, Metazeile („Genre · Jahr · Dauer · S2 E3“), Besetzung („Regie: … · Mit: …“, gekürzt) und die
// Auswahl für „Läuft auch“ (weitere Termine desselben Titels aus epg:search). Alle Texte stammen aus fremden
// EPG-Daten: hier werden sie nur gekürzt/zusammengesetzt; epg-detail-view.js setzt sie per textContent.

'use strict';

const grid = require('./lib/epg-grid.js');
const searchModel = require('./epg-search-model.js');
const viewModel = require('./epg-view-model.js');

const MAX_ICON_URL_LENGTH = 512; // wie der Parser (lib/epg/xmltv-stream-parser.js)
const MAX_NAME_LENGTH = 60;
const MAX_EPISODE_LENGTH = 24;
const MAX_SUBTITLE_LENGTH = 160;
const MAX_RATING_LENGTH = 24;
/** Bis zu dieser Anzahl werden alle Namen genannt; darüber die ersten SHOWN_NAMES und „… + N weitere“. */
const MAX_NAMES = 4;
const SHOWN_NAMES = 3;
const ALSO_LIMIT = 5;
/** Treffer, die für „Läuft auch“ angefragt werden (Obergrenze des Main); danach wird auf den exakten Titel gefiltert. */
const ALSO_FETCH_LIMIT = 200;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/; // eslint-disable-line no-control-regex

/**
 * Bild-URL eines Sendungsbilds: nur http(s) mit Host und ohne Zugangsdaten, höchstens 512 Zeichen.
 * Alles andere (javascript:, data:, file:, blob:, leer, kein String) → ''. Das Ergebnis ist die normalisierte URL
 * und wird ausschließlich als img.src gesetzt (nie als HTML).
 */
function safeIconUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > MAX_ICON_URL_LENGTH || CONTROL_CHARS.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Jahr 1900–2100 oder 0. */
function cleanYear(value) {
  return Number.isInteger(value) && value >= 1900 && value <= 2100 ? value : 0;
}

/**
 * Teile der Metazeile in fester Reihenfolge: Genre (Text), Jahr, Dauer, Episode. Fehlendes entfällt.
 * genreText: Beschriftung der Gruppe ('' ohne Genre), minutes: Dauer in Minuten (0 = unbekannt).
 */
function metaParts({ genreText = '', year = 0, minutes = 0, episode = '' } = {}) {
  const parts = [];
  if (genreText) parts.push(genreText);
  const y = cleanYear(year);
  if (y) parts.push(String(y));
  if (Number.isFinite(minutes) && minutes > 0) parts.push(`${Math.round(minutes)} min`);
  const ep = cleanText(episode, MAX_EPISODE_LENGTH);
  if (ep) parts.push(ep);
  return parts;
}

function metaLine(fields) {
  return metaParts(fields).join(' · ');
}

function cleanNames(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const name = cleanText(entry, MAX_NAME_LENGTH);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** „A, B, C … + 4 weitere“ (bis 4 Namen alle, sonst die ersten 3 und der Rest als Zahl). */
function namesText(list) {
  const names = cleanNames(list);
  if (names.length <= MAX_NAMES) return names.join(', ');
  return `${names.slice(0, SHOWN_NAMES).join(', ')} … + ${names.length - SHOWN_NAMES} weitere`;
}

/**
 * Besetzungszeilen: [{ label, text }] für Regie, Mit (Darsteller) und Moderation — nur was vorhanden ist.
 * castLine() fügt sie zu „Regie: … · Mit: …“ zusammen.
 */
function castEntries(credits) {
  const c = credits && typeof credits === 'object' ? credits : {};
  const entries = [];
  for (const [label, list] of [['Regie', c.director], ['Mit', c.actor], ['Moderation', c.presenter]]) {
    const text = namesText(list);
    if (text) entries.push({ label, text });
  }
  return entries;
}

function castLine(credits) {
  return castEntries(credits)
    .map(e => `${e.label}: ${e.text}`)
    .join(' · ');
}

/** Untertitel (EPG-E7): nur wenn vorhanden. */
function subtitleText(value) {
  return cleanText(value, MAX_SUBTITLE_LENGTH);
}

/** Altersfreigabe (EPG-E7): nur wenn vorhanden. */
function ratingText(value) {
  return cleanText(value, MAX_RATING_LENGTH);
}

/** Suchtext für „Läuft auch“: der Titel, wenn die Suche ihn annimmt (2–80 Zeichen, keine Steuerzeichen), sonst ''. */
function alsoQuery(title) {
  if (typeof title !== 'string') return '';
  const text = title.trim();
  if (text.length < searchModel.MIN_QUERY || text.length > searchModel.MAX_QUERY || CONTROL_CHARS.test(text)) return '';
  return text;
}

/**
 * „Läuft auch“ aus den Treffern von epg:search (Titel als Suchtext): nur Termine mit exakt gleichem Titel,
 * ohne den aktuellen Termin, nur laufende/kommende (epg:search sucht ab „jetzt“ im Cache), nach Start sortiert.
 *   hits: [{ channelKey, start, stop, title }], current: Zeile des offenen Details,
 *   channelByKey: Schlüssel → Sender (Treffer anderer Schlüssel entfallen)
 * → { items: höchstens 5 Zeilen (Format der Liste), more: Anzahl weiterer Termine }
 */
function alsoPicks({ hits, current, channelByKey, nowMs, limit = ALSO_LIMIT }) {
  const currentKey = grid.normalizeKey(current.channelKey);
  const seen = new Set();
  const rows = [];
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit || hit.title !== current.title || !Number.isFinite(hit.start) || !Number.isFinite(hit.stop)) continue;
    if (Number.isFinite(nowMs) && hit.stop <= nowMs) continue;
    const norm = grid.normalizeKey(hit.channelKey);
    if (norm === currentKey && hit.start === current.start) continue;
    const channel = channelByKey instanceof Map ? channelByKey.get(hit.channelKey) : null;
    if (!channel) continue;
    const id = `${norm}|${hit.start}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(viewModel.slotToRow({ channelKey: hit.channelKey, channel, slot: { start: hit.start, stop: hit.stop, title: hit.title, genre: '' } }));
  }
  rows.sort((a, b) => a.start - b.start);
  return { items: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/** Beschriftung eines Eintrags: Wochentag/Uhrzeit (bzw. Datum) und Sendername. */
function alsoLabel(row, nowMs) {
  return { when: searchModel.hitWhen(row.start, nowMs), channel: row.channel.name || row.channelKey };
}

module.exports = {
  MAX_ICON_URL_LENGTH,
  MAX_NAMES,
  SHOWN_NAMES,
  ALSO_LIMIT,
  ALSO_FETCH_LIMIT,
  safeIconUrl,
  cleanYear,
  metaParts,
  metaLine,
  namesText,
  castEntries,
  castLine,
  subtitleText,
  ratingText,
  alsoQuery,
  alsoPicks,
  alsoLabel,
};
