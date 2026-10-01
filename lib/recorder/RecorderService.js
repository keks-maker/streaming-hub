// v0.5.8 – RecorderService: Orchestrator der Aufnahme-Engine
// (Aufnahme Phase 1b, Karte t_17ee2ca5; Konzept §2.5)
//
// Verantwortlichkeiten (SRP): aktive Aufnahmen verwalten, Start-Checks
// (ffmpeg, Speicherort, Platz), Duplikat-Schutz pro Kanal, Persistenz
// (RecordingStore), Remux nach Stop + Recovery beim Start (remux-pending),
// Status-/Progress-Events. Nicht Teil dieser Klasse: Tray, UI, Settings
// (eigene Karten). Die ffmpeg-API kommt aus dem Phase-1a-Spike (lib/ffmpeg.js:
// ensureBinaries/checkHealth/binaryPath, Mindestversion 7.0.0).

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('../../logger.js');
const ffmpegLib = require('../ffmpeg.js');
const { createRecordingStore } = require('./RecordingStore.js');
const { RecordJob, playlistDurationSec } = require('./RecordJob.js');
const { runRemux, decodeCheckMp4 } = require('./RemuxJob.js');
const paths = require('./paths.js');
const {
  makeRecordingId,
  normalizeMeta,
  assertTransition,
  buildRecordingFilename,
  withCollisionSuffix,
  PROGRESS_PHASE_RECORDING,
  PROGRESS_PHASE_STOPPING,
  PROGRESS_PHASE_REMUXING,
  PROGRESS_PHASE_DONE,
} = require('./meta.js');

const DEFAULT_MAX_PARALLEL = 3; // Konzept §4.4

function log(level, message) {
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[fn](`[recorder] ${message}`);
}

/**
 * Validiert eine Aufnahme-Anfrage aus dem Renderer (Muster lib/ipc-validation.js):
 * nur http(s)-URLs, Längenlimits, Kanal-ID ohne Steuerzeichen.
 *
 * Die Kanal-ID wird bewusst NICHT mehr auf ein festes Zeicheninventar
 * beschränkt (QA F-FB-02): reale M3U/i-ptv-IDs enthalten Leerzeichen und
 * '@' (z. B. "DasErste.de@HD", "Kanal 21") — der alte Reject warf den
 * Record-Start im UI für den praktischen Normalfall. Sicherheitstechnisch
 * unbedenklich, weil die Kanal-ID niemals in einen Pfad fließt: Der
 * Aufnahmen-Ordner eines Jobs ist die intern erzeugte Aufnahme-ID
 * (rec_*, Whitelist /^rec_[A-Za-z0-9._-]+$/ in paths.jobDir/RecordingStore/
 * rec://-Handler), Dateinamen der MP4 bauen aus channelName (safeNamePart).
 * Ablehnung nur noch bei Steuerzeichen (Injektions-/Log-Manipulation).
 */
function validateRecordingRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Ungültige Aufnahme-Anfrage');
  }
  const sourceUrl = String(input.sourceUrl || '');
  if (!/^https?:\/\//i.test(sourceUrl) || sourceUrl.length > 4096) {
    throw new Error('Ungültige Stream-URL (nur http/https)');
  }
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
  const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
  const channelId =
    typeof input.channelId === 'string' && input.channelId.trim()
      ? input.channelId.trim().slice(0, 200)
      : null;
  const channelName =
    typeof input.channelName === 'string' && input.channelName.trim()
      ? input.channelName.trim().slice(0, 200)
      : null;
  if (channelId && HAS_CONTROL_CHARS.test(channelId)) {
    throw new Error('Ungültige Kanal-ID (Steuerzeichen)');
  }
  if (channelName && HAS_CONTROL_CHARS.test(channelName)) {
    throw new Error('Ungültiger Kanalname (Steuerzeichen)');
  }
  if (!channelId && !channelName) {
    throw new Error('Aufnahme benötigt channelId oder channelName');
  }
  const epgTitle =
    typeof input.epgTitle === 'string' && input.epgTitle.trim() ? input.epgTitle.trim().slice(0, 300) : null;
  const epgDescription =
    typeof input.epgDescription === 'string' && input.epgDescription.trim()
      ? input.epgDescription.trim().slice(0, 2000)
      : null;
  return { sourceUrl, channelId, channelName, epgTitle, epgDescription };
}

