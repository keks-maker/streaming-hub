// Suche des Programmführers (Etappe 3.5, M8/P11) — rein und DOM-frei.
//
// Die Suche läuft über epg:search im Main (gefaltet: Umlaute/Groß-/Kleinschreibung, siehe lib/epg-text.js)
// über die gewählte Senderauswahl und den Cache-Zeitraum. Hier: Eingabe prüfen (2–80 Zeichen),
// Abfragen planen (ein Aufruf nimmt höchstens 600 Kanäle), Teilantworten zusammenführen,
// Veraltungsschutz (Anfragenzähler) und der abgeleitete Anzeigezustand.

'use strict';

const viewModel = require('./epg-view-model.js');

const MIN_QUERY = 2;
const MAX_QUERY = 80;
const DEBOUNCE_MS = 250;
/** Treffer je Anzeige (Main-Obergrenze ist 200); darüber: Hinweis, die Suche einzugrenzen. */
const RESULT_LIMIT = 100;
/** Kanäle je epg:search-Aufruf (Main-Grenze). */
const MAX_KEYS_PER_CALL = 600;
const MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g; // eslint-disable-line no-control-regex

/**
 * Eingabe → { text, state }. text: getrimmt, ohne Steuerzeichen, auf 80 Zeichen gekürzt.
 * state: 'idle' (leer) | 'short' (1 Zeichen) | 'ready' (2–80 Zeichen).
 */
function normalizeQuery(raw) {
  const text = (typeof raw === 'string' ? raw : '').replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_QUERY).trim();
  if (!text) return { text: '', state: 'idle' };
  return { text, state: text.length < MIN_QUERY ? 'short' : 'ready' };
}

/**
 * Abfrageplan: Kanalschlüssel in Blöcken à 600 und der Zeitraum vom ersten angezeigten Tag bis zum
 * Cache-Ende (höchstens 14 Tage). null, wenn nichts abzufragen ist (keine Sender oder kein Zeitraum).
 */
function searchPlan({ keys, days, coverageToMs }) {
  if (!Array.isArray(keys) || !keys.length || !Array.isArray(days) || !days.length || !Number.isFinite(coverageToMs)) return null;
  const fromMs = days[0].startMs;
  const toMs = Math.min(coverageToMs, fromMs + MAX_RANGE_MS);
  if (!(toMs > fromMs)) return null;
  const chunks = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) chunks.push(keys.slice(i, i + MAX_KEYS_PER_CALL));
  return { chunks, fromMs, toMs };
}

/** Teilantworten ({ results, truncated }) → { results (nach Start, dann Stop, höchstens limit), truncated }. */
function mergeResults(parts, limit = RESULT_LIMIT) {
  const hits = [];
  let truncated = false;
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || !Array.isArray(part.results)) continue;
    if (part.truncated) truncated = true;
    for (const hit of part.results) if (hit && Number.isFinite(hit.start) && Number.isFinite(hit.stop)) hits.push(hit);
  }
  hits.sort((a, b) => a.start - b.start || a.stop - b.stop);
  if (hits.length > limit) truncated = true;
  return { results: hits.slice(0, limit), truncated };
}

/**
 * Treffer → Zeilen im Format der Liste (für das Detail-Modal). Treffer eines Senders, der nicht (mehr) in
 * channelByKey steht, entfallen. byId: bereits geladene Zeilen (haben das Genre) werden bevorzugt.
 */
function hitsToRows(results, channelByKey, byId) {
  const rows = [];
  for (const hit of Array.isArray(results) ? results : []) {
    const channel = channelByKey.get(hit.channelKey);
    if (!channel) continue;
    const id = `${hit.channelKey}|${hit.start}`;
    const known = byId && typeof byId.get === 'function' ? byId.get(id) : null;
    rows.push(known || viewModel.slotToRow({ channelKey: hit.channelKey, channel, slot: hit }));
  }
  return rows;
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** „Di 20:15“; weiter als 6 Tage von jetzt entfernt (oder vergangen) mit Datum: „Di 13.10. 20:15“. */
function hitWhen(startMs, nowMs) {
  const near = Math.abs(startMs - nowMs) < 6 * 24 * 60 * 60 * 1000;
  return near ? `${WEEKDAYS[new Date(startMs).getDay()]} ${viewModel.clock(startMs)}` : `${viewModel.calendarLabel(startMs)} ${viewModel.clock(startMs)}`;
}

/** Zeile der Trefferliste: Titel · Sender · Wochentag Uhrzeit. */
function hitParts(row, nowMs) {
  return {
    title: row.title || '(ohne Titel)',
    channel: row.channel.name || row.channelKey,
    when: hitWhen(row.start, nowMs),
  };
}

/**
 * Anzeigezustand der Suche.
 *   queryState 'idle'|'short'|'ready', keyCount: Sender in der Auswahl, hasPlan: Zeitraum vorhanden,
 *   loading, error (Text), total (Treffer), truncated
 * → { kind: 'idle'|'short'|'no-channels'|'loading'|'error'|'empty'|'results', text }
 */
function deriveSearchState({ queryState, keyCount, hasPlan, loading, error, total, truncated, includeDesc }) {
  if (queryState === 'idle') return { kind: 'idle', text: '' };
  if (queryState === 'short') return { kind: 'short', text: `Bitte mindestens ${MIN_QUERY} Zeichen eingeben.` };
  if (!keyCount) return { kind: 'no-channels', text: 'Keine Sender in der Auswahl. Wähle über „Sender“ andere Sender aus.' };
  if (!hasPlan) return { kind: 'empty', text: 'Keine Treffer: Der EPG-Cache enthält noch keine Daten.' };
  if (error) return { kind: 'error', text: `Suche fehlgeschlagen: ${error}` };
  if (loading) return { kind: 'loading', text: 'Suche läuft …' };
  if (!total) {
    return { kind: 'empty', text: includeDesc ? 'Keine Treffer in Titeln und Beschreibungen.' : 'Keine Treffer in den Titeln. Unter „Mehr“ lässt sich die Beschreibung mitdurchsuchen.' };
  }
  return { kind: 'results', text: truncated ? `Mehr als ${total} Treffer — Suchbegriff eingrenzen oder Sender auswählen.` : '' };
}

/** Anfragenzähler: nur die Antwort der jüngsten Anfrage zählt (alte Antworten werden verworfen). */
function createRequestCounter() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent: id => id === current,
    /** Alle laufenden Anfragen verwerfen (Suche geschlossen). */
    cancel() {
      current += 1;
    },
  };
}

module.exports = {
  MIN_QUERY,
  MAX_QUERY,
  DEBOUNCE_MS,
  RESULT_LIMIT,
  MAX_KEYS_PER_CALL,
  normalizeQuery,
  searchPlan,
  mergeResults,
  hitsToRows,
  hitWhen,
  hitParts,
  deriveSearchState,
  createRequestCounter,
};
