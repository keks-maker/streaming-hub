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
const {
  RecordJob,
  playlistDurationSec,
  directoryBytes,
  defaultFreeBytes,
  defaultStorageProbe,
} = require('./RecordJob.js');
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

const settingsLib = require('./recording-settings.js');

const DEFAULT_MAX_PARALLEL = settingsLib.DEFAULT_MAX_PARALLEL; // Konzept §4.4
const REMUX_DEFERRED_LOW_SPACE = 'Nicht konvertiert — Speicher knapp';
const REMUX_DEFERRED_STORAGE_LOST = 'Nicht konvertiert — Speicherort nicht erreichbar';

/**
 * Soft-Limit-Überschreitung (Konzept §1.3 L2): unterscheidbarer Fehler mit
 * Code 'PARALLEL_LIMIT'. Mit `force: true` im start() wird das Limit bewusst
 * überschritten (UI: „Trotzdem aufnehmen“).
 */
class RecorderLimitError extends Error {
  constructor(limit, active) {
    super(`Maximale Anzahl paralleler Aufnahmen erreicht (${limit}, Konzept §4.4)`);
    this.name = 'RecorderLimitError';
    this.code = 'PARALLEL_LIMIT';
    this.limit = limit;
    this.active = active;
  }
}

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
  // startOffsetSec (Karte t_f36663be, Item 2 Option C/D): DVR-Rückstand in
  // Sekunden, von dem aus die Aufnahme starten soll (VOR der Live-Kante).
  // 0/undefined = Live-Head (Bestandsverhalten). Negative/nicht-endliche
  // Werte werden zu 0 normalisiert (konservativ: kein Live-Voraus-Lesen).
  const rawOffset = Number(input.startOffsetSec);
  const startOffsetSec = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  // stopAt (Etappe 1, L1): Stopp-Zeitpunkt in ms seit Epoch. Der Main-Prozess
  // beendet die Aufnahme dann selbst (kein Renderer-Timer). Nicht-numerisch
  // oder unplausibel → Fehler; ein Zeitpunkt in der Vergangenheit wird
  // ignoriert (Sendung schon zu Ende — wie bisher: Nutzer stoppt selbst,
  // die Höchstdauer ist das Sicherheitsnetz).
  let stopAt = null;
  if (input.stopAt !== undefined && input.stopAt !== null) {
    const rawStopAt = Number(input.stopAt);
    if (!Number.isFinite(rawStopAt) || rawStopAt < 0 || rawStopAt > 4102444800000) {
      throw new Error('Ungültiger stopAt-Zeitpunkt');
    }
    stopAt = Math.floor(rawStopAt);
  }
  return { sourceUrl, channelId, channelName, epgTitle, epgDescription, startOffsetSec, stopAt };
}

