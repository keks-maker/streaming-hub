// v0.5.8 – Ein Aufnahme-Job = ffmpeg-Subprozess + State-Machine
// (Aufnahme Phase 1b, Karte t_17ee2ca5; Konzept §2.1/§2.3)
//
// Technik (empirisch verifiziert, Probe 2026-09-30):
// - HLS-Zwischenform: wachsende index.m3u8 + seg_%05d.ts im Job-Verzeichnis
//   (hls_list_size 0 = VOD-lesbar für hls.js, „Watch while Recording").
//   Flags: temp_file (atomare Playlist-Updates) + omit_endlist (Playlist
//   bleibt resumabel) + append_list (Reconnect nummeriert Segmente
//   fortlaufend weiter, alte bleiben erhalten) + independent_segments.
// - Stream-Abbruch: ffmpeg-Attempt endet → begrenzter Reconnect-Loop
//   (Exponential-Backoff 2s→30s, Gesamtbudget 5 min). Beim Neustart liest
//   ffmpeg das LIVE-Playlist-Fenster der Quelle von vorn — Sekunden vor der
//   Abrisskante können daher doppelt landen (bekannte, dokumentierte Naht).
// - Stop: SIGINT → ffmpeg schließt sauber; danach #EXT-X-ENDLIST absichern
//   (ohne ENDLIST hängt der spätere Remux — Probe-Befund), Dauer aus den
//   #EXTINF-Zeilen der Playlist, Größe aus den Fragmenten.
//
// Zustände: idle → starting → recording ⇄ waiting-retry → stopping → stopped
// Metadaten-Status (Konzept §5): recording → remux-pending | failed | aborted
// Der Job besitzt seine Metadaten vollständig; Persistenz passiert im
// RecorderService über die 'meta'-Events (SRP: Job = Prozess, Service = Store).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../../logger.js');
const { assertTransition } = require('./meta.js');

const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 30000;
const RETRY_MAX_WAIT_MS = 5 * 60 * 1000; // Gesamtbudget aller Retry-Wartezeiten
const RETRY_KILL_GRACE_MS = 5000; // SIGINT→SIGKILL bei Fatal/Stop
const STOP_GRACE_MS = 10000; // SIGINT→SIGKILL beim User-Stop
const SIZE_TICK_MS = 5000; // Progress-Frequenz (Größe + Laufzeit)
const FIRST_ATTEMPT_MIN_RUN_MS = 5000; // kürzer = Start nie geglückt → kein Retry

const STATE_IDLE = 'idle';
const STATE_STARTING = 'starting';
const STATE_RECORDING = 'recording';
const STATE_WAITING_RETRY = 'waiting-retry';
const STATE_STOPPING = 'stopping';
const STATE_STOPPED = 'stopped';

function log(level, message) {
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[fn](`[record] ${message}`);
}

/**
 * Summiert die #EXTINF-Dauern der Zwischenplaylist → Aufnahme-Dauer in Sekunden.
 * Dedup (F-FB-09, t_9372a4b3): Playlists aus Retry-Loops (Bestand vor dem
 * Fix) können denselben Segment-Dateinamen mehrfach listen (überschriebene
 * Runden, veraltete EXTINF-Zeilen) — jeder Dateiname zählt genau einmal,
 * sonst bläht die Dauer-Meta künstlich auf (QA: 66460s bei ~282s Wandzeit).
 */
function playlistDurationSec(playlistPath) {
  const raw = fs.readFileSync(playlistPath, 'utf-8');
  let total = 0;
  const seenSegments = new Set();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const extinf = /^#EXTINF:([\d.]+)/.exec(lines[i]);
    if (!extinf) continue;
    // Zum Eintrag gehörender Segment-Dateiname = nächste Nicht-Kommentarzeile
    let segment = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j].trim();
      if (!line || line.startsWith('#')) continue;
      segment = line;
      break;
    }
    if (segment !== null && seenSegments.has(segment)) continue; // Duplikat
    if (segment !== null) seenSegments.add(segment);
    total += parseFloat(extinf[1]);
  }
  return Math.round(total * 1000) / 1000;
}

/**
 * Summe der Fragment-Größen im Job-Verzeichnis (ohne .tmp).
 */
function directoryBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith('.ts')) continue;
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch (_) {
      // Fragment zwischendurch verschwunden (temp_file-Renaming) — ignorieren
    }
  }
  return total;
}

class RecordJob extends EventEmitter {
  /**
   * options:
   * - recId, sourceUrl (http(s)), dir (Job-Verzeichnis), ffmpegPath
   * - meta: initialisierte Metadaten (normalizeMeta-Form, status 'recording')
   * - expectedSegmentSec: HLS-Target-Dauer (Default 2)
   * - startOffsetSec (Karte t_f36663be, Item 2): DVR-Rückstand in Sekunden —
   *   ffmpeg startet mit `-ss <offset>` VOR `-i` am DVR-History-Fenster der
   *   Live-Playlist. 0 = Live-Head (Bestandsverhalten). Übersteigt der
   *   Offset die verfügbare DVR-Tiefe, liefert der HLS-Demuxer
   *   „could not seek to position" und startet am frühesten verfügbaren
   *   Segment (graceful Degrade, empirisch verifiziert 2026-10-02 an
   *   ARD/ZDF-HLS); der Job meldet den realen Start nach dem ersten
   *   Segment via 'started'-Event + lastError-Diagnostik.
   * - now: injizierbare Zeitfunktion (Tests)
   */
  constructor({ recId, sourceUrl, dir, ffmpegPath, meta, expectedSegmentSec = 2, startOffsetSec = 0, now = () => new Date() }) {
    super();
    if (!recId) throw new Error('RecordJob benötigt recId');
    if (typeof sourceUrl !== 'string' || !/^https?:\/\//i.test(sourceUrl)) {
      throw new Error('RecordJob benötigt eine http(s)-sourceUrl');
    }
    if (!dir || !ffmpegPath || !meta) throw new Error('RecordJob benötigt dir, ffmpegPath und meta');
    if (meta.status !== 'recording') throw new Error('RecordJob startet nur mit meta.status "recording"');

    this.recId = recId;
    this.sourceUrl = sourceUrl;
    this.dir = dir;
    this.ffmpegPath = ffmpegPath;
    this.meta = meta;
    this.expectedSegmentSec = expectedSegmentSec;
    this.startOffsetSec = Number.isFinite(startOffsetSec) && startOffsetSec > 0 ? Math.floor(startOffsetSec) : 0;
    this._now = now;

    this._state = STATE_IDLE;
    this._child = null;
    this._attempt = 0;
    this._attemptStartedAt = 0;
    this._accumulatedRecordingMs = 0;
    this._retryCount = 0;
    this._retryWaitTotalMs = 0;
    this._retryTimer = null;
    this._sizeTimer = null;
    this._killTimer = null;
    this._stopSafetyTimer = null;
    this._stderrTail = '';
    this._lastError = null;
    this._fatalReason = null;
    this._abortRequested = false;
    this._finalized = false;
    this._stopPromise = null;
    this._seekDegraded = false;
  }

  // ── Öffentliche API ──

  start() {
    if (this._state !== STATE_IDLE) throw new Error(`RecordJob.start im Zustand ${this._state}`);
    this._state = STATE_STARTING;
    this._spawnAttempt();
    return this;
  }

