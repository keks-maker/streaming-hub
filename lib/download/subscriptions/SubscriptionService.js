'use strict';

// SubscriptionService: Serien-Abos „Neue Folgen automatisch laden“ (Konzept §6 Punkt 6). Hält die Abos (subscriptions.json),
// prüft sie im Main-Prozess seriell und rate-limit-schonend (verzögert nach dem App-Start, danach alle n Stunden, manuell
// „Jetzt prüfen“) und reiht neue Folgen über den DownloadService ein (Duplikat-Index, OV/AD, Altersfreigabe, Platzreserve gelten
// dort). Läuft nur, solange die App läuft. Zeit, Timer, Benachrichtigung und Netz sind injizierbar; kein Electron.
// Ereignisse: 'changed' { items, checking, nextCheckAt }.

const { EventEmitter } = require('node:events');
const records = require('./records.js');
const { planCheck, baselineIds } = require('./check-logic.js');
const { normalizeOverrides } = require('../download-settings.js');

const HOUR_MS = 3600 * 1000;
const START_DELAY_MS = 90 * 1000; // nach dem App-Start: Netz und Fenster haben Vorrang
const OFFLINE_RETRY_MS = 30 * 60 * 1000;
const GAP_MS = 2000; // Pause zwischen zwei Serien (Rate-Limit der Sender schonen)
const MAX_SUBSCRIPTIONS = 100;
const MAX_TIMER_MS = 2 ** 31 - 1;

const MESSAGES = {
  none: 'Keine neuen Folgen.',
  offline: 'Keine Verbindung zur Quelle. Die Prüfung wird später wiederholt.',
  error: 'Die Folgen der Serie konnten nicht geladen werden.',
  space: 'Zu wenig freier Speicherplatz (Reserve für Aufnahmen). Automatisches Laden pausiert, bis wieder Platz frei ist.',
};

const plural = (n, one, many) => (n === 1 ? one : many);

/** Fehler beim Holen der Folgen: vorübergehend (kein Netz, Server überlastet) oder dauerhaft. */
function isTransient(error) {
  if (!error) return false;
  if (error.code === 'network') return true;
  return error.code === 'http' && (error.status >= 500 || error.status === 429);
}