class RecorderService extends EventEmitter {
  /**
   * options:
   * - appRoot: App-Stamm (ffmpeg-Binaries in <appRoot>/bin, lib/ffmpeg.js)
   * - storageRoot: Speicherort (Default ~/Videos/Streaming Hub, Konzept §3.4)
   * - maxParallel: Parallelitäts-Limit (Default 3, Konzept §4.4; Soft-Limit)
   * - maxDurationHours: harte Höchstdauer pro Aufnahme (Default 6 h, geklemmt)
   * - reserveMB: Reserve freier Speicher (Default 1024, Minimum 512, geklemmt)
   * - segmentSec: HLS-Target-Segmentdauer der Zwischenform
   * - freeBytes(dir) / storageProbe(dir) / now / sizeTickMs / jobTiming / minReserveBytes:
   *   Test-Seams (statfs simulieren, Uhr, Tick, Minimum für Mini-Volumes).
   *   Produktion nutzt die Defaults — das Reserve-Minimum ist 512 MB.
   */
  constructor({
    appRoot, storageRoot, maxParallel = DEFAULT_MAX_PARALLEL, segmentSec = 2,
    maxDurationHours, reserveMB, freeBytes = defaultFreeBytes, storageProbe = defaultStorageProbe,
    now = () => new Date(), sizeTickMs = undefined, jobTiming = null, minReserveBytes = settingsLib.MIN_RESERVE_MB * settingsLib.MB,
  } = {}) {
    super();
    if (!appRoot) throw new Error('RecorderService benötigt appRoot');
    if (!storageRoot) throw new Error('RecorderService benötigt storageRoot');
    this.appRoot = appRoot;
    this.storageRoot = path.resolve(storageRoot);
    this._freeBytes = freeBytes;
    this._storageProbe = storageProbe;
    this._now = now;
    this._sizeTickMs = sizeTickMs;
    this._jobTiming = jobTiming;
    this._minReserveBytes = minReserveBytes;
    this.maxParallel = settingsLib.clampMaxParallel(maxParallel).value;
    this.maxDurationHours = settingsLib.clampMaxDurationHours(maxDurationHours).value;
    this.reserveBytes = this._clampReserveBytes(reserveMB === undefined ? settingsLib.DEFAULT_RESERVE_MB : reserveMB);
    this.segmentSec = segmentSec;
    this.store = createRecordingStore({ root: this.storageRoot, logger });
    this.jobs = new Map(); // recId → RecordJob
    this.remuxing = new Set(); // recIds in Nachbearbeitung
    this._afterRemuxCallbacks = new Map(); // recId → afterRemux (App-Kontext)
    // Quit-Cleanup-Registry (Karte t_695bf150): remux/probe/decode-Childs
    // (pid → ChildProcess-Handle), damit der before-quit-Sweep auch
    // Nachbearbeitungs-Prozesse deterministisch trifft (kein Orphan).
    this._bgChildren = new Map();
    // Quit-Race-Hardening (Review R1): _quitRequested = quitSweep() ist
    // gelaufen — stop()-Fortsetzungen starten ihren Remux dann nicht mehr
    // (Quit-Guard in stop()), sonst spawnt die Continuation einen Remux,
    // den der beendete Sweep nie registriert gesehen hat (Orphan-Fenster).
    this._quitRequested = false;
    // stop()-Aufrufe zwischen Job-Abruf und Registry-Sichtbarkeit (recId→Job):
    // quitSweep braucht die Job-Referenz, um einen bereits awaitenden stop()
    // über finalizeForQuit zu bedienen, obwohl der Job evtl. schon aus jobs
    // gerutscht ist (Registry-Fenster).
    this._stopsInProgress = new Map();
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
    const deferred = [];
    for (const meta of this.store.findResumable()) {
      try {
        const finalMeta = await this._remuxAfterStop(meta, { afterRemux, fromRecovery: true });
        if (finalMeta.status === 'completed') recovered.push(finalMeta);
        else if (finalMeta.remuxDeferredReason) deferred.push(finalMeta);
      } catch (e) {
        // Remux-Fehler: Meta bleibt remux-pending → nächster Start versucht es
        // erneut (Zwischenstände bleiben bewusst erhalten).
        log('error', `Recovery-Remux fehlgeschlagen für ${meta.id}: ${e.message}`);
      }
    }
    return { reaped, recovered, deferred };
  }

  // ── Start/Stop ──

