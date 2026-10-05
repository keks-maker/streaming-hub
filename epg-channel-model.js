// Zustandsmodell der Kanalansicht (Etappe 3.4, Design B2 „Kanalansicht“)
//
// Rein und DOM-frei: keine Uhr (nowMs ist immer Parameter). Die Kanalansicht ist ein MODUS im
// Overlay (P7): sie liegt über Liste/Raster, dessen Zustand (Modus, Tag, Zeitanker, Zoom,
// Scrollposition, Auswahl) beim Wechsel gemerkt und beim Zurück wiederhergestellt wird.
//
// Bausteine:
//   - 7 TV-Tage ab dem heutigen TV-Tag (P8, 05:00–05:00) über lib/epg-grid.js, Abruf-Bereich
//   - Gruppierung eines Kanals in TV-Tage (Nachtsendungen beim Vorabend) über buildDayRows
//   - Kennzeichnung „Jetzt“/„Nächste“, Slot-Status (vorbei/läuft/zukünftig/> 8 Tage, P9)
//   - aktiver Tag zur Scrollposition, Datensignatur (kein Neuaufbau bei unveränderten Daten)
//   - Anzeigezustand (M9): lädt, Fehler, Quelle ohne EPG, Cache leer, kein Programm im Zeitraum
//   - Ansichtszustand der Kanalansicht samt Herkunfts-Snapshot

'use strict';

const grid = require('./lib/epg-grid.js');
const viewModel = require('./epg-view-model.js');

const CHANNEL_DAYS = viewModel.PLAN_DAYS;
const MAX_EXTENDED_DAYS = 14;

// ── Tage ──

/**
 * 7 TV-Tage ab dem heutigen TV-Tag (P8). Jeder Tag trägt label (Tab), heading (Kopf in der Liste)
 * und beyondCache (Tag beginnt hinter dem Cache-Ende: es kann keine Daten geben). coverageToMs: epg:status.
 * extended („+ Weitere Tage“, Mockup „+ Cache-Tage“): zusätzlich die Tage 8–14, soweit der Cache reicht —
 * dort liegen Sendungen jenseits der 8-Tage-Planungsgrenze (P9).
 */
function channelDays({ nowMs, coverageToMs, extended = false }) {
  if (!Number.isFinite(nowMs)) return [];
  const hasCoverage = Number.isFinite(coverageToMs);
  const today = grid.tvDayOf(nowMs);
  let end = today;
  for (let i = 1; i < CHANNEL_DAYS; i += 1) end = grid.tvDayOf(end.endMs);
  if (extended && hasCoverage) {
    for (let i = CHANNEL_DAYS; i < MAX_EXTENDED_DAYS && end.endMs < coverageToMs; i += 1) end = grid.tvDayOf(end.endMs);
  }
  return grid
    .dayChips({ fromMs: today.startMs, toMs: end.endMs, nowMs })
    .map(chip => ({
      ...chip,
      label: viewModel.dayTabLabel(chip),
      heading: viewModel.dayHeading(chip),
      beyondCache: !hasCoverage || chip.startMs >= coverageToMs,
    }));
}

/** Reicht der Cache über die 7 TV-Tage hinaus (dann gibt es „+ Weitere Tage“)? */
function hasMoreDays({ nowMs, coverageToMs }) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(coverageToMs)) return false;
  let end = grid.tvDayOf(nowMs);
  for (let i = 1; i < CHANNEL_DAYS; i += 1) end = grid.tvDayOf(end.endMs);
  return end.endMs < coverageToMs;
}

/** Abruf-Bereich [fromMs, toMs) über alle Tage; null ohne Tage. */
function channelRange(days) {
  if (!Array.isArray(days) || !days.length) return null;
  return { fromMs: days[0].startMs, toMs: days[days.length - 1].endMs };
}

// ── Gruppierung ──

/**
 * Ein Kanal in TV-Tage: [{ day, rows, empty }] in Tagesfolge (jeder Tag auch ohne Sendungen).
 * slots: Antwort von epg:range-many für genau diesen Kanal (schlanke Slots). Eine Sendung gehört
 * zum TV-Tag ihres Starts; Nachtsendungen (vor 05:00) stehen beim Vorabend und tragen night = true.
 * Ausnahme: die beim Öffnen noch laufende Sendung vom Vorabend-TV-Tag steht am Anfang des ersten Tages.
 */
function groupByDay({ days, slots, channelKey, channel }) {
  const channelByKey = new Map([[channelKey, channel]]);
  const list = (Array.isArray(slots) ? slots : []).filter(Boolean);
  return days.map((day, index) => {
    // Erster Tag: eine Sendung, die vor 05:00 des heutigen TV-Tags begann und noch läuft (z. B. 04:40–05:30),
    // gehört zum Vorabend-TV-Tag, wäre aber sonst unsichtbar — sie steht am Anfang des ersten Tages (Badge „Nacht“).
    const first = index === 0;
    const scope = first ? { ...day, startMs: Number.NEGATIVE_INFINITY } : day;
    const input = first ? list.filter(slot => slot.stop > day.startMs) : list;
    const rows = viewModel.buildDayRows(scope, [{ channelKey, slots: input }], channelByKey).map(row => ({ ...row, dayKey: day.key }));
    return { day, rows, empty: rows.length === 0 };
  });
}