class RecorderService extends EventEmitter {
  /**
   * options:
   * - appRoot: App-Stamm (ffmpeg-Binaries in <appRoot>/bin, lib/ffmpeg.js)
   * - storageRoot: Speicherort (Default ~/Videos/Streaming Hub, Konzept §3.4)
   * - maxParallel: Parallelitäts-Limit (Default 3, Konzept §4.4)
   * - segmentSec: HLS-Target-Segmentdauer der Zwischenform
   */
  constructor({ appRoot, storageRoot, maxParallel = DEFAULT_MAX_PARALLEL, segmentSec = 2 } = {}) {
    super();
    if (!appRoot) throw new Error('RecorderService benötigt appRoot');
    if (!storageRoot) throw new Error('RecorderService benötigt storageRoot');
    this.appRoot = appRoot;
    this.storageRoot = path.resolve(storageRoot);
    this.maxParallel = Math.max(1, Number.isFinite(maxParallel) ? Math.floor(maxParallel) : DEFAULT_MAX_PARALLEL);
    this.segmentSec = segmentSec;
    this.store = createRecordingStore({ root: this.storageRoot, logger });
    this.jobs = new Map(); // recId → RecordJob
    this.remuxing = new Set(); // recIds in Nachbearbeitung
    this._afterRemuxCallbacks = new Map(); // recId → afterRemux (App-Kontext)
  }

  // ── Lifecycle ──

  /**
   * App-Start-Recovery (Konzept §2.3 "remux-pending → nachholender Remux"):
   * 1) Zombies (Status recording ohne Job) → aborted; 2) remux-pending →
   * Remux nachholen. afterRemux: async ({meta}) für App-Kontext-Broadcasts.
   */
  async recover({ afterRemux = null } = {}) {
    const reaped = this.store.reapOrphans(this.jobs.keys());
    const recovered = [];
    for (const meta of this.store.findResumable()) {
      try {
        const finalMeta = await this._remuxAfterStop(meta, { afterRemux, fromRecovery: true });
        recovered.push(finalMeta);
      } catch (e) {
        // Remux-Fehler: Meta bleibt remux-pending → nächster Start versucht es
        // erneut (Zwischenstände bleiben bewusst erhalten).
        log('error', `Recovery-Remux fehlgeschlagen für ${meta.id}: ${e.message}`);
      }
    }
    return { reaped, recovered };
  }

  // ── Start/Stop ──