class SubscriptionService extends EventEmitter {
  /**
   * options: store ({ load, save }), mediathek ({ fetchEpisodes(series) }), downloads ({ enqueueMany, findDuplicate, spaceStatus, list }),
   * getSettings() (Download-Einstellungen: autoDownloadEnabled, autoCheckIntervalHours, maxPerCheck, notifyOnDone), notifier ({ notify }),
   * now(), setTimer/clearTimer, startDelayMs, offlineRetryMs, gapMs, autoSchedule (false: nur manuelle Prüfung, z. B. in E2E-Läufen), logger
   */
  constructor(options) {
    super();
    const o = options || {};
    if (!o.store || !o.mediathek || !o.downloads || typeof o.getSettings !== 'function') throw new Error('SubscriptionService: store, mediathek, downloads und getSettings sind erforderlich');
    this.store = o.store;
    this.mediathek = o.mediathek;
    this.downloads = o.downloads;
    this.getSettings = o.getSettings;
    this.notifier = o.notifier || null;
    this.now = o.now || (() => Date.now());
    this.setTimer = o.setTimer || setTimeout;
    this.clearTimer = o.clearTimer || clearTimeout;
    this.startDelayMs = o.startDelayMs ?? START_DELAY_MS;
    this.offlineRetryMs = o.offlineRetryMs ?? OFFLINE_RETRY_MS;
    this.gapMs = o.gapMs ?? GAP_MS;
    this.autoSchedule = o.autoSchedule !== false;
    this.logger = o.logger || null;
    this.subs = new Map();
    this.timer = null;
    this.nextCheckAt = null;
    this.checking = false;
    this.started = false;
    this.stopped = false;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[abo] ${message}`);
  }

  // ── Lebenszyklus ──

  /** Lädt die Abos und plant die erste Prüfung (verzögert, blockiert den Start nicht). */
  start({ immediate = false } = {}) {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    for (const sub of this.store.load()) this.subs.set(sub.id, sub);
    this._arm(immediate ? 0 : this.startDelayMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
  }

  _persist() {
    this.store.save([...this.subs.values()]);
  }

  _settings() {
    return this.getSettings() || {};
  }

  _intervalMs() {
    const hours = Number(this._settings().autoCheckIntervalHours);
    return (Number.isFinite(hours) && hours >= 1 ? Math.min(24, hours) : 6) * HOUR_MS;
  }

  _hasEnabled() {
    for (const sub of this.subs.values()) if (sub.enabled) return true;
    return false;
  }

  /** Nächste Prüfung planen (delayMs; ohne Angabe das eingestellte Intervall). Ohne aktive Abos oder bei ausgeschaltetem Laden ruht der Timer. */
  _arm(delayMs) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    if (this.stopped || !this.autoSchedule || !this._settings().autoDownloadEnabled || !this._hasEnabled()) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, delayMs === undefined ? this._intervalMs() : delayMs));
    this.nextCheckAt = this.now() + delay;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.nextCheckAt = null;
      this._runScheduled();
    }, delay);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Einstellungen oder Abos haben sich geändert: Timer neu planen (nicht während einer Prüfung, sie plant danach selbst). */
  reschedule() {
    if (this.checking || !this.started) return;
    this._arm(this.nextCheckAt && this.timer ? Math.min(this.nextCheckAt - this.now(), this._intervalMs()) : undefined);
    this._emit();
  }

  async _runScheduled() {
    if (this.stopped) return;
    if (!this._settings().autoDownloadEnabled) return this._arm();
    const result = await this._run(null);
    this._arm(result.offline ? Math.min(this.offlineRetryMs, this._intervalMs()) : undefined);
    return this._emit();
  }

  // ── Ansicht und Ereignisse ──

  /** Hinweise aus den Downloads einer Serie (Geoblock, nicht unterstützt, nicht mehr verfügbar): Schlüssel "<quelle>:<serie>". */
  _failureNotes() {
    const counts = new Map();
    let list;
    try {
      list = this.downloads.list();
    } catch {
      return counts;
    }
    for (const view of list) {
      if (view.status !== 'failed' || !view.seriesId) continue;
      const kind = { geo: 'geo', unsupported: 'unsupported', unavailable: 'gone', expired: 'gone' }[view.errorCode];
      if (!kind) continue;
      const key = `${view.sourceId}:${view.seriesId}`;
      const entry = counts.get(key) || { geo: 0, unsupported: 0, gone: 0 };
      entry[kind] += 1;
      counts.set(key, entry);
    }
    const notes = new Map();
    for (const [key, c] of counts) {
      const parts = [];
      if (c.geo) parts.push(`${c.geo} ${plural(c.geo, 'Folge', 'Folgen')} in deiner Region nicht abrufbar`);
      if (c.unsupported) parts.push(`${c.unsupported} ${plural(c.unsupported, 'Folge', 'Folgen')} nicht unterstützt (z. B. DRM)`);
      if (c.gone) parts.push(`${c.gone} ${plural(c.gone, 'Folge', 'Folgen')} nicht mehr verfügbar`);
      notes.set(key, parts.join(', '));
    }
    return notes;
  }

  /** Alle Abos als Ansichten (neueste zuerst) plus Zustand der Prüfung. */
  list() {
    const settings = this._settings();
    const notes = this._failureNotes();
    const items = [...this.subs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(sub => records.toView(sub, { note: notes.get(`${sub.sourceId}:${sub.seriesId}`) || null }));
    return {
      ok: true,
      items,
      checking: this.checking,
      enabled: settings.autoDownloadEnabled !== false,
      intervalHours: Math.round(this._intervalMs() / HOUR_MS),
      nextCheckAt: this.nextCheckAt ? new Date(this.nextCheckAt).toISOString() : null,
    };
  }

  _emit() {
    this.emit('changed', this.list());
  }

  isSubscribed(sourceId, seriesId) {
    for (const sub of this.subs.values()) if (sub.sourceId === sourceId && sub.seriesId === seriesId) return true;
    return false;
  }

  // ── Verwaltung ──

  _failure(error, fallback) {
    return { ok: false, code: isTransient(error) ? 'network' : (error && error.code) || 'error', message: isTransient(error) ? MESSAGES.offline : fallback };
  }

  /**
   * Abo anlegen. mode 'future': vorhandene Folgen gelten als bekannt (Standard); 'all': alle Folgen sind neu und werden (höchstens
   * maxPerCheck je Prüfung) geladen. Ergebnis { ok, item } | { ok: false, code: 'exists'|'limit'|'network'|'error', message }.
   */
  async add({ series, mode = 'future', overrides = {} }) {
    const sub0 = records.normalizeSubscription({ id: records.newId(), sourceId: series.sourceId, seriesId: series.id, title: series.title, imageUrl: series.imageUrl, description: series.description, groupingURL: series.groupingURL, createdAt: new Date(this.now()).toISOString(), overrides });
    if (!sub0) return { ok: false, code: 'invalid', message: 'Die Serie ist ungültig.' };
    if (this.isSubscribed(sub0.sourceId, sub0.seriesId)) return { ok: false, code: 'exists', message: 'Für diese Serie gibt es schon ein Abo.' };
    if (this.subs.size >= MAX_SUBSCRIPTIONS) return { ok: false, code: 'limit', message: `Es sind höchstens ${MAX_SUBSCRIPTIONS} Abos möglich.` };
    if (mode === 'future') {
      try {
        sub0.knownEntryIds = records.normalizeKnown(baselineIds(await this.mediathek.fetchEpisodes(records.seriesOf(sub0))));
      } catch (error) {
        return this._failure(error, 'Die Folgen der Serie konnten nicht geladen werden. Das Abo wurde nicht angelegt.');
      }
      if (this.isSubscribed(sub0.sourceId, sub0.seriesId)) return { ok: false, code: 'exists', message: 'Für diese Serie gibt es schon ein Abo.' };
    }
    this.subs.set(sub0.id, sub0);
    this._persist();
    this._arm(mode === 'all' ? 0 : undefined);
    this._emit();
    return { ok: true, item: records.toView(sub0) };
  }

  /** Aktiv-Schalter und Optionen ändern (patch: { enabled?, overrides? }; overrides {} = globale Einstellungen). */
  update(id, patch) {
    const sub = this.subs.get(id);
    if (!sub) return { ok: false, code: 'unknown', message: 'Das Abo gibt es nicht mehr.' };
    if (patch.enabled !== undefined) sub.enabled = patch.enabled === true;
    if (patch.overrides !== undefined) sub.overrides = normalizeOverrides(patch.overrides);
    this._persist();
    this.reschedule();
    this._emit();
    return { ok: true, item: records.toView(sub) };
  }

  remove(id) {
    if (!this.subs.delete(id)) return { ok: false, code: 'unknown', message: 'Das Abo gibt es nicht mehr.' };
    this._persist();
    this.reschedule();
    this._emit();
    return { ok: true };
  }

  // ── Prüfung ──

  /** „Jetzt prüfen“: ein Abo (id) oder alle aktiven. Ergebnis { ok, checked, added } | { ok: false, code: 'disabled'|'busy'|'unknown' }. */
  async checkNow(id) {
    if (!this._settings().autoDownloadEnabled) return { ok: false, code: 'disabled', message: 'Automatisches Laden ist ausgeschaltet (Einstellungen ▸ Mediatheken ▸ Downloads ▸ Steuerung).' };
    if (this.checking) return { ok: false, code: 'busy', message: 'Es läuft bereits eine Prüfung.' };
    if (id !== undefined && !this.subs.has(id)) return { ok: false, code: 'unknown', message: 'Das Abo gibt es nicht mehr.' };
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    const result = await this._run(id === undefined ? null : [id]);
    this._arm(result.offline ? Math.min(this.offlineRetryMs, this._intervalMs()) : undefined);
    this._emit();
    return { ok: true, checked: result.checked, added: result.added };
  }

  _sleep(ms) {
    return new Promise(resolve => {
      const timer = this.setTimer(resolve, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  /** Prüft die aktiven Abos (oder die genannten) nacheinander; Benachrichtigung einmal je Durchlauf. */
  async _run(ids) {
    this.checking = true;
    this._emit();
    const summary = { checked: 0, added: 0, offline: false, series: [] };
    try {
      const targets = [...this.subs.values()].filter(sub => sub.enabled && (!ids || ids.includes(sub.id)));
      for (const [index, sub] of targets.entries()) {
        if (this.stopped) break;
        if (index > 0 && this.gapMs > 0) await this._sleep(this.gapMs);
        if (!this.subs.has(sub.id)) continue; // währenddessen entfernt
        const outcome = await this._checkOne(sub);
        summary.checked += 1;
        if (outcome.offline) summary.offline = true;
        if (outcome.added > 0) {
          summary.added += outcome.added;
          summary.series.push({ title: sub.title, added: outcome.added });
        }
        this._persist();
        this._emit();
        if (outcome.offline) break; // ohne Netz bringt jede weitere Serie nur Fehler
      }
    } catch (error) {
      this._log('error', `Prüfung abgebrochen: ${error && error.message}`);
    } finally {
      this.checking = false;
    }
    this._notify(summary);
    return summary;
  }

  _result(sub, status, fields = {}) {
    sub.lastCheckAt = new Date(this.now()).toISOString();
    sub.lastResult = { at: sub.lastCheckAt, status, added: 0, pending: 0, message: null, note: null, ...fields };
  }

  _remember(sub, ids) {
    sub.knownEntryIds = records.normalizeKnown([...sub.knownEntryIds, ...ids]);
  }

  /** Prüft ein Abo. Ergebnis { added, offline }; lastResult und knownEntryIds werden am Abo gesetzt. */
  async _checkOne(sub) {
    let episodes;
    try {
      episodes = await this.mediathek.fetchEpisodes(records.seriesOf(sub));
    } catch (error) {
      const transient = isTransient(error);
      // Ohne Netz: kein Dauer-Fehler, nur ein Hinweis; lastCheckAt bleibt, damit „zuletzt erfolgreich geprüft“ stimmt
      if (transient) sub.lastResult = { at: new Date(this.now()).toISOString(), status: 'offline', added: 0, pending: 0, message: MESSAGES.offline, note: null };
      else this._result(sub, 'error', { message: MESSAGES.error });
      this._log('info', `Prüfung ${transient ? 'ohne Netz' : 'fehlgeschlagen'} (${(error && error.code) || 'error'})`);
      return { added: 0, offline: transient };
    }
    const settings = this._settings();
    const plan = planCheck({ episodes, known: sub.knownEntryIds, isDuplicate: entry => Boolean(this.downloads.findDuplicate(entry)), nowMs: this.now(), maxPerCheck: settings.maxPerCheck });
    this._remember(sub, plan.settled);
    const note = plan.geo > 0 ? `${plan.geo} ${plural(plan.geo, 'Folge', 'Folgen')} in deiner Region nicht abrufbar` : null;
    if (!plan.take.length) {
      this._result(sub, 'ok', { message: MESSAGES.none, note });
      return { added: 0, offline: false };
    }
    const pending = plan.take.length + plan.deferred;
    const space = this.downloads.spaceStatus();
    if (space && space.low) {
      this._result(sub, 'space', { pending, message: MESSAGES.space, note });
      return { added: 0, offline: false };
    }
    const queued = this.downloads.enqueueMany({ series: records.seriesOf(sub), entries: plan.take, overrides: sub.overrides });
    if (!queued.ok) {
      this._result(sub, 'storage', { pending, message: queued.message || 'Der Speicherort ist nicht nutzbar.', note });
      return { added: 0, offline: false };
    }
    const byId = new Map(plan.take.map(entry => [entry.id, entry]));
    for (const result of queued.results) {
      const entry = byId.get(result.entryId);
      if (entry) this._remember(sub, [entry.id, entry.originalVersionId, entry.audioDescriptionId].filter(Boolean)); // eingereiht, schon vorhanden oder ungültig: nicht erneut versuchen
    }
    const added = queued.added || 0;
    const message = added ? `${added} ${plural(added, 'neue Folge wird', 'neue Folgen werden')} geladen.` : MESSAGES.none;
    this._result(sub, 'ok', { added, pending: plan.deferred, message: plan.deferred ? `${message} ${plan.deferred} ${plural(plan.deferred, 'weitere folgt', 'weitere folgen')} bei der nächsten Prüfung.` : message, note });
    return { added, offline: false };
  }

  /** Eine gebündelte Meldung je Durchlauf (nie je Folge). */
  _notify({ added, series }) {
    if (!added || !this.notifier || this._settings().notifyOnDone === false) return;
    try {
      if (series.length === 1) this.notifier.notify('Neue Folgen', `${added} ${plural(added, 'neue Folge', 'neue Folgen')} von ${series[0].title} ${plural(added, 'wird', 'werden')} geladen.`);
      else this.notifier.notify('Neue Folgen', `${added} neue Folgen aus ${series.length} Serien werden geladen: ${series.map(item => item.title).slice(0, 3).join(', ')}${series.length > 3 ? ' …' : ''}.`);
    } catch (error) {
      this._log('warn', `Benachrichtigung fehlgeschlagen: ${error && error.message}`);
    }
  }
}

module.exports = { SubscriptionService, MESSAGES, START_DELAY_MS, OFFLINE_RETRY_MS, MAX_SUBSCRIPTIONS };
