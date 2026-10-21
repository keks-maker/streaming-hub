'use strict';

// Altersfreigabe (FSK) für Listen nachladen. Listen-Teaser nennen sie oft nicht (ZDF "none"), die Stream-Info der Folge schon
// (ZDF document, ARD item). Der Main-Prozess cached und begrenzt auf zwei parallele Abfragen; hier wird zusätzlich nur für
// die ersten sichtbaren Einträge angefragt (decorate: max. N je Aufruf, Reihenfolge wie im DOM), nie für ganze Listen.
// Das Ergebnis wird in den Eintrag geschrieben (entry.fsk), damit Detail, Player und Downloads es mitnehmen, und als Badge in
// die Bilder der Karten/Zeilen gemalt (Thumbs mit der JS-Eigenschaft fskEntry).

const { fskText } = require('./mediathek-format.js');

const FETCHABLE = new Set(['zdf', 'ard']);
const keyOf = entry => `${entry.sourceId}:${entry.id}`;
const isLevel = value => typeof value === 'number' && Number.isInteger(value);

/**
 * fetchFsk(entry) -> Promise<{ ok, fsk }> (IPC mediathek:entry-fsk). Ergebnis: { decorate(root, { max }), lookup(entry) -> Promise<number|null>,
 * known(entry) -> number|null, onChange(listener) -> unsubscribe }.
 */
function createFskLoader({ fetchFsk, parallel = 2 }) {
  const cache = new Map(); // key -> number|null (Treffer, auch "keine Angabe")
  const failed = new Set(); // Fehler: in dieser Sitzung nicht erneut versuchen
  const pending = new Map(); // key -> Promise<number|null>
  const roots = new Set();
  const listeners = new Set();
  let waiting = []; // { entry } in Anzeigereihenfolge
  let running = 0;

  const eligible = entry => Boolean(entry) && FETCHABLE.has(entry.sourceId) && typeof entry.id === 'string' && !isLevel(entry.fsk) && typeof fetchFsk === 'function';

  function known(entry) {
    if (!entry) return null;
    if (isLevel(entry.fsk)) return entry.fsk;
    const cached = cache.get(keyOf(entry));
    return isLevel(cached) ? cached : null;
  }

  function paint(root) {
    for (const thumb of root.querySelectorAll('.mediathek-thumb')) {
      const entry = thumb.fskEntry;
      if (!entry || thumb.querySelector('.mediathek-pill-fsk')) continue;
      const level = known(entry);
      const text = fskText(level);
      if (!text) continue;
      const pill = thumb.ownerDocument.createElement('span');
      pill.className = 'mediathek-pill mediathek-pill-fsk';
      pill.textContent = text;
      thumb.appendChild(pill);
    }
  }

  function settle(entry, level) {
    cache.set(keyOf(entry), level);
    if (isLevel(level)) entry.fsk = level;
    for (const root of roots) paint(root);
    for (const listener of listeners) listener(entry, level);
  }

  function load(entry) {
    const key = keyOf(entry);
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      try {
        const result = await fetchFsk(entry);
        if (result && result.ok) {
          settle(entry, isLevel(result.fsk) ? result.fsk : null);
          return cache.get(key);
        }
        failed.add(key);
      } catch {
        failed.add(key);
      }
      return null;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  function pump() {
    while (running < parallel && waiting.length) {
      const { entry } = waiting.shift();
      if (cache.has(keyOf(entry)) || failed.has(keyOf(entry))) continue;
      running += 1;
      load(entry).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  return {
    known,
    /** Altersfreigabe jetzt (Zahl) oder null; fragt bei Bedarf sofort nach (Detail, Wiedergabe), Fehler ergeben null. */
    async lookup(entry) {
      if (known(entry) !== null) return known(entry);
      if (!eligible(entry) || failed.has(keyOf(entry))) return null;
      if (cache.has(keyOf(entry))) return cache.get(keyOf(entry));
      return load(entry);
    },
    /** Badges in root malen und für die ersten max sichtbaren Einträge ohne Angabe nachladen (ersetzt wartende Anfragen). */
    decorate(root, { max = 12 } = {}) {
      roots.add(root);
      paint(root);
      const next = [];
      for (const thumb of root.querySelectorAll('.mediathek-thumb')) {
        const entry = thumb.fskEntry;
        if (!eligible(entry) || cache.has(keyOf(entry)) || failed.has(keyOf(entry))) continue;
        if (next.length >= max) break;
        if (!next.some(item => keyOf(item.entry) === keyOf(entry))) next.push({ entry });
      }
      waiting = next;
      pump();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createFskLoader };