  /**
   * Startet eine Aufnahme. Wirft bei fehlgeschlagenen Start-Checks
   * (ffmpeg, Speicherort, Duplikat pro Kanal, Parallelitäts-Limit).
   * afterRemux: async ({meta}) — App-Kontext-Broadcast nach Remux-Abschluss.
   */
  async start(request, { afterRemux = null } = {}) {
    const { sourceUrl, channelId, channelName, epgTitle, epgDescription } = validateRecordingRequest(request);

    const health = ffmpegLib.checkHealth(this.appRoot);
    if (!health.ok) {
      throw new Error('ffmpeg/ffprobe fehlen oder sind defekt — Aufnahme nicht verfügbar (siehe App-Log)');
    }
    const storage = paths.validateStorageRoot(this.storageRoot);
    if (!storage.ok) throw new Error(`Speicherort nicht nutzbar: ${storage.error}`);

    const duplicate = this.findJobByChannel(channelId, channelName);
    if (duplicate) {
      throw new Error(
        `Es läuft bereits eine Aufnahme für ${duplicate.meta.channelName || duplicate.meta.channelId} ` +
          '(Duplikat-Schutz, Konzept §3.1)',
      );
    }
    if (this.jobs.size >= this.maxParallel) {
      throw new Error(`Maximale Anzahl paralleler Aufnahmen erreicht (${this.maxParallel}, Konzept §4.4)`);
    }

    const recId = makeRecordingId();
    const dir = paths.jobDir(this.storageRoot, recId);
    const meta = normalizeMeta({
      id: recId,
      channelId,
      channelName,
      epgTitle,
      epgDescription,
      sourceUrl,
      status: 'recording',
    });
    if (!this.store.writeMeta(meta)) {
      throw new Error('Aufnahme-Metadaten konnten nicht gespeichert werden — Aufnahme abgebrochen');
    }
    this.store.upsertIndex(meta);

    const job = new RecordJob({
      recId,
      sourceUrl,
      dir,
      ffmpegPath: ffmpegLib.binaryPath('ffmpeg', this.appRoot),
      meta,
      expectedSegmentSec: this.segmentSec,
    });
    this.jobs.set(recId, job);
    this._forwardJobEvents(job, { afterRemux });
    job.start();
    log('info', `Aufnahme gestartet: ${recId} (${channelName || channelId}) → ${dir}`);
    this._emitStatus({ recId, phase: PROGRESS_PHASE_RECORDING });
    return { recId, meta: { ...meta } };
  }

  /**
   * Stoppt eine Aufnahme und remuxt im Anschluss. Löst mit den finalen
   * Metadaten auf (completed oder remux-pending bei Remux-Fehler).
   */
  async stop(recId) {
    const job = this.jobs.get(recId);
    if (!job) throw new Error(`Keine aktive Aufnahme: ${recId}`);
    this._emitStatus({ recId, phase: PROGRESS_PHASE_STOPPING });
    const { meta } = await job.stop({ reason: 'user' });
    this.jobs.delete(recId);
    const afterRemux = this._afterRemuxCallbacks.get(recId) || null;
    try {
      return await this._remuxAfterStop(meta, { afterRemux });
    } finally {
      this._afterRemuxCallbacks.delete(recId);
    }
  }

  // ── Abfragen ──

  getJob(recId) {
    return this.jobs.get(recId) || null;
  }

  findJobByChannel(channelId, channelName) {
    for (const job of this.jobs.values()) {
      if (channelId && job.meta.channelId === channelId) return job;
      if (!channelId && channelName && job.meta.channelName === channelName) return job;
    }
    return null;
  }

  activeJobs() {
    return [...this.jobs.values()];
  }

  /**
   * Speicherort zur Laufzeit wechseln (Settings, Phase 1c — Konzept §3.4):
   * nur möglich, solange keine Aufnahme läuft (Jobs/Remux binden Pfade).
   * Validiert den neuen Root (beschreibbar? Platz?) VOR dem Wechsel; bei
   * Fehlschlag bleibt der alte Root aktiv. Store wird neu aufgebaut.
   */
  setStorageRoot(newRoot) {
    if (this.jobs.size > 0 || this.remuxing.size > 0) {
      throw new Error('Speicherort kann nur ohne laufende Aufnahmen gewechselt werden');
    }
    const check = paths.validateStorageRoot(newRoot);
    if (!check.ok) throw new Error(`Speicherort nicht nutzbar: ${check.error}`);
    this.storageRoot = path.resolve(newRoot);
    this.store = createRecordingStore({ root: this.storageRoot, logger });
    return this.storageRoot;
  }

  /**
   * Status für IPC (recording:status): aktive Aufnahmen + Remux-Fortschritt.
   */
  status() {
    const active = [];
    for (const job of this.jobs.values()) {
      const run = job.getRunState();
      active.push({
        recId: run.recId,
        channelId: job.meta.channelId,
        channelName: job.meta.channelName,
        epgTitle: job.meta.epgTitle,
        startedAt: job.meta.startedAt,
        state: run.state,
        recordingSec: run.recordingSec,
        bytesWritten: run.bytesWritten,
        lastError: run.lastError,
      });
    }
    return { active, remuxing: [...this.remuxing] };
  }

