// WakeHelperClient: startet/steuert den Wake-Helfer (lib/recorder/wake-helper.sh).
// Konzept §4.3. Nur macOS. Der Helfer läuft als root nur solange die App läuft
// und nimmt über eine FIFO ausschließlich „wake/cancel <Datum>“ und „quit“ an.
//
// Start: `osascript … do shell script … with administrator privileges` mit dem
// Skript INLINE (sh -c '<Skript>' …). In den privilegierten Befehl gelangen nur
// feste, geprüfte Tokens: UID (Zahl), PID (Zahl), Zufalls-Token (Hex), feste
// Pfade. Kein Benutzername, keine Nutzereingabe.
//
// Alles Fremde ist injizierbar (execFile, fs, Zufall, Uhr): Tests führen weder
// osascript noch pmset noch root-Code aus.

'use strict';

const nodeFs = require('fs');
const nodeCrypto = require('crypto');
const { execFile: nodeExecFile } = require('child_process');
const { HELPER_SCRIPT } = require('./wake-helper-script.js');

const BASE_DIR = '/var/run';
const DIR_PREFIX = 'streaminghub-wake-';
const PMSET_PATH = '/usr/bin/pmset';
const DATE_PATTERN = /^(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])\/\d{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
const READY_TIMEOUT_MS = 6000;
const READY_POLL_MS = 150;
const USER_CANCELLED = -128;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class WakeHelperClient {
  constructor({
    platform = process.platform,
    execFile = nodeExecFile,
    fs = nodeFs,
    getUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    pid = process.pid,
    randomToken = () => nodeCrypto.randomBytes(16).toString('hex'),
    baseDir = BASE_DIR,
    pmsetPath = PMSET_PATH,
    script = HELPER_SCRIPT,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    logger = null,
  } = {}) {
    this.platform = platform;
    this.execFile = execFile;
    this.fs = fs;
    this.getUid = getUid;
    this.pid = pid;
    this.randomToken = randomToken;
    this.baseDir = baseDir;
    this.pmsetPath = pmsetPath;
    this.script = script;
    this.sleep = sleep;
    this.logger = logger;
    this.fifo = null;
    this._starting = null;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](`[wake] ${message}`);
  }

  isSupported() {
    return this.platform === 'darwin';
  }

  /** Läuft ein Helfer für diesen Lauf? (Leser an der FIFO vorhanden) */
  isActive() {
    return this.fifo !== null && this._probe(this.fifo);
  }

  _probe(fifo) {
    try {
      const fd = this.fs.openSync(fifo, this.fs.constants.O_WRONLY | this.fs.constants.O_NONBLOCK);
      this.fs.closeSync(fd);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Eine Zeile an die FIFO (nie blockierend). true bei Erfolg. */
  _write(fifo, line) {
    let fd = null;
    try {
      fd = this.fs.openSync(fifo, this.fs.constants.O_WRONLY | this.fs.constants.O_NONBLOCK);
      this.fs.writeSync(fd, `${line}\n`);
      return true;
    } catch (e) {
      this._log('warn', `Auftrag nicht zustellbar: ${e.code || e.message}`);
      return false;
    } finally {
      if (fd !== null) {
        try {
          this.fs.closeSync(fd);
        } catch (_) {
          /* ignorieren */
        }
      }
    }
  }

  /** Auftrag senden; prüft das Format schon hier (zweite Verteidigungslinie). */
  send(verb, dateText) {
    if (!this.fifo) return false;
    if (verb !== 'wake' && verb !== 'cancel') return false;
    if (typeof dateText !== 'string' || !DATE_PATTERN.test(dateText)) return false;
    return this._write(this.fifo, `${verb} ${dateText}`);
  }

  /** Helfer beenden (best effort). */
  quit() {
    if (!this.fifo) return false;
    const ok = this._write(this.fifo, 'quit');
    this.fifo = null;
    return ok;
  }

  buildCommand(token) {
    const uid = this.getUid();
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('Nutzerkennung nicht ermittelbar');
    if (!Number.isInteger(this.pid) || this.pid <= 0) throw new Error('App-PID ungültig');
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('Token ungültig');
    const args = [uid, this.pid, token, this.pmsetPath, this.baseDir].map(shellQuote).join(' ');
    return `/bin/sh -c ${shellQuote(this.script)} streaminghub-wake-helper ${args} >/dev/null 2>&1 &`;
  }

  /**
   * Helfer starten (fragt das Admin-Passwort ab). Idempotent: läuft schon einer,
   * passiert nichts. Liefert { ok, error?, cancelled? }; wirft nie.
   */
  start() {
    if (!this.isSupported()) return Promise.resolve({ ok: false, error: 'Nur auf macOS verfügbar' });
    if (this.isActive()) return Promise.resolve({ ok: true });
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
    let command;
    let token;
    try {
      token = this.randomToken();
      command = this.buildCommand(token);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const fifo = `${this.baseDir}/${DIR_PREFIX}${this.getUid()}-${token}/cmd`;
    const result = await new Promise(resolve => {
      this.execFile(
        '/usr/bin/osascript',
        ['-e', 'on run argv', '-e', 'do shell script (item 1 of argv) with administrator privileges', '-e', 'end run', command],
        { timeout: 120000 },
        (err, _stdout, stderr) => resolve({ err, stderr: String(stderr || '') }),
      );
    });
    if (result.err) {
      const cancelled = /\(-128\)/.test(result.stderr) || result.err.code === USER_CANCELLED;
      this._log('warn', cancelled ? 'Abfrage abgebrochen' : `Start fehlgeschlagen: ${result.stderr.trim() || result.err.message}`);
      return { ok: false, cancelled, error: cancelled ? 'Abgebrochen' : 'Der Helfer konnte nicht gestartet werden' };
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this._probe(fifo)) {
        this.fifo = fifo;
        this._log('info', 'Helfer aktiv');
        return { ok: true };
      }
      await this.sleep(READY_POLL_MS);
    }
    return { ok: false, error: 'Der Helfer ist nicht angesprungen' };
  }

  /**
   * Beim App-Start: Helfer eines früheren Laufs (gleiche UID) erkennen und
   * beenden. Liefert die Anzahl beendeter Helfer.
   */
  sweepOrphans() {
    if (!this.isSupported()) return 0;
    let names;
    try {
      names = this.fs.readdirSync(this.baseDir);
    } catch (_) {
      return 0;
    }
    const mine = new RegExp(`^${DIR_PREFIX}${this.getUid()}-[0-9a-f]{32}$`);
    let ended = 0;
    for (const name of names) {
      if (!mine.test(name)) continue;
      const fifo = `${this.baseDir}/${name}/cmd`;
      if (fifo === this.fifo) continue;
      if (this._probe(fifo) && this._write(fifo, 'quit')) {
        ended += 1;
        this._log('info', 'Verwaisten Helfer beendet');
      }
    }
    return ended;
  }
}

module.exports = { WakeHelperClient, DATE_PATTERN, shellQuote, DIR_PREFIX };
