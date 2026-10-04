// Reine Raster-Logik des EPG-Programmführers (Etappe 3.1; EPG-Konzept §4 A-2)
//
// Keine Electron-/DOM-/Node-Abhängigkeit und keine Uhr: "jetzt" kommt immer als
// Parameter. CommonJS wie die anderen lib-Module, aber vom esbuild-Renderer-Bundle
// nutzbar (nur lib/epg-text.js wird nachgeladen, ebenfalls rein).
//
// Zeitzone: Die lokale Zeit der ausführenden Umgebung (Renderer = Anzeigezone).
// Der TV-Tag (P8) läuft von 05:00 bis 05:00 lokaler Zeit; Tagesgrenzen werden über
// lokale Datumskomponenten gebildet, NICHT über 24-h-Millisekunden — an
// Sommerzeitumstellungen hat ein TV-Tag 23 bzw. 25 Stunden.
//
// Bausteine: Zeit<->px, sichtbarer Bereich/Virtualisierungsfenster, Fortschritt,
// TV-Tag + Tagesleisten-Chips, Marker-Zuordnung, Suchtext-Faltung.

'use strict';

const { foldText } = require('./epg-text.js');

const MINUTE_MS = 60 * 1000;
const TV_DAY_START_HOUR = 5;
const MAX_SLOT_MS = 24 * 60 * MINUTE_MS;

// ── Zeit <-> px ──

/** x-Position (px) der Zeit ms auf einer Achse, die bei originMs bei 0 beginnt. */
function timeToX(ms, originMs, pxPerMin) {
  return ((ms - originMs) / MINUTE_MS) * pxPerMin;
}

function xToTime(x, originMs, pxPerMin) {
  return originMs + (x / pxPerMin) * MINUTE_MS;
}

/** Block eines Slots: { left, width } in px (Breite nie negativ). */
function slotRect(slot, originMs, pxPerMin) {
  const left = timeToX(slot.start, originMs, pxPerMin);
  return { left, width: Math.max(0, timeToX(slot.stop, originMs, pxPerMin) - left) };
}

// ── Sichtbarer Bereich / Virtualisierung ──

/** Sichtbarer Zeitbereich { fromMs, toMs } bei Scrollposition und Viewportbreite. */
function visibleTimeRange({ scrollLeft, viewportWidth, originMs, pxPerMin }) {
  return {
    fromMs: xToTime(scrollLeft, originMs, pxPerMin),
    toMs: xToTime(scrollLeft + viewportWidth, originMs, pxPerMin),
  };
}

/**
 * Virtualisierungsfenster: sichtbarer Bereich ± overscan Viewports (Standard 1) je Achse.
 * Rückgabe: rowStart/rowEnd (Ende exklusiv, auf [0, rowCount] geklemmt), xFrom/xTo (px,
 * nicht unter 0) und der zugehörige Zeitbereich fromMs/toMs.
 */
function virtualWindow({
  scrollLeft = 0,
  scrollTop = 0,
  viewportWidth,
  viewportHeight,
  rowHeight,
  rowCount,
  originMs,
  pxPerMin,
  overscan = 1,
}) {
  const xFrom = Math.max(0, scrollLeft - overscan * viewportWidth);
  const xTo = scrollLeft + viewportWidth + overscan * viewportWidth;
  const yFrom = Math.max(0, scrollTop - overscan * viewportHeight);
  const yTo = scrollTop + viewportHeight + overscan * viewportHeight;
  const rowStart = Math.min(rowCount, Math.max(0, Math.floor(yFrom / rowHeight)));
  const rowEnd = Math.min(rowCount, Math.max(rowStart, Math.ceil(yTo / rowHeight)));
  return {
    rowStart,
    rowEnd,
    xFrom,
    xTo,
    fromMs: xToTime(xFrom, originMs, pxPerMin),
    toMs: xToTime(xTo, originMs, pxPerMin),
  };
}

/**
 * Slots (nach Start sortiert), die [fromMs, toMs) überlappen — Binärsuche auf den Start,
 * dann Rückwärtsschritt (höchstens 24 h) für Slots, die früher beginnen, aber hineinragen.
 */
function slotsInWindow(slots, fromMs, toMs) {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (slots[mid].start < toMs) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  // Slots sind höchstens 24 h lang: früher beginnende, die noch hineinragen, liegen höchstens so weit zurück
  const earliestStart = fromMs - MAX_SLOT_MS;
  for (let i = lo - 1; i >= 0 && slots[i].start >= earliestStart; i -= 1) {
    if (slots[i].stop > fromMs) out.push(slots[i]);
  }
  return out.reverse();
}

