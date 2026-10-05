// Raster-Modell des EPG-Programmführers (Etappe 3.3, T-B) — rein und DOM-frei.
//
// Zeitachse (px/min, Zoom 3/5/8), Blockgeometrie, Ruler-Marken, Zeit-Buckets für das
// Nachladen über epg:range-many und der Slot-Speicher je Kanal. Die Grundbausteine
// (Zeit<->px, Virtualisierungsfenster, Slots im Fenster) kommen aus lib/epg-grid.js.

'use strict';

const grid = require('./lib/epg-grid.js');
const { cleanGenre, genreLabel } = require('./epg-genres.js');

const ROW_HEIGHT = 64;
const CHANNEL_COL_WIDTH = 150;
const RULER_HEIGHT = 32;
const ZOOMS = [3, 5, 8];
const DEFAULT_ZOOM = 5;
/** „jetzt“ steht beim Öffnen ein Viertel der Zeitfläche vom linken Rand. */
const NOW_RATIO = 0.25;
const MIN_BLOCK_WIDTH = 28;
const BLOCK_GAP = 2;
/** Erst ab dieser Blockbreite sitzt der Aufnahme-Toggle im Block (der Text wird um seinen Platz eingerückt). */
const MIN_REC_BLOCK_WIDTH = 90;
/** Mindestbreite, die vom Text eines links angeschnittenen Blocks sichtbar bleibt (Text rückt nur so weit nach). */
const MIN_TEXT_WIDTH = 60;
const BUCKET_MS = 6 * 60 * 60 * 1000;
const MAX_AXIS_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_KEYS_PER_CALL = 100;

function isZoom(value) {
  return ZOOMS.includes(value);
}

// ── Zeitachse ──

/**
 * Achse vom Beginn des ersten TV-Tags (Vortag, soweit Daten) bis zum Cache-Ende.
 * days: Tage der Tagesleiste (epg-view-model.planDays), coverageToMs: epg:status.coverageToMs.
 */
function axisFor({ days, coverageToMs }) {
  if (!Array.isArray(days) || !days.length || !Number.isFinite(coverageToMs)) return null;
  const originMs = days[0].startMs;
  const endMs = Math.min(coverageToMs, originMs + MAX_AXIS_MS);
  return endMs > originMs ? { originMs, endMs } : null;
}

function axisWidth(axis, pxPerMin) {
  return grid.timeToX(axis.endMs, axis.originMs, pxPerMin);
}

function xForTime(axis, ms, pxPerMin) {
  return grid.timeToX(ms, axis.originMs, pxPerMin);
}

function timeForX(axis, x, pxPerMin) {
  return grid.xToTime(x, axis.originMs, pxPerMin);
}

/** scrollLeft, bei dem ms am linken Rand der Zeitfläche steht (nie negativ). */
function scrollLeftForTime(axis, ms, pxPerMin) {
  return Math.max(0, Math.round(xForTime(axis, ms, pxPerMin)));
}

/** scrollLeft, bei dem „jetzt“ ein Viertel der Zeitflächenbreite vom linken Rand steht. */
function scrollLeftForNow(axis, nowMs, pxPerMin, viewportW, ratio = NOW_RATIO) {
  return Math.max(0, Math.round(xForTime(axis, nowMs, pxPerMin) - viewportW * ratio));
}

/**
 * Zeitanker aus der Scrollposition. Steht die Ansicht noch dort, wo der bisherige Anker sie
 * hingesetzt hat (±2 px, z. B. nach programmatischem Scrollen), bleibt der Anker unverändert —
 * so verfälscht Pixelrundung ihn nicht (Moduswechsel Liste ↔ Raster).
 */
function anchorFromScrollLeft(prevAnchorMs, scrollLeft, axis, pxPerMin) {
  if (Number.isFinite(prevAnchorMs) && Math.abs(xForTime(axis, prevAnchorMs, pxPerMin) - scrollLeft) < 2) return prevAnchorMs;
  return timeForX(axis, scrollLeft, pxPerMin);
}

