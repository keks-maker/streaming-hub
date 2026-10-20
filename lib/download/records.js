'use strict';

// Datensatz eines Downloads (downloads.json): Normalisierung gespeicherter Daten, Duplikatschlüssel, Ansicht für den Renderer.
// Rein; gespeicherte Daten gelten als nicht vertrauenswürdig (Pfade bleiben im Main, Zustände werden geprüft).

const path = require('node:path');
const { normalizeOverrides } = require('./download-settings.js');

const STATUSES = ['queued', 'resolving', 'downloading', 'paused', 'scheduled', 'done', 'failed', 'canceled'];
const RUNNING = ['resolving', 'downloading'];
/** Zustände, die eine Folge "belegen" (Duplikaterkennung): fehlgeschlagene/abgebrochene dürfen erneut angelegt werden. */
const OCCUPYING = ['queued', 'resolving', 'downloading', 'paused', 'scheduled', 'done'];
const FILE_EXTENSIONS = ['.mp4', '.mkv', '.srt', '.nfo', '.jpg', '.png'];
const ID_PATTERN = /^dl_[A-Za-z0-9_-]{4,60}$/;

const str = (value, max = 2000) => (typeof value === 'string' && value.length <= max ? value : null);
const int = value => (Number.isInteger(value) && value >= 0 && value < 1e6 ? value : null);
const num = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const iso = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);

/** Felder der Folge, die der Download braucht (frisch aufgelöst wird die Stream-Adresse, nie gespeichert). */
function minimalEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return {
    id: str(e.id, 500),
    title: str(e.title) || '',
    subtitle: str(e.subtitle),
    description: str(e.description, 4000),
    imageUrl: str(e.imageUrl),
    duration: num(e.duration),
    sourceId: str(e.sourceId, 20),
    airedAt: iso(e.airedAt),
    partner: str(e.partner, 60),
    season: int(e.season),
    episode: int(e.episode),
    originalVersionId: str(e.originalVersionId, 500),
    audioDescriptionId: str(e.audioDescriptionId, 500),
    availableUntil: iso(e.availableUntil),
  };
}

function minimalSeries(series) {
  if (!series || typeof series !== 'object') return null;
  const id = str(series.id, 500);
  const groupingURL = str(series.groupingURL);
  const sourceId = str(series.sourceId, 20);
  if (!id || !groupingURL || !sourceId) return null;
  return { id, title: str(series.title) || '', imageUrl: str(series.imageUrl), description: str(series.description, 4000), sourceId, groupingURL };
}

/** Schlüssel einer Folge: "<quelle>:<id>". */
const keyOf = (sourceId, entryId) => `${sourceId}:${entryId}`;

/** Alle Schlüssel, unter denen dieselbe Folge geführt wird (OV- und AD-Variante zählen als dieselbe Folge). */
function aliasKeys(entry) {
  const keys = [keyOf(entry.sourceId, entry.id)];
  for (const id of [entry.originalVersionId, entry.audioDescriptionId]) if (id) keys.push(keyOf(entry.sourceId, id));
  return keys;
}

function normalizeTarget(raw, root) {
  if (!raw || typeof raw !== 'object') return null;
  const file = str(raw.file, 1500);
  const dir = str(raw.dir, 1500);
  const base = str(raw.base, 300);
  const ext = str(raw.ext, 8);
  if (!file || !dir || !base || !['mp4', 'mkv'].includes(ext) || !path.isAbsolute(file)) return null;
  if (root && !isInside(root, file)) return null;
  return { dir, base, ext, file, partFile: `${file}.part` };
}

