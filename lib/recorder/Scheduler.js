// Scheduler: geplante Aufnahmen im Main-Prozess (Etappe 2a; Konzept §3.3/§3.4)
//
// - Ein Tick-Loop (30 s) statt langer setTimeouts: robust gegen Standby und
//   Uhrenwechsel. Re-Evaluation bei powerMonitor 'resume' → onResume().
//   Uhr und Timer sind injizierbar (Tests).
// - Start: now ≥ epgStart − Vorlauf → recorder.start({..., stopAt}). Der Stopp
//   liegt beim RecordJob (stopAt = epgStop + Nachlauf), nicht im Scheduler.
//   Die Stream-URL wird beim Start FRISCH aus der Senderliste aufgelöst
//   (resolveStream aus main.js); der Snapshot am Eintrag ist nur Fallback.
// - Verpasst/Spätstart (E4): liegt der Start zurück, das Sendungsende (epgStop)
//   noch nicht, wird bei aktiviertem Spätstart sofort ab jetzt aufgenommen
//   (Hinweis „ab hh:mm“), sonst `missed`. Liegt epgStop zurück → `missed`.
// - Fehler: kein stilles Wiederholen. Engine-Fehler → `failed` mit Engine-Text.
//   Einzige Ausnahme: ein Vorgänger-Job desselben Kanals, der nachweislich
//   gleich endet (Mittelpunkt-Regel), wird bis max. 2 min nach Startzeit
//   abgewartet, statt am Duplikat-Schutz zu scheitern.
// - Absagen/Entfernen (cancelEntry): scheduled → `cancelled` (Eintrag bleibt als
//   Verlauf sichtbar); abgeschlossene Einträge (done/missed/failed/cancelled)
//   werden endgültig entfernt; für einen laufenden Eintrag (`recording`) wird
//   die Aufnahme NICHT angefasst und die Absage abgelehnt (stoppen: Bibliothek).
//
// - Schedule-Slip (Etappe 2b, §3.4): 10 min vor `epgStart − Vorlauf` wird das EPG der
//   Quelle gezielt neu geladen (refreshEpg → EpgService.refreshForSource) und der
//   Eintrag mit dem frischen Cache abgeglichen (schedule-slip.js): Verschiebung nach
//   hinten UND vorne wird übernommen (solange der Start nicht erreicht ist) und
//   gemeldet, eine aus dem EPG entfernte Sendung bleibt als Eintrag erhalten (nur
//   Warnung). Nach der Übernahme wird die Konfliktprüfung erneut bewertet. Die
//   Prüfung blockiert den Takt NIE (läuft nebenher, Einzelflug), ist einmal pro
//   Eintrag/Fenster fällig (lastSlipCheck überlebt den Neustart) und ein
//   fehlgeschlagener Refresh lässt den alten Cache unberührt (Wiederholung nach
//   slipRetryMs, kein Absturz). Zusammengelegte Einträge („A + B“) sind ausgenommen.
//
// Events: 'schedule:changed' ({reason, id, notice|null}), 'schedule:notify'
// ({kind, entry, message}) für Tray-Benachrichtigungen, 'schedule:tick' nach jedem
// Takt (StandbyGuard, Tray-Menü).
//
// SRP: Zeitsteuerung + Zustandsübergänge. Datenhaltung: ScheduleStore, Logik:
// schedule-logic.js, Validierung der Renderer-Eingaben: lib/ipc-validation.js.

'use strict';

const { EventEmitter } = require('events');
const logic = require('./schedule-logic.js');
const { MSG_RUNNING, MSG_PAST, MSG_NO_EPG, toScheduleIso } = require('./schedule-ui-model.js');
const slip = require('./schedule-slip.js');

const TICK_MS = 30 * 1000;
const MAX_AHEAD_MS = 8 * 24 * 3600 * 1000;
const PREDECESSOR_WAIT_MS = 2 * 60 * 1000;
const SLOT_TOLERANCE_MS = 5 * 60 * 1000;
const SLIP_LEAD_MS = 10 * 60 * 1000;
const SLIP_RETRY_MS = 3 * 60 * 1000;
const SLIP_WARN_PREFIX = 'Warnung: Die Sendung ist im aktuellen EPG nicht mehr zu finden';