/** Tag (aus der Tagesleiste), in dem die Zeit am linken Rand liegt; null außerhalb der Tage. */
function dayKeyAtTime(days, ms) {
  const day = days.find(d => ms >= d.startMs && ms < d.endMs);
  return day ? day.key : null;
}

// ── Blöcke ──

/**
 * Geometrie eines Blocks: links, Breite (mit Lücke zum Nachbarn, mindestens 2 px) und ob er
 * schmaler als MIN_BLOCK_WIDTH ist (dann nur Farbfläche + Tooltip, kein Text).
 */
function blockGeometry(slot, axis, pxPerMin) {
  const rect = grid.slotRect(slot, axis.originMs, pxPerMin);
  const width = Math.max(2, rect.width - BLOCK_GAP);
  return { left: rect.left, width, narrow: width < MIN_BLOCK_WIDTH };
}

/** Tooltip: voller Titel, Zeit, Dauer. */
function blockTooltip(row, clockFn) {
  const minutes = Math.max(0, Math.round((row.stop - row.start) / grid.MINUTE_MS));
  const genre = genreLabel(row.genre);
  return `${row.title || '(ohne Titel)'}\n${clockFn(row.start)}–${clockFn(row.stop)} · ${minutes} min${genre ? ` · Genre: ${genre}` : ''}`;
}

/**
 * Logo-URL eines Kanals (Playlist-Feld logo): nur was die Prüffunktion des Renderers (safeResourceUrl:
 * http/https/file, keine Zugangsdaten) durchlässt; sonst '' → Kürzel-Badge.
 */
