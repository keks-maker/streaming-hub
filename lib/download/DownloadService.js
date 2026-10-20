'use strict';

// DownloadService (Konzept §3/§4): Warteschlange, Zustandsautomat, Persistenz (downloads.json), Wiederaufnahme beim Start,
// Duplikat-Index, Zurückstellung bei Altersfreigabe, Platzprüfung (Reserve gemeinsam mit den Aufnahmen), Serien-Batch,
// Benachrichtigung, Aufräumen und Quit-Registry. Zustände: queued | resolving | downloading | paused | scheduled | done | failed | canceled.
// Aufnahmen haben Vorrang: laufen welche, wird nur ein Download gleichzeitig geladen und die Platzreserve verdoppelt.
// Der Dienst kennt kein Electron; alles Äußere (Auflösung, Jobs, Zeit, Plattenplatz, Benachrichtigung) ist injizierbar.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { effectiveOptions, resolveStorageRoot, OVERRIDE_KEYS } = require('./download-settings.js');
const { buildPlan } = require('./track-selection.js');
const { buildTarget } = require('./filenames.js');
const { nextAttemptAt } = require('./age-window.js');
const { DownloadJob } = require('./DownloadJob.js');
const { assertDownloadUrl } = require('./net.js');
const { validateStorageRoot } = require('../recorder/paths.js');
const records = require('./records.js');
const { sortForBatch } = require('./batch.js');
const { writeSidecars } = require('./sidecars.js');
const { describePlan } = require('./preview.js');

const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_AGE_RETRIES = 30;
const FREE_CHECK_MS = 5000;
const CLEANUP_INTERVAL_MS = 6 * 3600 * 1000;

const MESSAGES = {
  network: 'Die Quelle ist nicht erreichbar. Bitte später erneut versuchen.',
  geo: 'Dieser Beitrag ist in deiner Region nicht abrufbar (Geoblock).',
  expired: 'Der Beitrag ist nicht mehr verfügbar.',
  space: 'Zu wenig freier Speicherplatz für diesen Download.',
  spaceLow: 'Speicherplatz wird knapp: Die Reserve für Aufnahmen bleibt frei. Der Download wurde angehalten.',
};

function defaultFreeBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

