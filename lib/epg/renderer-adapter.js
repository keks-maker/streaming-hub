// Adapter zwischen den Main-EPG-APIs (epg:now-next, epg:range-many; Zeiten in ms)
// und den Renderer-/tv.html-Verbrauchern (XMLTV-Zeitstrings "YYYYMMDDHHMMSS +0000").
// Reine Funktionen ohne DOM/IPC (Unit-Tests: tests/epg-renderer-adapter.test.js).
// Die Titel stammen aus fremden EPG-Daten und sind im Main bereits entity-dekodiert:
// Verbraucher rendern sie nur als Text (textContent).

'use strict';

/** Maximale Kanalzahl je epg:now-next-Aufruf (Main-Limit). */
const NOW_NEXT_CHUNK = 600;

/** Normalisierter EPG-Schlüssel eines Kanals (wie typed-core normalizeEpgId: ohne @Suffix, klein, getrimmt). */
function normEpgKey(id) {
  return String(id || '')
    .replace(/@[^.@]*/g, '')
    .toLowerCase()
    .trim();
}

/** EPG-Schlüssel eines Senders: tvg-id, ohne tvg-id der Name (wie die frühere Zuordnung der Player-Senderliste). */
function channelEpgKey(ch) {
  return ch ? normEpgKey(ch.tvgId || ch.name) : '';
}

/** ms → XMLTV-Zeitstring in UTC ("20261006120000 +0000"); ungültig → ''. */
function msToXmltvTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    p(d.getUTCFullYear(), 4) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    ' +0000'
  );
}

/** Main-Slot {start, stop, title, ...} (ms) → XMLTV-Eintrag {title, start, stop} (Strings) oder null. */
function slotToXmltvEntry(slot) {
  if (!slot || typeof slot !== 'object') return null;
  const start = msToXmltvTime(slot.start);
  const stop = msToXmltvTime(slot.stop);
  if (!start || !stop) return null;
  return { title: typeof slot.title === 'string' ? slot.title : '', start, stop };
}

function slotsToXmltvEntries(slots) {
  return (Array.isArray(slots) ? slots : []).map(slotToXmltvEntry).filter(Boolean);
}

/** Antwort von epg:now-next ([{channelKey, current, next}]) → Map<channelKey, {current, next}>. */
function nowNextToMap(result) {
  const map = new Map();
  if (!Array.isArray(result)) return map;
  for (const row of result) {
    if (!row || typeof row.channelKey !== 'string') continue;
    map.set(row.channelKey, { current: row.current || null, next: row.next || null });
  }
  return map;
}

/**
 * Zeitliche Fortschreibung eines gecachten Jetzt/Nächste-Eintrags: ist die laufende Sendung zu Ende, rückt
 * "next" nach (sofern sie schon läuft), sonst bleibt nichts Laufendes. Ohne Eintrag: {current: null, next: null}.
 */
function resolveNowNext(entry, nowMs) {
  let current = entry && entry.current ? entry.current : null;
  let next = entry && entry.next ? entry.next : null;
  if (current && current.stop <= nowMs) current = null;
  if (!current && next && next.start <= nowMs && nowMs < next.stop) {
    current = next;
    next = null;
  }
  if (next && next.stop <= nowMs) next = null;
  return { current, next };
}

/** Liste in Teilstücke der Größe size zerlegen. */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

module.exports = {
  NOW_NEXT_CHUNK,
  normEpgKey,
  channelEpgKey,
  msToXmltvTime,
  slotToXmltvEntry,
  slotsToXmltvEntries,
  nowNextToMap,
  resolveNowNext,
  chunk,
};