  /**
   * Startet eine Aufnahme. Wirft bei fehlgeschlagenen Start-Checks
   * (ffmpeg, Speicherort, Duplikat pro Kanal, Parallelitäts-Limit).
   * afterRemux: async ({meta}) — App-Kontext-Broadcast nach Remux-Abschluss.
   */
  async start(request, { afterRemux = null, force = false } = {}) {
    const { sourceUrl, channelId, channelName, epgTitle, epgDescription, startOffsetSec, stopAt } =
      validateRecordingRequest(request);

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
    // Soft-Limit (L2): ohne force ein unterscheidbarer Fehler (code
    // 'PARALLEL_LIMIT'), mit force wird bewusst überschritten.
    if (this.jobs.size >= this.maxParallel && force !== true) {
      throw new RecorderLimitError(this.maxParallel, this.jobs.size);
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
      ffmpegPath: ffmpegLib.resolveBinaryPath('ffmpeg', this.appRoot),
      meta,
      expectedSegmentSec: this.segmentSec,
      startOffsetSec,
      now: this._now,
      stopAt: stopAt !== null && stopAt > this._now().getTime() ? stopAt : null,
      maxDurationSec: this.maxDurationHours * 3600,
      reserveBytes: this.reserveBytes,
      freeBytes: this._freeBytes,
      storageProbe: this._storageProbe,
      sizeTickMs: this._sizeTickMs,
      timing: this._jobTiming,
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
    // Quit-Sweep-Vertrag (Karte t_695bf150): Ein in-flight stop() wird VOM
    // bedient — quitSweep ruft finalizeForQuit() auf demselben Job auf,
    // _finalize() resolvet dieses awaiting stop() mit denselben finalen
    // Metadaten (reason 'abort'). Der Sweep darf den Job hierfür noch sehen
    // (Registry-Sichtbarkeit über _stopsInProgress recId→Job).
    this._stopsInProgress.set(recId, job);
    let meta;
    try {
      ({ meta } = await job.stop({ reason: 'user' }));
    } catch (e) {
      // Job ist bereits beendet (z. B. Fatal-Fehler parallel): nicht als
      // aktive Aufnahme hängen lassen.
      if (job.getRunState().state === 'stopped') {
        this.jobs.delete(recId);
        this._afterRemuxCallbacks.delete(recId);
      }
      throw e;
    } finally {
      this._stopsInProgress.delete(recId);
    }
    this.jobs.delete(recId);
    // Quit-Race-Guard (Review R1, Kern-Rest-Hole): Der Sweep kann GENAU in
    // der Mikrotask zwischen job.stop()-Resolve und diesem Remux-Start
    // abgeschlossen haben — ein hier ungehinderter Remux-Start wäre für den
    // Sweep unsichtbar (Spawn noch nicht in _bgChildren) und würde hinter
    // dem beendeten Nodeprozess weiterlaufen (Orphan, QA-Befund: 22 GB).
    // Der Quit versagt dem Remux die Fortsetzung: die Meta bleibt als
    // aborted (finalizeForQuit) mit gesicherter ENDLIST persistiert und wird
    // beim nächsten Start über recover() nachremuxt (remuxInterrupted-Pfad).
    if (this._quitRequested) {
      log('info', `Quit-Race: Remux für ${meta.id} dem Quit geopfert — Recovery-Remux beim nächsten Start`);
      this._afterRemuxCallbacks.delete(recId);
      return meta;
    }
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

  // ── Quit-Cleanup (Karte t_695bf150) ──

  /**
   * Beendet ALLE Aufnahme-Prozess-Ressourcen für den App-Quit — synchron im
   * Sinne des E2E-Beweises (5 s nach App-Ende: pgrep ffmpeg = 0):
   *
   * 1) RecordJobs: finalizeForQuit() pro Job (SIGKILL auf das ffmpeg-Child,
   *    Meta → aborted, ENDLIST in der Zwischenplaylist gesichert →
   *    Recovery-Remux beim nächsten Start möglich, F-FB-10). Erfasst auch
   *    Jobs, deren stop() gerade in-flight ist (Quelltext-Invariante
   *    RecorderService.stop → _stopsInProgress): deren Promise wird vom
   *    finalizeForQuit/_finalize-Resolver bedient.
   * 2) Background-Childs (Remux/ffprobe/decodeCheck): deren Registry-Einträge
   *    werden SIGKILL'ed — der Remux läuft beim nächsten Start nach
   *    (remux-pending/aborted bleibt persistent, recover() holt nach).
   * 3) Registry geleert (Childs sind danach tot), Stillstand garantiert.
   * 4) Quit-Guard (_quitRequested): stop()-Fortsetzungen starten KEINEN
   *    Remux mehr — das Spawn-Race-Fenster (Registry-Eintrag geschieht erst
   *    NACH dem spawn()-Return) kann vom Sweep nicht geschlossen werden,
   *    also verweigert die Continuation selbst den Start (Quit-Race-Guard
   *    in stop()) und die Recovery holt den Remux beim nächsten Start nach.
   *
   * Bewusst KEINE Promise.allSettled-Abfrage: Quit <= falsche Asynchronie.
   * Der Rückgabewert dokumentiert nur den Sweep (Diagnostik).
   */
  quitSweep() {
    this._quitRequested = true;
    const killed = [];
    // Window-First (Review R1): Alle synchronen Kill-/Finalize-Aktionen
    // laufen in EINEM Tick — es gibt keinen await zwischen Job-Scan und
    // Registry-Kill, also existiert kein Spawn-Fenster INNERHALB des Sweeps.
    for (const job of this.jobs.values()) {
      const { pid, alreadyFinalized } = job.finalizeForQuit();
      if (!alreadyFinalized) killed.push({ recId: job.recId, pid, kind: 'record' });
    }
    // In-flight stops (Registry-Fenster, Review R1): _stopsInProgress ist
    // eine Map recId→Job — die Job-Referenz kommt von dort, NICHT aus jobs:
    // im Fenster hat stop() den Job evtl. schon aus jobs gerutscht (await
    // läuft, Continuation noch nicht). Doppel-Finalisierung ist unschädlich
    // (finalizeForQuit ist idempotent via _finalized-Flag); geskippt werden
    // nur Jobs, die der Jobs-Loop oben schon gesehen hat.
    for (const [recId, job] of this._stopsInProgress) {
      if (this.jobs.has(recId)) continue;
      if (!job || typeof job.finalizeForQuit !== 'function') continue;
      const { pid, alreadyFinalized } = job.finalizeForQuit();
      if (!alreadyFinalized) killed.push({ recId, pid, kind: 'record' });
    }
    this.jobs.clear();
    for (const [pid, child] of this._bgChildren) {
      try {
        child.kill('SIGKILL');
        killed.push({ recId: null, pid, kind: 'background' });
      } catch (_) {
        // Bereits beendet — nichts zu tun
      }
    }
    this._bgChildren.clear();
    if (killed.length) {
      log('info', `Quit-Sweep: ${killed.length} Aufnahme-Prozess(e) beendet (${killed.map(k => k.kind).join('+')})`);
    }
    return killed;
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
   * Setzt Limits zur Laufzeit (Settings). Alles wird im Main geklemmt — auch
   * die Reserve (Minimum 512 MB). Laufende Jobs behalten ihre Startwerte;
   * Parallel-Limit wirkt sofort auf neue Starts. Rückgabe: normalisierte Werte.
   */
  setLimits({ maxParallel, maxDurationHours, reserveMB } = {}) {
    if (maxParallel !== undefined) this.maxParallel = settingsLib.clampMaxParallel(maxParallel).value;
    if (maxDurationHours !== undefined) {
      this.maxDurationHours = settingsLib.clampMaxDurationHours(maxDurationHours).value;
    }
    if (reserveMB !== undefined) this.reserveBytes = this._clampReserveBytes(reserveMB);
    return this.getLimits();
  }

  getLimits() {
    return {
      maxParallel: this.maxParallel,
      maxDurationHours: this.maxDurationHours,
      reserveMB: Math.round(this.reserveBytes / settingsLib.MB),
    };
  }

  /**
   * Reserve in Bytes: nicht-numerisch → Default (1 GB), nach oben begrenzt,
   * nach unten auf das Minimum (Produktion: 512 MB) geklemmt. Das Minimum ist
   * nur über die Test-Seam `minReserveBytes` des Konstruktors absenkbar.
   */
  _clampReserveBytes(reserveMB) {
    const n = typeof reserveMB === 'string' && reserveMB.trim() !== '' ? Number(reserveMB) : reserveMB;
    if (typeof n !== 'number' || !Number.isFinite(n)) return settingsLib.DEFAULT_RESERVE_MB * settingsLib.MB;
    const bytes = Math.min(settingsLib.MAX_RESERVE_MB * settingsLib.MB, Math.floor(n) * settingsLib.MB);
    return Math.max(this._minReserveBytes, bytes);
  }

  /**
   * Holt zurückgestellte Remuxes nach (Status „nicht konvertiert — Speicher
   * knapp“), sobald wieder Platz da ist. Aufruf z. B. nach dem Löschen einer
   * Aufnahme; Fälle ohne ausreichenden Platz bleiben unverändert zurückgestellt.
   */
  async retryDeferredRemuxes({ afterRemux = null } = {}) {
    const done = [];
    for (const meta of this.store.findResumable()) {
      if (!meta.remuxDeferredReason || this.remuxing.has(meta.id) || this.jobs.has(meta.id)) continue;
      try {
        const result = await this._remuxAfterStop(meta, { afterRemux, fromRecovery: true });
        if (result.status === 'completed') done.push(result);
      } catch (e) {
        log('error', `Nachholender Remux fehlgeschlagen für ${meta.id}: ${e.message}`);
      }
    }
    return done;
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
        stopAt: run.stopAt,
        stopReason: run.stopReason,
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
    job.on('seek-degraded', payload => {
      // Karte t_f36663be (Meldung 4): DVR-Rückstand > Fenster — Aufnahme
      // läuft am frühersten DVR-Segment weiter. App broadcastet den Quer-
      // text (Toast + Bibliothek) via main.js afterStart-Brücke.
      this.emit('recording:seek-degraded', { ...payload });
    });
    job.on('auto-stop', ({ recId, reason, message }) => {
      // Auto-Stopp im Main (stopAt/Höchstdauer/Speicher): Benachrichtigung
      // (Tray + App) und regulärer stop()-Pfad inkl. Remux bzw. Zurückstellen.
      this.emit('recording:auto-stopped', {
        recId,
        reason,
        message,
        channelId: job.meta.channelId,
        channelName: job.meta.channelName,
        epgTitle: job.meta.epgTitle,
      });
      this.stop(recId).catch(e => log('error', `Auto-Stopp-Nachlauf fehlgeschlagen (${recId}): ${e.message}`));
    });
    job.on('failed', ({ meta }) => {
      this.jobs.delete(meta.id);
      this._afterRemuxCallbacks.delete(meta.id);
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
      // NAS weg / Volume nicht gemountet: nicht als „failed“ abschreiben —
      // die Zwischenform liegt vermutlich noch dort und wird nachgeholt.
      if (!fs.existsSync(this.storageRoot)) {
        return this._deferRemux(meta, REMUX_DEFERRED_STORAGE_LOST);
      }
      log('error', `Remux übersprungen (${meta.id}): Zwischenplaylist fehlt`);
      const failedMeta = this._transitionMeta(meta, 'failed', 'Zwischenplaylist fehlt');
      return failedMeta;
    }
    // Konzept §3.9: Das MP4 braucht beim Erzeugen etwa so viel Platz wie die
    // Zwischenform, bevor die .ts-Fragmente gelöscht werden. Bei knappem
    // Platz kein Remux — die Aufnahme bleibt in der abspielbaren HLS-Form
    // (remux-pending) und wird nachgeholt (recover/retryDeferredRemuxes).
    const free = this._safeFreeBytes(this.storageRoot);
    if (free !== null && free < directoryBytes(jobDir) + this._minReserveBytes) {
      return this._deferRemux(meta, REMUX_DEFERRED_LOW_SPACE);
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
    // Quit-Cleanup-Registry (Karte t_695bf150): jede Spawnung im Nachlauf
    // (Remux/ffprobe/decodeCheck) meldet ihr Child — der before-quit-Sweep
    // (quitSweep) killt sie deterministisch statt Orphans zu hinterlassen.
    const onChild = child => {
      try {
        if (child && typeof child.pid === 'number' && child.pid > 0) this._bgChildren.set(child.pid, child);
      } catch (_) {}
      if (child) {
        child.on('close', () => {
          try {
            if (typeof child.pid === 'number') this._bgChildren.delete(child.pid);
          } catch (_) {}
        });
      }
    };
    try {
      const result = await runRemux({
        ffmpegPath: ffmpegLib.resolveBinaryPath('ffmpeg', this.appRoot),
        ffprobePath: ffmpegLib.resolveBinaryPath('ffprobe', this.appRoot),
        dir: jobDir,
        playlistPath: playlist,
        outputPath,
        expectedDurationSec,
        onChild,
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
        const check = await decodeCheckMp4(ffmpegLib.resolveBinaryPath('ffmpeg', this.appRoot), outputPath, 120000, onChild);
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
          remuxDeferredReason: null,
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

  _safeFreeBytes(dir) {
    try {
      const free = this._freeBytes(dir);
      return Number.isFinite(free) ? free : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Remux zurückstellen: Status bleibt remux-pending (bzw. aborted bei
   * Recovery-Resten), die Zwischenform bleibt abspielbar. Kein Fehler — der
   * nächste Recovery-/Retry-Lauf holt den Remux nach.
   */
  _deferRemux(meta, reason) {
    let current = meta;
    if (current.status === 'recording') current = this._transitionMeta(current, 'remux-pending');
    const deferred = { ...current, remuxDeferredReason: reason };
    this.store.writeMeta(deferred);
    this.store.upsertIndex(deferred);
    log('warn', `Remux zurückgestellt (${meta.id}): ${reason}`);
    this.emit('recording:changed', { recId: deferred.id, meta: { ...deferred } });
    return deferred;
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
   * Räumt das Job-Verzeichnis KOMPLETT weg (Karte t_f36663be, Item 1):
   * Nach dem Remux lebt nur die MP4 im Aufnahmen-Root — die Meta-Datei
   * ist bereits parallel zur MP4 migriert (RecordingStore.writeMeta,
   * completed → Bibliotheks-Layer). Fehlgeschlagene Teil-Löschungen
   * (AV-Scanner-Block) loggen, ohne den Remux-Erfolg zu torpedieren —
   * der Rest-Ordner ist dann beim nächsten Delete-Flow konsolidiert.
   */
  _cleanupIntermediate(jobDir) {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
      log('info', `Job-Verzeichnis entfernt: ${jobDir}`);
    } catch (e) {
      // Fallback: Datei-Weise räumen (AV-Scanner kann Einzeldateien blocken)
      log('warn', `Job-Ordner-Komplett-Räumung fehlgeschlagen (${jobDir}): ${e.message} — Datei-weise Fallback`);
      try {
        for (const name of fs.readdirSync(jobDir)) {
          try {
            fs.rmSync(path.join(jobDir, name), { force: true, recursive: true });
          } catch (_) {
            // Einzelne Datei blockiert — Rest weiter versuchen
          }
        }
        fs.rmdirSync(jobDir); // nur wenn leer
      } catch (e2) {
        log('warn', `Auch Datei-weise Räumung fehlerhaft (${jobDir}): ${e2.message}`);
      }
    }
  }
}

module.exports = { RecorderService, RecorderLimitError, DEFAULT_MAX_PARALLEL };
