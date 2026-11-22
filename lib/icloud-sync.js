// iCloud-Abgleich (D10) im Main: startet den Mac-Helfer StreamingHubSync, spricht JSON-Zeilen nach
// native/StreamingHubSync/PROTOCOL.md (Version 1) und gleicht Fortschritt, Warteschlange (und Zuletzt gesehen, sobald
// der Desktop einen Speicher dafür hat) mit iCloud ab. Die Abgleich-Regel selbst wendet der Helfer an; hier schützt
// lib/sync-merge.js nur das lokale Übernehmen (ein Record wird nur angewendet, wenn er gegen den aktuellen lokalen gewinnt).
//
// No-op ohne Wirkung auf die App: nicht macOS, kein Helfer, Schalter aus, kein iCloud-Konto. Kürzen oder Ablauf lokaler
// Einträge ist nie eine Löschung: fehlende Records werden nicht gemeldet, der Helfer löscht auf dem Server nichts.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { merge } = require('./sync-merge.js');
const { normalizeEntries } = require('./youtube-progress.js');
const { normalizePlaylist } = require('./youtube-playlist.js');

const PROTOCOL_VERSION = 1;
const MAX_TRIMMED = 2000;
const HELPER_EXECUTABLE = ['StreamingHubSync.app', 'Contents', 'MacOS', 'StreamingHubSync'];
const DEFAULTS = {
  debounceMs: 45000,
  helloTimeoutMs: 15000,
  requestTimeoutMs: 15000,
  syncTimeoutMs: 120000,
  retryAfterFailureMs: 5 * 60 * 1000,
  restartDelaysMs: [1000, 5000, 30000],
  stopGraceMs: 2000,
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNum = value => typeof value === 'number' && Number.isFinite(value);

/** Schlüsselreihenfolge-unabhängige Serialisierung. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const signature = value => crypto.createHash('sha1').update(stable(value)).digest('hex').slice(0, 16);

// ── Abbildung Fortschritt/Warteschlange ⇄ Records (Format wie lib/sync-merge.js) ──

function progressToRecord(entry) {
  const { updated, done, ...fields } = entry;
  const record = { name: `p:${entry.id}`, kind: 'Progress', modified: updated, fields };
  if (done === true) record.deleted = true;
  return record;
}

function progressFromRecord(record) {
  const fields = isObject(record.fields) ? record.fields : {};
  const entry = { ...fields, id: record.name.slice(2), position: isNum(fields.position) ? fields.position : 0, duration: isNum(fields.duration) ? fields.duration : 0, updated: record.modified };
  if (record.deleted === true) {
    entry.done = true;
    entry.position = 0;
  }
  return entry;
}

const validRecord = record => isObject(record) && typeof record.name === 'string' && typeof record.kind === 'string' && isNum(record.modified);

/** Gewinnt `incoming` nach der Abgleich-Regel gegen den aktuellen lokalen Record (ohne lokalen: ja)? */
function incomingWins(current, incoming, now) {
  if (!current) return true;
  const { merged } = merge([current], [incoming], now);
  const winner = merged.find(record => record.name === incoming.name);
  return !!winner && winner.modified === incoming.modified && (winner.deleted === true) === (incoming.deleted === true) && signature(winner.fields || {}) === signature(incoming.fields || {});
}

function defaultCommand(helperDir) {
  const file = path.join(helperDir, ...HELPER_EXECUTABLE);
  return { file, args: ['--state-dir', helperDir] };
}

/**
 * @param {object} options
 *  - platform, helperDir, command ({ file, args }, Test-Override), enabled (Startwert)
 *  - adapter: { readProgress(): Eintrag[] (inkl. Marken done), readQueue(): Eintrag[], applyProgress({ upsert, removeIds }), applyQueue(items) }
 *  - stateStore: { read(), write(state) } (persistierter Abgleichzustand)
 *  - spawnImpl, now (Sekunden), logger, onStatus(status), Zeiten siehe DEFAULTS
 */
function createICloudSync(options = {}) {
  const platform = options.platform || process.platform;
  const helperDir = options.helperDir;
  const adapter = options.adapter;
  const stateStore = options.stateStore;
  const spawnImpl = options.spawnImpl || spawn;
  const now = options.now || (() => Date.now() / 1000);
  const logger = options.logger || null;
  const timing = { ...DEFAULTS, ...(options.timing || {}) };
  const getCommand = () => options.command || (helperDir ? defaultCommand(helperDir) : null);

  let enabled = options.enabled === true;
  let child = null;
  let stopping = false;
  let requestSeq = 0;
  let pendingRequests = new Map();
  let ready = false; // hello erfolgreich und Konto verfügbar
  let syncing = false;
  let syncAgain = false;
  let debounceTimer = null;
  let retryTimer = null;
  let restartTimer = null;
  let restartCount = 0;
  let status = { state: platform === 'darwin' ? 'disabled' : 'unsupported', message: '', lastSync: null };
  const persisted = loadState();

  function loadState() {
    try {
      const raw = stateStore ? stateStore.read() : null;
      if (isObject(raw)) return { initialized: raw.initialized === true, known: isObject(raw.known) ? raw.known : {}, queueSig: typeof raw.queueSig === 'string' ? raw.queueSig : null, queueModified: isNum(raw.queueModified) ? raw.queueModified : 0, queueText: typeof raw.queueText === 'string' ? raw.queueText : null, trimmed: isObject(raw.trimmed) ? raw.trimmed : {}, lastSync: isNum(raw.lastSync) ? raw.lastSync : null };
    } catch (_) { /* unlesbar → leerer Zustand */ }
    return { initialized: false, known: {}, queueSig: null, queueModified: 0, queueText: null, trimmed: {}, lastSync: null };
  }
  function saveState() {
    try { if (stateStore) stateStore.write(persisted); } catch (error) { logger?.warn?.('iCloud-Abgleichzustand nicht gespeichert:', error.message); }
  }

  function publicStatus() {
    return { supported: platform === 'darwin', enabled, state: status.state, message: status.message, lastSync: persisted.lastSync };
  }
  function setStatus(state, message = '') {
    if (status.state === state && status.message === message) return;
    status = { state, message, lastSync: persisted.lastSync };
    try { options.onStatus?.(publicStatus()); } catch (_) { /* Anzeige darf den Abgleich nie stören */ }
  }

  // ── Lokaler Bestand ──

  function queueChangedAt() {
    try {
      const value = adapter.readQueueModified?.();
      if (isNum(value) && value > 0) return value;
    } catch (_) { /* unbekannt → ältester Stand */ }
    return 0; // unbekanntes Alter verliert gegen jeden Server-Stand, gewinnt nie durch Zufall
  }

  function collectLocal() {
    const records = [];
    for (const entry of normalizeEntries(adapter.readProgress(), now())) records.push(progressToRecord(entry));
    const items = normalizePlaylist(adapter.readQueue());
    const itemsText = JSON.stringify(items);
    const sig = signature(items);
    if (persisted.queueSig !== sig) {
      // Nie gesehen und leer: nichts melden, der Server-Stand soll gewinnen. Sonst die echte Änderungszeit
      // (vom Speicher beim Schreiben festgehalten, Rückfall mtime der Datei), nie der Zeitpunkt der Erkennung.
      if (!(persisted.queueSig === null && items.length === 0)) {
        persisted.queueSig = sig;
        persisted.queueModified = queueChangedAt();
        persisted.queueText = null;
      }
    }
    if (persisted.queueSig === sig) {
      records.push({ name: 'queue', kind: 'Queue', modified: persisted.queueModified, fields: { items: persisted.queueText || itemsText } });
    }
    const sigs = new Map();
    const byName = new Map();
    for (const record of records) {
      sigs.set(record.name, signature(record));
      byName.set(record.name, record);
    }
    return { records, sigs, byName };
  }

  // ── Prozess und Protokoll ──

  function rejectAll(error) {
    const list = pendingRequests;
    pendingRequests = new Map();
    for (const entry of list.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function request(cmd, fields, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin || child.stdin.destroyed) { reject(new Error('Helfer läuft nicht')); return; }
      const id = `m${++requestSeq}`;
      const owner = child;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Zeitüberschreitung bei ${cmd}`));
        killChild(owner); // hängender Helfer: beenden, der Exit-Handler startet begrenzt neu
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, cmd, ...fields })}\n`);
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  function killChild(target) {
    try { target.kill('SIGKILL'); } catch (_) { /* schon beendet */ }
  }

  function handleLine(line, owner) {
    if (owner !== child || !line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch (_) { logger?.warn?.('iCloud-Helfer: unlesbare Zeile verworfen'); return; }
    if (!isObject(message)) { logger?.warn?.('iCloud-Helfer: Zeile ist kein Objekt'); return; }
    if (typeof message.event === 'string') { handleEvent(message); return; }
    if (typeof message.id !== 'string') return;
    const entry = pendingRequests.get(message.id);
    if (!entry) return;
    pendingRequests.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(isObject(message.result) ? message.result : {});
    else {
      const error = new Error(isObject(message.error) && typeof message.error.message === 'string' ? message.error.message : 'Helfer-Fehler');
      error.code = isObject(message.error) && typeof message.error.code === 'string' ? message.error.code : 'unknown';
      entry.reject(error);
    }
  }

  function handleEvent(message) {
    if (!ready && status.state !== 'no_account' && status.state !== 'unavailable') return; // Ereignisse erst nach hello
    if (message.event === 'remoteChange') {
      if (ready) requestSync();
    } else if (message.event === 'account') {
      applyAccount(message.status);
    }
  }

  function applyAccount(account) {
    if (account === 'available') {
      ready = true;
      setStatus('active');
      requestSync();
    } else if (account === 'no_account') {
      ready = false;
      setStatus('no_account', 'Kein iCloud-Konto');
    } else if (account === 'unavailable') {
      ready = false;
      setStatus('unavailable', 'iCloud vorübergehend nicht erreichbar');
    }
  }

  function onExit(owner, reason) {
    if (owner !== child) return;
    child = null;
    ready = false;
    rejectAll(new Error(`Helfer beendet (${reason})`));
    clearTimeout(debounceTimer); debounceTimer = null;
    syncing = false;
    if (stopping || !enabled) return;
    if (restartCount >= timing.restartDelaysMs.length) {
      setStatus('error', 'Der Abgleich-Helfer wurde wiederholt unerwartet beendet');
      return;
    }
    const delay = timing.restartDelaysMs[restartCount];
    restartCount += 1;
    setStatus('starting', 'Helfer startet neu');
    restartTimer = setTimeout(() => { restartTimer = null; launch(); }, delay);
    restartTimer.unref?.();
  }

  function launch() {
    const command = getCommand();
    if (platform !== 'darwin') { setStatus('unsupported'); return false; }
    if (!enabled) { setStatus('disabled'); return false; }
    if (!command || !fs.existsSync(command.file)) { setStatus('no_helper', 'Der Abgleich-Helfer ist nicht installiert'); return false; }
    if (child) return true;
    stopping = false;
    let proc;
    try {
      proc = spawnImpl(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      setStatus('error', `Helfer startet nicht: ${error.message}`);
      return false;
    }
    child = proc;
    const owner = proc;
    setStatus('starting');
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line, owner);
      }
      if (buffer.length > 8 * 1024 * 1024) buffer = ''; // Schutz vor endloser Zeile
    });
    proc.stdout.on('end', () => { if (owner === child) killChild(owner); }); // EOF ohne Exit: wie Absturz behandeln
    proc.stderr?.on?.('data', chunk => logger?.debug?.('iCloud-Helfer:', String(chunk).trim()));
    proc.stdin?.on?.('error', () => { /* EPIPE nach Absturz: der Exit-Handler räumt auf */ });
    proc.on('error', error => { logger?.warn?.('iCloud-Helfer Fehler:', error.message); onExit(owner, error.message); });
    proc.on('exit', code => onExit(owner, `Exit ${code}`));
    handshake(owner);
    return true;
  }

  async function handshake(owner) {
    try {
      const hello = await request('hello', { protocol: PROTOCOL_VERSION }, timing.helloTimeoutMs);
      if (owner !== child) return;
      if (hello.protocol !== PROTOCOL_VERSION) throw Object.assign(new Error('Protokollversion passt nicht'), { code: 'unsupported_protocol' });
      ready = true; // vorläufig, damit Ereignisse (account) ab jetzt gelten
      applyAccount(hello.account === 'available' || hello.account === 'no_account' || hello.account === 'unavailable' ? hello.account : 'unavailable');
    } catch (error) {
      if (owner !== child) return;
      ready = false;
      if (error.code === 'unsupported_protocol') {
        restartCount = timing.restartDelaysMs.length; // kein Neustart: ein anderer Helfer wird erst nach Update passen
        setStatus('error', 'Der Abgleich-Helfer passt nicht zu dieser App-Version');
        closeInput(owner);
        return;
      }
      logger?.warn?.('iCloud-Helfer Handshake fehlgeschlagen:', error.message);
      if (!stopping) killChild(owner);
    }
  }

  function closeInput(target) {
    try { target.stdin?.end?.(); } catch (_) { /* schon zu */ }
  }

  // ── Abgleich ──

  function requestSync() {
    if (!ready) return;
    if (syncing) { syncAgain = true; return; }
    runSync();
  }

  function scheduleSync() {
    if (!enabled || !ready || debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; requestSync(); }, timing.debounceMs);
    debounceTimer.unref?.();
  }

  async function runSync() {
    const owner = child;
    if (!owner || !ready) return;
    syncing = true;
    clearTimeout(retryTimer); retryTimer = null;
    try {
      let snapshot;
      try { snapshot = collectLocal(); } catch (error) { logger?.warn?.('iCloud-Abgleich: lokaler Bestand nicht lesbar:', error.message); return; }
      const pending = persisted.initialized ? [...snapshot.sigs].filter(([name, sig]) => persisted.known[name] !== sig).map(([name]) => name) : [];
      const result = await request('sync', { local: snapshot.records, pending }, timing.syncTimeoutMs);
      if (owner !== child) return;
      finishSync(result, snapshot);
      restartCount = 0;
      setStatus('active');
    } catch (error) {
      if (owner !== child) return;
      if (error.code === 'no_account') { ready = false; setStatus('no_account', 'Kein iCloud-Konto'); }
      else if (error.code === 'account_unavailable') { ready = false; setStatus('unavailable', 'iCloud vorübergehend nicht erreichbar'); }
      else {
        setStatus('error', error.message);
        retryTimer = setTimeout(() => { retryTimer = null; requestSync(); }, timing.retryAfterFailureMs);
        retryTimer.unref?.();
      }
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; if (ready && child === owner) requestSync(); }
    }
  }

  /** Angewendete Progress-Records, die lokal gleich wieder gekürzt wurden (Obergrenzen), merken: Kürzen ist keine Löschung. */
  function rememberTrimmed(upsert, after) {
    for (const entry of upsert) {
      const name = `p:${entry.id}`;
      if (after.byName.has(name)) delete persisted.trimmed[name];
      else persisted.trimmed[name] = entry.updated;
    }
    for (const name of Object.keys(persisted.trimmed)) {
      if (after.byName.has(name)) delete persisted.trimmed[name]; // wieder lokal vorhanden
    }
    const names = Object.keys(persisted.trimmed);
    if (names.length > MAX_TRIMMED) {
      names.sort((a, b) => persisted.trimmed[a] - persisted.trimmed[b]);
      for (const name of names.slice(0, names.length - MAX_TRIMMED)) delete persisted.trimmed[name];
    }
  }

  function finishSync(result, snapshot) {
    const failed = new Set(Array.isArray(result.failed) ? result.failed.filter(name => typeof name === 'string') : []);
    const current = collectLocal();
    const upsert = [];
    const removeIds = [];
    let queueRecord = null;
    for (const record of Array.isArray(result.apply) ? result.apply : []) {
      if (!validRecord(record)) continue;
      const unchanged = snapshot.sigs.get(record.name) === current.sigs.get(record.name);
      // Lokal gekürzt (Obergrenze) und seither unverändert: kein erneutes Anwenden, sonst käme es bei jedem Abgleich wieder.
      if (record.kind === 'Progress' && isNum(persisted.trimmed[record.name]) && record.modified <= persisted.trimmed[record.name]) continue;
      if (!unchanged || !incomingWins(current.byName.get(record.name), record, now())) continue; // lokal inzwischen geändert: bleibt pending
      if (record.kind === 'Progress' && /^p:./.test(record.name)) upsert.push(progressFromRecord(record));
      else if (record.kind === 'Queue' && record.name === 'queue') queueRecord = record;
    }
    for (const name of Array.isArray(result.remove) ? result.remove : []) {
      if (typeof name === 'string' && /^p:./.test(name) && snapshot.sigs.get(name) === current.sigs.get(name)) removeIds.push(name.slice(2));
    }
    if (upsert.length || removeIds.length) adapter.applyProgress({ upsert, removeIds });
    if (queueRecord) {
      let text = isObject(queueRecord.fields) && typeof queueRecord.fields.items === 'string' ? queueRecord.fields.items : null;
      let items = [];
      try { items = normalizePlaylist(JSON.parse(text)); } catch (_) { text = null; }
      if (text !== null) {
        adapter.applyQueue(items, queueRecord.modified);
        persisted.queueSig = signature(items);
        persisted.queueModified = queueRecord.modified;
        persisted.queueText = text; // Originaltext behalten, damit Hin und Her zwischen Geräten entfällt
      }
    }
    const after = collectLocal();
    rememberTrimmed(upsert, after);
    const known = {};
    for (const [name, sig] of after.sigs) {
      if (failed.has(name)) continue;
      const sentSig = snapshot.sigs.get(name);
      const applied = upsert.some(entry => `p:${entry.id}` === name) || (queueRecord && name === 'queue');
      if (applied || sentSig === sig) known[name] = sig; // zwischenzeitlich geänderte Records bleiben pending
      else if (persisted.known[name] !== undefined) known[name] = persisted.known[name];
    }
    persisted.known = known;
    persisted.initialized = true;
    if (result.zoneReset === true) { persisted.known = {}; persisted.initialized = false; persisted.trimmed = {}; }
    persisted.lastSync = isNum(result.lastSync) ? result.lastSync : now();
    saveState();
  }

  // ── Öffentliche Schnittstelle ──

  function start() {
    if (platform !== 'darwin') { setStatus('unsupported'); return false; }
    if (!enabled) { setStatus('disabled'); return false; }
    stopping = false;
    return launch();
  }

  /** Beendet den Helfer sauber (shutdown, EOF); Promise erst nach Exit, nach stopGraceMs notfalls SIGKILL. */
  function stop() {
    stopping = true;
    clearTimeout(debounceTimer); debounceTimer = null;
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(restartTimer); restartTimer = null;
    const owner = child;
    if (!owner) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(killTimer); resolve(); };
      const killTimer = setTimeout(() => { killChild(owner); finish(); }, timing.stopGraceMs);
      killTimer.unref?.();
      owner.once('exit', finish);
      try { owner.stdin.write(`${JSON.stringify({ id: `m${++requestSeq}`, cmd: 'shutdown' })}\n`); } catch (_) { /* Pipe schon zu */ }
      closeInput(owner);
    }).then(() => { if (child === owner) { child = null; ready = false; rejectAll(new Error('Beendet')); } });
  }

  async function setEnabled(value) {
    const next = value === true;
    if (next === enabled) return publicStatus();
    enabled = next;
    if (enabled) { restartCount = 0; start(); }
    else { await stop(); setStatus('disabled'); }
    return publicStatus();
  }

  /** Lokale Änderung gemeldet (Fortschritt, Warteschlange): entprellter Abgleich. */
  function notifyLocalChange() { scheduleSync(); }

  return { start, stop, setEnabled, notifyLocalChange, syncNow: requestSync, getStatus: publicStatus };
}

module.exports = { createICloudSync, progressToRecord, progressFromRecord, signature, PROTOCOL_VERSION, HELPER_EXECUTABLE };
