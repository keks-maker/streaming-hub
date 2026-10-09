// WakeScheduler: setzt macOS-Wecktermine (pmset schedule wake) für geplante
// Aufnahmen — nur über den Wake-Helfer (WakeHelperClient), nur solange er läuft.
// Konzept §4.3.
//
// Wecktermin = effektiver Start (epgStart − Vorlauf, aus Scheduler.upcomingWindows)
// minus `leadMs` (5 min), auf die Minute abgerundet, lokale Zeit „MM/dd/yy HH:mm:ss“.
// Nur Einträge mit Wecktermin in der Zukunft. reconcile() gleicht den Soll-Zustand
// mit den persistierten, bereits gesetzten Terminen ab (setzt neue, löscht
// nicht mehr benötigte) und wirft nie; ohne Helfer passiert nichts.
// Helfer-Kanal, Uhr und Speicher sind injizierbar (Tests).

'use strict';

const LEAD_MS = 5 * 60 * 1000;
const MAX_TIMES = 200;

const pad = n => String(n).padStart(2, '0');

/** Lokale Zeit im pmset-Format. */
function formatWakeTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** Rückrechnung für Anzeige und Vergangenheitsprüfung (null bei ungültig). */
function parseWakeTime(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text || '');
  if (!m) return null;
  const ms = new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

class WakeScheduler {
  /**
   * helper: { isSupported(), isActive(), send(verb, dateText) → bool }
   * getWindows(): [{startMs}]  storage: { read() → {times:[]}, write(obj) }
   */
  constructor({ helper, getWindows, storage, now = () => Date.now(), leadMs = LEAD_MS, logger = null, onChange = null } = {}) {
    if (!helper || typeof helper.send !== 'function' || typeof helper.isActive !== 'function') {
      throw new Error('WakeScheduler benötigt einen Helfer-Client');
    }
    if (typeof getWindows !== 'function') throw new Error('WakeScheduler benötigt getWindows()');
    this.helper = helper;
    this.getWindows = getWindows;
    this.storage = storage || { read: () => ({ times: [] }), write: () => {} };
    this.now = now;
    this.leadMs = leadMs;
    this.logger = logger;
    this.onChange = onChange;
    this._running = false;
    this._again = false;
    this._set = this._load();
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[wake] ${message}`);
  }

  _load() {
    try {
      const raw = this.storage.read();
      const times = Array.isArray(raw?.times) ? raw.times : [];
      return new Set(times.filter(t => typeof t === 'string' && parseWakeTime(t) !== null).slice(0, MAX_TIMES));
    } catch (e) {
      this._log('warn', `Gesetzte Termine nicht lesbar: ${e.message}`);
      return new Set();
    }
  }

  _save() {
    try {
      this.storage.write({ version: 1, times: [...this._set] });
    } catch (e) {
      this._log('warn', `Gesetzte Termine nicht speicherbar: ${e.message}`);
    }
  }

  /** Soll-Wecktermine (pmset-Texte), nur Zukunft, dedupliziert, aufsteigend. */
  desiredTimes() {
    const nowMs = this.now();
    const byMs = new Map();
    for (const w of this.getWindows() || []) {
      if (!Number.isFinite(w?.startMs)) continue;
      const wakeMs = Math.floor((w.startMs - this.leadMs) / 60000) * 60000;
      if (wakeMs <= nowMs) continue;
      byMs.set(wakeMs, formatWakeTime(wakeMs));
    }
    return [...byMs.entries()].sort((a, b) => a[0] - b[0]).slice(0, MAX_TIMES).map(([, text]) => text);
  }

  /** Status für die UI. */
  getStatus() {
    const supported = typeof this.helper.isSupported === 'function' ? this.helper.isSupported() : true;
    const active = supported && this.helper.isActive();
    const times = [...this._set].map(parseWakeTime).filter(ms => ms !== null && ms > this.now()).sort((a, b) => a - b);
    return { supported, active, nextWakeMs: times.length ? times[0] : null, count: times.length };
  }

  /** Abgleich Soll ↔ gesetzt. Serialisiert, wirft nie, ohne Helfer no-op. */
  reconcile() {
    if (this._running) {
      this._again = true;
      return;
    }
    this._running = true;
    try {
      do {
        this._again = false;
        this._reconcileOnce();
      } while (this._again);
    } catch (e) {
      this._log('warn', `Abgleich fehlgeschlagen: ${e.message}`);
    } finally {
      this._running = false;
    }
  }

  _reconcileOnce() {
    if (!this.helper.isActive()) return;
    const desired = this.desiredTimes();
    const want = new Set(desired);
    const nowMs = this.now();
    let changed = false;
    // veraltete/nicht mehr benötigte Termine
    for (const t of [...this._set]) {
      if (want.has(t)) continue;
      const ms = parseWakeTime(t);
      // Vergangene Termine räumt macOS selbst ab — nur noch aus dem Speicher nehmen
      if (ms !== null && ms > nowMs && !this.helper.send('cancel', t)) continue;
      this._set.delete(t);
      changed = true;
    }
    for (const t of desired) {
      if (this._set.has(t)) continue;
      if (this.helper.send('wake', t)) {
        this._set.add(t);
        changed = true;
      } else {
        this._log('warn', `Wecktermin ${t} nicht gesetzt`);
      }
    }
    if (changed) {
      this._save();
      this._notify();
    }
  }

  /** Alle gesetzten Termine löschen (Helfer beenden / App-Ende). */
  cancelAll() {
    try {
      if (this.helper.isActive()) {
        for (const t of [...this._set]) {
          const ms = parseWakeTime(t);
          if (ms !== null && ms > this.now() && !this.helper.send('cancel', t)) continue;
          this._set.delete(t);
        }
      }
      this._save();
    } catch (e) {
      this._log('warn', `Termine nicht gelöscht: ${e.message}`);
    }
  }

  _notify() {
    if (typeof this.onChange !== 'function') return;
    try {
      this.onChange(this.getStatus());
    } catch (_) {
      /* Anzeige darf nie stören */
    }
  }

  /** An den Scheduler hängen: jede Planänderung löst einen Abgleich aus. */
  attach(scheduler) {
    const handler = () => this.reconcile();
    scheduler.on('schedule:changed', handler);
    this._detach = () => scheduler.removeListener('schedule:changed', handler);
  }

  detach() {
    if (this._detach) this._detach();
    this._detach = null;
  }
}

module.exports = { WakeScheduler, formatWakeTime, parseWakeTime, LEAD_MS };
