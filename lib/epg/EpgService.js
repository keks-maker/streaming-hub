// EpgService: Wochen-EPG im Main-Prozess (Etappe 1; Konzept §3.2)
//
// - Quellen: epgUrl je TV-Quelle (tvsources.json) über getSources()
// - Refresh: beim Start (sofern der Cache nicht ganz frisch ist) und danach alle
//   12 h — unabhängig vom Fenster (Tray-Betrieb). Der Takt ist ein 10-min-Tick,
//   der gegen die (injizierbare) Uhr prüft: robust gegen Standby/Uhrenwechsel.
//   Nach Fehlschlag: Wiederholung nach 30 min; der alte Cache bleibt unverändert.
// - Download: fetchEpgResponse (remoteHttpUrl, Redirects, MAX_EPG_BYTES) +
//   Streaming-Parse (xmltv-stream-parser). Fenster: jetzt − 1 Tag … jetzt + 10 Tage.
// - Abfrage: range/find/status — der Renderer kopiert nichts in seinen RAM.
//
// Bewusst NICHT hier: Scheduler, Planung, UI (Etappe 2a).

'use strict';

const { fetchEpgResponse, parseXmltvResponse } = require('./download.js');
const { createEpgStore } = require('./EpgStore.js');
const { remoteHttpUrl, MAX_EPG_BYTES } = require('../input-validation.js');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULTS = {
  refreshIntervalMs: 12 * HOUR_MS, // 2×/Tag
  retryIntervalMs: 30 * 60 * 1000,
  tickMs: 10 * 60 * 1000,
  startMinAgeMs: 30 * 60 * 1000, // Neustart-Schleifen laden nicht jedes Mal 50 MB
  windowBackMs: DAY_MS,
  windowAheadMs: 10 * DAY_MS,
  downloadTimeoutMs: 5 * 60 * 1000,
};