function allRows(dayData) {
  const rows = [];
  for (const entry of dayData) for (const row of entry.rows) rows.push(row);
  return rows;
}

function rowTotal(dayData) {
  let n = 0;
  for (const entry of dayData) n += entry.rows.length;
  return n;
}

/** Signatur der Daten: gleiche Signatur → Liste muss nicht neu aufgebaut werden (epg:changed ohne Änderung). */
function dataSignature(dayData) {
  const parts = [];
  for (const entry of dayData) {
    parts.push(entry.day.key);
    for (const row of entry.rows) parts.push(`${row.start}-${row.stop}-${row.genre}-${row.title}`);
  }
  return parts.join('\n');
}

// ── Status und Kennzeichnung ──

/**
 * Status einer Sendung für die Anzeige: 'past' | 'now' | 'future' | 'too-far' (Start mehr als 8 Tage voraus,
 * Planung nicht möglich, P9). Die Zukunftsregel selbst (laufend/vorbei → Meldung) bleibt im bestehenden Weg.
 */
function slotStatus(row, nowMs) {
  const phase = grid.slotPhase(row, nowMs);
  if (phase === 'future' && row.start > nowMs + viewModel.PLAN_MAX_AHEAD_MS) return 'too-far';
  return phase;
}

/**
 * Hervorhebung: running = laufende Sendung (Start ≤ jetzt < Ende), next = die erste Sendung mit
 * Start > jetzt über alle Tage. Beide null, wenn es sie nicht gibt.
 */
function highlights(dayData, nowMs) {
  let running = null;
  let next = null;
  for (const entry of dayData) {
    for (const row of entry.rows) {
      if (!running && row.start <= nowMs && nowMs < row.stop) running = row;
      if (!next && row.start > nowMs) next = row;
    }
  }
  return { running, next };
}

/** Kennzeichen einer Zeile: 'now' | 'next' | ''. */
function flagFor(row, marks) {
  if (marks.running && marks.running.id === row.id) return 'now';
  if (marks.next && marks.next.id === row.id) return 'next';
  return '';
}

/** Zeile unter dem Kanalnamen: „Jetzt läuft: …“, sonst „Als Nächstes: …“, sonst Hinweis. */
function nowLine(dayData, nowMs) {
  const marks = highlights(dayData, nowMs);
  if (marks.running) {
    return {
      kind: 'running',
      label: 'Jetzt läuft: ',
      title: marks.running.title || '(ohne Titel)',
      suffix: ` · noch ${grid.minutesLeft(marks.running, nowMs)} min`,
    };
  }
  if (marks.next) {
    return { kind: 'next', label: 'Als Nächstes: ', title: marks.next.title || '(ohne Titel)', suffix: ` · ${viewModel.clock(marks.next.start)}` };
  }
  return { kind: 'none', label: 'Gerade keine Sendung im EPG', title: '', suffix: '' };
}

// ── Scrollen ──

/**
 * Aktiver Tag zur Scrollposition. dayTops: [{ key, top }] aufsteigend (Oberkante der Tag-Köpfe).
 * pin = { key, top }: explizit gewählter Tag bleibt aktiv, solange die Liste an dieser Position steht
 * (auch wenn die Liste zu kurz zum Scrollen ist); scrollt der Nutzer weg, folgt der Tab wieder.
 * Rückgabe { key, pin }.
 */
function resolveActiveDay(dayTops, scrollTop, pin) {
  if (pin && Math.abs(scrollTop - pin.top) < 2) return { key: pin.key, pin };
  let key = dayTops.length ? dayTops[0].key : null;
  for (const entry of dayTops) {
    if (entry.top <= scrollTop + 1) key = entry.key;
    else break;
  }
  return { key, pin: null };
}

/**
 * Wohin scrollt die Liste beim Öffnen/„Jetzt“? Heute (oder kein Tag gewählt): auf die laufende bzw. die
 * nächste Sendung, sonst auf den Tag; anderer Tag: 05:00 dieses Tages (Tag-Kopf).
 * Rückgabe { kind: 'row', rowId } | { kind: 'day', dayKey } | null.
 */
function initialTarget({ dayData, dayKey, todayKey, nowMs }) {
  if (!dayData.length) return null;
  const wanted = dayKey && dayData.some(e => e.day.key === dayKey) ? dayKey : todayKey;
  if (wanted === todayKey) {
    const marks = highlights(dayData, nowMs);
    const target = marks.running || marks.next;
    if (target) {
      const holder = dayData.find(e => e.rows.includes(target));
      // nur im Heute-Block anspringen; die nächste Sendung kann schon morgen liegen → dann Tagesanfang
      if (holder && holder.day.key === todayKey) return { kind: 'row', rowId: target.id };
    }
  }
  return dayData.some(e => e.day.key === wanted) ? { kind: 'day', dayKey: wanted } : { kind: 'day', dayKey: dayData[0].day.key };
}