function resolveLogoUrl(channel, sanitize) {
  if (!channel || typeof channel.logo !== 'string' || !channel.logo.trim() || typeof sanitize !== 'function') return '';
  try {
    const url = sanitize(channel.logo.trim());
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

/** Zwei bis drei Buchstaben für das Sender-Kürzel (Initialen der Wörter, sonst die ersten Buchstaben) und ein Farbton 0–359. */
function channelBadge(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  const words = text.split(/[\s\-_.()/]+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  let abbr;
  if (words.length >= 2) abbr = words.slice(0, 3).map(w => [...w][0]).join('');
  else abbr = [...(words[0] || '?')].slice(0, 3).join('');
  let hue = 0;
  for (const ch of text) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  return { abbr: abbr.toUpperCase(), hue };
}

// ── Zeilen ──

/** Nur Sender mit EPG (Schlüssel aus epgKeys), in der Reihenfolge der Senderauswahl. */
function gridRowsFor(entries, epgKeys) {
  return (Array.isArray(entries) ? entries : []).filter(entry => epgKeys.has(entry.key));
}

// ── Ruler ──

function pad2(n) {
  return String(n).padStart(2, '0');
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/**
 * Marken der Zeitleiste: volle Stunden (außer dem Tagesbeginn) und die Tagesgrenzen 05:00 mit
 * Beschriftung „Mo 05.10.“. Je Marke left in px.
 */
function rulerMarks(axis, pxPerMin) {
  const hours = [];
  const days = [];
  const cursor = new Date(axis.originMs);
  cursor.setMinutes(0, 0, 0);
  if (cursor.getTime() < axis.originMs) cursor.setHours(cursor.getHours() + 1);
  while (cursor.getTime() < axis.endMs) {
    const ms = cursor.getTime();
    if (cursor.getHours() !== grid.TV_DAY_START_HOUR) {
      hours.push({ ms, left: xForTime(axis, ms, pxPerMin), label: `${pad2(cursor.getHours())}:00` });
    }
    cursor.setHours(cursor.getHours() + 1);
  }
  let day = grid.tvDayOf(axis.originMs);
  while (day.startMs < axis.endMs) {
    days.push({
      ms: day.startMs,
      left: xForTime(axis, day.startMs, pxPerMin),
      key: day.key,
      label: `${WEEKDAYS[day.weekday]} ${pad2(day.day)}.${pad2(day.month)}. · ${pad2(grid.TV_DAY_START_HOUR)}:00`,
    });
    day = grid.tvDayOf(day.endMs);
  }
  return { hours, days };
}

// ── Nachladen (Buckets) ──

function loadedKey(bucketStart, key) {
  return `${bucketStart}|${key}`;
}

/** Bucket-Anfänge (6 h, an der Epoche ausgerichtet), die [fromMs, toMs) berühren, auf die Achse begrenzt. */
function bucketsFor(fromMs, toMs, axis) {
  const from = Math.max(fromMs, axis.originMs);
  const to = Math.min(toMs, axis.endMs);
  const out = [];
  if (!(to > from)) return out;
  for (let b = Math.floor(from / BUCKET_MS) * BUCKET_MS; b < to; b += BUCKET_MS) out.push(b);
  return out;
}

/**
 * Noch nicht geladene (Bucket, Kanal)-Paare als Abrufe: je Bucket und höchstens 100 Kanäle
 * [{ fromMs, toMs, bucket, keys }]. loaded: Set aus loadedKey().
 */
function neededFetches({ fromMs, toMs, axis, keys, loaded }) {
  const calls = [];
  for (const bucket of bucketsFor(fromMs, toMs, axis)) {
    const missing = keys.filter(key => !loaded.has(loadedKey(bucket, key)));
    for (let i = 0; i < missing.length; i += MAX_KEYS_PER_CALL) {
      calls.push({ bucket, fromMs: bucket, toMs: bucket + BUCKET_MS, keys: missing.slice(i, i + MAX_KEYS_PER_CALL) });
    }
  }
  return calls;
}

// ── Slot-Speicher ──

/**
 * Slots je Kanal, aus mehreren Abrufen zusammengeführt (Sendungen über Bucket-Grenzen erscheinen
 * in beiden Abrufen und werden über den Start dedupliziert). Zeilenobjekte tragen dieselbe Form
 * wie die der Liste (id = „Schlüssel|Start“), damit Auswahl und Detail in beiden Modi gelten.
 */
function createSlotStore() {
  const channels = new Map();
  const loaded = new Set();
  return {
    loaded,
    ingest(entry, slots) {
      let c = channels.get(entry.key);
      if (!c) {
        c = { byStart: new Map(), sorted: null };
        channels.set(entry.key, c);
      }
      for (const slot of Array.isArray(slots) ? slots : []) {
        if (!slot || !Number.isFinite(slot.start) || !Number.isFinite(slot.stop) || c.byStart.has(slot.start)) continue;
        c.byStart.set(slot.start, {
          id: `${entry.key}|${slot.start}`,
          start: slot.start,
          stop: slot.stop,
          title: typeof slot.title === 'string' ? slot.title : '',
          channelKey: entry.key,
          channel: entry.channel,
          genre: cleanGenre(slot.genre),
          night: new Date(slot.start).getHours() < grid.TV_DAY_START_HOUR,
        });
        c.sorted = null;
      }
    },
    /** Zeilenobjekte des Kanals, die [fromMs, toMs) überlappen (nach Start sortiert). */
    window(key, fromMs, toMs) {
      const c = channels.get(key);
      if (!c) return [];
      if (!c.sorted) c.sorted = [...c.byStart.values()].sort((a, b) => a.start - b.start);
      return grid.slotsInWindow(c.sorted, fromMs, toMs);
    },
    clear() {
      channels.clear();
      loaded.clear();
    },
  };
}

module.exports = {
  ROW_HEIGHT,
  CHANNEL_COL_WIDTH,
  RULER_HEIGHT,
  ZOOMS,
  DEFAULT_ZOOM,
  NOW_RATIO,
  MIN_BLOCK_WIDTH,
  BLOCK_GAP,
  MIN_REC_BLOCK_WIDTH,
  MIN_TEXT_WIDTH,
  BUCKET_MS,
  MAX_AXIS_MS,
  MAX_KEYS_PER_CALL,
  isZoom,
  axisFor,
  axisWidth,
  xForTime,
  timeForX,
  scrollLeftForTime,
  scrollLeftForNow,
  anchorFromScrollLeft,
  dayKeyAtTime,
  blockGeometry,
  blockTooltip,
  channelBadge,
  resolveLogoUrl,
  gridRowsFor,
  rulerMarks,
  loadedKey,
  bucketsFor,
  neededFetches,
  createSlotStore,
};
