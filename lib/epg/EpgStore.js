// EpgStore: Wochen-Cache der EPG-Daten im Main-Prozess (Etappe 1; Konzept §3.2)
//
// Hält je EPG-URL (= je TV-Quelle mit epgUrl) die Sendungen je Kanal als
// sortierte Slots {start, stop, title, desc, subtitle, categories, icon, year, episode,
// credits, rating} (UTC-ms) im Speicher und persistiert sie kompakt in
// userData/epg-cache.json.
//
// Cache-Format v2 (Etappe 3.2; EPG-Konzept B2): Zeile
//   [start, stop, title, desc, cats, iconIdx, year, episode, credits, subtitle, rating]
// iconIdx verweist auf die Bild-URL-Stringtabelle `icons` der Quelle (-1 = kein Bild),
// credits ist null oder [Regie[], Darsteller[], Moderation[]]. Leere Felder am Zeilenende
// werden nicht geschrieben. v1-Dateien (Zeile [start, stop, title, desc]) werden weiter
// gelesen (neue Felder leer); isLegacy(url) meldet das dem EpgService (Upgrade-Refresh). Beim Start ist der Cache
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
const { normalizeGenre } = require('./genre.js');

const CACHE_FILE = 'epg-cache.json';
const CACHE_VERSION = 2;
const LEGACY_CACHE_VERSION = 1;
// range-many: harte Obergrenze der Gesamtslots je Aufruf (Antwortgröße / Main-Blockade)
const RANGE_MANY_MAX_SLOTS = 25000;
// now-next: so weit wird nach der folgenden Sendung gesucht
const NOW_NEXT_LOOKAHEAD_MS = 3 * 24 * 60 * 60 * 1000;
// search: Slots je Scheibe, danach setImmediate (Event-Loop frei halten)
const SEARCH_SLICE_SLOTS = 4000;
// save: so viele Zeichen werden gesammelt, bevor sie auf die Platte geschrieben werden
const SAVE_CHUNK_CHARS = 256 * 1024;

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

// Geteilte, eingefrorene Leerwerte: 74 000 Slots halten sonst je 4 leere Arrays + 1 Objekt
const EMPTY_LIST = Object.freeze([]);
const EMPTY_CREDITS = Object.freeze({ director: EMPTY_LIST, actor: EMPTY_LIST, presenter: EMPTY_LIST });

function strings(value) {
  if (!Array.isArray(value) || !value.length) return EMPTY_LIST;
  const list = value.filter(x => typeof x === 'string' && x);
  return list.length ? list : EMPTY_LIST;
}

function creditsOf(c) {
  if (!c || typeof c !== 'object') return EMPTY_CREDITS;
  const credits = { director: strings(c.director), actor: strings(c.actor), presenter: strings(c.presenter) };
  return credits.director === EMPTY_LIST && credits.actor === EMPTY_LIST && credits.presenter === EMPTY_LIST
    ? EMPTY_CREDITS
    : credits;
}

/** Zeile (v1 oder v2) → Slot oder null. icons: Stringtabelle der Quelle (v2). */
function slotFromRow(row, icons) {
  if (!Array.isArray(row) || !Number.isFinite(row[0]) || !Number.isFinite(row[1]) || typeof row[2] !== 'string') return null;
  const credits = Array.isArray(row[8]) ? row[8] : [];
  const iconIdx = Number.isInteger(row[5]) ? row[5] : -1;
  return {
    start: row[0],
    stop: row[1],
    title: row[2],
    desc: typeof row[3] === 'string' ? row[3] : '',
    categories: strings(row[4]),
    icon: iconIdx >= 0 && iconIdx < icons.length ? icons[iconIdx] : '',
    year: Number.isFinite(row[6]) ? row[6] : 0,
    episode: typeof row[7] === 'string' ? row[7] : '',
    credits: creditsOf({ director: credits[0], actor: credits[1], presenter: credits[2] }),
    subtitle: typeof row[9] === 'string' ? row[9] : '',
    rating: typeof row[10] === 'string' ? row[10] : '',
  };
}

