// ScheduleStore: Persistenz der geplanten Aufnahmen (Etappe 2a; Konzept §3.3)
//
// userData/schedules.json (Verzeichnis injizierbar), atomares Schreiben
// (tmp + rename). Persistenz ist bewusst GETRENNT von den *.recording.json der
// Aufnahmen; die Verknüpfung läuft über `recId`. Zeiten sind ISO-Strings mit
// Offset (Sommerzeitwechsel), verglichen wird in ms (schedule-logic.js).
//
// Korrupte Datei: wird als schedules.json.corrupt-<ts> gesichert, der Store
// startet leer und loggt — die App bleibt startbar. Einzelne ungültige Einträge
// werden verworfen, gültige bleiben erhalten.
//
// SRP: Datenhaltung. Zeitlogik/Start/Stopp: Scheduler.js.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseIsoWithOffset } = require('./schedule-logic.js');

const FILE_NAME = 'schedules.json';
const STORE_VERSION = 1;
const STATES = ['scheduled', 'recording', 'done', 'missed', 'cancelled', 'failed'];
const FINAL_STATES = ['done', 'missed', 'cancelled', 'failed'];
const SCHEDULE_ID_PATTERN = /^sch_[A-Za-z0-9._-]+$/;
const RETAIN_FINAL_MS = 14 * 24 * 3600 * 1000; // abgeschlossene Einträge 14 Tage sichtbar halten
const MAX_FINAL_ENTRIES = 200;

