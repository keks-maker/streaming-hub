'use strict';

// Ausführung eines einzelnen Downloads (Konzept §3): (a) progressive MP4-Datei per HTTP mit Range-Resume und Bandbreitenlimit,
// (b) ffmpeg-Mux aus getrennten Eingängen (Video, Tonspuren, WebVTT) mit -progress. Ausgabe immer in <Datei>.part; erst nach der
// ffprobe-Prüfung wird atomar umbenannt. Abbruch beendet den Prozess (SIGTERM, dann SIGKILL) und löscht die Teildatei (bei Pause
// im HTTP-Modus bleibt sie für den Resume). Adressen und Tokens erscheinen weder in Meldungen noch in Logs.
//
// Der Job kennt weder Queue noch Persistenz: er bekommt Plan, Ziel und Abhängigkeiten und liefert ein Ergebnis oder wirft einen
// Error mit lesbarer Meldung und code ('expired' = Adresse abgelaufen, neu auflösen).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { probeMp4 } = require('../recorder/RemuxJob.js');
const { parseHlsMaster } = require('../mediathek/hls-master.js');
const { downloadFile } = require('./http-download.js');
const { buildMuxArgs, buildSrtArgs, readRateFor, createProgressParser, DEFAULT_PROTOCOLS } = require('./ffmpeg-args.js');
const { pickHlsVariant, approxBitrate, maxHeightOf } = require('./track-selection.js');

const KILL_GRACE_MS = 3000;
const STALL_MS = 120000;
const MIN_DURATION_FACTOR = 0.5; // kürzer als die Hälfte der angekündigten Dauer = unvollständig
const PROGRESS_INTERVAL_MS = 500;

function jobError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Adressen aus ffmpeg-Ausgaben entfernen (Tokens in Query-Parametern). */
function scrub(text) {
  return String(text || '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<Adresse>').replace(/\s+/g, ' ').trim();
}

/** Lesbare Meldung zu einer ffmpeg-Ausgabe. */
function describeFfmpegFailure(stderr, exitCode) {
  const text = String(stderr || '');
  if (/No space left|Disk quota/i.test(text)) return jobError('Speicherplatz voll', 'disk');
  if (/Server returned (401|403|404|410)|HTTP error (401|403|404|410)/i.test(text)) return jobError('Der Server verweigert den Abruf (Adresse abgelaufen)', 'expired');
  if (/Connection (refused|timed out|reset)|Network is unreachable|Name or service not known|nodename nor servname|Input\/output error/i.test(text)) return jobError('Verbindung zum Server fehlgeschlagen', 'network');
  const tail = scrub(text).slice(-240);
  return jobError(`Zusammenfügen fehlgeschlagen (ffmpeg ${exitCode})${tail ? `: ${tail}` : ''}`, 'ffmpeg');
}