// ── Fortschritt ──

/** 'past' | 'now' | 'future' (start <= now < stop ist 'now'). */
function slotPhase(slot, nowMs) {
  if (nowMs >= slot.stop) return 'past';
  if (nowMs >= slot.start) return 'now';
  return 'future';
}

/** Fortschritt 0..1 (vor Beginn 0, nach Ende 1). */
function slotProgress(slot, nowMs) {
  const length = slot.stop - slot.start;
  if (!(length > 0)) return nowMs >= slot.stop ? 1 : 0;
  return Math.min(1, Math.max(0, (nowMs - slot.start) / length));
}

/** "noch N min" (aufgerundet, mindestens 1) für die laufende Sendung, sonst null. */
function minutesLeft(slot, nowMs) {
  if (slotPhase(slot, nowMs) !== 'now') return null;
  return Math.max(1, Math.ceil((slot.stop - nowMs) / MINUTE_MS));
}

// ── TV-Tag (05:00–05:00 lokal) ──

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Beginn (05:00 lokal) des TV-Tags, in dem ms liegt. */
function tvDayStart(ms) {
  const d = new Date(ms);
  const dayOffset = d.getHours() < TV_DAY_START_HOUR ? -1 : 0;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, TV_DAY_START_HOUR, 0, 0, 0).getTime();
}

/**
 * TV-Tag zu einem Zeitpunkt: { key: 'YYYY-MM-DD' (Kalendertag des Beginns), startMs, endMs
 * (= Beginn des nächsten TV-Tags, exklusiv), weekday (0 = So), day, month (1–12), year }.
 * 01:00 gehört zum Vorabend. endMs − startMs ist 23, 24 oder 25 Stunden.
 */
function tvDayOf(ms) {
  const startMs = tvDayStart(ms);
  const s = new Date(startMs);
  const endMs = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1, TV_DAY_START_HOUR, 0, 0, 0).getTime();
  return {
    key: `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-${pad2(s.getDate())}`,
    startMs,
    endMs,
    weekday: s.getDay(),
    day: s.getDate(),
    month: s.getMonth() + 1,
    year: s.getFullYear(),
  };
}

/**
 * Alle TV-Tage, die ein Slot berührt (meist einer; eine Sendung über 05:00 berührt zwei).
 * Der Start entscheidet über die "Heimat" (erster Eintrag); Endzeitpunkt ist exklusiv.
 */
function slotTvDays(slot) {
  const days = [];
  let day = tvDayOf(slot.start);
  days.push(day);
  while (day.endMs < slot.stop) {
    day = tvDayOf(day.endMs);
    days.push(day);
  }
  return days;
}

/** Zeitpunkt hour:minute (lokal) innerhalb des TV-Tags ab dayStartMs; hour < 5 liegt nach Mitternacht. */
function tvDayTime(dayStartMs, hour, minute = 0) {
  const s = new Date(dayStartMs);
  const nextDay = hour < TV_DAY_START_HOUR ? 1 : 0;
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() + nextDay, hour, minute, 0, 0).getTime();
}

function calendarDayNumber(day) {
  return Math.round(Date.UTC(day.year, day.month - 1, day.day) / 86400000);
}

/**
 * Chips der Tagesleiste für [fromMs, toMs): je TV-Tag { ...tvDayOf, offset (Tage relativ zum
 * TV-Tag von nowMs: 0 heute, -1 gestern, 1 morgen), isToday, isPast }.
 */
function dayChips({ fromMs, toMs, nowMs }) {
  const chips = [];
  const today = calendarDayNumber(tvDayOf(nowMs));
  let day = tvDayOf(fromMs);
  while (day.startMs < toMs) {
    const offset = calendarDayNumber(day) - today;
    chips.push({ ...day, offset, isToday: offset === 0, isPast: offset < 0 });
    day = tvDayOf(day.endMs);
  }
  return chips;
}

// ── Marker-Zuordnung ──

/** Gleiche Normalisierung wie normalizeTvId (typed-core): "ard@hdr.de" → "ard.de", klein. */
function normalizeKey(id) {
  return (typeof id === 'string' ? id : '').replace(/@[^.@]*/g, '').toLowerCase().trim();
}