class EpgService {
  /**
   * options:
   * - dir: Cache-Verzeichnis (userData) ODER store: fertiger EpgStore
   * - getSources(): [{ id, name?, epgUrl? }] — aktuelle TV-Quellen
   * - fetchImpl, validateUrl, maxBytes: Download-Seams (Tests: lokale Dateien)
   * - now(): ms — injizierbare Uhr
   * - timers: { setInterval, clearInterval } — injizierbar (Tests)
   * - logger, plus Zeitkonstanten (DEFAULTS)
   */
  constructor({
    dir,
    store = null,
    getSources,
    fetchImpl = fetch,
    validateUrl = remoteHttpUrl,
    maxBytes = MAX_EPG_BYTES,
    now = () => Date.now(),
    timers = null,
    logger = null,
    ...timing
  } = {}) {
    if (typeof getSources !== 'function') throw new Error('EpgService benötigt getSources()');
    this.store = store || createEpgStore({ dir, logger });
    this.getSources = getSources;
    this.fetchImpl = fetchImpl;
    this.validateUrl = validateUrl;
    this.maxBytes = maxBytes;
    this.now = now;
    this.logger = logger;
    this.timing = { ...DEFAULTS, ...timing };
    this._timers = timers || { setInterval, clearInterval };
    this._tick = null;
    this._refreshing = null;
    this._abort = null;
    this._started = false;
    // url → { lastAttemptAt, lastSuccessAt, lastError, sourceIds }
    this._state = new Map();
    this._lastRefreshAt = null;
    this.initialRefresh = null;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[epg] ${message}`);
  }

  /**
   * Startet den Dienst: Cache sofort nutzbar machen (async), Takt starten,
   * Hintergrund-Refresh anstoßen. Löst auf, sobald der Cache geladen ist — der
   * Refresh läuft im Hintergrund weiter (refreshPromise).
   */
  async start() {
    if (this._started) return;
    this._started = true;
    const loaded = await this.store.load();
    for (const entry of this.store.describe()) {
      this._state.set(entry.url, {
        lastAttemptAt: entry.fetchedAt,
        lastSuccessAt: entry.fetchedAt,
        lastError: null,
        sourceIds: entry.sourceIds,
      });
    }
    this._log('info', `Cache geladen (${loaded} Quelle(n))`);
    this._tick = this._timers.setInterval(() => {
      this.tick().catch(e => this._log('warn', `Tick fehlgeschlagen: ${e.message}`));
    }, this.timing.tickMs);
    if (this._tick && typeof this._tick.unref === 'function') this._tick.unref();
    // Hintergrund-Refresh; das Promise ist für Tests/Diagnose erreichbar
    this.initialRefresh = this.tick({ atStart: true }).catch(e =>
      this._log('warn', `Start-Refresh fehlgeschlagen: ${e.message}`),
    );
  }

  stop() {
    this._started = false;
    if (this._tick) this._timers.clearInterval(this._tick);
    this._tick = null;
    if (this._abort) this._abort.abort();
  }

  /** Aktuell konfigurierte, gültige EPG-Quellen: url → [sourceId…] + Fehler je Quelle. */
  _configuredUrls() {
    const byUrl = new Map();
    const invalid = [];
    for (const source of this.getSources() || []) {
      if (!source || typeof source.epgUrl !== 'string' || !source.epgUrl.trim()) continue;
      let url;
      try {
        url = this.validateUrl(source.epgUrl.trim(), 'EPG-URL');
      } catch (e) {
        invalid.push({ sourceId: source.id, url: source.epgUrl, error: e.message });
        continue;
      }
      const ids = byUrl.get(url) || [];
      ids.push(source.id);
      byUrl.set(url, ids);
    }
    return { byUrl, invalid };
  }

  _isDue(url, atStart) {
    const state = this._state.get(url);
    const now = this.now();
    if (!state || !this.store.hasSource(url)) {
      // Nie erfolgreich geladen: sofort, aber nach Fehlschlag erst nach retryInterval
      return !state || !state.lastAttemptAt || now - state.lastAttemptAt >= this.timing.retryIntervalMs;
    }
    if (state.lastError) return now - state.lastAttemptAt >= this.timing.retryIntervalMs;
    const age = now - state.lastSuccessAt;
    return atStart ? age >= this.timing.startMinAgeMs : age >= this.timing.refreshIntervalMs;
  }

  /**
   * Prüft, ob ein Refresh fällig ist, und führt ihn aus. Öffentlich, damit
   * Tests die Uhr verstellen und den Takt deterministisch auslösen.
   */
  async tick({ atStart = false } = {}) {
    const { byUrl } = this._configuredUrls();
    const due = [...byUrl.keys()].some(url => this._isDue(url, atStart));
    const pruned = this.store.retainOnly([...byUrl.keys()]);
    if (pruned.length) {
      for (const url of pruned) this._state.delete(url);
      await this.store.save().catch(e => this._log('warn', `Cache speichern fehlgeschlagen: ${e.message}`));
    }
    if (!due) return null;
    return this.refresh({ onlyDue: true, atStart });
  }

  /**
   * Lädt die EPG-Quellen neu. force=true ignoriert die Fälligkeit. Parallele
   * Aufrufe teilen sich den laufenden Refresh. Fehler einer Quelle lassen deren
   * alten Cache unangetastet und stoppen die anderen Quellen nicht.
   */
  refresh({ force = false, onlyDue = false, atStart = false } = {}) {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh({ force, onlyDue, atStart }).finally(() => {
      this._refreshing = null;
      this._abort = null;
    });
    return this._refreshing;
  }

  async _doRefresh({ force, onlyDue, atStart }) {
    const { byUrl, invalid } = this._configuredUrls();
    this._abort = new AbortController();
    const results = [];
    for (const bad of invalid) {
      this._log('warn', `Quelle ${bad.sourceId}: ungültige EPG-URL (${bad.error})`);
    }
    for (const [url, sourceIds] of byUrl) {
      if (this._abort.signal.aborted) break;
      if (onlyDue && !force && !this._isDue(url, atStart)) continue;
      results.push(await this._refreshUrl(url, sourceIds));
    }
    this._lastRefreshAt = this.now();
    return results;
  }

  async _refreshUrl(url, sourceIds) {
    const startedAt = this.now();
    const previous = this._state.get(url) || { lastSuccessAt: 0 };
    const state = { ...previous, lastAttemptAt: startedAt, sourceIds };
    this._state.set(url, state);
    try {
      const fromMs = startedAt - this.timing.windowBackMs;
      const toMs = startedAt + this.timing.windowAheadMs;
      const channelSlots = new Map();
      const response = await fetchEpgResponse(url, {
        fetchImpl: this.fetchImpl,
        validateUrl: this.validateUrl,
        timeoutMs: this.timing.downloadTimeoutMs,
        signal: this._abort ? this._abort.signal : null,
      });
      const stats = await parseXmltvResponse(response, {
        maxBytes: this.maxBytes,
        fromMs,
        toMs,
        onProgramme: ({ channel, start, stop, title, desc }) => {
          let list = channelSlots.get(channel);
          if (!list) {
            list = [];
            channelSlots.set(channel, list);
          }
          list.push({ start, stop, title, desc });
        },
      });
      if (stats.emitted === 0) throw new Error('Die XMLTV-Datei enthält keine gültigen Sendungen im Zeitfenster');
      this.store.setSource(url, { fetchedAt: startedAt, sourceIds, channelSlots });
      await this.store.save();
      state.lastSuccessAt = startedAt;
      state.lastError = null;
      this._log(
        'info',
        `EPG aktualisiert: ${url} — ${stats.emitted} Sendungen, ${channelSlots.size} Kanäle` +
          `${stats.gzip ? ' (gzip)' : ''}`,
      );
      return { url, ok: true, slots: stats.emitted, channels: channelSlots.size };
    } catch (e) {
      // Alter Cache bleibt unverändert (setSource wurde nicht erreicht)
      state.lastError = e && e.message ? e.message : String(e);
      this._log('warn', `EPG-Refresh fehlgeschlagen (${url}): ${state.lastError}`);
      return { url, ok: false, error: state.lastError };
    }
  }

  // ── Abfrage-API ──

  range(channelKey, fromMs, toMs) {
    return this.store.range(channelKey, fromMs, toMs);
  }

  find(channelKey, atMs) {
    return this.store.find(channelKey, atMs);
  }

  /**
   * Status für Settings/Diagnose: Stand je Quelle, Abdeckung in Tagen, nächster Refresh.
   */
  status() {
    const now = this.now();
    const cached = this.store.describe();
    const { byUrl, invalid } = this._configuredUrls();
    const urls = new Set([...byUrl.keys(), ...cached.map(c => c.url)]);
    const sources = [];
    let lastSuccessAt = null;
    let nextRefreshAt = null;
    let coverageToMs = null;
    for (const url of urls) {
      const info = cached.find(c => c.url === url) || null;
      const state = this._state.get(url) || null;
      const next = !state
        ? now
        : state.lastError
          ? state.lastAttemptAt + this.timing.retryIntervalMs
          : state.lastSuccessAt + this.timing.refreshIntervalMs;
      if (info && (lastSuccessAt === null || info.fetchedAt > lastSuccessAt)) lastSuccessAt = info.fetchedAt;
      if (byUrl.has(url) && (nextRefreshAt === null || next < nextRefreshAt)) nextRefreshAt = next;
      if (info && info.toMs !== null && (coverageToMs === null || info.toMs > coverageToMs)) coverageToMs = info.toMs;
      sources.push({
        url,
        sourceIds: byUrl.get(url) || info?.sourceIds || [],
        configured: byUrl.has(url),
        fetchedAt: info ? info.fetchedAt : null,
        lastAttemptAt: state ? state.lastAttemptAt : null,
        lastError: state ? state.lastError : null,
        channelCount: info ? info.channelCount : 0,
        slotCount: info ? info.slotCount : 0,
        coverageFromMs: info ? info.fromMs : null,
        coverageToMs: info ? info.toMs : null,
      });
    }
    return {
      refreshing: !!this._refreshing,
      lastSuccessAt,
      nextRefreshAt,
      coverageToMs,
      coverageDays: coverageToMs === null ? 0 : Math.max(0, Math.round(((coverageToMs - now) / DAY_MS) * 10) / 10),
      sources,
      invalidSources: invalid,
    };
  }
}

module.exports = { EpgService, DEFAULTS };