class ScheduleError extends Error {
  constructor(message, code = 'INVALID') {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

function clockText(ms) {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function channelLabel(entry) {
  return entry.channelName || entry.channelId || 'Sender';
}

class Scheduler extends EventEmitter {
  /**
   * options:
   * - store: ScheduleStore, recorder: RecorderService
   * - resolveStream({sourceId, channelId, tvgId, channelName, sourceUrlSnapshot})
   *     → { ok: true, url, channelName? } | { ok: false, message }
   * - getSettings() → { bufferBeforeMin, bufferAfterMin, lateStart }
   * - epgLookup({ key, atMs }) → Slot {start, stop, title, desc} | null   (optional)
   * - Slip (optional, beide nötig): refreshEpg({ entry }) → { ok } (gezielter Refresh der
   *   Quelle des Eintrags), epgRange({ key, fromMs, toMs }) → Slots; slipLeadMs, slipRetryMs
   * - now() ms, timers { setInterval, clearInterval }, tickMs, lateThresholdMs, logger
   */
  constructor({
    store,
    recorder,
    resolveStream,
    getSettings,
    epgLookup = null,
    refreshEpg = null,
    epgRange = null,
    slipLeadMs = SLIP_LEAD_MS,
    slipRetryMs = SLIP_RETRY_MS,
    now = () => Date.now(),
    timers = null,
    tickMs = TICK_MS,
    lateThresholdMs = null,
    logger = null,
  } = {}) {
    super();
    if (!store || !recorder) throw new Error('Scheduler benötigt store und recorder');
    if (typeof resolveStream !== 'function') throw new Error('Scheduler benötigt resolveStream()');
    if (typeof getSettings !== 'function') throw new Error('Scheduler benötigt getSettings()');
    this.store = store;
    this.recorder = recorder;
    this.resolveStream = resolveStream;
    this.getSettings = getSettings;
    this.epgLookup = epgLookup;
    this.refreshEpg = refreshEpg;
    this.epgRange = epgRange;
    this.slipLeadMs = slipLeadMs;
    this.slipRetryMs = slipRetryMs;
    this._slipping = null;
    this._slipRetryAt = new Map();
    this.now = now;
    this.logger = logger;
    this.tickMs = tickMs;
    // „Zu spät“ = der reguläre Start-Zeitpunkt liegt länger zurück als zwei Ticks
    this.lateThresholdMs = lateThresholdMs === null ? tickMs * 2 : lateThresholdMs;
    this._timers = timers || { setInterval, clearInterval };
    this._interval = null;
    this._ticking = null;
    this._starting = new Set();
    this._started = false;
    this._onRecorderEvent = () => {
      try {
        this._reconcileRecordings();
      } catch (e) {
        this._log('warn', `Abgleich mit Aufnahmen fehlgeschlagen: ${e.message}`);
      }
    };
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[schedule] ${message}`);
  }

  // ── Lifecycle ──

  /** Lädt den Store, löst hängende `recording`-Einträge auf und startet den Takt. */
  async start() {
    if (this._started) return;
    this._started = true;
    this.store.load();
    this.store.prune();
    for (const evt of ['recording:changed', 'recording:status', 'recording:auto-stopped']) {
      this.recorder.on(evt, this._onRecorderEvent);
    }
    this._reconcileRecordings();
    this._interval = this._timers.setInterval(() => {
      this.tick().catch(e => this._log('warn', `Tick fehlgeschlagen: ${e.message}`));
    }, this.tickMs);
    if (this._interval && typeof this._interval.unref === 'function') this._interval.unref();
    await this.tick();
  }

  /** Beendet den Takt. Laufende Aufnahmen bleiben unberührt (Job-Timer im RecordJob). */
  stop() {
    this._started = false;
    if (this._interval) this._timers.clearInterval(this._interval);
    this._interval = null;
    for (const evt of ['recording:changed', 'recording:status', 'recording:auto-stopped']) {
      this.recorder.removeListener(evt, this._onRecorderEvent);
    }
  }

  /** powerMonitor 'resume' (Standby): sofort neu bewerten, Verpasstes behandeln. */
  async onResume() {
    this._log('info', 'Resume aus dem Standby — Planung wird neu bewertet');
    return this.tick();
  }

  // ── Takt ──

  /** Öffentlich für deterministische Tests (Uhr verstellen, tick() aufrufen). */
  tick() {
    if (this._ticking) return this._ticking;
    this._ticking = this._tick().finally(() => {
      this._ticking = null;
      try {
        this.emit('schedule:tick');
      } catch (e) {
        this._log('warn', `Takt-Listener fehlgeschlagen: ${e.message}`);
      }
    });
    return this._ticking;
  }

  async _tick() {
    this._reconcileRecordings();
    const nowMs = this.now();
    const scheduled = this.store.list().filter(e => e.state === 'scheduled');
    if (!scheduled.length) return;
    // Slip-Prüfung läuft nebenher: ein langsamer EPG-Download darf keinen Start verzögern
    this.checkSlips().catch(e => this._log('warn', `Slip-Prüfung fehlgeschlagen: ${e.message}`));
    const windows = logic.effectiveWindows(scheduled, this._runningJobs());
    const due = scheduled
      .map(entry => ({ entry, win: windows.get(entry.id) }))
      .filter(x => x.win)
      .sort((a, b) => a.win.startMs - b.win.startMs);
    for (const { entry, win } of due) {
      if (nowMs < win.startMs) continue;
      if (this._starting.has(entry.id)) continue;
      if (nowMs >= win.epgStopMs) {
        this._markMissed(entry, 'Verpasst: Streaming Hub war zum Sendungsende nicht aktiv (App aus oder Rechner im Standby).');
        continue;
      }
      const late = nowMs - win.startMs > this.lateThresholdMs;
      if (late && this.getSettings().lateStart === false) {
        this._markMissed(
          entry,
          `Verpasst: Streaming Hub war zur Startzeit nicht aktiv (Spätstart ist deaktiviert). Die Sendung lief bis ${clockText(win.epgStopMs)}.`,
        );
        continue;
      }
      this._starting.add(entry.id);
      try {
        await this._startEntry(entry, win, { late, nowMs });
      } finally {
        this._starting.delete(entry.id);
      }
    }
  }

  _runningJobs() {
    let active;
    try {
      active = this.recorder.status().active || [];
    } catch (_) {
      active = [];
    }
    return active.map(job => ({
      id: job.recId,
      channelId: job.channelId,
      channelName: job.channelName,
      startedAtMs: job.startedAt ? Date.parse(job.startedAt) : NaN,
      stopAt: Number.isFinite(job.stopAt) ? job.stopAt : null,
    }));
  }

  async _startEntry(entry, win, { late, nowMs }) {
    // Vorgänger desselben Kanals läuft noch (Mittelpunkt-Regel: stoppt gleich)
    const predecessor = this.recorder.findJobByChannel(entry.channelId || null, entry.channelName || null);
    if (predecessor) {
      const stopAt = predecessor.stopAt;
      const ends = Number.isFinite(stopAt) && stopAt <= nowMs + PREDECESSOR_WAIT_MS;
      if (ends && nowMs - win.startMs < PREDECESSOR_WAIT_MS) return; // nächster Tick
      return this._markFailed(
        entry,
        `Für ${channelLabel(entry)} läuft bereits eine Aufnahme (Duplikat-Schutz) — die geplante Aufnahme konnte nicht starten.`,
      );
    }

    let resolved;
    try {
      resolved = await this.resolveStream({
        sourceId: entry.sourceId,
        channelId: entry.channelId,
        tvgId: entry.tvgId,
        channelName: entry.channelName,
        sourceUrlSnapshot: entry.sourceUrlSnapshot,
      });
    } catch (e) {
      resolved = { ok: false, message: `Sender konnte nicht aufgelöst werden: ${e.message}` };
    }
    if (!resolved || resolved.ok !== true || !resolved.url) {
      return this._markFailed(entry, (resolved && resolved.message) || 'Der Sender ist nicht mehr in der Senderliste.');
    }

    // Platzprüfung (Reserve aus Etappe 1): bei Mangel NICHT starten
    const free = this.recorder.getFreeBytes();
    const reserve = this.recorder.reserveBytes;
    if (free !== null && Number.isFinite(reserve) && free < reserve) {
      const mb = n => Math.max(0, Math.round(n / (1024 * 1024)));
      this._markFailed(
        entry,
        `Speicher knapp: nur ${mb(free)} MB frei (Reserve ${mb(reserve)} MB). Die geplante Aufnahme wurde nicht gestartet.`,
        'low-space',
      );
      return;
    }

    const stopAt = win.endMs;
    try {
      const result = await this.recorder.start(
        {
          sourceUrl: resolved.url,
          channelId: entry.channelId || null,
          channelName: resolved.channelName || entry.channelName || null,
          epgTitle: entry.title,
          epgDescription: entry.description || null,
          stopAt,
        },
        { force: entry.allowOverLimit === true },
      );
      const note = late ? `Spätstart: Aufnahme ab ${clockText(nowMs)} (Sendung begann ${clockText(win.epgStartMs)})` : null;
      this._update(entry.id, { state: 'recording', recId: result.recId, note }, 'started', late ? { kind: 'late-start', message: note } : null);
      // Job kann zwischen start() und hier schon wieder weg sein (sofortiger Fehler)
      this._reconcileRecordings();
      if (late) this._notify('late-start', entry.id, `„${entry.title}“ (${channelLabel(entry)}): ${note}`);
    } catch (e) {
      if (e && e.code === 'PARALLEL_LIMIT') {
        return this._markFailed(
          entry,
          `Parallel-Limit erreicht (${e.active} von ${e.limit} Aufnahmen) und die Überschreitung wurde beim Planen nicht bestätigt.`,
        );
      }
      return this._markFailed(entry, e && e.message ? e.message : 'Aufnahme konnte nicht gestartet werden');
    }
  }

  // ── Schedule-Slip (Etappe 2b) ──

  /**
   * Prüft alle fälligen Einträge (Fenster 10 min vor epgStart − Vorlauf). Einzelflug:
   * ein laufender Durchgang wird geteilt. Öffentlich für deterministische Tests;
   * der Takt ruft es ohne zu warten auf.
   */
  checkSlips() {
    if (!this.refreshEpg || !this.epgRange) return Promise.resolve();
    if (this._slipping) return this._slipping;
    this._slipping = this._checkSlips().finally(() => {
      this._slipping = null;
    });
    return this._slipping;
  }

  async _checkSlips() {
    const nowMs = this.now();
    const due = this.store
      .list()
      .filter(e => slip.isSlipDue(e, nowMs, this.slipLeadMs))
      .filter(e => !(this._slipRetryAt.get(e.id) > nowMs));
    if (!due.length) return;
    // Ein Refresh je Quelle und Durchgang (mehrere Einträge derselben Quelle teilen ihn)
    const refreshed = new Map();
    for (const entry of due) {
      const bySource = entry.sourceId || '';
      if (!refreshed.has(bySource)) refreshed.set(bySource, this._refreshFor(entry));
      const result = await refreshed.get(bySource);
      if (!result.ok) {
        this._slipRetryAt.set(entry.id, this.now() + this.slipRetryMs);
        this._log('warn', `Slip-Prüfung für „${entry.title}“: EPG-Refresh fehlgeschlagen (${result.error || 'unbekannt'}) — alter Cache bleibt, neuer Versuch später`);
        continue;
      }
      this._slipRetryAt.delete(entry.id);
      try {
        this._applySlip(entry.id);
      } catch (e) {
        this._log('warn', `Slip-Prüfung für „${entry.title}“ fehlgeschlagen: ${e.message}`);
      }
    }
  }

  async _refreshFor(entry) {
    try {
      const result = await this.refreshEpg({ entry });
      return result && result.ok === true ? { ok: true } : { ok: false, error: (result && result.error) || 'kein Refresh möglich' };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** Gleicht den Eintrag mit dem (frischen) Cache ab und übernimmt/meldet. */
  _applySlip(id) {
    // Während des Refreshs kann sich der Eintrag geändert haben (Start, Absage, Bearbeiten)
    const entry = this.store.get(id);
    const nowMs = this.now();
    if (!entry || !slip.isSlipDue(entry, nowMs, this.slipLeadMs)) return;
    const key = entry.tvgId || entry.channelId;
    const range = slip.slipSearchRange(entry);
    const slots = key ? this.epgRange({ key, fromMs: range.fromMs, toMs: range.toMs }) : [];
    const verdict = slip.evaluateSlip(entry, slots);
    const checkedAt = new Date(nowMs).toISOString();
    const label = `„${entry.title}“ (${channelLabel(entry)})`;

    if (verdict.kind === 'unchanged') {
      const clear = entry.note && entry.note.startsWith(SLIP_WARN_PREFIX);
      this.store.update(id, { lastSlipCheck: checkedAt, ...(clear ? { note: null } : {}) });
      if (clear) this.emit('schedule:changed', { reason: 'slip-cleared', id, notice: null });
      return;
    }
    if (verdict.kind === 'removed') {
      const message = `${SLIP_WARN_PREFIX}. Der Eintrag bleibt bestehen und startet zur geplanten Zeit — bitte prüfen, ob die Sendung noch läuft.`;
      this._update(id, { lastSlipCheck: checkedAt, note: message }, 'slip-removed', { kind: 'slip-removed', message });
      this._notify('slip-removed', id, `${label}: ${message}`);
      return;
    }

    // moved: neue Zeiten übernehmen (vor und zurück), solange der Start nicht erreicht ist
    const next = { ...entry, epgStart: toScheduleIso(verdict.startMs), epgStop: toScheduleIso(verdict.stopMs) };
    try {
      this._assertNotDuplicate(next, this.store.list(), id);
    } catch (e) {
      const message = `Die Sendung wurde im EPG verschoben (${clockText(verdict.startMs)}–${clockText(verdict.stopMs)}), die neue Zeit wäre aber bereits geplant. Der Eintrag behält die alte Zeit — bitte prüfen.`;
      this._update(id, { lastSlipCheck: checkedAt, note: message }, 'slip-removed', { kind: 'slip-removed', message });
      this._notify('slip-removed', id, `${label}: ${message}`);
      return;
    }
    const conflict = logic.findConflicts({
      candidate: next,
      entries: this.store.list(),
      running: this._runningJobs(),
      maxParallel: this.recorder.maxParallel,
      excludeId: id,
    });
    const oldTimes = `${clockText(logic.parseIsoWithOffset(entry.epgStart))}–${clockText(logic.parseIsoWithOffset(entry.epgStop))}`;
    const newTimes = `${clockText(verdict.startMs)}–${clockText(verdict.stopMs)}`;
    let message = `Sendezeit laut EPG geändert (${oldTimes} → ${newTimes}); die Aufnahme folgt der neuen Zeit.`;
    const overload = conflict.exceeds && !entry.allowOverLimit;
    if (overload) {
      message += ` Achtung: Zur neuen Zeit laufen bis zu ${conflict.maxConcurrent} Aufnahmen gleichzeitig (erlaubt: ${conflict.limit}) — ohne Bestätigung startet diese Aufnahme dann nicht.`;
    }
    const updated = this._update(
      id,
      { epgStart: next.epgStart, epgStop: next.epgStop, lastSlipCheck: checkedAt, note: message },
      'slipped',
      { kind: overload ? 'slip-conflict' : 'slip', message },
    );
    if (updated) this._notify(overload ? 'slip-conflict' : 'slip', id, `${label}: ${message}`);
  }

  /**
   * Effektive Aufnahmefenster geplanter Einträge (für den Standby-Schutz):
   * [{ id, startMs, endMs }] mit Mittelpunkt-Regel, abgeleitet.
   */
  upcomingWindows() {
    const scheduled = this.store.list().filter(e => e.state === 'scheduled');
    const windows = logic.effectiveWindows(scheduled, this._runningJobs());
    return scheduled
      .map(e => ({ id: e.id, ...windows.get(e.id) }))
      .filter(w => Number.isFinite(w.startMs));
  }

  // ── Abgleich laufender Einträge mit der Engine ──

  _reconcileRecordings() {
    for (const entry of this.store.list()) {
      if (entry.state !== 'recording') continue;
      if (entry.recId && this.recorder.getJob(entry.recId)) continue;
      this._finishRecordingEntry(entry);
    }
  }

  _finishRecordingEntry(entry) {
    let meta;
    try {
      meta = entry.recId ? this.recorder.store.readMeta(entry.recId) : null;
    } catch (_) {
      meta = null;
    }
    if (!meta) {
      return this._markFailed(entry, 'Die Aufnahme ist nicht mehr vorhanden.');
    }
    if (meta.status === 'failed') {
      return this._markFailed(entry, meta.lastError || 'Die Aufnahme ist fehlgeschlagen.');
    }
    if (meta.status === 'aborted' || meta.status === 'recording') {
      // 'recording' ohne Job = Zombie (Absturz/Neustart); recover() setzt ihn auf aborted
      return this._markFailed(
        entry,
        'Die Aufnahme wurde unterbrochen (Streaming Hub wurde beendet). Der aufgenommene Teil liegt in der Bibliothek.',
      );
    }
    if (meta.stopReason === 'disk-full' || meta.stopReason === 'storage-lost') {
      return this._markFailed(
        entry,
        meta.stopReason === 'disk-full'
          ? 'Die Aufnahme endete vorzeitig: Speicher voll. Sie bleibt abspielbar.'
          : 'Die Aufnahme endete vorzeitig: Speicherort nicht erreichbar. Sie bleibt abspielbar.',
        'failed',
      );
    }
    const note = meta.stopReason === 'max-duration' ? 'Beendet: Höchstdauer pro Aufnahme erreicht' : entry.note;
    this._update(entry.id, { state: 'done', note: note || null }, 'done');
  }

  // ── Zustandsübergänge ──

  _markMissed(entry, message) {
    this._update(entry.id, { state: 'missed', note: message }, 'missed', { kind: 'missed', message });
    this._notify('missed', entry.id, `„${entry.title}“ (${channelLabel(entry)}): ${message}`);
  }

  _markFailed(entry, message, kind = 'failed') {
    this._log('warn', `Geplante Aufnahme „${entry.title}“ fehlgeschlagen: ${message}`);
    this._update(entry.id, { state: 'failed', note: message }, 'failed', { kind, message });
    this._notify(kind, entry.id, `„${entry.title}“ (${channelLabel(entry)}): ${message}`);
  }

  _update(id, patch, reason, notice = null) {
    const updated = this.store.update(id, patch);
    if (updated) this.emit('schedule:changed', { reason, id, notice });
    return updated;
  }

  _notify(kind, id, message) {
    const entry = this.store.get(id);
    this.emit('schedule:notify', { kind, entry, message });
  }

  // ── Anlegen / Ändern / Absagen (von ipc-schedule.js aufgerufen) ──

  list() {
    return this.store
      .list()
      .sort((a, b) => logic.parseIsoWithOffset(a.epgStart) - logic.parseIsoWithOffset(b.epgStart));
  }

  /** Anstehende Planungen (state scheduled, Start in der Zukunft) — window-all-closed. */
  hasPendingSchedules() {
    const nowMs = this.now();
    return this.store.list().some(e => {
      if (e.state !== 'scheduled') return false;
      const stop = logic.parseIsoWithOffset(e.epgStop);
      return Number.isFinite(stop) && stop > nowMs;
    });
  }

  _assertPlannable(epgStartMs, epgStopMs, nowMs) {
    if (!(epgStopMs > epgStartMs)) throw new ScheduleError('Das Ende der Sendung muss nach dem Start liegen.');
    if (epgStartMs <= nowMs) {
      throw new ScheduleError(epgStopMs > nowMs ? MSG_RUNNING : MSG_PAST, epgStopMs > nowMs ? 'RUNNING' : 'PAST');
    }
    if (epgStartMs > nowMs + MAX_AHEAD_MS) throw new ScheduleError('Aufnahmen lassen sich höchstens 8 Tage im Voraus planen.');
    if (epgStopMs - epgStartMs > 24 * 3600 * 1000) throw new ScheduleError('Eine Aufnahme darf höchstens 24 Stunden dauern.');
  }

  _assertSlot(input, epgStartMs, epgStopMs) {
    if (!this.epgLookup) return;
    const key = input.tvgId || input.channelId;
    const slot = key ? this.epgLookup({ key, atMs: epgStartMs }) : null;
    if (!slot) throw new ScheduleError(MSG_NO_EPG, 'NO_EPG');
    if (Math.abs(slot.start - epgStartMs) > SLOT_TOLERANCE_MS || Math.abs(slot.stop - epgStopMs) > SLOT_TOLERANCE_MS) {
      throw new ScheduleError('Die Sendezeit weicht vom EPG-Cache ab. Bitte das EPG aktualisieren und erneut versuchen.', 'EPG_MISMATCH');
    }
  }

  _candidateFrom(input, settings) {
    return {
      channelId: input.channelId,
      channelName: input.channelName,
      tvgId: input.tvgId || '',
      sourceId: input.sourceId || '',
      sourceUrlSnapshot: input.sourceUrlSnapshot || '',
      title: input.title,
      description: input.description || '',
      epgStart: input.epgStart,
      epgStop: input.epgStop,
      bufferBeforeSec: input.bufferBeforeSec !== undefined ? input.bufferBeforeSec : settings.bufferBeforeMin * 60,
      bufferAfterSec: input.bufferAfterSec !== undefined ? input.bufferAfterSec : settings.bufferAfterMin * 60,
      allowOverLimit: input.allowOverLimit === true,
    };
  }

  /**
   * Vorab-Prüfung für den Dialog (nichts wird gespeichert): Zukunfts-Regel,
   * EPG-Plausibilität, Konflikte, Nachbarschaft/Mittelpunkt/Zusammenlegen.
   */
  checkConflicts(input) {
    const nowMs = this.now();
    const { epgStartMs, epgStopMs } = logic.entryTimes(input);
    this._assertPlannable(epgStartMs, epgStopMs, nowMs);
    this._assertSlot(input, epgStartMs, epgStopMs);
    const settings = this.getSettings();
    const candidate = this._candidateFrom(input, settings);
    const entries = this.store.list();
    this._assertNotDuplicate(candidate, entries);
    const adjacency = logic.describeAdjacency({ candidate, entries });
    const conflict = logic.findConflicts({
      candidate,
      entries,
      running: this._runningJobs(),
      maxParallel: this.recorder.maxParallel,
    });
    return { ok: true, defaults: { bufferBeforeSec: candidate.bufferBeforeSec, bufferAfterSec: candidate.bufferAfterSec }, conflict, adjacency: summarizeAdjacency(adjacency) };
  }

  _assertNotDuplicate(candidate, entries, excludeId = null) {
    const start = logic.parseIsoWithOffset(candidate.epgStart);
    const stop = logic.parseIsoWithOffset(candidate.epgStop);
    for (const e of entries) {
      if (e.id === excludeId || (e.state !== 'scheduled' && e.state !== 'recording')) continue;
      if (!logic.sameChannel(e, candidate)) continue;
      if (logic.parseIsoWithOffset(e.epgStart) === start && logic.parseIsoWithOffset(e.epgStop) === stop) {
        throw new ScheduleError('Diese Sendung ist bereits geplant.', 'DUPLICATE');
      }
    }
  }

  /**
   * Legt einen Eintrag an. Rückgabe { ok:true, entry, merged, adjacency } oder
   * { ok:false, code:'CONFLICT', conflict, adjacency } (Überschreitung des
   * Parallel-Limits ohne `allowOverLimit`). Regelverstöße werfen ScheduleError.
   * input.mergeWithId: bestehenden, direkt benachbarten Eintrag zu EINER
   * durchgehenden Aufnahme verlängern statt einen zweiten anzulegen.
   */
  addEntry(input) {
    const nowMs = this.now();
    const { epgStartMs, epgStopMs } = logic.entryTimes(input);
    this._assertPlannable(epgStartMs, epgStopMs, nowMs);
    this._assertSlot(input, epgStartMs, epgStopMs);
    const settings = this.getSettings();
    const candidate = this._candidateFrom(input, settings);
    const entries = this.store.list();
    this._assertNotDuplicate(candidate, entries);
    const adjacency = logic.describeAdjacency({ candidate, entries });

    if (input.mergeWithId) {
      return this._mergeInto(input.mergeWithId, candidate, entries, adjacency);
    }

    const conflict = logic.findConflicts({
      candidate,
      entries,
      running: this._runningJobs(),
      maxParallel: this.recorder.maxParallel,
    });
    if (conflict.exceeds && !candidate.allowOverLimit) {
      return { ok: false, code: 'CONFLICT', conflict, adjacency: summarizeAdjacency(adjacency) };
    }
    const entry = this.store.add({ ...candidate, state: 'scheduled' });
    this.emit('schedule:changed', { reason: 'added', id: entry.id, notice: null });
    return { ok: true, entry, merged: false, conflict, adjacency: summarizeAdjacency(adjacency) };
  }

  _mergeInto(otherId, candidate, entries, adjacency) {
    const other = entries.find(e => e.id === otherId);
    if (!other || other.state !== 'scheduled') {
      throw new ScheduleError('Der Eintrag zum Zusammenlegen ist nicht mehr geplant.', 'MERGE_INVALID');
    }
    if (!adjacency || adjacency.entry.id !== otherId || !adjacency.canMerge) {
      throw new ScheduleError('Diese Sendungen lassen sich nicht zu einer durchgehenden Aufnahme zusammenlegen.', 'MERGE_INVALID');
    }
    const otherFirst = logic.parseIsoWithOffset(other.epgStop) <= logic.parseIsoWithOffset(candidate.epgStart);
    const first = otherFirst ? other : candidate;
    const second = otherFirst ? candidate : other;
    let merged;
    try {
      merged = logic.mergeEntries(first, second);
    } catch (e) {
      throw new ScheduleError(e.message, 'MERGE_INVALID');
    }
    const mergedCandidate = { ...other, ...merged, allowOverLimit: other.allowOverLimit || candidate.allowOverLimit };
    const conflict = logic.findConflicts({
      candidate: mergedCandidate,
      entries,
      running: this._runningJobs(),
      maxParallel: this.recorder.maxParallel,
      excludeId: other.id,
    });
    if (conflict.exceeds && !mergedCandidate.allowOverLimit) {
      return { ok: false, code: 'CONFLICT', conflict, adjacency: summarizeAdjacency(adjacency) };
    }
    const entry = this.store.update(other.id, {
      ...merged,
      allowOverLimit: mergedCandidate.allowOverLimit,
      merged: true,
      note: 'Zwei Sendungen zu einer durchgehenden Aufnahme zusammengelegt',
    });
    this.emit('schedule:changed', { reason: 'merged', id: entry.id, notice: null });
    return { ok: true, entry, merged: true, conflict, adjacency: summarizeAdjacency(adjacency) };
  }

  /**
   * Ändert einen geplanten Eintrag (nur state `scheduled`): Puffer, allowOverLimit,
   * Zeiten (mit derselben Zukunfts-Regel wie beim Anlegen).
   */
  updateEntry(id, patch) {
    const existing = this.store.get(id);
    if (!existing) throw new ScheduleError('Planungseintrag nicht gefunden.', 'NOT_FOUND');
    if (existing.state !== 'scheduled') {
      throw new ScheduleError('Nur geplante Aufnahmen können geändert werden.', 'NOT_SCHEDULED');
    }
    const next = { ...existing };
    for (const key of ['bufferBeforeSec', 'bufferAfterSec', 'epgStart', 'epgStop', 'allowOverLimit']) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    const nowMs = this.now();
    const { epgStartMs, epgStopMs } = logic.entryTimes(next);
    this._assertPlannable(epgStartMs, epgStopMs, nowMs);
    if (next.epgStart !== existing.epgStart || next.epgStop !== existing.epgStop) {
      this._assertSlot(next, epgStartMs, epgStopMs);
    }
    const entries = this.store.list();
    this._assertNotDuplicate(next, entries, id);
    const conflict = logic.findConflicts({
      candidate: next,
      entries,
      running: this._runningJobs(),
      maxParallel: this.recorder.maxParallel,
      excludeId: id,
    });
    if (conflict.exceeds && !next.allowOverLimit) {
      return { ok: false, code: 'CONFLICT', conflict, adjacency: summarizeAdjacency(logic.describeAdjacency({ candidate: next, entries: entries.filter(e => e.id !== id) })) };
    }
    const entry = this.store.update(id, {
      bufferBeforeSec: next.bufferBeforeSec,
      bufferAfterSec: next.bufferAfterSec,
      epgStart: next.epgStart,
      epgStop: next.epgStop,
      allowOverLimit: next.allowOverLimit,
    });
    this.emit('schedule:changed', { reason: 'updated', id, notice: null });
    return { ok: true, entry, conflict };
  }

  /**
   * „Absagen“ (schedule:remove): scheduled → cancelled; abgeschlossene Einträge
   * werden endgültig aus der Liste entfernt; ein laufender Eintrag wird NICHT
   * angefasst (die Aufnahme läuft weiter, Stoppen geht über die Bibliothek).
   */
  cancelEntry(id) {
    const existing = this.store.get(id);
    if (!existing) throw new ScheduleError('Planungseintrag nicht gefunden.', 'NOT_FOUND');
    if (existing.state === 'recording') {
      throw new ScheduleError(
        'Diese Aufnahme läuft bereits. Stoppe sie in der Bibliothek — die laufende Aufnahme wird hier nicht abgebrochen.',
        'RUNNING',
      );
    }
    if (existing.state === 'scheduled') {
      const entry = this.store.update(id, { state: 'cancelled', note: 'Abgesagt' });
      this.emit('schedule:changed', { reason: 'cancelled', id, notice: null });
      return { ok: true, entry, removed: false };
    }
    this.store.remove(id);
    this.emit('schedule:changed', { reason: 'removed', id, notice: null });
    return { ok: true, entry: null, removed: true };
  }
}

/** Dialog-taugliche Form der Nachbarschaft (ohne interne Objekte). */
function summarizeAdjacency(adj) {
  if (!adj) return null;
  return {
    entryId: adj.entry.id,
    title: adj.entry.title,
    position: adj.position,
    gapSec: adj.gapSec,
    midpointIso: adj.midpointIso,
    firstAfterSec: adj.firstAfterSec,
    secondBeforeSec: adj.secondBeforeSec,
    canMerge: adj.canMerge,
    merged: adj.merged,
  };
}

module.exports = {
  Scheduler,
  SLIP_LEAD_MS,
  SLIP_RETRY_MS,
  SLIP_WARN_PREFIX,
  ScheduleError,
  summarizeAdjacency,
  TICK_MS,
  MSG_RUNNING,
  MSG_PAST,
  MSG_NO_EPG,
  MAX_AHEAD_MS,
};