// Pro Zeilenposition (ab 4): ist der Wert „leer“ (und am Zeilenende entbehrlich)?
const ROW_EMPTY = {
  4: v => v.length === 0,
  5: v => v === -1,
  6: v => v === 0,
  7: v => v === '',
  8: v => v === null,
  9: v => v === '',
  10: v => v === '',
};

/** Slot → Zeile; leere Felder am Ende entfallen. iconIndexOf(url) liefert den Tabellenindex. */
function rowFromSlot(slot, iconIndexOf) {
  const c = slot.credits;
  const hasCredits = c !== EMPTY_CREDITS && (c.director.length || c.actor.length || c.presenter.length);
  const row = [
    slot.start,
    slot.stop,
    slot.title,
    slot.desc,
    slot.categories,
    slot.icon ? iconIndexOf(slot.icon) : -1,
    slot.year || 0,
    slot.episode,
    hasCredits ? [c.director, c.actor, c.presenter] : null,
    slot.subtitle,
    slot.rating,
  ];
  let end = row.length;
  while (end > 4 && ROW_EMPTY[end - 1](row[end - 1])) end -= 1;
  return row.slice(0, end);
}

/** Vollständiger Slot für Eingaben aus dem Parser (fehlende Zusatzfelder → leer). */
function normalizeSlot(slot) {
  return {
    start: slot.start,
    stop: slot.stop,
    title: slot.title,
    desc: typeof slot.desc === 'string' ? slot.desc : '',
    categories: strings(slot.categories),
    icon: typeof slot.icon === 'string' ? slot.icon : '',
    year: Number.isFinite(slot.year) ? slot.year : 0,
    episode: typeof slot.episode === 'string' ? slot.episode : '',
    credits: creditsOf(slot.credits),
    subtitle: typeof slot.subtitle === 'string' ? slot.subtitle : '',
    rating: typeof slot.rating === 'string' ? slot.rating : '',
  };
}

/** Volle Projektion (range/find/search full): Kopien, damit Aufrufer den Cache nie verändern. */
function fullProjection(s) {
  return {
    start: s.start,
    stop: s.stop,
    title: s.title,
    desc: s.desc,
    subtitle: s.subtitle,
    categories: [...s.categories],
    icon: s.icon,
    year: s.year,
    episode: s.episode,
    credits: { director: [...s.credits.director], actor: [...s.credits.actor], presenter: [...s.credits.presenter] },
    rating: s.rating,
  };
}

