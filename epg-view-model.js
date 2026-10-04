// Zustandsmodell des EPG-Programmführers (Etappe 3.3, Design B2)
//
// Rein und DOM-frei: keine Uhr (nowMs ist immer Parameter), keine Electron-/Browser-
// Abhängigkeit. epg-view.js (DOM) und die Unit-Tests nutzen dieses Modul; die
// zeitlichen Grundbausteine (TV-Tag, Fortschritt, Marker-Zuordnung) kommen aus
// lib/epg-grid.js, die Zukunftsregel aus lib/recorder/schedule-ui-model.js.
//
// Bausteine:
//   - Tage der Tagesleiste (7 TV-Tage ab heute, 05:00–05:00; Gestern nur mit Daten)
//   - Zeilen einer TV-Tag-Liste und das flache Layout (Tag-Köpfe, Zeilen, „Jetzt“-Trennlinie)
//     mit festen Höhen → Virtualisierung per Offset-Tabelle + Binärsuche
//   - Scroll-Ziele (Jetzt, Tag, Zeitpunkt) und „aktiver Tag folgt der Scrollposition“
//   - Aufnehmen/Abbrechen/Stoppen-Toggle samt Rückfrage-Texten und 8-Tage-Regel (P9)
//   - Ansichtszustand (Modus Liste|Raster, Tag, Scroll-Anker, Auswahl), moduswechsel-fähig
//   - abgeleiteter Anzeigezustand (laden, leer, Fehler, Quelle ohne EPG, keine Favoriten)

'use strict';

const grid = require('./lib/epg-grid.js');
const scheduleUi = require('./lib/recorder/schedule-ui-model.js');

const ROW_HEIGHT = 44;
const DAY_HEIGHT = 30;
const NOW_HEIGHT = 28;
/** „Jetzt“-Trennlinie steht beim Sprung auf dieser Höhe des Viewports. */
const NOW_ANCHOR_RATIO = 0.4;
const PLAN_DAYS = 7;
/** Planungsgrenze des Main (Scheduler.MAX_AHEAD_MS) — die Tests prüfen die Gleichheit. */
const PLAN_MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

const MSG_TOO_FAR = 'Planung nur bis 8 Tage im Voraus';
const LABEL_RECORD = '● Aufnehmen';
const LABEL_CANCEL = '✕ Aufnahme abbrechen';
const LABEL_STOP = '■ Aufnahme stoppen';

const MAX_KEY_LENGTH = 200;

// ── Formatierung ──

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** „Mo 05.10.“ (Kalendertag) */
function calendarLabel(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;
}

/** Beschriftung eines Tages-Tabs: Gestern, Heute, Morgen, sonst „Mi 7.10.“. */
function dayTabLabel(chip) {
  if (chip.offset === -1) return 'Gestern';
  if (chip.offset === 0) return 'Heute';
  if (chip.offset === 1) return 'Morgen';
  return `${WEEKDAYS[chip.weekday]} ${chip.day}.${chip.month}.`;
}

/** Überschrift eines Tages in der Liste: „Heute · Mo 05.10.“ bzw. „Mi 07.10.“ */
function dayHeading(chip) {
  const cal = `${WEEKDAYS[chip.weekday]} ${pad2(chip.day)}.${pad2(chip.month)}.`;
  if (chip.offset === -1) return `Gestern · ${cal}`;
  if (chip.offset === 0) return `Heute · ${cal}`;
  if (chip.offset === 1) return `Morgen · ${cal}`;
  return cal;
}

function durationMinutes(startMs, stopMs) {
  return Math.max(0, Math.round((stopMs - startMs) / grid.MINUTE_MS));
}

/** Sendung nach Mitternacht (vor 05:00): steht beim Vorabend-TV-Tag (M10). */
function isNightStart(startMs) {
  return new Date(startMs).getHours() < grid.TV_DAY_START_HOUR;
}

