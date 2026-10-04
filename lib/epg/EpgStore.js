// EpgStore: Wochen-Cache der EPG-Daten im Main-Prozess (Etappe 1; Konzept §3.2)
//
// Hält je EPG-URL (= je TV-Quelle mit epgUrl) die Sendungen je Kanal als
// sortierte Slots {start, stop, title, desc} (UTC-ms) im Speicher und
// persistiert sie kompakt in userData/epg-cache.json. Beim Start ist der Cache
// sofort nutzbar (load()), ein Refresh läuft im Hintergrund (EpgService).
//
// Kanal-Schlüssel: dieselbe Normalisierung wie im Renderer (typed-core
// normalizeTvId: "ard@hdr.de" → "ard.de", lower-case) — eine Funktion, nicht neu
// erfunden. Abfragen akzeptieren Roh-IDs (tvgId) und normalisieren selbst.
//
// SRP: Datenhaltung + Persistenz + Abfrage. Download/Parsing/Takt: EpgService.

'use strict';

const fs = require('fs');
const path = require('path');
const { setImmediate } = require('timers');
const { normalizeTvId } = require('@streaming-hub/typed-core');
const { foldText } = require('../epg-text.js');

const CACHE_FILE = 'epg-cache.json';
const CACHE_VERSION = 1;
// range-many: harte Obergrenze der Gesamtslots je Aufruf (Antwortgröße / Main-Blockade)
const RANGE_MANY_MAX_SLOTS = 25000;
// search: Slots je Scheibe, danach setImmediate (Event-Loop frei halten)
const SEARCH_SLICE_SLOTS = 4000;

function channelKey(id) {
  return normalizeTvId(typeof id === 'string' ? id : '');
}

/**
 * Sortiert, entfernt exakte Duplikate (gleicher Start+Stop) und löst Überlappungen
 * nicht auf (Quelle bleibt maßgeblich).
 */
function finalizeSlots(slots) {
  slots.sort((a, b) => a.start - b.start || a.stop - b.stop);
  const out = [];
  for (const slot of slots) {
    const prev = out[out.length - 1];
    if (prev && prev.start === slot.start && prev.stop === slot.stop) continue;
    out.push(slot);
  }
  return out;
}