class DownloadJob {
  /**
   * options:
   *  plan, target ({ dir, base, ext, file, partFile }), meta ({ title, show, season, episode, date }), durationSec (erwartet),
   *  sourceId, maxHeight (für HLS-Master), bytesPerSecond (Limit, 0 = aus), etag (Validator der Teildatei),
   *  ffmpegPath, ffprobePath, mediaHttp ({ getText }), assertUrl(url, sourceId) (async, wirft bei unerlaubter Adresse),
   *  httpOptions (fetchImpl, lookup, guardUrl an downloadFile), spawnImpl, userAgent, protocolWhitelist, stallMs,
   *  onProgress(progress), onChild(child) / offChild(child) (Quit-Registry), logger
   */
  constructor(options) {
    // nicht gesetzte Optionen (undefined) lassen die Standardwerte stehen
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== null));
    Object.assign(this, { bytesPerSecond: 0, etag: null, spawnImpl: spawn, stallMs: STALL_MS, protocolWhitelist: DEFAULT_PROTOCOLS, httpOptions: {}, logger: null, onProgress: null, onChild: null, offChild: null, durationSec: null, meta: {}, userAgent: null }, given);
    this.controller = new AbortController();
    this.child = null;
    this.stopMode = null; // 'pause' | 'cancel' | 'quit'
    this.lastEmit = 0;
    this.startedAt = 0;
    this.speedSample = { at: 0, bytes: 0, speed: 0 };
    this.warnings = [...(this.plan.warnings || [])];
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[download] ${message}`);
  }

  _emit(progress, force = false) {
    if (!this.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    // Geschwindigkeit: gleitend über die letzten Messpunkte
    const sample = this.speedSample;
    if (progress.bytes !== null && progress.bytes !== undefined) {
      if (!sample.at) Object.assign(sample, { at: now, bytes: progress.bytes, speed: 0 });
      else if (now - sample.at >= 1000) {
        const instant = ((progress.bytes - sample.bytes) / (now - sample.at)) * 1000;
        sample.speed = sample.speed ? sample.speed * 0.6 + instant * 0.4 : instant;
        Object.assign(sample, { at: now, bytes: progress.bytes });
      }
    }
    const speed = Math.max(0, Math.round(sample.speed));
    let etaSec = null;
    if (progress.percent !== null && progress.percent !== undefined && progress.percent > 0 && progress.percent < 100) {
      const elapsed = (now - this.startedAt) / 1000;
      etaSec = Math.round((elapsed * (100 - progress.percent)) / progress.percent);
    } else if (progress.totalBytes && speed > 0) {
      etaSec = Math.round((progress.totalBytes - progress.bytes) / speed);
    }
    try {
      this.onProgress({ ...progress, speed, etaSec });
    } catch (error) {
      this._log('warn', `Fortschritt nicht zustellbar: ${error.message}`);
    }
  }

  /** Läuft der Job gerade (Prozess oder HTTP-Lauf)? */
  get running() {
    return this._running === true;
  }

  async run() {
    this._running = true;
    this.startedAt = Date.now();
    try {
      fs.mkdirSync(this.target.dir, { recursive: true });
      if (this.plan.mode === 'http') await this._runHttp();
      else await this._runFfmpeg();
      if (this.stopMode) throw jobError('Abgebrochen', 'aborted');
      const info = await this._verify();
      const file = this._finalize();
      await this._writeExternalSubtitles(file);
      return { file, fileSize: info.fileSizeBytes, durationSec: info.durationSec, etag: this.resultEtag || null, total: this.resultTotal || null, warnings: this.warnings };
    } catch (error) {
      if (this.stopMode === 'cancel' || (this.stopMode && this.plan.mode !== 'http') || (error && error.code === 'verify')) this._removePart();
      if (this.stopMode && !(error && error.code === 'aborted')) throw jobError('Abgebrochen', 'aborted');
      throw error;
    } finally {
      this._running = false;
    }
  }

  async _runHttp() {
    const url = this.plan.video.url;
    await this.assertUrl(url, this.sourceId);
    let lastTotal = null;
    const result = await downloadFile(url, this.target.partFile, {
      guardUrl: target => this.assertUrl(target, this.sourceId), // jede Weiterleitung wird geprüft
      ...this.httpOptions,
      signal: this.controller.signal,
      bytesPerSecond: this.bytesPerSecond,
      etag: this.etag,
      userAgent: this.userAgent || undefined,
      onProgress: ({ bytes, total }) => {
        lastTotal = total;
        this._emit({ percent: total ? Math.min(99.9, (bytes / total) * 100) : null, bytes, totalBytes: total });
      },
    });
    this.resultEtag = result.etag;
    this.resultTotal = result.total || lastTotal;
    this._emit({ percent: 100, bytes: result.bytes, totalBytes: result.total }, true);
  }

  /** Eingänge auflösen: HLS-Master -> Variante (und getrennte Audiogruppe), Host-/Adressprüfung je Eingang. */
  async _resolveInputs() {
    const inputs = [];
    const audioRemap = new Map(); // Eingang 0 mit getrennter Audiogruppe: Index des zusätzlichen Audioeingangs
    for (const [index, input] of this.plan.inputs.entries()) {
      await this.assertUrl(input.url, this.sourceId);
      if (!input.needsMaster) {
        inputs.push(input.url);
        continue;
      }
      let text;
      try {
        text = await this.mediaHttp.getText(input.url, { accept: '*/*' });
      } catch (error) {
        throw jobError(error && error.status === 404 ? 'Der Server verweigert den Abruf (Adresse abgelaufen)' : 'Verbindung zum Server fehlgeschlagen', error && [403, 404, 410].includes(error.status) ? 'expired' : 'network');
      }
      const master = parseHlsMaster(text, input.url);
      if (master.encrypted) throw jobError('Dieser Stream ist verschlüsselt (DRM) und kann nicht geladen werden.', 'unsupported');
      if (!master.isMaster) {
        inputs.push(input.url); // schon eine Medienplaylist
        continue;
      }
      const variant = pickHlsVariant(master, this._maxHeight());
      if (!variant) throw jobError('Keine ladbare Videostufe gefunden', 'no-video');
      await this.assertUrl(variant.uri, this.sourceId);
      inputs.push(variant.uri);
      if (index === 0 && variant.audio) {
        const group = master.media.filter(medium => medium.type === 'AUDIO' && medium.groupId === variant.audio && medium.uri);
        const audio = group.find(medium => medium.isDefault) || group[0];
        if (audio) {
          await this.assertUrl(audio.uri, this.sourceId);
          audioRemap.set(0, { url: audio.uri });
        }
      }
    }
    return { inputs, audioRemap };
  }

  _maxHeight() {
    return maxHeightOf({ maxHeight: this.maxHeight || 'best' });
  }

  async _runFfmpeg() {
    this._removePart(); // HLS/Mux-Abbruch startet die Folge neu
    const { inputs, audioRemap } = await this._resolveInputs();
    let plan = this.plan;
    if (audioRemap.has(0)) {
      // Variante ohne Ton: Audiogruppe als zusätzlicher Eingang, Standardspur kommt von dort
      const extra = audioRemap.get(0);
      inputs.push(extra.url);
      plan = { ...plan, inputs: [...plan.inputs, { url: extra.url }], audio: plan.audio.map(audio => (audio.input === 0 ? { ...audio, input: inputs.length - 1 } : audio)) };
    }
    const bitrate = approxBitrate(plan.video);
    const readRate = readRateFor(this.bytesPerSecond / 1000, bitrate);
    const args = buildMuxArgs({ plan, inputUrls: inputs, outFile: this.target.partFile, meta: this.meta, userAgent: this.userAgent, protocolWhitelist: this.protocolWhitelist, readRate });
    await this._spawnFfmpeg(args, { progress: true });
  }

  /** Startet ffmpeg, verfolgt -progress und wartet auf das Ende. */
  _spawnFfmpeg(args, { progress = false } = {}) {
    return new Promise((resolve, reject) => {
      if (this.stopMode) return reject(jobError('Abgebrochen', 'aborted'));
      let child;
      try {
        child = this.spawnImpl(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        return reject(jobError(`ffmpeg konnte nicht gestartet werden: ${scrub(error.message)}`, 'ffmpeg'));
      }
      this.child = child;
      if (this.onChild) this.onChild(child);
      let stderr = '';
      let settled = false;
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          this.stallKilled = true;
          this._killChild(child);
        }, this.stallMs);
      };
      armStall();
      const parse = createProgressParser(({ timeSec, totalSize }) => {
        armStall();
        if (!progress) return;
        const expected = this.durationSec;
        const percent = expected && timeSec !== null ? Math.min(99.9, Math.max(0, (timeSec / expected) * 100)) : null;
        this._emit({ percent, bytes: totalSize, totalBytes: null });
      });
      child.stdout.on('data', chunk => parse(String(chunk)));
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-4000);
      });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        if (this.offChild) this.offChild(child);
        this.child = null;
        if (error) reject(error);
        else resolve(value);
      };
      child.on('error', error => finish(jobError(`ffmpeg-Fehler: ${scrub(error.message)}`, 'ffmpeg')));
      child.on('close', code => {
        if (this.stopMode) return finish(jobError('Abgebrochen', 'aborted'));
        if (this.stallKilled) return finish(jobError('Keine Daten mehr empfangen (Zeitüberschreitung)', 'timeout'));
        if (code === 0) return finish(null);
        this._log('warn', `ffmpeg beendet mit Code ${code}: ${scrub(stderr).slice(-300)}`);
        return finish(describeFfmpegFailure(stderr, code));
      });
    });
  }

  _killChild(child) {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Prozess schon beendet
      }
    }, KILL_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('close', () => clearTimeout(timer));
  }

  /** ffprobe-Prüfung der Teildatei: lesbar, Dauer > 0, Video- (und Ton-)Spur, nicht deutlich kürzer als angekündigt. */
  async _verify() {
    let info;
    try {
      info = await probeMp4(this.ffprobePath, this.target.partFile, 30000, this.onChild);
    } catch {
      throw jobError('Die geladene Datei ist nicht lesbar', 'verify');
    }
    if (!info.durationSec || info.durationSec <= 0) throw jobError('Die geladene Datei hat keine gültige Dauer', 'verify');
    if (!info.streamTypes.includes('video')) throw jobError('Die geladene Datei enthält kein Bild', 'verify');
    if (this.durationSec && info.durationSec < this.durationSec * MIN_DURATION_FACTOR) throw jobError('Der Download ist unvollständig (Datei zu kurz)', 'verify');
    return info;
  }

  /** .part -> Zieldatei (atomar); bei Kollision (Datei entstand inzwischen) wird nummeriert. */
  _finalize() {
    let file = this.target.file;
    for (let counter = 2; fs.existsSync(file) && counter < 1000; counter += 1) file = path.join(this.target.dir, `${this.target.base} (${counter}).${this.target.ext}`);
    fs.renameSync(this.target.partFile, file);
    return file;
  }

  /** Externe Untertitel (.srt) neben der Videodatei; Fehler sind nicht fatal. */
  async _writeExternalSubtitles(videoFile) {
    const external = this.plan.subtitles.filter(subtitle => subtitle.external);
    const base = videoFile.slice(0, -path.extname(videoFile).length);
    this.subtitleFiles = [];
    for (const subtitle of external) {
      if (this.stopMode) break;
      const suffix = subtitle.kind === 'hearing-impaired' ? '.sdh' : subtitle.kind === 'forced' ? '.forced' : '';
      const out = `${base}.${subtitle.language || 'und'}${suffix}.srt`;
      try {
        await this.assertUrl(subtitle.url, this.sourceId);
        await this._spawnFfmpeg(buildSrtArgs({ url: subtitle.url, outFile: out, userAgent: this.userAgent, protocolWhitelist: this.protocolWhitelist }));
        this.subtitleFiles.push(out);
      } catch (error) {
        try {
          fs.rmSync(out, { force: true });
        } catch {
          // Teildatei nicht löschbar
        }
        this.warnings.push('Ein Untertitel konnte nicht gespeichert werden.');
        this._log('warn', `Untertitel nicht gespeichert: ${scrub(error.message)}`);
      }
    }
  }

  _removePart() {
    try {
      fs.rmSync(this.target.partFile, { force: true });
    } catch (error) {
      this._log('warn', `Teildatei nicht gelöscht: ${error.code || error.message}`);
    }
  }

  /** Pause: HTTP behält die Teildatei (Resume per Range), ffmpeg-Läufe beginnen später von vorn. */
  pause() {
    this._stop('pause');
  }

  /** Abbrechen: Prozess beenden, Teildatei löschen. */
  cancel() {
    this._stop('cancel');
  }

  /** Beenden der App: synchron SIGKILL, Teildatei von ffmpeg-Läufen löschen; HTTP-Teildatei bleibt für den Resume. */
  killForQuit() {
    this.stopMode = 'quit';
    this.controller.abort();
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Prozess schon beendet
      }
    }
    if (this.plan.mode !== 'http') this._removePart();
  }

  _stop(mode) {
    if (this.stopMode) return;
    this.stopMode = mode;
    this.controller.abort();
    if (this.child) this._killChild(this.child);
  }
}

module.exports = { DownloadJob, describeFfmpegFailure, scrub, MIN_DURATION_FACTOR };