function createEpgStore({ dir, logger = null, fileName = CACHE_FILE } = {}) {
  if (!dir) throw new Error('EpgStore benötigt dir (userData)');
  const file = path.join(dir, fileName);
  // url → { fetchedAt, sourceIds, channels: Map<key, Slot[]>, slotCount, fromMs, toMs }
  const sources = new Map();
  // URLs, die aus einem v1-Cache stammen (Zusatzfelder leer) und noch nicht neu geladen wurden
  const legacyUrls = new Set();

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
    const version = parsed ? parsed.version : null;
    if (
      (version !== CACHE_VERSION && version !== LEGACY_CACHE_VERSION) ||
      typeof parsed.sources !== 'object' ||
      !parsed.sources
    ) {
      log('warn', 'Cache hat unbekanntes Format, wird ignoriert');
      return 0;
    }
    sources.clear();
    legacyUrls.clear();
    for (const [url, src] of Object.entries(parsed.sources)) {
      if (!src || typeof src.channels !== 'object' || !src.channels) continue;
      const icons = version === CACHE_VERSION ? strings(src.icons) : [];
      const channels = new Map();
      for (const [key, rows] of Object.entries(src.channels)) {
        if (!Array.isArray(rows)) continue;
        const slots = [];
        for (const row of rows) {
          const slot = slotFromRow(row, icons);
          if (slot) slots.push(slot);
        }
        if (slots.length) channels.set(key, slots);
      }
      if (version === LEGACY_CACHE_VERSION) legacyUrls.add(url);
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
    // Momentaufnahme: Quellen-Objekte werden nie verändert, nur ersetzt (setSource) — so bleibt die Datei
    // konsistent, auch wenn während des Schreibens eine Quelle ausgetauscht wird.
    const snapshot = [...sources];
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(dir, { recursive: true });
    let handle = null;
    try {
      handle = await fs.promises.open(tmp, 'w');
      // Stückweise schreiben statt einer 25-MB-Zeichenkette: der Spitzenverbrauch bleibt klein
      let pending = `{"version":${CACHE_VERSION},"sources":{`;
      const flush = async force => {
        if (pending.length >= SAVE_CHUNK_CHARS || (force && pending)) {
          await handle.write(pending, null, 'utf-8');
          pending = '';
        }
      };
      let firstSource = true;
      for (const [url, src] of snapshot) {
        const icons = [];
        const iconIndex = new Map();
        const iconIndexOf = icon => {
          let idx = iconIndex.get(icon);
          if (idx === undefined) {
            idx = icons.length;
            icons.push(icon);
            iconIndex.set(icon, idx);
          }
          return idx;
        };
        pending += `${firstSource ? '' : ','}${JSON.stringify(url)}:{"fetchedAt":${JSON.stringify(src.fetchedAt)},"sourceIds":${JSON.stringify(src.sourceIds)},"channels":{`;
        firstSource = false;
        let firstChannel = true;
        for (const [key, slots] of src.channels) {
          pending += `${firstChannel ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(slots.map(slot => rowFromSlot(slot, iconIndexOf)))}`;
          firstChannel = false;
          await flush(false);
        }
        // Die Stringtabelle steht hinter den Kanälen (sie entsteht beim Schreiben der Zeilen)
        pending += `},"icons":${JSON.stringify(icons)}}`;
        await flush(false);
      }
      pending += '}}';
      await flush(true);
      await handle.close();
      handle = null;
      await fs.promises.rename(tmp, file);
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  /**
   * Ersetzt die Daten einer Quelle vollständig (nach erfolgreichem Parse).
   * channelSlots: Map<rohe Kanal-ID, Slot[]> — Schlüssel werden normalisiert,
   * Kanäle, die nach der Normalisierung zusammenfallen, werden vereinigt.
   * Slots dürfen nur {start, stop, title, desc} tragen (Zusatzfelder → leer); Bild-URLs
   * werden je Quelle dedupliziert (eine String-Instanz je URL im Speicher).
   */
  function setSource(url, { fetchedAt, sourceIds = [], channelSlots }) {
    const channels = new Map();
    const internedIcons = new Map();
    for (const [rawId, slots] of channelSlots) {
      const key = channelKey(rawId);
      if (!key) continue;
      const list = channels.get(key) || [];
      for (const raw of slots) {
        const slot = normalizeSlot(raw);
        if (slot.icon) {
          const known = internedIcons.get(slot.icon);
          if (known === undefined) internedIcons.set(slot.icon, slot.icon);
          else slot.icon = known;
        }
        list.push(slot);
      }
      channels.set(key, list);
    }
    for (const [key, list] of channels) channels.set(key, finalizeSlots(list));
    legacyUrls.delete(url);
    sources.set(url, { fetchedAt, sourceIds, channels, ...summarize(channels) });
  }

  /** Entfernt Quellen, die nicht mehr konfiguriert sind. Rückgabe: entfernte URLs. */
  function retainOnly(urls) {
    const keep = new Set(urls);
    const removed = [];
    for (const url of [...sources.keys()]) {
      if (!keep.has(url)) {
        sources.delete(url);
        legacyUrls.delete(url);
        removed.push(url);
      }
    }
    return removed;
  }

  /** true, solange die Quelle aus einem v1-Cache stammt (Zusatzfelder leer, Upgrade-Refresh offen). */
  function isLegacy(url) {
    return legacyUrls.has(url);
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
   * über alle Quellen vereinigt, nach Start sortiert. Volle Projektion inkl. der
   * Zusatzfelder (subtitle, categories, icon, year, episode, credits, rating).
   */
  function range(id, fromMs, toMs) {
    const key = channelKey(id);
    if (!key) return [];
    return overlapping(key, fromMs, toMs).map(fullProjection);
  }

  /**
   * Raster-Abfrage (T1): schlanke Slots {start, stop, title, genre} (ohne desc; genre = normalizeGenre
   * der Kategorien, '' ohne Kategorie — Etappe 3.3: Genre-Spalte/Farbbalken) für mehrere
   * Kanäle in einem Aufruf. Rückgabe [{ channelKey, slots }] in Eingabereihenfolge;
   * channelKey ist der übergebene Schlüssel (der Aufrufer ordnet damit zu), Kanäle ohne
   * Daten liefern slots: []. Kanäle, die nach der Normalisierung zusammenfallen, werden
   * einzeln beantwortet. Mehr als maxSlots Gesamtslots → Fehler (kein stilles Abschneiden).
   */
  const genres = new WeakMap();
  function genreOf(slot) {
    let genre = genres.get(slot);
    if (genre === undefined) {
      genre = normalizeGenre(slot.categories);
      genres.set(slot, genre);
    }
    return genre;
  }

  function rangeMany(ids, fromMs, toMs, { maxSlots = RANGE_MANY_MAX_SLOTS } = {}) {
    const out = [];
    let total = 0;
    for (const id of ids) {
      const key = channelKey(id);
      const slots = key ? overlapping(key, fromMs, toMs).map(s => ({ start: s.start, stop: s.stop, title: s.title, genre: genreOf(s) })) : [];
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
   * Mit options.full tragen die Treffer die volle Projektion (wie range) — Standard bleibt schlank.
   * Läuft in Scheiben (setImmediate), blockiert den Event-Loop also nie lange.
   * Aufrufer validieren (limit ≤ 200 etc.); hier nur defensive Mindestgrenzen.
   */
  async function search(ids, query, fromMs, toMs, { limit = 50, includeDesc = false, full = false, sliceSlots = SEARCH_SLICE_SLOTS } = {}) {
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
            hits.push(full ? { channelKey: id, ...fullProjection(slot) } : { channelKey: id, start: slot.start, stop: slot.stop, title: slot.title });
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

  /**
   * Jetzt/Nächste (Zapping, Settings-Anzeige): je Kanal laufende Sendung (start <= at < stop) und die
   * folgende (erste mit start >= stop der laufenden, ohne laufende: erste mit start > at). Schlanke Slots
   * {start, stop, title, genre}; fehlt eines, null. Rückgabe [{ channelKey, current, next }] in Eingabereihenfolge,
   * channelKey ist der übergebene Schlüssel.
   */
  function nowNext(ids, atMs, { lookAheadMs = NOW_NEXT_LOOKAHEAD_MS } = {}) {
    const slim = s => ({ start: s.start, stop: s.stop, title: s.title, genre: genreOf(s) });
    return ids.map(id => {
      const key = channelKey(id);
      let current = null;
      let next = null;
      if (key) {
        for (const slot of overlapping(key, atMs, atMs + lookAheadMs)) {
          if (!current && slot.start <= atMs) {
            current = slot;
          } else if (slot.start > atMs && (!current || slot.start >= current.stop)) {
            next = slot;
            break;
          }
        }
      }
      return { channelKey: id, current: current ? slim(current) : null, next: next ? slim(next) : null };
    });
  }

  /**
   * Kanalliste für die Settings-Zuordnung: [{ normId, channelId, sampleTitle }] nach normId sortiert, über alle
   * Quellen vereinigt. channelId = normalisierter Schlüssel (die rohe XMLTV-ID wird im Cache nicht gehalten;
   * die Zuordnung normalisiert ohnehin). sampleTitle = Titel der frühesten Sendung des Kanals.
   */
  function channels() {
    const best = new Map();
    for (const src of sources.values()) {
      for (const [key, slots] of src.channels) {
        const first = slots[0];
        if (!first) continue;
        const known = best.get(key);
        if (!known || first.start < known.start) best.set(key, { start: first.start, title: first.title });
      }
    }
    return [...best]
      .map(([normId, v]) => ({ normId, channelId: normId, sampleTitle: v.title }))
      .sort((a, b) => a.normId.localeCompare(b.normId));
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

  return { load, save, setSource, retainOnly, hasSource, fetchedAtOf, range, rangeMany, search, find, nowNext, channels, describe, isLegacy, file };
}

module.exports = { createEpgStore, channelKey, CACHE_FILE, CACHE_VERSION, LEGACY_CACHE_VERSION, RANGE_MANY_MAX_SLOTS };