function createEpgStore({ dir, logger = null, fileName = CACHE_FILE } = {}) {
  if (!dir) throw new Error('EpgStore benötigt dir (userData)');
  const file = path.join(dir, fileName);
  // url → { fetchedAt, sourceIds, channels: Map<key, Slot[]>, slotCount, fromMs, toMs }
  const sources = new Map();

  function log(level, message) {
    if (logger && typeof logger[level] === 'function') logger[level](`[epg] ${message}`);
  }

  function summarize(channels) {
    let slotCount = 0;
    let fromMs = Infinity;
    let toMs = -Infinity;
    for (const slots of channels.values()) {
      slotCount += slots.length;
      if (slots.length) {
        fromMs = Math.min(fromMs, slots[0].start);
        for (const slot of slots) toMs = Math.max(toMs, slot.stop);
      }
    }
    return { slotCount, fromMs: Number.isFinite(fromMs) ? fromMs : null, toMs: Number.isFinite(toMs) ? toMs : null };
  }

  /**
   * Cache laden (async, damit der App-Start nicht blockiert). Fehlende/defekte
   * Datei → leerer Cache (kein Wurf). Rückgabe: Anzahl geladener Quellen.
   */
  async function load() {
    let raw;
    try {
      raw = await fs.promises.readFile(file, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') log('warn', `Cache nicht lesbar: ${e.message}`);
      return 0;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      log('warn', `Cache defekt, wird ignoriert: ${e.message}`);
      return 0;
    }
    if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.sources !== 'object' || !parsed.sources) {
      log('warn', 'Cache hat unbekanntes Format, wird ignoriert');
      return 0;
    }
    sources.clear();
    for (const [url, src] of Object.entries(parsed.sources)) {
      if (!src || typeof src.channels !== 'object' || !src.channels) continue;
      const channels = new Map();
      for (const [key, rows] of Object.entries(src.channels)) {
        if (!Array.isArray(rows)) continue;
        const slots = [];
        for (const row of rows) {
          if (!Array.isArray(row) || !Number.isFinite(row[0]) || !Number.isFinite(row[1]) || typeof row[2] !== 'string') continue;
          slots.push({ start: row[0], stop: row[1], title: row[2], desc: typeof row[3] === 'string' ? row[3] : '' });
        }
        if (slots.length) channels.set(key, slots);
      }
      sources.set(url, {
        fetchedAt: Number.isFinite(src.fetchedAt) ? src.fetchedAt : 0,
        sourceIds: Array.isArray(src.sourceIds) ? src.sourceIds.filter(x => typeof x === 'string') : [],
        channels,
        ...summarize(channels),
      });
    }
    return sources.size;
  }

  /**
   * Atomar schreiben (tmp + rename). Fehler werden geloggt und geworfen — der
   * Aufrufer (Refresh) behandelt sie; der Speicher-Cache bleibt gültig.
   */
  async function save() {
    const payload = { version: CACHE_VERSION, sources: {} };
    for (const [url, src] of sources) {
      const channels = {};
      for (const [key, slots] of src.channels) {
        channels[key] = slots.map(s => [s.start, s.stop, s.title, s.desc]);
      }
      payload.sources[url] = { fetchedAt: src.fetchedAt, sourceIds: src.sourceIds, channels };
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(payload), 'utf-8');
      await fs.promises.rename(tmp, file);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  /**
   * Ersetzt die Daten einer Quelle vollständig (nach erfolgreichem Parse).
   * channelSlots: Map<rohe Kanal-ID, Slot[]> — Schlüssel werden normalisiert,
   * Kanäle, die nach der Normalisierung zusammenfallen, werden vereinigt.
   */
  function setSource(url, { fetchedAt, sourceIds = [], channelSlots }) {
    const channels = new Map();
    for (const [rawId, slots] of channelSlots) {
      const key = channelKey(rawId);
      if (!key) continue;
      const list = channels.get(key) || [];
      for (const slot of slots) list.push(slot);
      channels.set(key, list);
    }
    for (const [key, list] of channels) channels.set(key, finalizeSlots(list));
    sources.set(url, { fetchedAt, sourceIds, channels, ...summarize(channels) });
  }

  /** Entfernt Quellen, die nicht mehr konfiguriert sind. Rückgabe: entfernte URLs. */
  function retainOnly(urls) {
    const keep = new Set(urls);
    const removed = [];
    for (const url of [...sources.keys()]) {
      if (!keep.has(url)) {
        sources.delete(url);
        removed.push(url);
      }
    }
    return removed;
  }

  function hasSource(url) {
    return sources.has(url);
  }

  function fetchedAtOf(url) {
    const src = sources.get(url);
    return src ? src.fetchedAt : 0;
  }

  /**
   * Slots eines Kanals (normalisierter Schlüssel), die [fromMs, toMs) überlappen
   * (stop > from && start < to), über alle Quellen vereinigt, nach Start sortiert.
   * Rückgabe: Referenzen auf die gespeicherten Slots — Aufrufer projizieren/kopieren.
   */
  function overlapping(key, fromMs, toMs) {
    const merged = [];
    for (const src of sources.values()) {
      const slots = src.channels.get(key);
      if (!slots) continue;
      for (const slot of slots) {
        if (slot.start >= toMs) break;
        if (slot.stop > fromMs) merged.push(slot);
      }
    }
    return sources.size > 1 ? finalizeSlots(merged.map(s => ({ ...s }))) : merged;
  }

  /**
   * Slots eines Kanals, die [fromMs, toMs) überlappen (stop > from && start < to),
   * über alle Quellen vereinigt, nach Start sortiert.
   */
  function range(id, fromMs, toMs) {
    const key = channelKey(id);
    if (!key) return [];
    return overlapping(key, fromMs, toMs).map(s => ({ start: s.start, stop: s.stop, title: s.title, desc: s.desc }));
  }

  /**
   * Raster-Abfrage (T1): schlanke Slots {start, stop, title} (ohne desc) für mehrere
   * Kanäle in einem Aufruf. Rückgabe [{ channelKey, slots }] in Eingabereihenfolge;
   * channelKey ist der übergebene Schlüssel (der Aufrufer ordnet damit zu), Kanäle ohne
   * Daten liefern slots: []. Kanäle, die nach der Normalisierung zusammenfallen, werden
   * einzeln beantwortet. Mehr als maxSlots Gesamtslots → Fehler (kein stilles Abschneiden).
   */
  function rangeMany(ids, fromMs, toMs, { maxSlots = RANGE_MANY_MAX_SLOTS } = {}) {
    const out = [];
    let total = 0;
    for (const id of ids) {
      const key = channelKey(id);
      const slots = key ? overlapping(key, fromMs, toMs).map(s => ({ start: s.start, stop: s.stop, title: s.title })) : [];
      total += slots.length;
      if (total > maxSlots) {
        throw new Error(`Zu viele Sendungen (max. ${maxSlots}) — Kanäle oder Zeitraum verkleinern`);
      }
      out.push({ channelKey: id, slots });
    }
    return out;
  }

  const foldedTitles = new WeakMap();
  const foldedDescs = new WeakMap();

  function foldedOf(cache, slot, field) {
    let folded = cache.get(slot);
    if (folded === undefined) {
      folded = foldText(slot[field]);
      cache.set(slot, folded);
    }
    return folded;
  }

  /**
   * Volltextsuche (gefaltet, siehe lib/epg-text.js) in Titel (und optional Beschreibung)
   * der Sendungen, die [fromMs, toMs) überlappen. Treffer nach Start, dann Kanal-
   * Reihenfolge sortiert; Rückgabe { results: [{channelKey, start, stop, title}], truncated }.
   * Läuft in Scheiben (setImmediate), blockiert den Event-Loop also nie lange.
   * Aufrufer validieren (limit ≤ 200 etc.); hier nur defensive Mindestgrenzen.
   */
  async function search(ids, query, fromMs, toMs, { limit = 50, includeDesc = false, sliceSlots = SEARCH_SLICE_SLOTS } = {}) {
    const needle = foldText(query);
    if (!needle) return { results: [], truncated: false };
    const hits = [];
    const seen = sources.size > 1 ? new Set() : null;
    const visited = new Set();
    let budget = sliceSlots;
    for (const id of ids) {
      const key = channelKey(id);
      if (!key || visited.has(key)) continue;
      visited.add(key);
      for (const src of sources.values()) {
        const slots = src.channels.get(key);
        if (!slots) continue;
        for (const slot of slots) {
          if (slot.start >= toMs) break;
          if (slot.stop <= fromMs) continue;
          if (--budget <= 0) {
            budget = sliceSlots;
            await new Promise(resolve => setImmediate(resolve));
          }
          if (
            foldedOf(foldedTitles, slot, 'title').includes(needle) ||
            (includeDesc && foldedOf(foldedDescs, slot, 'desc').includes(needle))
          ) {
            if (seen) {
              const dup = `${key}|${slot.start}|${slot.stop}`;
              if (seen.has(dup)) continue;
              seen.add(dup);
            }
            hits.push({ channelKey: id, start: slot.start, stop: slot.stop, title: slot.title });
          }
        }
      }
    }
    hits.sort((a, b) => a.start - b.start || a.stop - b.stop);
    const max = Math.max(1, limit);
    return { results: hits.slice(0, max), truncated: hits.length > max };
  }

  /** Laufende Sendung zum Zeitpunkt atMs (start <= at < stop) oder null. */
  function find(id, atMs) {
    const slots = range(id, atMs, atMs + 1);
    return slots.find(s => s.start <= atMs && atMs < s.stop) || null;
  }

  function describe() {
    const list = [];
    for (const [url, src] of sources) {
      list.push({
        url,
        sourceIds: src.sourceIds,
        fetchedAt: src.fetchedAt,
        channelCount: src.channels.size,
        slotCount: src.slotCount,
        fromMs: src.fromMs,
        toMs: src.toMs,
      });
    }
    return list;
  }

  return { load, save, setSource, retainOnly, hasSource, fetchedAtOf, range, rangeMany, search, find, describe, file };
}

module.exports = { createEpgStore, channelKey, CACHE_FILE, CACHE_VERSION, RANGE_MANY_MAX_SLOTS };