/** true, wenn file strikt unter dir liegt. */
function isInside(dir, file) {
  if (typeof dir !== 'string' || typeof file !== 'string') return false;
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Datei, die der Dienst anfassen darf: unter dem Speicherort des Datensatzes, mit bekannter Endung. */
function isManagedFile(record, file) {
  return Boolean(record.root) && typeof file === 'string' && FILE_EXTENSIONS.includes(path.extname(file).toLowerCase()) && isInside(record.root, file);
}

/** Normalisiert einen gespeicherten Datensatz; null = unbrauchbar. */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || !ID_PATTERN.test(String(raw.id))) return null;
  const entry = minimalEntry(raw.entry);
  if (!entry.id || !entry.sourceId || !['ard', 'zdf', 'arte'].includes(entry.sourceId)) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : 'failed';
  const root = str(raw.root, 1500) && path.isAbsolute(raw.root) ? raw.root : null;
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  const file = str(raw.file, 1500);
  const options = normalizeOverrides(raw.options);
  return {
    id: raw.id,
    seq: int(raw.seq) ?? 0,
    key: keyOf(entry.sourceId, entry.id),
    aliases: aliasKeys(entry),
    entry,
    series: minimalSeries(raw.series),
    batchId: str(raw.batchId, 60),
    options,
    status,
    error: str(raw.error, 500),
    errorCode: str(raw.errorCode, 40),
    progress: { percent: num(progress.percent), bytes: num(progress.bytes), totalBytes: num(progress.totalBytes), speed: num(progress.speed), etaSec: num(progress.etaSec) },
    estimatedBytes: num(raw.estimatedBytes),
    title: str(raw.title) || entry.title,
    seriesTitle: str(raw.seriesTitle),
    season: int(raw.season),
    episode: int(raw.episode),
    broadcastDate: str(raw.broadcastDate, 12),
    durationSec: num(raw.durationSec),
    availableUntil: iso(raw.availableUntil),
    retryAt: iso(raw.retryAt),
    ageRetries: int(raw.ageRetries) ?? 0,
    reresolved: raw.reresolved === true,
    root,
    target: normalizeTarget(raw.target, root),
    file: file && root && isInside(root, file) && FILE_EXTENSIONS.includes(path.extname(file).toLowerCase()) ? file : null,
    fileSize: num(raw.fileSize),
    sidecars: Array.isArray(raw.sidecars) ? raw.sidecars.filter(item => typeof item === 'string' && root && isInside(root, item)).slice(0, 20) : [],
    http: raw.http && typeof raw.http === 'object' ? { etag: str(raw.http.etag, 200), total: num(raw.http.total) } : { etag: null, total: null },
    createdAt: iso(raw.createdAt) || new Date(0).toISOString(),
    startedAt: iso(raw.startedAt),
    finishedAt: iso(raw.finishedAt),
    watchedAt: iso(raw.watchedAt),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(item => typeof item === 'string').slice(0, 10) : [],
  };
}

/** Ansicht für den Renderer: keine Pfade, keine Adressen. */
function toView(record, { nowMs = Date.now(), fileMissing = false } = {}) {
  const until = record.availableUntil ? Date.parse(record.availableUntil) : null;
  return {
    id: record.id,
    key: record.key,
    sourceId: record.entry.sourceId,
    entryId: record.entry.id,
    title: record.title,
    seriesTitle: record.seriesTitle,
    seriesId: record.series ? record.series.id : null,
    season: record.season,
    episode: record.episode,
    imageUrl: record.entry.imageUrl,
    status: record.status,
    error: record.error,
    errorCode: record.errorCode,
    progress: record.progress,
    estimatedBytes: record.estimatedBytes,
    fileSize: record.fileSize,
    durationSec: record.durationSec,
    availableUntil: record.availableUntil,
    sourceExpired: until !== null && until < nowMs,
    retryAt: record.retryAt,
    container: record.options.container || null,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
    watchedAt: record.watchedAt,
    fileMissing,
    warnings: record.warnings,
  };
}

module.exports = { STATUSES, RUNNING, OCCUPYING, FILE_EXTENSIONS, ID_PATTERN, minimalEntry, minimalSeries, keyOf, aliasKeys, isInside, isManagedFile, normalizeRecord, toView };