function makeScheduleId() {
  return `sch_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Normalisiert einen gespeicherten Eintrag. Ungültig (Pflichtfelder/Zeiten) → null.
 */
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !SCHEDULE_ID_PATTERN.test(raw.id)) return null;
  const startMs = parseIsoWithOffset(raw.epgStart);
  const stopMs = parseIsoWithOffset(raw.epgStop);
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) return null;
  if (!STATES.includes(raw.state)) return null;
  const channelId = str(raw.channelId, 200);
  const channelName = str(raw.channelName, 200);
  if (!channelId && !channelName) return null;
  const sec = v => (Number.isInteger(v) && v >= 0 && v <= 1800 ? v : 0);
  return {
    id: raw.id,
    channelId,
    channelName,
    tvgId: str(raw.tvgId, 200),
    sourceId: str(raw.sourceId, 200),
    sourceUrlSnapshot: str(raw.sourceUrlSnapshot, 4096),
    title: str(raw.title, 300) || 'Aufnahme',
    description: str(raw.description, 2000),
    epgStart: raw.epgStart,
    epgStop: raw.epgStop,
    bufferBeforeSec: sec(raw.bufferBeforeSec),
    bufferAfterSec: sec(raw.bufferAfterSec),
    state: raw.state,
    recId: typeof raw.recId === 'string' && /^rec_[A-Za-z0-9._-]+$/.test(raw.recId) ? raw.recId : null,
    allowOverLimit: raw.allowOverLimit === true,
    // zwei Sendungen zu einer Aufnahme zusammengelegt (Titel „A + B“): vom Schedule-Slip ausgenommen
    merged: raw.merged === true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    lastSlipCheck: typeof raw.lastSlipCheck === 'string' ? raw.lastSlipCheck : null,
    note: typeof raw.note === 'string' && raw.note ? raw.note.slice(0, 500) : null,
  };
}

function createScheduleStore({ dir, logger = null, now = () => Date.now(), fileName = FILE_NAME } = {}) {
  if (!dir) throw new Error('ScheduleStore benötigt dir (userData)');
  const file = path.join(dir, fileName);
  let entries = [];

  function log(level, message) {
    if (logger && typeof logger[level] === 'function') logger[level](`[schedule] ${message}`);
  }

  function writeAtomic() {
    const payload = JSON.stringify({ version: STORE_VERSION, entries }, null, 1);
    const tmp = `${file}.${process.pid}.${now()}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(tmp, payload, 'utf-8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (_) {
        // tmp nicht entfernbar — kein Folgeproblem
      }
      throw e;
    }
  }

  function backupCorrupt(reason) {
    const backup = `${file}.corrupt-${now()}`;
    try {
      fs.renameSync(file, backup);
      log('error', `schedules.json ist defekt (${reason}) — gesichert als ${path.basename(backup)}, Planung startet leer`);
    } catch (e) {
      log('error', `schedules.json ist defekt (${reason}) und konnte nicht gesichert werden: ${e.message}`);
    }
  }

  /**
   * Lädt die Datei neu (Neustart-Simulation: neue Store-Instanz + load()).
   * Rückgabe: Anzahl gültiger Einträge. Wirft nie.
   */
  function load() {
    entries = [];
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') log('warn', `schedules.json nicht lesbar: ${e.message}`);
      return 0;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      backupCorrupt(e.message);
      return 0;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      backupCorrupt('unbekanntes Format');
      return 0;
    }
    let dropped = 0;
    const seen = new Set();
    for (const rawEntry of parsed.entries) {
      const entry = sanitizeEntry(rawEntry);
      if (!entry || seen.has(entry.id)) {
        dropped += 1;
        continue;
      }
      seen.add(entry.id);
      entries.push(entry);
    }
    if (dropped) log('warn', `${dropped} ungültige(r) Eintrag/Einträge in schedules.json verworfen`);
    return entries.length;
  }

  function list() {
    return entries.map(e => ({ ...e }));
  }

  function get(id) {
    const e = entries.find(x => x.id === id);
    return e ? { ...e } : null;
  }

  /** Fügt einen (bereits validierten) Eintrag hinzu und speichert. */
  function add(input) {
    const entry = sanitizeEntry({
      ...input,
      id: input.id || makeScheduleId(),
      state: input.state || 'scheduled',
      createdAt: input.createdAt || new Date(now()).toISOString(),
    });
    if (!entry) throw new Error('Ungültiger Planungseintrag');
    if (entries.some(e => e.id === entry.id)) throw new Error('Planungseintrag existiert bereits');
    entries.push(entry);
    try {
      writeAtomic();
    } catch (e) {
      entries.pop();
      throw new Error(`Planung konnte nicht gespeichert werden: ${e.message}`);
    }
    return { ...entry };
  }

  /** Aktualisiert Felder eines Eintrags (Patch) und speichert. null, wenn unbekannt. */
  function update(id, patch) {
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) return null;
    const previous = entries[idx];
    const next = sanitizeEntry({ ...previous, ...patch, id: previous.id });
    if (!next) throw new Error('Ungültige Änderung am Planungseintrag');
    entries[idx] = next;
    try {
      writeAtomic();
    } catch (e) {
      entries[idx] = previous;
      throw new Error(`Planung konnte nicht gespeichert werden: ${e.message}`);
    }
    return { ...next };
  }

  /** Entfernt einen Eintrag endgültig. Rückgabe: true, wenn vorhanden. */
  function remove(id) {
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    const [removed] = entries.splice(idx, 1);
    try {
      writeAtomic();
    } catch (e) {
      entries.splice(idx, 0, removed);
      throw new Error(`Planung konnte nicht gespeichert werden: ${e.message}`);
    }
    return true;
  }

  /**
   * Räumt alte abgeschlossene Einträge weg (älter als 14 Tage nach Sendungsende,
   * zusätzlich Obergrenze 200). Aktive Einträge bleiben immer. Rückgabe: Anzahl.
   */
  function prune() {
    const cutoff = now() - RETAIN_FINAL_MS;
    const finals = entries
      .filter(e => FINAL_STATES.includes(e.state))
      .sort((a, b) => parseIsoWithOffset(b.epgStop) - parseIsoWithOffset(a.epgStop));
    const drop = new Set();
    finals.forEach((e, i) => {
      if (parseIsoWithOffset(e.epgStop) < cutoff || i >= MAX_FINAL_ENTRIES) drop.add(e.id);
    });
    if (!drop.size) return 0;
    const before = entries;
    entries = entries.filter(e => !drop.has(e.id));
    try {
      writeAtomic();
    } catch (e) {
      entries = before;
      log('warn', `Aufräumen nicht gespeichert: ${e.message}`);
      return 0;
    }
    return drop.size;
  }

  return { load, list, get, add, update, remove, prune, file };
}

module.exports = {
  createScheduleStore,
  makeScheduleId,
  sanitizeEntry,
  STATES,
  FINAL_STATES,
  SCHEDULE_ID_PATTERN,
  FILE_NAME,
};