/** Zeitangabe für das Detail: „20:15–21:00“, bei Nachtsendungen mit Kalenderdatum „Di 06.10. 01:00–02:00“. */
function formatDetailTime(startMs, stopMs) {
  const range = `${clock(startMs)}–${clock(stopMs)}`;
  return isNightStart(startMs) ? `${calendarLabel(startMs)} ${range}` : range;
}

// ── Tage der Tagesleiste ──

/**
 * Tage der Tagesleiste: 7 TV-Tage ab dem heutigen TV-Tag (P8), davor „Gestern“, wenn der
 * Cache Daten davor enthält; Tage ab dem Cache-Ende entfallen. Ohne Abdeckung: [].
 * coverageFromMs/coverageToMs: Cache-Abdeckung (epg:status).
 */
function planDays({ nowMs, coverageFromMs, coverageToMs }) {
  if (!Number.isFinite(coverageToMs) || !Number.isFinite(nowMs)) return [];
  const today = grid.tvDayOf(nowMs);
  const hasYesterday = Number.isFinite(coverageFromMs) && coverageFromMs < today.startMs;
  const fromMs = hasYesterday ? grid.tvDayOf(today.startMs - 1).startMs : today.startMs;
  let end = today;
  for (let i = 1; i < PLAN_DAYS; i += 1) end = grid.tvDayOf(end.endMs);
  return grid
    .dayChips({ fromMs, toMs: end.endMs, nowMs })
    .filter(chip => chip.startMs < coverageToMs)
    .map(chip => ({ ...chip, label: dayTabLabel(chip), heading: dayHeading(chip) }));
}

// ── Senderauswahl ──

/** EPG-Schlüssel eines Senders (wie im Planungsdialog: tvgId), '' wenn nicht abfragbar. */
function epgChannelKey(channel) {
  const key = channel && typeof channel.tvgId === 'string' ? channel.tvgId.trim() : '';
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel (IPC-Validierung)
  if (!key || key.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(key)) return '';
  return key;
}

/**
 * Sender der Liste: nur Sender mit EPG-Schlüssel, je normalisiertem Schlüssel einer
 * (gleiche tvgId in mehreren Quellen → erste Fundstelle). isFavorite filtert, solange
 * showAll nicht gesetzt ist (EPG-E3). Rückgabe: [{ key (roh, für epg:range-many), channel }].
 */
function selectChannels({ channels, isFavorite, showAll }) {
  const seen = new Set();
  const out = [];
  for (const channel of Array.isArray(channels) ? channels : []) {
    if (!showAll && !(typeof isFavorite === 'function' && isFavorite(channel))) continue;
    const key = epgChannelKey(channel);
    if (!key) continue;
    const norm = grid.normalizeKey(key);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ key, channel });
  }
  return out;
}

/** Schlüsselliste in Blöcken (epg:range-many nimmt höchstens 100 Kanäle je Aufruf). */
function chunkKeys(keys, size = 100) {
  const chunks = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  return chunks;
}

// ── Zeilen eines TV-Tags ──

/**
 * Zeilen eines TV-Tags aus den epg:range-many-Antworten (eine oder mehrere Antworten,
 * zu einem Array zusammengefasst). Eine Sendung gehört zum TV-Tag ihres Starts (Nachtsendungen
 * zum Vorabend). Sortiert nach Start, dann Sender-Reihenfolge. channelByKey: roher Schlüssel → Sender.
 */
