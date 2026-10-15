// Podcast-Oberfläche (P3): kleine reine Hilfsfunktionen für Texte und Zahlen (Dauer, Datum, Fortschritt). Kein DOM, kein IPC.

'use strict';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Dauer in Sekunden als "45 Min.", "1 Std. 05 Min." bzw. "30 Sek."; ungültig oder 0 → ''. */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  if (total < 60) return `${total} Sek.`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (!hours) return `${minutes} Min.`;
  return `${hours} Std. ${String(minutes).padStart(2, '0')} Min.`;
}

function dayStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Veröffentlichungsdatum: "Heute", "Gestern", "vor n Tagen" (bis 6 Tage), sonst "12.10.2026"; ungültig → ''. */
function formatEpisodeDate(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const days = Math.round((dayStart(now) - dayStart(time)) / DAY);
  if (days === 0) return 'Heute';
  if (days === 1) return 'Gestern';
  if (days > 1 && days < 7) return `vor ${days} Tagen`;
  const date = new Date(time);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** "gerade eben", "vor 3 Min.", "vor 2 Std.", "vor 4 Tagen"; ohne Zeit → "noch nie". */
function formatAgo(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'noch nie';
  const diff = Math.max(0, now - time);
  if (diff < MINUTE) return 'gerade eben';
  if (diff < HOUR) return `vor ${Math.floor(diff / MINUTE)} Min.`;
  if (diff < DAY) return `vor ${Math.floor(diff / HOUR)} Std.`;
  const days = Math.floor(diff / DAY);
  return `vor ${days} ${days === 1 ? 'Tag' : 'Tagen'}`;
}

/** Kapitelzeit: "3:05" bzw. "1:02:03"; ungültig → "0:00". */
function formatChapterTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Anteil 0..1 (auf 1 % gerundet), ungültig → 0. */
function clampFraction(position, duration) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position <= 0 || duration <= 0) return 0;
  return Math.round(Math.min(1, position / duration) * 100) / 100;
}

/** Anfangsbuchstabe für den Cover-Platzhalter. */
function initialOf(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
}

/** Anzahl mit Einzahl/Mehrzahl: plural(2, 'Abo', 'Abos') → "2 Abos". */
function plural(count, one, many) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${n} ${n === 1 ? one : many}`;
}

/** Cover-Art: 'https' (direkt ladbar), 'http' (über den Main), sonst null (Platzhalter). Keine Zugangsdaten. */
function coverKind(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'https:') return 'https';
    if (parsed.protocol === 'http:') return 'http';
  } catch {
    /* ungültige URL → Platzhalter */
  }
  return null;
}

module.exports = { formatChapterTime, formatDuration, formatEpisodeDate, formatAgo, clampFraction, initialOf, plural, coverKind, DAY };
