// v0.5.8 – Metadaten-Schema + Dateinamen (Aufnahme Phase 1b, Karte t_17ee2ca5)
//
// Einheitliches Metadaten-Schema exakt nach Konzept §5 (Status-Maschine:
// recording | remux-pending | completed | failed | aborted) und das
// Dateinamen-Schema `<Kanal>_<Sendungstitel>_<YYYY-MM-DD_HHMM>.mp4`
// mit Kollisions-Suffix -2/-3 (Konzept §5).

'use strict';

const RECORDING_STATUSES = ['recording', 'remux-pending', 'completed', 'failed', 'aborted'];

const PROGRESS_PHASE_IDLE = 'idle';
const PROGRESS_PHASE_RECORDING = 'recording';
const PROGRESS_PHASE_STOPPING = 'stopping';
const PROGRESS_PHASE_REMUXING = 'remuxing';
const PROGRESS_PHASE_DONE = 'done';

function makeRecordingId(now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const suffix = now.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  return `rec_${stamp}_${suffix}`;
}

/**
 * Normiert eine Metadaten-Struktur auf das Konzept-§5-Schema.
 * Unbekannte Status werden zu 'failed' (konservativ: Remux-Retry-Pfad
 * bleibt über die reine Meta-Datei-Prüfung abgedeckt).
 */
function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('Ungültige Aufnahme-Metadaten');
  }
  if (typeof meta.id !== 'string' || !/^rec_[A-Za-z0-9._-]+$/.test(meta.id)) {
    throw new Error('Ungültige Aufnahme-ID');
  }
  const normalized = {
    id: meta.id,
    channelId: typeof meta.channelId === 'string' ? meta.channelId : null,
    channelName: typeof meta.channelName === 'string' && meta.channelName.trim() ? meta.channelName.trim() : 'Unbekannter Kanal',
    epgTitle: typeof meta.epgTitle === 'string' ? meta.epgTitle : null,
    epgDescription: typeof meta.epgDescription === 'string' ? meta.epgDescription : null,
    startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : null,
    stoppedAt: typeof meta.stoppedAt === 'string' ? meta.stoppedAt : null,
    durationSec: Number.isFinite(meta.durationSec) ? meta.durationSec : null,
    fileSizeBytes: Number.isSafeInteger(meta.fileSizeBytes) ? meta.fileSizeBytes : null,
    sourceUrl: typeof meta.sourceUrl === 'string' ? meta.sourceUrl : null,
    status: RECORDING_STATUSES.includes(meta.status) ? meta.status : 'failed',
    // Pfad der fertigen MP4 (setzt der Remux; Konzept §5 ergänzend, damit der
    // Renderer ohne Pfad-Rekonstruktion wiedergeben kann)
    outputFile: typeof meta.outputFile === 'string' ? meta.outputFile : null,
    // Letzter Fehler (failed/Remux-Retry-Diagnostik)
    lastError: typeof meta.lastError === 'string' ? meta.lastError : null,
    // Prozess-Management: Remux-Prozess wurde hart beendet (App-Shutdown) —
    // Zwischenstände bleiben, Remux beim nächsten Start nachholen.
    remuxInterrupted: meta.remuxInterrupted === true,
  };
  return normalized;
}

/**
 * Status-Übergänge der State-Maschine (Konzept §5).
 */
function assertTransition(from, to) {
  const allowed = {
    recording: ['remux-pending', 'failed', 'aborted'],
    'remux-pending': ['completed', 'failed'],
    completed: [],
    failed: ['completed'], // nachholender Remux (Recovery beim App-Start)
    aborted: [],
  };
  if (!allowed[from] || !allowed[from].includes(to)) {
    throw new Error(`Ungültiger Status-Übergang: ${from} → ${to}`);
  }
  return true;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * Sichere Dateinamen-Komponente: Steuerzeichen/Slashes raus, anonisierte
 * Klartext-Form für die User-sichtbaren Dateinamen (Konzept §5).
 */
function safeNamePart(value) {
  const cleaned = String(value || '')
    // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Unbenannt';
}

/**
 * Dateinamen-Schema `<Kanal>_<Sendungstitel>_<YYYY-MM-DD_HHMM>.mp4` aus den
 * Metadaten. startedAt liefert den Zeitstempel (ohne → now).
 */
function buildRecordingFilename(meta, now = new Date()) {
  const channel = safeNamePart(meta.channelName);
  const title = safeNamePart(meta.epgTitle || 'Aufnahme');
  let start = now;
  if (meta.startedAt) {
    const parsed = new Date(meta.startedAt);
    if (!Number.isNaN(parsed.getTime())) start = parsed;
  }
  const stamp = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}_${pad2(start.getHours())}${pad2(start.getMinutes())}`;
  return `${channel}_${title}_${stamp}.mp4`;
}

/**
 * Kollisions-Suffix -2/-3 (Konzept §5): hängt „-2", „-3", … vor die
 * Extension. Suffix 1 (= Basisname ohne Suffix) wird erwartet.
 */
function withCollisionSuffix(filename, n) {
  if (!Number.isInteger(n) || n < 2) throw new Error('Kollisions-Suffix beginnt bei -2');
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  return `${stem}-${n}${ext}`;
}

module.exports = {
  RECORDING_STATUSES,
  PROGRESS_PHASE_IDLE,
  PROGRESS_PHASE_RECORDING,
  PROGRESS_PHASE_STOPPING,
  PROGRESS_PHASE_REMUXING,
  PROGRESS_PHASE_DONE,
  makeRecordingId,
  normalizeMeta,
  assertTransition,
  safeNamePart,
  buildRecordingFilename,
  withCollisionSuffix,
};