function slotIdentifiers(slot) {
  const ids = new Set();
  for (const raw of [slot.channelKey, slot.tvgId, slot.channelId]) {
    const key = normalizeKey(raw);
    if (key) ids.add(key);
  }
  return ids;
}

function parseMs(iso) {
  return typeof iso === 'string' ? Date.parse(iso) : NaN;
}

/**
 * Ordnet Slots Aufnahme-Markern zu.
 *
 * slots: [{ start, stop, channelKey, channelId?, tvgId? }] — mindestens ein Kanalbezug.
 * scheduleEntries: Planungseinträge (schedule:list) — nur state 'scheduled' (●) und
 *   'recording' (pulsierend). Verglichen wird der Sendungsinhalt [epgStart, epgStop]
 *   (ISO), nicht das Puffer-Fenster. Kanal wie im Scheduler: tvgId || channelId,
 *   normalisiert (Entry-channelId zusätzlich exakt gegen slot.channelId). Zusammengelegte
 *   Einträge (merged) decken ihren ganzen Bereich ab: jeder überlappte Slot ist markiert.
 *   Slip-Verschiebungen ändern epgStart/epgStop — die Zuordnung folgt automatisch.
 * recordings: recording:list — status 'recording' (manuelle Player-Aufnahme): der Slot
 *   des Kanals (channelId exakt oder normalisiert), den [startedAt, nowMs] berührt.
 * nowMs: "jetzt"; ohne gültigen Wert zählt nur der Startzeitpunkt der Aufnahme.
 *
 * Rückgabe: Array parallel zu slots: null oder { state: 'scheduled' | 'recording', ids: [...] }
 * ('recording' gewinnt; ids = Planungs-IDs bzw. Aufnahme-IDs der Treffer).
 * Überlappung ist streng (Berühren an der Grenze zählt nicht).
 */
function matchMarkers(slots, scheduleEntries, recordings, nowMs) {
  const entries = [];
  for (const entry of Array.isArray(scheduleEntries) ? scheduleEntries : []) {
    if (!entry || (entry.state !== 'scheduled' && entry.state !== 'recording')) continue;
    const start = parseMs(entry.epgStart);
    const stop = parseMs(entry.epgStop);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) continue;
    const key = normalizeKey(entry.tvgId || entry.channelId);
    entries.push({ id: entry.id, state: entry.state, start, stop, key, channelId: entry.channelId || '' });
  }
  const running = [];
  for (const rec of Array.isArray(recordings) ? recordings : []) {
    if (!rec || rec.status !== 'recording') continue;
    const start = parseMs(rec.startedAt);
    if (!Number.isFinite(start)) continue;
    running.push({
      id: rec.id,
      start,
      stop: Number.isFinite(nowMs) && nowMs > start ? nowMs : start,
      key: normalizeKey(rec.channelId),
      channelId: rec.channelId || '',
    });
  }
  return (Array.isArray(slots) ? slots : []).map(slot => {
    if (!slot) return null;
    const ids = slotIdentifiers(slot);
    const matched = { scheduled: [], recording: [] };
    for (const entry of entries) {
      const sameChannel = (entry.key && ids.has(entry.key)) || (entry.channelId && entry.channelId === slot.channelId);
      if (sameChannel && slot.start < entry.stop && slot.stop > entry.start) matched[entry.state].push(entry.id);
    }
    for (const rec of running) {
      const sameChannel = (rec.key && ids.has(rec.key)) || (rec.channelId && rec.channelId === slot.channelId);
      // laufende Aufnahme: Slot, der [startedAt, jetzt] berührt (bei Punkt-Intervall: enthält den Start)
      const touches = rec.stop > rec.start ? slot.start < rec.stop && slot.stop > rec.start : slot.start <= rec.start && rec.start < slot.stop;
      if (sameChannel && touches) matched.recording.push(rec.id);
    }
    if (matched.recording.length) return { state: 'recording', ids: matched.recording };
    if (matched.scheduled.length) return { state: 'scheduled', ids: matched.scheduled };
    return null;
  });
}

module.exports = {
  MINUTE_MS,
  TV_DAY_START_HOUR,
  timeToX,
  xToTime,
  slotRect,
  visibleTimeRange,
  virtualWindow,
  slotsInWindow,
  slotPhase,
  slotProgress,
  minutesLeft,
  tvDayStart,
  tvDayOf,
  slotTvDays,
  tvDayTime,
  dayChips,
  normalizeKey,
  matchMarkers,
  foldText,
};