  // ── Intern ──

  _forwardJobEvents(job, { afterRemux }) {
    job.on('meta', ({ meta }) => {
      this.store.writeMeta(meta);
      this.store.upsertIndex(meta);
    });
    job.on('progress', payload => {
      this.emit('recording:progress', { ...payload, channelId: job.meta.channelId, channelName: job.meta.channelName });
    });
    job.on('reconnecting', payload => {
      this.emit('recording:reconnecting', { ...payload });
    });
    job.on('failed', ({ meta }) => {
      this.jobs.delete(meta.id);
      this.store.writeMeta(meta);
      this.store.upsertIndex(meta);
      this.emit('recording:changed', { recId: meta.id, meta: { ...meta } });
    });
    this._afterRemuxCallbacks.set(job.recId, afterRemux);
  }

  /**
   * Remux nach Stop (Konzept §2.3): Dateiname + Kollisions-Suffix, Remux mit
   * Fortschritt, danach Zwischenform löschen. Robustheit: bei Fehlschlag
   * bleibt der Status remux-pending → nachholender Remux beim nächsten Start.
   */
  async _remuxAfterStop(meta, { afterRemux = null, fromRecovery = false } = {}) {
    const jobDir = path.join(this.store.library, meta.id);
    const playlist = path.join(jobDir, 'index.m3u8');
    if (!fs.existsSync(playlist)) {
      log('error', `Remux übersprungen (${meta.id}): Zwischenplaylist fehlt`);
      const failedMeta = this._transitionMeta(meta, 'failed', 'Zwischenplaylist fehlt');
      return failedMeta;
    }
    const expectedDurationSec = playlistDurationSec(playlist);
    const filename = this._uniqueLibraryFilename(meta);
    const outputPath = path.join(this.store.library, filename);
    if (meta.status === 'recording') {
      meta = this._transitionMeta(meta, 'remux-pending');
    } else if (meta.status === 'aborted') {
      // Recovery nach Hard-Kill (F-FB-08): Der Zwischenstand wird remuxt —
      // das MP4 soll den bis zum Abbruch aufgenommenen Inhalt liefern. Das
      // Flag bleibt bis zum completed-Write erhalten (Diagnostik: „diese
      // Aufnahme wurde nachgeholt, nicht live fertiggestellt").
      meta = { ...meta, remuxInterrupted: true };
    }

    this.remuxing.add(meta.id);
    this._emitStatus({ recId: meta.id, phase: PROGRESS_PHASE_REMUXING, percent: 0 });
    try {
      const result = await runRemux({
        ffmpegPath: ffmpegLib.binaryPath('ffmpeg', this.appRoot),
        ffprobePath: ffmpegLib.binaryPath('ffprobe', this.appRoot),
        dir: jobDir,
        playlistPath: playlist,
        outputPath,
        expectedDurationSec,
        onProgress: ({ percent, remainingSec }) => {
          this._emitStatus({
            recId: meta.id,
            phase: PROGRESS_PHASE_REMUXING,
            percent,
            remainingSec,
          });
        },
      });
      // Decode-Verifikation (Fix-Set 4, t_18d3dbb2): `-v error -f null` zählt
      // Dekode-Fehler im Elementarstrom — Container-Probe (probeMp4) sieht
      // korrupte h264-Packets nicht. Die Datei bleibt completed (kein
      // Status-Fallback ohne Beweis), aber der Befund ist sichtbar in
      // Meta/Index und Log — Diagnose-Basis fürs Player-Fehlersymptom.
      let decodeErrors = 0;
      let decodeErrorSample = null;
      try {
        const check = await decodeCheckMp4(ffmpegLib.binaryPath('ffmpeg', this.appRoot), outputPath);
        decodeErrors = check.decodeErrors;
        decodeErrorSample = check.decodeErrorSample || null;
      } catch (checkErr) {
        log('warn', `Decode-Verifikation fehlgeschlagen (${meta.id}): ${checkErr.message}`);
      }
      if (decodeErrors > 0) {
        log('warn', `Aufnahme ${meta.id}: ${decodeErrors} Dekode-Fehler in der MP4 (Sample: ${decodeErrorSample})`);
      }
      const completedMeta = this._transitionMeta(
        {
          ...meta,
          durationSec: result.durationSec,
          fileSizeBytes: result.fileSizeBytes,
          decodeErrors,
          decodeErrorSample,
        },
        'completed',
      );
      // Diagnostik nach dem Nachhol-Remux zurücksetzen: completed + Flag
      // false = „kein offener Remux mehr“ (F-FB-08-Akzeptanz).
      completedMeta.remuxInterrupted = false;
      completedMeta.outputFile = outputPath;
      this.store.writeMeta(completedMeta);
      this.store.upsertIndex(completedMeta);
      this._cleanupIntermediate(jobDir);
      log('info', `Remux abgeschlossen: ${outputPath} (${result.durationSec}s, ${result.streamTypes.join('+')})`);
      if (fromRecovery) log('info', `Remux nachgeholt (Recovery): ${meta.id}`);
      if (typeof afterRemux === 'function') await afterRemux({ meta: completedMeta });
      return completedMeta;
    } catch (e) {
      log('error', `Remux fehlgeschlagen für ${meta.id}: ${e.message}`);
      // Status bewusst NICHT auf failed: remux-pending bleibt bestehen, damit
      // der Recovery-Pfad beim nächsten App-Start es erneut versucht
      // (Zwischenstände bleiben erhalten). Änderung nur der Meta-Datei:
      const retryMeta = { ...meta, lastError: e.message };
      this.store.writeMeta(retryMeta);
      this.store.upsertIndex(retryMeta);
      throw e;
    } finally {
      this.remuxing.delete(meta.id);
      this._emitStatus({ recId: meta.id, phase: PROGRESS_PHASE_DONE });
    }
  }