/** Größe der Teildatei (0, wenn es sie nicht gibt). */
function partSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function newId() {
  return `dl_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

class DownloadService extends EventEmitter {
  /**
   * options:
   *  store ({ load, save }), resolver ({ resolveForDownload(entry, { series }) }), getSettings(), getRecordingRoot(), getReserveBytes(),
   *  getRecordingActive() (Anzahl laufender Aufnahmen), notifier ({ notify(title, body) }), getWatchState(record) -> { watched } | null,
   *  coverFetcher(url) -> Buffer|null, ffmpegPath, ffprobePath, mediaHttp, httpOptions, spawnImpl, userAgent, protocolWhitelist,
   *  assertUrl(url, sourceId), freeBytes(dir), now() (ms), setTimer/clearTimer, createJob(options), validateRoot(root), logger
   */
  constructor(options) {
    super();
    const o = options || {};
    if (!o.store || !o.resolver || typeof o.getSettings !== 'function' || typeof o.getRecordingRoot !== 'function') throw new Error('DownloadService: store, resolver, getSettings und getRecordingRoot sind erforderlich');
    this.store = o.store;
    this.resolver = o.resolver;
    this.getSettings = o.getSettings;
    this.getRecordingRoot = o.getRecordingRoot;
    this.getReserveBytes = o.getReserveBytes || (() => 1024 * 1024 * 1024);
    this.getRecordingActive = o.getRecordingActive || (() => 0);
    this.notifier = o.notifier || null;
    this.getWatchState = o.getWatchState || (() => null);
    this.coverFetcher = o.coverFetcher || null;
    this.ffmpegPath = o.ffmpegPath;
    this.ffprobePath = o.ffprobePath;
    this.mediaHttp = o.mediaHttp || null;
    this.httpOptions = o.httpOptions || {};
    this.spawnImpl = o.spawnImpl;
    this.userAgent = o.userAgent || null;
    this.protocolWhitelist = o.protocolWhitelist;
    this.assertUrl = o.assertUrl || ((url, sourceId) => assertDownloadUrl(url, sourceId));
    this.freeBytes = o.freeBytes || defaultFreeBytes;
    this.now = o.now || (() => Date.now());
    this.setTimer = o.setTimer || setTimeout;
    this.clearTimer = o.clearTimer || clearTimeout;
    this.createJob = o.createJob || (jobOptions => new DownloadJob(jobOptions));
    this.validateRoot = o.validateRoot || validateStorageRoot;
    this.logger = o.logger || null;
    this.records = new Map();
    this.runs = new Map(); // id -> { token, job }
    this.timers = new Map(); // id -> Timer (Zurückstellung)
    this.children = new Set(); // ffmpeg/ffprobe-Prozesse (Quit-Sweep)
    this.reserved = new Set(); // Zielpfade laufender/geplanter Jobs (Kollisionen)
    this.seq = 0;
    this.finishedSinceIdle = [];
    this.quitting = false;
    this.started = false;
    this.cleanupTimer = null;
    this.lastFreeCheck = new Map();
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[download] ${message}`);
  }

  // ── Lebenszyklus ──

  /** Lädt die gespeicherte Liste, setzt unterbrochene Downloads fort und startet Timer. */
  start() {
    if (this.started) return;
    this.started = true;
    for (const record of this.store.load()) {
      this.records.set(record.id, record);
      this.seq = Math.max(this.seq, record.seq);
    }
    for (const record of this.records.values()) {
      if (records.RUNNING.includes(record.status)) {
        record.status = 'queued'; // App war weg: Wiederaufnahme
        record.progress = { ...record.progress, speed: null, etaSec: null };
      } else if (record.status === 'scheduled') {
        this._armTimer(record);
      }
      if (record.target && !['done', 'canceled'].includes(record.status)) this.reserved.add(record.target.file);
    }
    this._persist();
    this.cleanupWatched();
    this.cleanupTimer = this.setTimer(() => this._cleanupTick(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
    this.pump();
  }

  _cleanupTick() {
    this.cleanupWatched();
    this.cleanupTimer = this.setTimer(() => this._cleanupTick(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  /** Timer löschen (Tests/Beenden); Jobs laufen weiter, bis quitSweep aufgerufen wird. */
  stop() {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    if (this.cleanupTimer) this.clearTimer(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  // ── Persistenz und Ereignisse ──

  _persist() {
    this.store.save([...this.records.values()].sort((a, b) => a.seq - b.seq));
  }

  _emitChanged(record, reason = 'state') {
    this.emit('changed', { id: record.id, reason, view: this._view(record) });
  }

  _set(record, fields, { persist = true } = {}) {
    if (!this.records.has(record.id)) return false;
    Object.assign(record, fields);
    if (persist) this._persist();
    this._emitChanged(record);
    return true;
  }

  _view(record) {
    const fileMissing = record.status === 'done' && (!record.file || !fs.existsSync(record.file));
    const view = records.toView(record, { nowMs: this.now(), fileMissing });
    // "Gesehen" sofort aus dem Verlauf (watchedAt wird nur im Aufräum-Takt festgeschrieben)
    if (record.status === 'done') view.watched = Boolean(record.watchedAt) || this._isWatched(record);
    return view;
  }

  /** Alle Datensätze (Warteschlange und Bibliothek) als Ansichten, neueste zuerst. */
  list() {
    return [...this.records.values()].sort((a, b) => b.seq - a.seq).map(record => this._view(record));
  }

  get(id) {
    return this.records.get(id) || null;
  }

  summary() {
    const counts = { queued: 0, active: 0, paused: 0, scheduled: 0, done: 0, failed: 0 };
    for (const record of this.records.values()) {
      if (records.RUNNING.includes(record.status)) counts.active += 1;
      else if (counts[record.status] !== undefined) counts[record.status] += 1;
    }
    return counts;
  }

  /** Anzahl Downloads, die ein Beenden der App unterbrechen würde (laufend oder wartend). */
  activeCount() {
    let count = 0;
    for (const record of this.records.values()) if (record.status === 'queued' || records.RUNNING.includes(record.status)) count += 1;
    return count;
  }

  // ── Einstellungen und Ziel ──

  _storageRoot() {
    return resolveStorageRoot(this.getSettings(), this.getRecordingRoot());
  }

  /** Wirksamer Speicherort (für Anzeige und Platzprüfung). */
  storageRoot() {
    return this._storageRoot();
  }

  _reserveBytes() {
    return this.getRecordingActive() > 0 ? this.getReserveBytes() * 2 : this.getReserveBytes();
  }

  /** Freier Platz am Speicherort gegen die Reserve (für automatische Abos): { freeBytes, reserveBytes, low } (low = unter der Reserve). */
  spaceStatus() {
    const root = this._storageRoot();
    const freeBytes = this.freeBytes(fs.existsSync(root) ? root : this.getRecordingRoot());
    const reserveBytes = this._reserveBytes();
    return { freeBytes, reserveBytes, low: freeBytes !== null && freeBytes <= reserveBytes };
  }

  // ── Duplikate ──

  /** Vorhandener Datensatz derselben Folge (OV/AD zählen als dieselbe), der die Folge belegt. */
  findDuplicate(entry) {
    const wanted = new Set(records.aliasKeys(entry));
    for (const record of this.records.values()) {
      if (!records.OCCUPYING.includes(record.status)) continue;
      if (record.status === 'done' && (!record.file || !fs.existsSync(record.file))) continue; // Datei gelöscht: erneut ladbar
      if (record.aliases.some(key => wanted.has(key))) return record;
    }
    return null;
  }

  // ── Einreihen ──

  _newRecord({ entry, series, options, batchId, root }) {
    this.seq += 1;
    const minimal = records.minimalEntry(entry);
    return {
      id: newId(),
      seq: this.seq,
      key: records.keyOf(minimal.sourceId, minimal.id),
      aliases: records.aliasKeys(minimal),
      entry: minimal,
      series: records.minimalSeries(series),
      batchId: batchId || null,
      options,
      status: 'queued',
      error: null,
      errorCode: null,
      progress: { percent: null, bytes: null, totalBytes: null, speed: null, etaSec: null },
      estimatedBytes: null,
      title: minimal.title,
      seriesTitle: series && series.title ? series.title : null,
      season: minimal.season,
      episode: minimal.episode,
      broadcastDate: null,
      durationSec: minimal.duration,
      availableUntil: minimal.availableUntil,
      retryAt: null,
      ageRetries: 0,
      reresolved: false,
      root,
      target: null,
      file: null,
      fileSize: null,
      sidecars: [],
      http: { etag: null, total: null },
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      watchedAt: null,
      warnings: [],
    };
  }

  /** Optionen eines Downloads: Einstellungen plus Überschreibungen, als vollständiger Schnappschuss der Wahl-Felder. */
  _snapshotOptions(overrides) {
    const merged = effectiveOptions(this.getSettings(), overrides);
    const snapshot = {};
    for (const key of OVERRIDE_KEYS) snapshot[key] = merged[key];
    return snapshot;
  }

  _enqueueOne({ entry, series, overrides, batchId, root }) {
    const minimal = records.minimalEntry(entry);
    if (!minimal.id || !minimal.sourceId) return { ok: false, code: 'invalid', message: 'Ungültige Folge' };
    const duplicate = this.findDuplicate(minimal);
    if (duplicate) return { ok: false, code: 'duplicate', id: duplicate.id, status: duplicate.status, message: duplicate.status === 'done' ? 'Bereits geladen.' : 'Bereits in der Warteschlange.' };
    // Datensätze fehlgeschlagener/abgebrochener Vorgänger (und fertiger mit gelöschter Datei) derselben Folge ersetzen
    const keys = records.aliasKeys(minimal);
    for (const old of [...this.records.values()]) {
      if (!old.aliases.some(key => keys.includes(key))) continue;
      this._removePartFile(old);
      this._dropRecord(old, { deleteFile: false });
      this.emit('removed', { id: old.id });
    }
    const record = this._newRecord({ entry: minimal, series, options: this._snapshotOptions(overrides), batchId, root });
    this.records.set(record.id, record);
    return { ok: true, id: record.id, status: record.status, record };
  }

  _checkRoot() {
    const root = this._storageRoot();
    const check = this.validateRoot(root);
    if (!check.ok) return { ok: false, code: 'storage', message: `Speicherort nicht nutzbar: ${check.error}` };
    return { ok: true, root, freeBytes: check.freeBytes };
  }

  /** Eine Folge einreihen. Ergebnis { ok, id, status } oder { ok: false, code: 'duplicate'|'storage'|'invalid', message }. */
  enqueue({ entry, series = null, overrides = {} }) {
    const root = this._checkRoot();
    if (!root.ok) return root;
    const result = this._enqueueOne({ entry, series, overrides, root: root.root });
    if (!result.ok) return result;
    this._persist();
    this._emitChanged(result.record, 'added');
    this.pump();
    return { ok: true, id: result.id, status: result.status };
  }

  /**
   * Mehrere Folgen einer Serie: Reihenfolge bald ablaufend zuerst, dann chronologisch. Ergebnis { ok, results: [{ entryId, ok, id?,
   * code? }], added }.
   */
  enqueueMany({ series, entries, overrides = {} }) {
    const root = this._checkRoot();
    if (!root.ok) return { ...root, results: [], added: 0 };
    const batchId = `batch_${newId().slice(3)}`;
    const results = [];
    let added = 0;
    for (const entry of sortForBatch(entries, this.now())) {
      const result = this._enqueueOne({ entry, series, overrides, batchId, root: root.root });
      if (result.ok) {
        added += 1;
        results.push({ entryId: entry.id, ok: true, id: result.id });
        this._emitChanged(result.record, 'added');
      } else {
        results.push({ entryId: entry.id, ok: false, code: result.code, id: result.id || null, message: result.message });
      }
    }
    if (added) this._persist();
    this.pump();
    return { ok: true, results, added };
  }

  // ── Steuerung ──

  pause(id) {
    const record = this.records.get(id);
    if (!record) return { ok: false, code: 'unknown' };
    if (!['queued', 'resolving', 'downloading', 'scheduled'].includes(record.status)) return { ok: false, code: 'state', message: 'Dieser Download kann nicht angehalten werden.' };
    this._clearTimer(record.id);
    const run = this.runs.get(id);
    this._set(record, { status: 'paused', error: null, errorCode: null, retryAt: null, progress: { ...record.progress, speed: null, etaSec: null } });
    if (run) {
      run.token = null; // laufende Auflösung/Planung verwerfen
      if (run.job) run.job.pause();
    }
    return { ok: true };
  }

  resume(id) {
    const record = this.records.get(id);
    if (!record) return { ok: false, code: 'unknown' };
    if (record.status !== 'paused') return { ok: false, code: 'state', message: 'Dieser Download ist nicht angehalten.' };
    this._set(record, { status: 'queued', error: null, errorCode: null });
    this.pump();
    return { ok: true };
  }

  cancel(id) {
    const record = this.records.get(id);
    if (!record) return { ok: false, code: 'unknown' };
    if (['done', 'failed', 'canceled'].includes(record.status)) return { ok: false, code: 'state', message: 'Dieser Download läuft nicht.' };
    this._clearTimer(record.id);
    const run = this.runs.get(id);
    this._set(record, { status: 'canceled', error: null, errorCode: null, retryAt: null, progress: { percent: null, bytes: null, totalBytes: null, speed: null, etaSec: null } });
    if (run) {
      run.token = null;
      if (run.job) run.job.cancel();
    }
    if (!run || !run.job) this._removePartFile(record);
    if (record.target) this.reserved.delete(record.target.file);
    record.target = null; // nach Abbruch beginnt ein neuer Versuch mit frischem Dateinamen
    this._persist();
    this.pump();
    return { ok: true };
  }

  retry(id) {
    const record = this.records.get(id);
    if (!record) return { ok: false, code: 'unknown' };
    if (!['failed', 'canceled'].includes(record.status)) return { ok: false, code: 'state', message: 'Dieser Download kann nicht wiederholt werden.' };
    const duplicate = this.findDuplicate(record.entry);
    if (duplicate && duplicate.id !== record.id) return { ok: false, code: 'duplicate', message: 'Diese Folge ist bereits vorhanden.' };
    this.seq += 1;
    this._set(record, { status: 'queued', seq: this.seq, error: null, errorCode: null, reresolved: false, ageRetries: 0, retryAt: null, progress: { percent: null, bytes: null, totalBytes: null, speed: null, etaSec: null } });
    this.pump();
    return { ok: true };
  }

  /** Entfernt den Eintrag (laufende Downloads werden abgebrochen); deleteFile löscht auch Videodatei und Begleitdateien. */
  remove(id, { deleteFile = false } = {}) {
    const record = this.records.get(id);
    if (!record) return { ok: false, code: 'unknown' };
    const run = this.runs.get(id);
    this._clearTimer(id);
    if (run) {
      run.token = null;
      if (run.job) run.job.cancel();
    }
    if (!run || !run.job) this._removePartFile(record);
    this._dropRecord(record, { deleteFile });
    this._persist();
    this.emit('removed', { id });
    this.pump();
    return { ok: true };
  }

  _dropRecord(record, { deleteFile }) {
    if (deleteFile) this._deleteFiles(record);
    this._clearTimer(record.id);
    this.records.delete(record.id);
    if (record.target) this.reserved.delete(record.target.file);
  }

  _deleteFiles(record) {
    const targets = [record.file, ...record.sidecars].filter(Boolean);
    for (const file of targets) {
      if (!records.isManagedFile(record, file)) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        this._log('warn', `Datei nicht gelöscht: ${error.code || error.message}`);
      }
    }
    this._removeEmptyDirs(record);
  }

  /** Leere Serien-/Quellenordner unterhalb des Speicherorts aufräumen. */
  _removeEmptyDirs(record) {
    if (!record.root || !record.file) return;
    let dir = path.dirname(record.file);
    for (let depth = 0; depth < 3 && records.isInside(record.root, dir); depth += 1) {
      try {
        fs.rmdirSync(dir);
      } catch {
        return; // nicht leer oder nicht vorhanden
      }
      dir = path.dirname(dir);
    }
  }

  _removePartFile(record) {
    if (!record.target || !record.root || !records.isInside(record.root, record.target.partFile)) return;
    try {
      fs.rmSync(record.target.partFile, { force: true });
    } catch {
      // Teildatei nicht löschbar
    }
  }

  // ── Datei für Anzeige/Wiedergabe ──

  /** Lokale Datei eines fertigen Downloads (nur aus dem eigenen Index); null, wenn nicht vorhanden. */
  fileInfo(id) {
    const record = this.records.get(id);
    if (!record || record.status !== 'done' || !record.file || !records.isManagedFile(record, record.file) || !fs.existsSync(record.file)) return null;
    return { path: record.file, record };
  }

  // ── Queue ──

  /**
   * Aufnahmen haben Vorrang: läuft eine Aufnahme, bleibt nur der älteste laufende Download aktiv, die übrigen kehren in die
   * Warteschlange zurück (HTTP-Teildateien bleiben für den Resume). Endet die Aufnahme, startet pump() sie wieder.
   * Wird bei jeder Änderung des Aufnahmezustands aufgerufen.
   */
  onRecordingActivity() {
    if (this.getRecordingActive() > 0) {
      const running = [...this.records.values()].filter(record => record.status === 'downloading').sort((a, b) => a.seq - b.seq);
      for (const record of running.slice(1)) {
        const run = this.runs.get(record.id);
        if (!run || !run.job) continue;
        run.token = null;
        run.job.pause();
        this._set(record, { status: 'queued', progress: { ...record.progress, speed: null, etaSec: null } });
      }
    }
    this.pump();
  }

  /**
   * Nach einer Anmeldung bei der Mediathek (Konto): wegen Jugendschutz zurückgestellte Downloads sofort neu auflösen, statt
   * auf das Abrufzeitfenster zu warten. sources = betroffene Sender (leer = alle). Ergebnis: Anzahl der wieder eingereihten.
   */
  retryAgeScheduledNow(sources = []) {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status !== 'scheduled' || record.errorCode !== 'age') continue;
      if (sources.length && !sources.includes(record.entry.sourceId)) continue;
      this._clearTimer(record.id);
      this._set(record, { status: 'queued', retryAt: null, error: null, errorCode: null });
      count += 1;
    }
    if (count) this.pump();
    return count;
  }

  _limit() {
    const settings = this.getSettings();
    return this.getRecordingActive() > 0 ? 1 : settings.maxParallel;
  }

  /** Startet wartende Downloads bis zur Parallelitätsgrenze. */
  pump() {
    if (this.quitting || !this.started) return;
    const limit = this._limit();
    let running = [...this.records.values()].filter(record => records.RUNNING.includes(record.status)).length;
    const queued = [...this.records.values()].filter(record => record.status === 'queued').sort((a, b) => a.seq - b.seq);
    for (const record of queued) {
      if (running >= limit) break;
      running += 1;
      this._begin(record);
    }
  }

  _begin(record) {
    const run = { token: Symbol(record.id), job: null };
    this.runs.set(record.id, run);
    this._set(record, { status: 'resolving', error: null, errorCode: null, startedAt: new Date(this.now()).toISOString() });
    this._execute(record, run).catch(error => {
      this._log('error', `Unerwarteter Fehler: ${error && error.message}`);
      if (run.token) this._fail(record, run, 'Der Download ist fehlgeschlagen.', 'error');
    }).finally(() => {
      if (this.runs.get(record.id) === run) this.runs.delete(record.id);
      this.pump();
    });
  }

  _alive(record, run) {
    return run.token !== null && this.runs.get(record.id) === run && this.records.has(record.id);
  }

  _fail(record, run, message, code) {
    if (run) run.token = null;
    this._set(record, { status: 'failed', error: message, errorCode: code, retryAt: null, progress: { ...record.progress, speed: null, etaSec: null } });
    this._notifyIdleIfDrained();
  }

  /** Frisch aufgelöste Info; ARD: Original-Ton aus dem OV-Eintrag, wenn gewünscht. */
  async _resolve(record, options) {
    const info = await this.resolver.resolveForDownload(record.entry, { series: record.series });
    const wantsOriginal = options.audioMode === 'all' || (options.audioLanguages || []).includes('orig');
    if (!info.restriction && record.entry.sourceId === 'ard' && record.entry.originalVersionId && wantsOriginal) {
      try {
        const ov = await this.resolver.resolveForDownload({ ...record.entry, id: record.entry.originalVersionId, originalVersionId: null, audioDescriptionId: null }, { series: null });
        const main = !ov.restriction ? ov.audioTracks.find(track => track.kind === 'main' && (track.url || track.hlsUrl)) : null;
        if (main) info.audioTracks.push({ ...main, id: 'ard-ov', kind: 'original', language: 'ov', label: 'Originalversion', isDefault: false });
      } catch (error) {
        this._log('warn', `Originalversion nicht aufgelöst: ${error && error.code}`);
      }
    }
    return info;
  }

  _restrictionOutcome(record, run, restriction) {
    if (restriction.code === 'age') {
      if (record.ageRetries >= MAX_AGE_RETRIES) return this._fail(record, run, restriction.message, 'age');
      const retryAt = nextAttemptAt(restriction.rating, this.now(), restriction.retryAt);
      run.token = null;
      this._set(record, { status: 'scheduled', retryAt, ageRetries: record.ageRetries + 1, error: restriction.message, errorCode: 'age', progress: { percent: null, bytes: null, totalBytes: null, speed: null, etaSec: null } });
      this._armTimer(record);
      return undefined;
    }
    const message = restriction.code === 'geo' ? MESSAGES.geo : restriction.message || MESSAGES.expired;
    return this._fail(record, run, message, restriction.code);
  }

  _clearTimer(id) {
    const timer = this.timers.get(id);
    if (timer) this.clearTimer(timer);
    this.timers.delete(id);
  }

  _armTimer(record) {
    this._clearTimer(record.id);
    if (!record.retryAt) return;
    const delay = Math.max(0, Date.parse(record.retryAt) - this.now());
    const timer = this.setTimer(() => {
      this.timers.delete(record.id);
      if (!this.records.has(record.id) || record.status !== 'scheduled') return;
      if (Date.parse(record.retryAt) - this.now() > 1000) return this._armTimer(record); // langer Zeitraum: nachgeführt
      this._set(record, { status: 'queued', retryAt: null });
      this.pump();
    }, Math.min(delay, MAX_TIMER_MS));
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.timers.set(record.id, timer);
  }

  async _execute(record, run) {
    const settings = this.getSettings();
    const options = effectiveOptions(settings, record.options);
    let info;
    try {
      info = await this._resolve(record, options);
    } catch (error) {
      if (!this._alive(record, run)) return;
      this._log('warn', `Auflösung fehlgeschlagen: ${error && error.code}`);
      return this._fail(record, run, MESSAGES.network, 'network');
    }
    if (!this._alive(record, run)) return;
    if (info.restriction) return this._restrictionOutcome(record, run, info.restriction);
    if (info.availableUntil && Date.parse(info.availableUntil) < this.now()) return this._fail(record, run, MESSAGES.expired, 'unavailable');
    const planned = buildPlan(info, options);
    if (!planned.ok) return this._fail(record, run, planned.message, planned.code);
    const { plan } = planned;
    const root = record.root || this._storageRoot();
    const meta = { season: info.season ?? record.season, episode: info.episode ?? record.episode, broadcastDate: info.broadcastDate || null };
    const seriesTitle = info.seriesTitle || (record.series && record.series.title) || record.seriesTitle || null;
    const fields = { root, title: info.title || record.title, seriesTitle, season: meta.season, episode: meta.episode, broadcastDate: meta.broadcastDate, durationSec: info.durationSeconds || record.durationSec, availableUntil: info.availableUntil || record.availableUntil, estimatedBytes: plan.estimatedBytes, warnings: plan.warnings };
    Object.assign(record, fields);
    if (!record.target) {
      const target = buildTarget({
        root,
        sourceId: record.entry.sourceId,
        seriesTitle,
        data: { title: record.title, season: record.season, episode: record.episode, date: record.broadcastDate },
        scheme: options.fileNameScheme,
        seriesFolders: options.seriesFolders,
        ext: plan.container,
        exists: file => fs.existsSync(file) || this.reserved.has(file.replace(/\.part$/, '')),
      });
      record.target = target;
    }
    this.reserved.add(record.target.file);
    this._persist();
    const spaceError = this._checkSpace(record, plan);
    if (spaceError) return this._fail(record, run, spaceError, 'space');
    return this._download(record, run, plan, options);
  }

  /** Genug Platz? Bedarf (geschätzt, abzüglich vorhandener Teildatei) + Reserve + Rest der anderen laufenden Downloads. */
  _checkSpace(record, plan) {
    const free = this.freeBytes(record.root);
    if (free === null || free === undefined) return null; // Netzlaufwerke ohne statfs: nicht prüfbar
    const existing = partSize(record.target.partFile);
    const needed = Math.max(0, (plan.estimatedBytes || 0) - existing);
    let committed = 0;
    for (const other of this.records.values()) {
      if (other.id === record.id || other.status !== 'downloading') continue;
      committed += Math.max(0, (other.estimatedBytes || 0) - (other.progress.bytes || 0));
    }
    if (free - committed < needed * 1.05 + this._reserveBytes()) return MESSAGES.space;
    return null;
  }

  async _download(record, run, plan, options) {
    const settings = this.getSettings();
    const job = this.createJob({
      plan,
      target: record.target,
      meta: { title: record.title, show: record.seriesTitle, season: record.season, episode: record.episode, date: record.broadcastDate },
      durationSec: record.durationSec,
      sourceId: record.entry.sourceId,
      maxHeight: options.maxHeight,
      bytesPerSecond: (settings.bandwidthKBps || 0) * 1000,
      etag: record.http.etag,
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
      mediaHttp: this.mediaHttp,
      assertUrl: this.assertUrl,
      httpOptions: this.httpOptions,
      spawnImpl: this.spawnImpl,
      userAgent: this.userAgent,
      protocolWhitelist: this.protocolWhitelist,
      logger: this.logger,
      onProgress: progress => this._onProgress(record, run, progress),
      onChild: child => this._trackChild(child),
    });
    run.job = job;
    this._set(record, { status: 'downloading', error: null, errorCode: null });
    try {
      const result = await job.run();
      if (!this._alive(record, run)) return;
      await this._complete(record, run, result, job);
    } catch (error) {
      if (!this._alive(record, run)) return; // pausiert/abgebrochen/entfernt: Zustand ist schon gesetzt
      await this._handleJobError(record, run, error);
    }
  }

  _trackChild(child) {
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
  }

  _onProgress(record, run, progress) {
    if (!this._alive(record, run)) return;
    record.progress = { percent: progress.percent ?? null, bytes: progress.bytes ?? null, totalBytes: progress.totalBytes ?? null, speed: progress.speed ?? null, etaSec: progress.etaSec ?? null };
    this._emitChanged(record, 'progress');
    const last = this.lastFreeCheck.get(record.id) || 0;
    if (this.now() - last >= FREE_CHECK_MS) {
      this.lastFreeCheck.set(record.id, this.now());
      const free = this.freeBytes(record.root);
      if (free !== null && free !== undefined && free < this.getReserveBytes()) {
        // Reserve für Aufnahmen unterschritten: Download anhalten statt die Platte zu füllen
        const job = run.job;
        run.token = null;
        this._set(record, { status: 'failed', error: MESSAGES.spaceLow, errorCode: 'space', progress: { ...record.progress, speed: null, etaSec: null } });
        if (job) job.pause();
      }
    }
  }

  async _handleJobError(record, run, error) {
    const code = (error && error.code) || 'error';
    if (code === 'expired' && !record.reresolved) {
      // Adresse abgelaufen: genau einmal frisch auflösen und neu beginnen
      run.token = null;
      this._set(record, { reresolved: true, status: 'queued' });
      return;
    }
    if (code === 'expired') return this._fail(record, run, MESSAGES.expired, 'expired');
    if (code === 'unsupported') return this._fail(record, run, error.message, 'unsupported');
    if (code === 'forbidden-host' || code === 'forbidden-address') return this._fail(record, run, 'Die Quelle verweist auf eine nicht erlaubte Adresse.', code);
    if (code === 'disk') return this._fail(record, run, 'Speicherplatz voll.', 'space');
    this._log('warn', `Download fehlgeschlagen (${code})`);
    const message = typeof error.message === 'string' && error.message ? error.message : 'Der Download ist fehlgeschlagen.';
    return this._fail(record, run, message, code);
  }

  async _complete(record, run, result, job) {
    run.token = null;
    const sidecars = [...(job.subtitleFiles || [])];
    const done = {
      status: 'done',
      file: result.file,
      fileSize: result.fileSize,
      durationSec: result.durationSec || record.durationSec,
      finishedAt: new Date(this.now()).toISOString(),
      error: null,
      errorCode: null,
      retryAt: null,
      progress: { percent: 100, bytes: result.fileSize, totalBytes: result.fileSize, speed: null, etaSec: 0 },
      http: { etag: result.etag || null, total: result.total || null },
      warnings: result.warnings || [],
    };
    this.reserved.delete(record.target.file);
    this.lastFreeCheck.delete(record.id);
    if (this.getSettings().writeNfoCover) sidecars.push(...(await writeSidecars({ record, file: result.file, coverFetcher: this.coverFetcher, seriesFolders: this.getSettings().seriesFolders, log: (level, message) => this._log(level, message) })));
    done.sidecars = sidecars;
    this._set(record, done);
    this._noteFinished(record);
  }

  // ── Benachrichtigung ──

  _noteFinished(record) {
    this.finishedSinceIdle.push(record.title);
    this._notifyIdleIfDrained();
  }

  /** Eine Benachrichtigung, wenn die Warteschlange leer ist (statt je Folge einer ganzen Staffel). */
  _notifyIdleIfDrained() {
    const pending = [...this.records.values()].some(record => record.status === 'queued' || records.RUNNING.includes(record.status));
    if (pending) return;
    const finished = this.finishedSinceIdle;
    this.finishedSinceIdle = [];
    if (!finished.length || !this.notifier || !this.getSettings().notifyOnDone) return;
    if (finished.length === 1) this.notifier.notify('Download fertig', finished[0]);
    else this.notifier.notify('Downloads fertig', `${finished.length} Folgen wurden geladen.`);
  }

  // ── Aufräumen ──

  /** Gesehene Downloads nach n Tagen löschen (Einstellung cleanupWatchedDays, 0 = aus). Rückgabe: Anzahl entfernter Downloads. */
  cleanupWatched() {
    const days = this.getSettings().cleanupWatchedDays;
    let removed = 0;
    for (const record of [...this.records.values()]) {
      if (record.status !== 'done') continue;
      if (!record.watchedAt) {
        if (this._isWatched(record)) {
          record.watchedAt = new Date(this.now()).toISOString();
          this._persist();
        }
      }
      if (days > 0 && record.watchedAt && this.now() - Date.parse(record.watchedAt) >= days * 86400000) {
        this._dropRecord(record, { deleteFile: true });
        this.emit('removed', { id: record.id });
        removed += 1;
      }
    }
    if (removed) this._persist();
    return removed;
  }

  _isWatched(record) {
    try {
      const state = this.getWatchState(record);
      return Boolean(state && state.watched);
    } catch {
      return false;
    }
  }

  // ── Beenden ──

  /** Synchron beim Beenden: Prozesse beenden, laufende Downloads für den nächsten Start vormerken. */
  quitSweep() {
    this.quitting = true;
    this.stop();
    for (const run of this.runs.values()) {
      if (run.job && typeof run.job.killForQuit === 'function') run.job.killForQuit();
      run.token = null;
    }
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Prozess schon beendet
      }
    }
    this.children.clear();
    for (const record of this.records.values()) {
      if (records.RUNNING.includes(record.status)) record.status = 'queued';
    }
    this._persist();
  }

  // ── Vorschau ──

  /** Plan ohne Einreihen: Spuren, Größe, freier Platz (für den Optionen-Dialog). */
  async preview({ entry, series = null, overrides = {} }) {
    const minimal = records.minimalEntry(entry);
    const options = effectiveOptions(this.getSettings(), overrides);
    const root = this._storageRoot();
    const base = { root, freeBytes: this.freeBytes(fs.existsSync(root) ? root : this.getRecordingRoot()), reserveBytes: this._reserveBytes() };
    const duplicate = this.findDuplicate(minimal);
    let info;
    try {
      info = await this._resolve({ entry: minimal, series: records.minimalSeries(series) }, options);
    } catch {
      return { ok: false, code: 'network', message: MESSAGES.network, ...base };
    }
    const common = { ...base, duplicate: duplicate ? { id: duplicate.id, status: duplicate.status } : null, availableUntil: info.availableUntil, title: info.title, seriesTitle: info.seriesTitle, season: info.season, episode: info.episode };
    if (info.restriction) {
      const restriction = info.restriction;
      if (restriction.code === 'age') return { ok: true, restricted: true, restriction: { code: 'age', message: restriction.message, retryAt: nextAttemptAt(restriction.rating, this.now(), restriction.retryAt) }, ...common };
      return { ok: false, code: restriction.code, message: restriction.code === 'geo' ? MESSAGES.geo : restriction.message, ...common };
    }
    const planned = buildPlan(info, options);
    if (!planned.ok) return { ok: false, code: planned.code, message: planned.message, ...common };
    const { plan } = planned;
    return {
      ok: true,
      restricted: false,
      ...common,
      ...describePlan(info, plan),
      enoughSpace: base.freeBytes === null ? null : base.freeBytes >= (plan.estimatedBytes || 0) * 1.05 + base.reserveBytes,
    };
  }
}

module.exports = { DownloadService, sortForBatch, MESSAGES };
