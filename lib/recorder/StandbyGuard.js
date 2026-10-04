// StandbyGuard: Standby-Schutz für Aufnahmen (Etappe 2b; Konzept §3.5)
//
// powerSaveBlocker('prevent-app-suspension') hält den Rechner wach, solange
//   - mindestens eine Aufnahme läuft, ODER
//   - eine geplante Aufnahme in Kürze startet: ab `leadMs` (5 min) vor dem
//     Aufnahmestart (epgStart − Vorlauf) bis der Job läuft (dann zählt „läuft“)
//     bzw. bis das Aufnahmefenster vorbei ist (Start fehlgeschlagen/verpasst).
// Sonst ist der Blocker aus. Er kann einen schlafenden Rechner nicht wecken
// (kein Aufwecken, Konzept §3.4) — er verhindert nur das Einschlafen davor.
//
// Idempotent: sync() startet höchstens einen Blocker (kein Doppel-Start) und
// gibt ihn frei, sobald er nicht mehr gebraucht wird; release() beim Beenden.
// powerSaveBlocker und Uhr sind injizierbar (Tests).

'use strict';

const LEAD_MS = 5 * 60 * 1000;
const BLOCKER_TYPE = 'prevent-app-suspension';

/**
 * Reine Entscheidung. windows: [{startMs, endMs}] der geplanten Einträge
 * (effektive Aufnahmefenster).
 */
function shouldBlockSuspension({ activeCount = 0, windows = [], nowMs, leadMs = LEAD_MS }) {
  if (activeCount > 0) return true;
  return windows.some(w => Number.isFinite(w.startMs) && nowMs >= w.startMs - leadMs && nowMs < w.endMs);
}

class StandbyGuard {
  /**
   * options: powerSaveBlocker { start(type) → id, stop(id), isStarted?(id) },
   * getActiveCount(), getWindows() → [{startMs,endMs}], now(), leadMs, logger
   */
  constructor({ powerSaveBlocker, getActiveCount, getWindows, now = () => Date.now(), leadMs = LEAD_MS, logger = null } = {}) {
    if (!powerSaveBlocker || typeof powerSaveBlocker.start !== 'function' || typeof powerSaveBlocker.stop !== 'function') {
      throw new Error('StandbyGuard benötigt powerSaveBlocker.start/stop');
    }
    if (typeof getActiveCount !== 'function' || typeof getWindows !== 'function') {
      throw new Error('StandbyGuard benötigt getActiveCount() und getWindows()');
    }
    this.blocker = powerSaveBlocker;
    this.getActiveCount = getActiveCount;
    this.getWindows = getWindows;
    this.now = now;
    this.leadMs = leadMs;
    this.logger = logger;
    this._id = null;
    this._released = false;
    this._detach = [];
  }

  get active() {
    return this._id !== null;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[standby] ${message}`);
  }

  /** Gleicht den Blocker mit dem Bedarf ab. Wirft nie. */
  sync() {
    if (this._released) return this.active;
    let need;
    try {
      need = shouldBlockSuspension({
        activeCount: this.getActiveCount(),
        windows: this.getWindows(),
        nowMs: this.now(),
        leadMs: this.leadMs,
      });
    } catch (e) {
      this._log('warn', `Bedarf nicht ermittelbar: ${e.message}`);
      return this.active;
    }
    try {
      if (need && this._id === null) {
        this._id = this.blocker.start(BLOCKER_TYPE);
        this._log('info', 'Standby-Schutz an (Aufnahme läuft oder startet in Kürze)');
      } else if (!need && this._id !== null) {
        this.blocker.stop(this._id);
        this._id = null;
        this._log('info', 'Standby-Schutz aus');
      }
    } catch (e) {
      this._log('warn', `powerSaveBlocker nicht schaltbar: ${e.message}`);
    }
    return this.active;
  }

  /** Hängt sync() an Scheduler-Takt/-Änderungen und Aufnahme-Ereignisse. */
  attach({ scheduler, recorder }) {
    const onChange = () => this.sync();
    const wire = (emitter, events) => {
      if (!emitter) return;
      for (const evt of events) {
        emitter.on(evt, onChange);
        this._detach.push(() => emitter.removeListener(evt, onChange));
      }
    };
    wire(scheduler, ['schedule:tick', 'schedule:changed']);
    wire(recorder, ['recording:changed', 'recording:status', 'recording:auto-stopped']);
    this.sync();
  }

  /** Beim Beenden: Blocker freigeben, keine weiteren Starts. */
  release() {
    this._released = true;
    for (const off of this._detach.splice(0)) off();
    if (this._id !== null) {
      try {
        this.blocker.stop(this._id);
      } catch (_) {
        // beim Beenden egal
      }
      this._id = null;
    }
  }
}

module.exports = { StandbyGuard, shouldBlockSuspension, LEAD_MS, BLOCKER_TYPE };