  _transitionMeta(meta, toStatus, lastError = null) {
    assertTransition(meta.status, toStatus);
    const updated = { ...meta, status: toStatus };
    if (lastError) updated.lastError = lastError;
    this.store.writeMeta(updated);
    this.store.upsertIndex(updated);
    this.emit('recording:changed', { recId: updated.id, meta: { ...updated } });
    return updated;
  }

  _emitStatus({ recId, phase, percent = null, remainingSec = null }) {
    this.emit('recording:status', { recId, phase, percent, remainingSec });
  }

  /**
   * Dateiname nach Konzept §5 mit Kollisions-Suffix -2/-3: freien Namen
   * im Bibliotheksverzeichnis finden.
   */
  _uniqueLibraryFilename(meta) {
    const base = buildRecordingFilename(meta);
    if (!fs.existsSync(path.join(this.store.library, base))) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = withCollisionSuffix(base, n);
      if (!fs.existsSync(path.join(this.store.library, candidate))) return candidate;
    }
    throw new Error('Kein freier Dateiname nach 998 Kollisionen');
  }

  /**
   * Löscht die HLS-Zwischenform (Konzept §2.3: ".ts-Fragmente +
   * Zwischenplaylist löschen") — die Meta-Datei im Job-Verzeichnis bleibt
   * für spätere Recovery/Inspection erhalten.
   */
  _cleanupIntermediate(jobDir) {
    try {
      for (const name of fs.readdirSync(jobDir)) {
        if (!/\.ts$|\.tmp$|^index\.m3u8$/.test(name)) continue;
        try {
          fs.rmSync(path.join(jobDir, name), { force: true });
        } catch (_) {
          // Einzelne Datei blockiert (AV-Scanner) — Rest weiter räumen
        }
      }
    } catch (e) {
      log('warn', `Zwischenverzeichnis konnte nicht geräumt werden (${jobDir}): ${e.message}`);
    }
  }
}

module.exports = { RecorderService, DEFAULT_MAX_PARALLEL };
