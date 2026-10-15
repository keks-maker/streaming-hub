// Podcast-Suche (P3): Zustandsmodell von Eingabe, Entprellung und Ergebnissen. Kein DOM; Zeitgeber und Suche sind
// injizierbar (Tests). Zustände: idle (zu kurz/leer) · waiting (Entprellung) · loading · done · empty · error · rate-limited.
// Veraltete Antworten (neuere Eingabe) werden verworfen.

'use strict';

const DEBOUNCE_MS = 500;
const MIN_TERM_LENGTH = 2;
const SEARCH_LIMIT = 25;

const MSG_SHORT = `Mindestens ${MIN_TERM_LENGTH} Zeichen eingeben.`;
const MSG_RATE = 'Zu viele Suchanfragen. Bitte später erneut versuchen.';

function normalize(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/**
 * options: { search(term) → Promise<{ ok, results?, error?, code? }>, onChange(), debounceMs, timers { setTimeout, clearTimeout } }
 * getState(): { term, status, results, message, countText }
 */
function createSearchModel({ search, onChange = () => {}, debounceMs = DEBOUNCE_MS, timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) } } = {}) {
  let term = '';
  let status = 'idle';
  let results = [];
  let message = '';
  let timer = null;
  let seq = 0;

  const set = patch => {
    ({ term = term, status = status, results = results, message = message } = patch);
    onChange();
  };

  function clearTimer() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }

  async function run() {
    clearTimer();
    const query = term;
    if (query.length < MIN_TERM_LENGTH) return;
    const mine = ++seq;
    set({ status: 'loading', message: 'Suche läuft …' });
    let reply;
    try {
      reply = await search(query);
    } catch (error) {
      reply = { ok: false, error: (error && error.message) || 'Suche fehlgeschlagen', code: 'error' };
    }
    if (mine !== seq) return;
    if (reply && reply.ok) {
      const list = Array.isArray(reply.results) ? reply.results : [];
      set(list.length ? { status: 'done', results: list, message: '' } : { status: 'empty', results: [], message: `Keine Treffer für „${query}“.` });
    } else if (reply && reply.code === 'rate-limited') {
      set({ status: 'rate-limited', results: [], message: MSG_RATE });
    } else {
      set({ status: 'error', results: [], message: `Suche nicht möglich: ${(reply && reply.error) || 'unbekannter Fehler'}` });
    }
  }

  /** Eingabeänderung: startet die Entprellung (500 ms); zu kurze Eingaben setzen die Suche zurück. */
  function setTerm(value) {
    const next = normalize(value);
    if (next === term && status !== 'idle') return;
    term = next;
    seq += 1; // laufende Antwort verwerfen
    clearTimer();
    if (term.length < MIN_TERM_LENGTH) {
      set({ status: 'idle', results: [], message: term ? MSG_SHORT : '' });
      return;
    }
    set({ status: 'waiting', message: '' });
    timer = timers.setTimeout(run, debounceMs);
  }

  /** Enter: sofort suchen. */
  function submit(value) {
    if (value !== undefined) {
      const next = normalize(value);
      if (next !== term) {
        term = next;
        seq += 1;
      }
    }
    if (term.length < MIN_TERM_LENGTH) {
      clearTimer();
      set({ status: 'idle', results: [], message: term ? MSG_SHORT : '' });
      return Promise.resolve();
    }
    return run();
  }

  function reset() {
    clearTimer();
    seq += 1;
    term = '';
    set({ status: 'idle', results: [], message: '' });
  }

  function getState() {
    const count = results.length;
    return {
      term,
      status,
      results,
      message,
      countText: status === 'done' ? `${count} Treffer` : status === 'empty' ? 'Keine Treffer' : '',
    };
  }

  return { setTerm, submit, reset, getState };
}

module.exports = { createSearchModel, DEBOUNCE_MS, MIN_TERM_LENGTH, SEARCH_LIMIT, MSG_SHORT, MSG_RATE };