function buildDayRows(day, results, channelByKey) {
  const rows = [];
  const seen = new Set();
  let rank = 0;
  for (const entry of Array.isArray(results) ? results : []) {
    const channel = channelByKey.get(entry.channelKey);
    const order = rank;
    rank += 1;
    if (!channel) continue;
    for (const slot of Array.isArray(entry.slots) ? entry.slots : []) {
      if (!slot || !Number.isFinite(slot.start) || !Number.isFinite(slot.stop)) continue;
      if (slot.start < day.startMs || slot.start >= day.endMs) continue;
      const id = `${entry.channelKey}|${slot.start}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        order,
        start: slot.start,
        stop: slot.stop,
        title: typeof slot.title === 'string' ? slot.title : '',
        channelKey: entry.channelKey,
        channel,
        dayKey: day.key,
        night: isNightStart(slot.start),
      });
    }
  }
  rows.sort((a, b) => a.start - b.start || a.order - b.order);
  return rows;
}

/** Slot-Form für grid.matchMarkers. */
function markerSlot(row) {
  const ch = row.channel || {};
  return { start: row.start, stop: row.stop, channelKey: row.channelKey, channelId: ch.id || '', tvgId: ch.tvgId || '' };
}

// ── Flaches Layout (Virtualisierung) ──

/**
 * dayData: zusammenhängende Tage [{ day, rows }] in zeitlicher Reihenfolge.
 * Items: { type:'day' } je Tag, { type:'row' } je Sendung, { type:'now' } einmal (vor der ersten
 * Sendung ab „jetzt“ im Tag von nowMs). offsets[i] = Oberkante, offsets[n] = Gesamthöhe.
 */
function buildLayout(dayData, nowMs) {
  const items = [];
  const heights = [];
  const dayIndex = new Map();
  const rowIndex = [];
  let nowIndex = -1;
  for (const { day, rows } of dayData) {
    dayIndex.set(day.key, items.length);
    items.push({ type: 'day', key: `d:${day.key}`, dayKey: day.key, day });
    heights.push(DAY_HEIGHT);
    const holdsNow = Number.isFinite(nowMs) && nowMs >= day.startMs && nowMs < day.endMs;
    let nowAt = rows.length;
    if (holdsNow) {
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (rows[mid].start < nowMs) lo = mid + 1;
        else hi = mid;
      }
      nowAt = lo;
    }
    for (let i = 0; i <= rows.length; i += 1) {
      if (holdsNow && i === nowAt) {
        nowIndex = items.length;
        items.push({ type: 'now', key: 'now', dayKey: day.key, ms: nowMs });
        heights.push(NOW_HEIGHT);
      }
      if (i === rows.length) break;
      rowIndex.push(items.length);
      items.push({ type: 'row', key: `r:${rows[i].id}`, dayKey: day.key, row: rows[i] });
      heights.push(ROW_HEIGHT);
    }
  }
  const offsets = new Float64Array(items.length + 1);
  for (let i = 0; i < items.length; i += 1) offsets[i + 1] = offsets[i] + heights[i];
  let keyMap = null;
  return {
    items,
    offsets,
    dayIndex,
    rowIndex,
    nowIndex,
    total: offsets[items.length],
    count: items.length,
    /** Index des Items mit diesem Schlüssel (Map wird erst bei Bedarf aufgebaut) oder −1. */
    indexOfKey(key) {
      if (!keyMap) {
        keyMap = new Map();
        for (let i = 0; i < items.length; i += 1) keyMap.set(items[i].key, i);
      }
      const idx = keyMap.get(key);
      return idx === undefined ? -1 : idx;
    },
  };
}

/** Index des Items, das die Höhe y enthält (geklemmt auf [0, count−1]; −1 bei leerem Layout). */
function itemIndexAt(layout, y) {
  const n = layout.count;
  if (n === 0) return -1;
  if (y <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (layout.offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Sichtbare Items [from, to) für den Bereich [scrollTop, scrollTop+viewportH) plus overscanPx je Seite. */
function visibleItems(layout, scrollTop, viewportH, overscanPx = 0) {
  if (layout.count === 0) return { from: 0, to: 0 };
  const top = Math.max(0, scrollTop - overscanPx);
  const bottom = scrollTop + viewportH + overscanPx;
  const from = itemIndexAt(layout, top);
  let to = itemIndexAt(layout, bottom);
  if (layout.offsets[to] < bottom) to += 1;
  return { from, to: Math.min(layout.count, Math.max(to, from)) };
}

/**
 * scrollTop, bei dem die „Jetzt“-Trennlinie auf NOW_ANCHOR_RATIO der Viewporthöhe steht; null ohne Linie.
 * headH: Höhe des mitscrollenden Tabellenkopfs (er liegt vor dem Layout und verschiebt es nach unten).
 */
function scrollTopForNow(layout, viewportH, ratio = NOW_ANCHOR_RATIO, headH = 0) {
  if (layout.nowIndex < 0) return null;
  return Math.max(0, layout.offsets[layout.nowIndex] + headH - viewportH * ratio);
}

/** scrollTop für den Beginn (05:00) eines Tages; null wenn der Tag nicht im Layout steht. */
function scrollTopForDay(layout, dayKey) {
  const idx = layout.dayIndex.get(dayKey);
  return idx === undefined ? null : layout.offsets[idx];
}

/** Index (in layout.rowIndex) der ersten Zeile mit Start ≥ ms; rowIndex.length wenn keine. */
function firstRowAtOrAfter(layout, ms) {
  let lo = 0;
  let hi = layout.rowIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (layout.items[layout.rowIndex[mid]].row.start < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** scrollTop, bei dem die erste Zeile ab ms oben steht; null ohne Zeilen. */
function scrollTopForTime(layout, ms) {
  if (!layout.rowIndex.length) return null;
  const i = Math.min(firstRowAtOrAfter(layout, ms), layout.rowIndex.length - 1);
  return layout.offsets[layout.rowIndex[i]];
}

/** Tag, der an der Oberkante (scrollTop) steht — folgt der Scrollposition (Tages-Tabs). */
function activeDayKeyAt(layout, scrollTop) {
  const idx = itemIndexAt(layout, scrollTop + 1);
  return idx < 0 ? null : layout.items[idx].dayKey;
}

/**
 * Aktiver Tag bei Scrollposition scrollTop. pin = { key, top }: ein explizit gewählter Tag (Tab-Klick)
 * bleibt aktiv, solange die Liste an der dabei erreichten Position steht — auch wenn scrollTop wegen
 * zu kurzer Liste auf 0 oder das Ende geklemmt ist. Scrollt der Nutzer weg, folgt der Tab wieder.
 * Rückgabe: { key, pin } (pin null, sobald aufgehoben).
 */
function resolveActiveDay(layout, scrollTop, pin) {
  if (pin && Math.abs(scrollTop - pin.top) < 2) return { key: pin.key, pin };
  return { key: activeDayKeyAt(layout, scrollTop), pin: null };
}

/** Startzeit der obersten (ganz oder teilweise sichtbaren) Zeile — Scroll-Anker, moduswechsel-fähig. */
function anchorTimeAt(layout, scrollTop) {
  const idx = itemIndexAt(layout, scrollTop);
  if (idx < 0) return null;
  for (let i = idx; i < layout.count; i += 1) {
    if (layout.items[i].type === 'row') return layout.items[i].row.start;
  }
  const last = layout.rowIndex.length ? layout.items[layout.rowIndex[layout.rowIndex.length - 1]].row : null;
  return last ? last.start : null;
}

// ── Phase / Fortschritt ──

function rowPhase(row, nowMs) {
  const phase = grid.slotPhase(row, nowMs);
  return {
    phase,
    progress: phase === 'now' ? grid.slotProgress(row, nowMs) : phase === 'past' ? 1 : 0,
    minutesLeft: grid.minutesLeft(row, nowMs),
  };
}

// ── Aufnahme-Toggle ──

/**
 * Zustand des einheitlichen Toggles einer Sendung.
 *   marker: Ergebnis von grid.matchMarkers (null | {state, ids})
 *   record: „● Aufnehmen“ (Zukunftsregel greift beim Klick im bestehenden Weg; > 8 Tage voraus
 *           ist der Button deaktiviert, P9)
 *   cancel: „✕ Aufnahme abbrechen“ (geplant, mit Rückfrage)
 *   stop:   „■ Aufnahme stoppen“ (laufend, immer mit Rückfrage)
 */
function toggleState({ row, marker, nowMs }) {
  if (marker && marker.state === 'recording') {
    return { kind: 'stop', label: LABEL_STOP, disabled: false, hint: '', verdict: null };
  }
  if (marker && marker.state === 'scheduled') {
    return { kind: 'cancel', label: LABEL_CANCEL, disabled: false, hint: '', verdict: null };
  }
  const verdict = scheduleUi.classifyProgramme(row.start, row.stop, nowMs);
  if (verdict.state === 'future' && row.start > nowMs + PLAN_MAX_AHEAD_MS) {
    return { kind: 'record', label: LABEL_RECORD, disabled: true, hint: MSG_TOO_FAR, verdict: verdict.state };
  }
  return { kind: 'record', label: LABEL_RECORD, disabled: false, hint: '', verdict: verdict.state };
}

/**
 * Ziele von Abbrechen/Stoppen aus einem Marker: Planungs-IDs (sch_…) zum Absagen, Aufnahme-IDs
 * (rec_…) zum Stoppen (direkt oder über recId des laufenden Planungseintrags), Titel für die Rückfrage.
 */
function resolveMarkerTargets(marker, schedules) {
  const out = { scheduleIds: [], recIds: [], titles: [] };
  if (!marker || !Array.isArray(marker.ids)) return out;
  const byId = new Map((Array.isArray(schedules) ? schedules : []).map(e => [e.id, e]));
  for (const id of marker.ids) {
    if (typeof id !== 'string') continue;
    const entry = byId.get(id);
    if (id.startsWith('rec_')) {
      if (!out.recIds.includes(id)) out.recIds.push(id);
      continue;
    }
    if (!entry) continue;
    if (marker.state === 'scheduled') {
      out.scheduleIds.push(id);
    } else if (typeof entry.recId === 'string' && entry.recId && !out.recIds.includes(entry.recId)) {
      out.recIds.push(entry.recId);
    }
    if (entry.title && !out.titles.includes(entry.title)) out.titles.push(entry.title);
  }
  return out;
}

/** Rückfrage-Texte des Toggles; title = Titel der Sendung bzw. des (zusammengelegten) Eintrags. */
function confirmCopy(kind, title) {
  const name = scheduleUi.sanitizeLabel(title, 120) || 'Aufnahme';
  if (kind === 'cancel') {
    return { message: `Geplante Aufnahme „${name}“ abbrechen?`, yes: 'Ja, abbrechen', no: 'Behalten' };
  }
  return {
    message: `Laufende Aufnahme „${name}“ stoppen? Die bisher aufgenommene Zeit bleibt erhalten.`,
    yes: 'Ja, stoppen',
    no: 'Weiter aufnehmen',
  };
}

// ── Anzeigezustand ──

/**
 * Welcher Zustand wird gezeigt (M9)? Reihenfolge: Fehler → Quelle ohne EPG → lädt → Cache leer →
 * keine Favoriten (P14) → keine Sendungen → bereit.
 *   status: epg:status (oder null), loadError: Text oder '', loading: Daten werden gerade geholt,
 *   channelCount: Sender mit EPG-Schlüssel in der Auswahl, hasFavorites: Favoriten vorhanden (P14),
 *   showAll: „Alle Sender“ gewählt, rowCount: Zeilen in den geladenen Tagen, hasDays: Tage mit Daten im Cache.
 */
function deriveViewState({ status, loadError, loading, channelCount, hasFavorites, showAll, rowCount, hasDays }) {
  if (loadError) {
    return { kind: 'error', title: 'EPG konnte nicht geladen werden', text: loadError, action: 'refresh' };
  }
  const sources = status && Array.isArray(status.sources) ? status.sources : [];
  const configured = sources.filter(s => s.configured);
  if (status && configured.length === 0) {
    return {
      kind: 'no-source',
      title: 'Keine EPG-Quelle',
      text: 'Für die TV-Quellen ist keine EPG-URL hinterlegt. Trage sie in den Einstellungen unter LiveTV → Quellen ein.',
      action: null,
    };
  }
  if (loading || (status && status.refreshing && !hasDays)) {
    return { kind: 'loading', title: 'EPG wird geladen …', text: '', action: null };
  }
  if (status && !hasDays) {
    const failed = configured.find(s => s.lastError);
    return {
      kind: 'empty',
      title: 'Noch keine EPG-Daten',
      text: failed ? `Der letzte Abruf ist fehlgeschlagen: ${failed.lastError}` : 'Der EPG-Cache ist noch leer.',
      action: 'refresh',
    };
  }
  if (!showAll && !hasFavorites) {
    return {
      kind: 'no-favorites',
      title: 'Keine Favoriten',
      text: 'Markiere Sender in der TV-Seitenleiste als Favorit oder zeige alle Sender.',
      action: 'show-all',
    };
  }
  if (channelCount === 0 || rowCount === 0) {
    return {
      kind: 'no-programmes',
      title: 'Kein Programm',
      text: 'Für die gewählten Sender liegt kein Programm im EPG-Cache vor.',
      action: showAll ? 'refresh' : 'show-all',
    };
  }
  return { kind: 'ready', title: '', text: '', action: null };
}

// ── Ansichtszustand (gemeinsam für Liste und Raster) ──

const MODES = ['list', 'grid'];

/**
 * Gemeinsamer Zustand: Modus, Tag, Scroll-Anker (Zeitpunkt statt Pixel → in jedem Modus
 * wiederherstellbar), Auswahl, „Alle Sender“ (Sitzungsvariable, P14). Ein Moduswechsel
 * ändert nur den Modus.
 */
function createViewState(initial = {}) {
  const state = {
    mode: MODES.includes(initial.mode) ? initial.mode : 'list',
    dayKey: initial.dayKey || null,
    anchorMs: Number.isFinite(initial.anchorMs) ? initial.anchorMs : null,
    selectedRowId: initial.selectedRowId || null,
    showAll: !!initial.showAll,
  };
  return {
    get mode() {
      return state.mode;
    },
    get dayKey() {
      return state.dayKey;
    },
    get anchorMs() {
      return state.anchorMs;
    },
    get selectedRowId() {
      return state.selectedRowId;
    },
    get showAll() {
      return state.showAll;
    },
    setMode(mode) {
      if (!MODES.includes(mode)) return false;
      state.mode = mode;
      return true;
    },
    setDay(dayKey) {
      state.dayKey = dayKey || null;
    },
    setAnchor(ms) {
      state.anchorMs = Number.isFinite(ms) ? ms : null;
    },
    select(rowId) {
      state.selectedRowId = rowId || null;
    },
    setShowAll(value) {
      state.showAll = !!value;
    },
    snapshot() {
      return { ...state };
    },
  };
}

module.exports = {
  ROW_HEIGHT,
  DAY_HEIGHT,
  NOW_HEIGHT,
  NOW_ANCHOR_RATIO,
  PLAN_DAYS,
  PLAN_MAX_AHEAD_MS,
  MSG_TOO_FAR,
  LABEL_RECORD,
  LABEL_CANCEL,
  LABEL_STOP,
  clock,
  calendarLabel,
  dayTabLabel,
  dayHeading,
  durationMinutes,
  isNightStart,
  formatDetailTime,
  planDays,
  epgChannelKey,
  selectChannels,
  chunkKeys,
  buildDayRows,
  markerSlot,
  buildLayout,
  itemIndexAt,
  visibleItems,
  scrollTopForNow,
  scrollTopForDay,
  scrollTopForTime,
  activeDayKeyAt,
  resolveActiveDay,
  anchorTimeAt,
  rowPhase,
  toggleState,
  resolveMarkerTargets,
  confirmCopy,
  deriveViewState,
  createViewState,
};