// ── Anzeigezustand (M9) ──

/**
 * Welcher Zustand wird in der Kanalansicht gezeigt? Reihenfolge: Fehler → Quelle ohne EPG → lädt →
 * Cache leer → kein Programm im Zeitraum → bereit.
 *   status: epg:status (oder null), loadError: Text oder '', loading: Daten werden geholt,
 *   rowCount: Sendungen aller 7 Tage, hasCoverage: der Cache enthält überhaupt Daten.
 */
function deriveChannelState({ status, loadError, loading, rowCount, hasCoverage, channelName }) {
  if (loadError) {
    return { kind: 'error', title: 'Programm konnte nicht geladen werden', text: loadError, action: 'refresh' };
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
  if (loading || (status && status.refreshing && !hasCoverage)) {
    return { kind: 'loading', title: 'Programm wird geladen …', text: '', action: null };
  }
  if (status && !hasCoverage) {
    const failed = configured.find(s => s.lastError);
    return {
      kind: 'empty',
      title: 'Noch keine EPG-Daten',
      text: failed ? `Der letzte Abruf ist fehlgeschlagen: ${failed.lastError}` : 'Der EPG-Cache ist noch leer.',
      action: 'refresh',
    };
  }
  if (rowCount === 0) {
    return {
      kind: 'no-programmes',
      title: 'Kein Programm',
      text: `Für ${channelName || 'diesen Sender'} liegt in den nächsten 7 TV-Tagen kein Programm im EPG-Cache vor.`,
      action: 'refresh',
    };
  }
  return { kind: 'ready', title: '', text: '', action: null };
}

/** Hinweis für einen Tag ohne Sendungen. */
function emptyDayNote(day) {
  return day.beyondCache ? 'Für diesen TV-Tag liegt noch kein EPG im Cache.' : 'Für diesen TV-Tag liegen keine Sendungen im Cache.';
}

// ── Ansichtszustand der Kanalansicht ──

/** Anzeigedaten des Senders (Name, Logo-URL roh); Prüfung der URL macht die View (safeResourceUrl). */
function channelMeta(channel) {
  const key = viewModel.epgChannelKey(channel);
  const name = channel && typeof channel.name === 'string' && channel.name.trim() ? channel.name.trim() : key;
  return { key, name, logo: channel && typeof channel.logo === 'string' ? channel.logo : '' };
}

/**
 * Zustand der Kanalansicht: aktiver Kanal, gewählter Tag und der Herkunfts-Snapshot (alles, was die
 * Herkunftsansicht zum Wiederherstellen braucht). enter() merkt den Snapshot, leave() gibt ihn heraus.
 * Der Kanal-Zustand selbst (Tag) bleibt beim Verlassen NICHT erhalten: jeder Einstieg beginnt „heute“.
 */
function createChannelState() {
  let channel = null;
  let meta = null;
  let dayKey = null;
  let origin = null;
  let extended = false;
  return {
    get active() {
      return meta !== null;
    },
    get channel() {
      return channel;
    },
    get meta() {
      return meta;
    },
    get key() {
      return meta ? meta.key : null;
    },
    get dayKey() {
      return dayKey;
    },
    get origin() {
      return origin;
    },
    get extended() {
      return extended;
    },
    /** Kanalmodus betreten. false, wenn der Sender keinen EPG-Schlüssel hat. */
    enter(nextChannel, snapshot) {
      const nextMeta = channelMeta(nextChannel);
      if (!nextMeta.key) return false;
      // Wechsel Kanal → Kanal (Modal-Link in der Kanalansicht): der Herkunfts-Snapshot bleibt der erste
      if (!meta) origin = snapshot ? { ...snapshot } : null;
      channel = nextChannel;
      meta = nextMeta;
      dayKey = null;
      extended = false;
      return true;
    },
    /** Kanalmodus verlassen: liefert den Herkunfts-Snapshot (oder null). */
    leave() {
      const snapshot = origin;
      channel = null;
      meta = null;
      dayKey = null;
      origin = null;
      extended = false;
      return snapshot;
    },
    setDay(key) {
      dayKey = key || null;
    },
    setExtended(value) {
      extended = !!value;
    },
  };
}

module.exports = {
  CHANNEL_DAYS,
  MAX_EXTENDED_DAYS,
  channelDays,
  hasMoreDays,
  channelRange,
  groupByDay,
  allRows,
  rowTotal,
  dataSignature,
  slotStatus,
  highlights,
  flagFor,
  nowLine,
  resolveActiveDay,
  initialTarget,
  deriveChannelState,
  emptyDayNote,
  channelMeta,
  createChannelState,
};