  /**
   * Stoppt die Aufnahme. reason 'user' = regulärer Stopp (→ remux-pending),
   * 'abort' = Abbruch (→ aborted). Löst mit { meta, reason, endlistAppended } auf.
   */
  stop({ reason = 'user' } = {}) {
    if (this._stopPromise) return this._stopPromise;
    if (this._state === STATE_IDLE || this._state === STATE_STOPPED) {
      return Promise.reject(new Error(`RecordJob.stop im Zustand ${this._state}`));
    }
    if (reason === 'abort') this._abortRequested = true;
    this.meta.stoppedAt = this._now().toISOString();
    this._state = STATE_STOPPING;
    this._clearRetryTimer();
    this._stopPromise = new Promise(resolve => {
      this._stopResolve = resolve;
      if (this._child) {
        const child = this._child;
        this._killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        }, STOP_GRACE_MS);
        // Fallback, falls 'close' nie feuert (should not happen, aber billig)
        this._stopSafetyTimer = setTimeout(() => this._finalize(), STOP_GRACE_MS + 2000);
        try {
          child.kill('SIGINT'); // ffmpeg schreibt sauber, fclose der Playlist
        } catch (_) {
          // Bereits weg → 'close' hat die Finalisierung über
        }
      } else {
        this._finalize();
      }
    });
    return this._stopPromise;
  }

  getRunState() {
    return {
      recId: this.recId,
      state: this._state,
      attempt: this._attempt,
      recordingSec: Math.round(this.getRecordingSec() * 1000) / 1000,
      bytesWritten: this._computeBytesWritten(),
      retryWaitTotalMs: this._retryWaitTotalMs,
      lastError: this._lastError,
      disconnectedAt: this._state === STATE_WAITING_RETRY ? this._now().toISOString() : null,
    };
  }

  getRecordingSec() {
    let ms = this._accumulatedRecordingMs;
    if (this._state === STATE_RECORDING && this._attemptStartedAt) {
      ms += this._now().getTime() - this._attemptStartedAt;
    }
    return ms / 1000;
  }

  /**
   * true, wenn die Zwischenform Content hat (Playlist existiert).
   */
  hasContent() {
    try {
      return fs.existsSync(path.join(this.dir, 'index.m3u8'));
    } catch (_) {
      return false;
    }
  }

  // ── Intern: Attempt-Loop ──

  _spawnAttempt() {
    this._attempt += 1;
    if (this._attempt === 1) {
      this.meta.startedAt = this._now().toISOString();
      this._emitMeta();
    }
    this._lastError = null;
    this._state = STATE_RECORDING;
    this._attemptStartedAt = this._now().getTime();

    // Segment-Präfix pro Attempt (F-FB-09, t_9372a4b3): Mit fixem Muster
    // seg_%05d.ts nummeriert ffmpeg bei JEDEM Reconnect-Spawn wieder bei
    // seg_00000.ts und ÜBERSCHREIBT die Segmente früherer Runden — die
    // append_list-Playlist behielt ihre alten #EXTINF-Zeilen, die Dauer
    // wuchs pro Retry um das erneut gelesene Leading-Edge-Fenster
    // (QA-Befund: 66460s MP4 bei ~282s Wandzeit). Mit attempt-eigenem
    // Präfix (seg_a1_…, seg_a2_…) überschreibt keine Runde mehr eine andere;
    // die Playlist summiert genau die tatsächlich gesammelten Segmente.
    // (Attempt 1 behält das schlichte Muster — Bestands-Playlists und die
    // Mehrheit aller Aufnahmen ohne Reconnect sehen unverändert aus.)
    const segmentPattern = this._attempt === 1 ? 'seg_%05d.ts' : `seg_a${this._attempt}_%05d.ts`;

    // startOffsetSec (Karte t_f36663be, Item 2 Option C): DVR-Rückstand.
    // `-ss` VOR `-i` → der HLS-Demuxer seekt im DVR-Fenster der Sliding-
    // Playlist (empirisch verifiziert: ARD/ZDF lesen dann History-Segmente).
    // Übersteigt der Offset die Fenster-Tiefe, meldet ffmpeg „could not
    // seek to position X" (stderr) und startet am frühesten verfügbaren
    // Segment — graceful Degrade, kein Abbruch. Die Naht-Diagnostik läuft
    // über _stderrTail (→ handleSeekDegrade).
    const seekArgs =
      this.startOffsetSec > 0
        ? ['-ss', String(this.startOffsetSec)]
        : [];

    const args = [
      '-nostdin',
      '-hide_banner',
      '-v', 'warning',
      ...seekArgs,
      '-i', this.sourceUrl,
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', String(this.expectedSegmentSec),
      '-hls_list_size', '0',
      '-hls_flags', 'temp_file+omit_endlist+append_list+independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(this.dir, segmentPattern),
      path.join(this.dir, 'index.m3u8'),
    ];

    let child;
    try {
      child = spawn(this.ffmpegPath, args, { cwd: this.dir, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this._handleFatal(`ffmpeg konnte nicht gestartet werden: ${e.message}`);
      return;
    }
    this._child = child;
    child.on('error', e => {
      if (this._child !== child) return;
      this._handleFatal(`ffmpeg-Prozessfehler: ${e.message}`);
    });
    child.stderr.on('data', chunk => {
      this._stderrTail = (this._stderrTail + chunk).slice(-2000);
      this._detectSeekDegrade();
    });
    child.on('close', (code, signal) => this._onAttemptClose(code, signal));
    this._scheduleSizeTick();
    this.emit('started', {
      recId: this.recId,
      attempt: this._attempt,
      startOffsetSec: this.startOffsetSec,
      requestedOffsetSec: this.startOffsetSec,
      degraded: this._seekDegraded,
    });
  }

  /**
   * Degrade-Detektor (Karte t_f36663be, Item 2 / Meldung 4): erkennt im
   * ffmpeg-stderr, dass der angefragte DVR-Seek nicht möglich war und die
   * Aufnahme am frühersten verfügbaren DVR-Segment (oder Live-Head)
   * gestartet ist. NurAttempt 1, einmalig — Recovery-/Retry-Versuche
   * starten ohnehin am Live-Fenster.
   */
  _detectSeekDegrade() {
    if (this._attempt !== 1 || this.startOffsetSec === 0 || this._seekDegraded) return;
    if (/could not seek to position/i.test(this._stderrTail)) {
      this._seekDegraded = true;
      const degradedMessage =
        `DVR-Rückstand von ${this.startOffsetSec}s nicht erreichbar — Aufnahme startet am frühersten ` +
        'verfügbaren DVR-Segment (Stream-Fenster begrenzt)';
      log('warn', `${this.recId}: ${degradedMessage}`);
      this.emit('seek-degraded', {
        recId: this.recId,
        requestedOffsetSec: this.startOffsetSec,
        message: degradedMessage,
      });
    }
  }

  _onAttemptClose(code, signal) {
    this._child = null;
    this._clearSizeTick();
    clearTimeout(this._killTimer);
    clearTimeout(this._stopSafetyTimer);
    const ranMs = this._attemptStartedAt ? this._now().getTime() - this._attemptStartedAt : 0;

    if (this._state === STATE_STOPPING) {
      this._accumulatedRecordingMs += ranMs;
      this._finalize();
      return;
    }
    if (this._state !== STATE_RECORDING) return;

    // Attempt endete von selbst → Stream abgebrochen
    this._accumulatedRecordingMs += ranMs;
    this._state = STATE_WAITING_RETRY;
    this._lastError = `Stream abgebrochen (code=${code}, signal=${signal || 'none'})`;

    if (this._attempt === 1 && ranMs < FIRST_ATTEMPT_MIN_RUN_MS) {
      // Start hat nie wirklich funktioniert (falsche URL, Host unreachable) —
      // Retries wären sinnloses Warten gegen eine permanente Fehler.
      this._handleFatal(
        `Aufnahme konnte nicht gestartet werden: ${this._stderrTail.trim().slice(-300) || this._lastError}`,
      );
      return;
    }
    this._scheduleRetry();
  }

  _scheduleRetry() {
    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** this._retryCount, RETRY_MAX_DELAY_MS);
    this._retryCount += 1;
    this._retryWaitTotalMs += delay;
    if (this._retryWaitTotalMs > RETRY_MAX_WAIT_MS) {
      this._handleFatal(
        `Stream dauerhaft nicht erreichbar (Retry-Budget ${Math.round(RETRY_MAX_WAIT_MS / 1000)}s ausgeschöpft): ${this._lastError}`,
      );
      return;
    }
    log('warn', `${this.recId}: Stream weg, Reconnect in ${delay}ms (Versuch ${this._attempt + 1})`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._state !== STATE_WAITING_RETRY) return;
      this._spawnAttempt();
    }, delay);
    this.emit('reconnecting', {
      recId: this.recId,
      attempt: this._attempt,
      nextAttempt: this._attempt + 1,
      delayMs: delay,
      waitTotalMs: this._retryWaitTotalMs,
      error: this._lastError,
    });
  }

  _handleFatal(message) {
    if (this._finalized || this._state === STATE_STOPPED) return;
    this._fatalReason = message;
    this._lastError = message;
    log('error', `${this.recId}: ${message}`);
    this._clearRetryTimer();
    if (this._child) {
      this._state = STATE_STOPPING;
      const child = this._child;
      this._killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
      }, RETRY_KILL_GRACE_MS);
      this._stopSafetyTimer = setTimeout(() => this._finalize(), RETRY_KILL_GRACE_MS + 2000);
      try {
        child.kill('SIGINT');
      } catch (_) {
        // Bereits weg → 'close' finalisiert
      }
    } else {
      this._finalize();
    }
  }

  // ── Intern: Finalisierung ──

  _appendEndlist() {
    const playlistPath = path.join(this.dir, 'index.m3u8');
    if (!fs.existsSync(playlistPath)) return false;
    const raw = fs.readFileSync(playlistPath, 'utf-8');
    if (/^\s*#EXT-X-ENDLIST\s*$/m.test(raw)) return false;
    fs.appendFileSync(playlistPath, raw.endsWith('\n') ? '#EXT-X-ENDLIST\n' : '\n#EXT-X-ENDLIST\n', 'utf-8');
    return true;
  }

  _computeBytesWritten() {
    return directoryBytes(this.dir);
  }

  _finalize() {
    if (this._finalized) return;
    this._finalized = true;
    this._clearRetryTimer();
    this._clearSizeTick();
    clearTimeout(this._killTimer);
    clearTimeout(this._stopSafetyTimer);
    if (this._child) {
      try {
        this._child.kill('SIGKILL');
      } catch (_) {}
      this._child = null;
    }

    let endlistAppended = false;
    try {
      endlistAppended = this._appendEndlist();
    } catch (e) {
      log('warn', `${this.recId}: ENDLIST konnte nicht gesichert werden: ${e.message}`);
    }
    if (!this.meta.stoppedAt) this.meta.stoppedAt = this._now().toISOString();
    try {
      this.meta.durationSec = playlistDurationSec(path.join(this.dir, 'index.m3u8'));
    } catch (_) {
      this.meta.durationSec = Math.round(this.getRecordingSec() * 1000) / 1000;
    }
    this.meta.fileSizeBytes = this._computeBytesWritten();

    let reason;
    if (this._abortRequested) {
      assertTransition(this.meta.status, 'aborted');
      this.meta.status = 'aborted';
      reason = 'abort';
    } else if (this._fatalReason) {
      assertTransition(this.meta.status, 'failed');
      this.meta.status = 'failed';
      this.meta.lastError = this._fatalReason;
      reason = 'failed';
    } else {
      assertTransition(this.meta.status, 'remux-pending');
      this.meta.status = 'remux-pending';
      reason = 'user';
    }

    this._state = STATE_STOPPED;
    this._emitMeta();
    const payload = { recId: this.recId, meta: { ...this.meta }, reason, endlistAppended };
    if (this._stopResolve) {
      const resolve = this._stopResolve;
      this._stopResolve = null;
      resolve(payload);
    }
    if (reason === 'failed') this.emit('failed', payload);
    else this.emit('stopped', payload);
  }

  // ── Intern: Progress-Tick ──

  _scheduleSizeTick() {
    this._clearSizeTick();
    this._sizeTimer = setTimeout(() => {
      this._sizeTimer = null;
      if (this._state !== STATE_RECORDING) return;
      this.meta.fileSizeBytes = this._computeBytesWritten();
      this.emit('progress', {
        recId: this.recId,
        recordingSec: Math.round(this.getRecordingSec() * 1000) / 1000,
        bytesWritten: this.meta.fileSizeBytes,
        attempt: this._attempt,
      });
      this._scheduleSizeTick();
    }, SIZE_TICK_MS);
  }

  _clearRetryTimer() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  _clearSizeTick() {
    if (this._sizeTimer) {
      clearTimeout(this._sizeTimer);
      this._sizeTimer = null;
    }
  }

  _emitMeta() {
    this.emit('meta', { recId: this.recId, meta: { ...this.meta } });
  }
}

module.exports = { RecordJob, playlistDurationSec, directoryBytes };
