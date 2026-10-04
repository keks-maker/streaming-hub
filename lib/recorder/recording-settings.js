// Aufnahme-Settings: Defaults, Normalisierung, Clamp (Etappe 1; Konzept §3.6/§3.9)
//
// Reine Logik ohne I/O und ohne Electron — damit sowohl der Main-Prozess
// (Laden/Speichern/IPC) als auch der RecorderService und die Tests dieselben
// Grenzen verwenden. Der Clamp liegt bewusst HIER (Main-Seite) und nicht nur
// in der UI: Kein Weg (gespeicherter Wert, IPC, Altdaten) führt unter das
// Mindest-Reserve-Minimum.
//
// Persistenz-Format (recording-settings.json), rückwärtskompatibel:
//   { storageRoot?, maxParallel?, maxDurationHours?, reserveMB? }
// Altdaten, die nur { storageRoot } enthalten, laden mit Defaults.

'use strict';

const MB = 1024 * 1024;

const DEFAULT_MAX_PARALLEL = 3; // Konzept §4.4
const MIN_MAX_PARALLEL = 1;
const MAX_MAX_PARALLEL = 10;

const DEFAULT_MAX_DURATION_HOURS = 6; // Notbremse pro Aufnahme (Konzept §3.4, L1 Variante C)
const MIN_MAX_DURATION_HOURS = 1;
const MAX_MAX_DURATION_HOURS = 24;

const DEFAULT_RESERVE_MB = 1024; // 1 GB (Konzept §3.9)
const MIN_RESERVE_MB = 512; // Minimum: danach müssen Playlist-Abschluss + Meta schreibbar bleiben
const MAX_RESERVE_MB = 100 * 1024; // 100 GB (Sanity-Obergrenze gegen Tippfehler)

const RESERVE_MIN_WARNING = 'Mindestens 512 MB, sonst kann die Aufnahme nicht sauber beendet werden';

function toFiniteNumber(value) {
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return typeof value === 'number' ? value : NaN;
}

/**
 * Klemmt einen Ganzzahl-Wert auf [min, max]; nicht-numerisch → fallback.
 * Rückgabe { value, clamped } — clamped=true, wenn der Eingabewert geändert wurde
 * (ungültige Eingaben zählen als geändert).
 */
function clampInt(raw, { min, max, fallback }) {
  const n = toFiniteNumber(raw);
  if (!Number.isFinite(n)) return { value: fallback, clamped: raw !== undefined && raw !== null };
  const rounded = Math.floor(n);
  const value = Math.min(max, Math.max(min, rounded));
  return { value, clamped: value !== n };
}

function clampMaxParallel(raw) {
  return clampInt(raw, { min: MIN_MAX_PARALLEL, max: MAX_MAX_PARALLEL, fallback: DEFAULT_MAX_PARALLEL });
}

function clampMaxDurationHours(raw) {
  return clampInt(raw, { min: MIN_MAX_DURATION_HOURS, max: MAX_MAX_DURATION_HOURS, fallback: DEFAULT_MAX_DURATION_HOURS });
}

/**
 * Reserve in MB. Werte unter dem Minimum werden auf das Minimum gesetzt
 * (belowMinimum=true → UI zeigt die Warnung).
 */
function clampReserveMB(raw) {
  const n = toFiniteNumber(raw);
  if (!Number.isFinite(n)) {
    return { value: DEFAULT_RESERVE_MB, clamped: raw !== undefined && raw !== null, belowMinimum: false };
  }
  const floored = Math.floor(n);
  const belowMinimum = floored < MIN_RESERVE_MB;
  const value = Math.min(MAX_RESERVE_MB, Math.max(MIN_RESERVE_MB, floored));
  return { value, clamped: value !== n, belowMinimum };
}

/**
 * Normalisiert gespeicherte/eingehende Settings. Unbekannte Felder werden
 * verworfen, fehlende bekommen Defaults, Zahlen werden geklemmt.
 * Rückgabe: { settings, clamped: { maxParallel, maxDurationHours, reserveMB }, reserveBelowMinimum }
 */
function normalizeRecordingSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const parallel = clampMaxParallel(src.maxParallel);
  const duration = clampMaxDurationHours(src.maxDurationHours);
  const reserve = clampReserveMB(src.reserveMB);
  const settings = {
    maxParallel: parallel.value,
    maxDurationHours: duration.value,
    reserveMB: reserve.value,
  };
  if (typeof src.storageRoot === 'string' && src.storageRoot.trim()) {
    settings.storageRoot = src.storageRoot.trim();
  }
  return {
    settings,
    clamped: {
      maxParallel: parallel.clamped,
      maxDurationHours: duration.clamped,
      reserveMB: reserve.clamped,
    },
    reserveBelowMinimum: reserve.belowMinimum,
  };
}

/**
 * Wendet einen Settings-Patch (aus der UI/IPC) auf die gespeicherten Rohdaten an.
 * Nur bekannte Felder werden übernommen; das Ergebnis ist normalisiert und
 * geklemmt (Reserve-Minimum!). `clamped`/`reserveBelowMinimum` beziehen sich
 * auf die im Patch gelieferten Felder — die UI zeigt damit die Warnung.
 */
function applyRecordingSettingsPatch(raw, patch) {
  const current = normalizeRecordingSettings(raw).settings;
  const src = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = { ...current };
  const patched = {};
  if (src.maxParallel !== undefined) {
    const r = clampMaxParallel(src.maxParallel);
    merged.maxParallel = r.value;
    patched.maxParallel = r.clamped;
  }
  if (src.maxDurationHours !== undefined) {
    const r = clampMaxDurationHours(src.maxDurationHours);
    merged.maxDurationHours = r.value;
    patched.maxDurationHours = r.clamped;
  }
  let reserveBelowMinimum = false;
  if (src.reserveMB !== undefined) {
    const r = clampReserveMB(src.reserveMB);
    merged.reserveMB = r.value;
    patched.reserveMB = r.clamped;
    reserveBelowMinimum = r.belowMinimum;
  }
  return { settings: merged, clamped: patched, reserveBelowMinimum };
}

module.exports = {
  MB,
  DEFAULT_MAX_PARALLEL,
  MIN_MAX_PARALLEL,
  MAX_MAX_PARALLEL,
  DEFAULT_MAX_DURATION_HOURS,
  MIN_MAX_DURATION_HOURS,
  MAX_MAX_DURATION_HOURS,
  DEFAULT_RESERVE_MB,
  MIN_RESERVE_MB,
  MAX_RESERVE_MB,
  RESERVE_MIN_WARNING,
  clampMaxParallel,
  clampMaxDurationHours,
  clampReserveMB,
  normalizeRecordingSettings,
  applyRecordingSettingsPatch,
};
