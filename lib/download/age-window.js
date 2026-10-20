'use strict';

// Zurückstellung bei Altersfreigabe (JMStV): Wann öffnet das Abrufzeitfenster einer FSK-Stufe wieder? Rein, mit Berliner Ortszeit
// (Intl, Sommer-/Winterzeit). Fenster: FSK 12 ab 20 Uhr, FSK 16 ab 22 Uhr, FSK 18 ab 23 Uhr, jeweils bis 6 Uhr (restrictions.js).

const { berlinLocalToIso } = require('../mediathek/download-info.js');

const WINDOW_START_HOUR = { 12: 20, 16: 22, 18: 23 };
const WINDOW_END_HOUR = 6;
const REPEAT_MS = 15 * 60 * 1000; // Fenster offen, Beitrag aber weiter gesperrt: später erneut prüfen
const MIN_LEAD_MS = 60 * 1000;

function berlinParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms));
  const get = type => Number(parts.find(part => part.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

/** Beginn des Fensters der Altersstufe als Stunde (Berliner Ortszeit); null bei unbekannter Stufe. */
function windowStartHour(rating) {
  const digits = Number(String(rating || '').replace(/\D/g, ''));
  return WINDOW_START_HOUR[digits] || null;
}

/**
 * Nächster Zeitpunkt (ISO), an dem ein Wiederholversuch sinnvoll ist. providedAt (z. B. arte timeSlot.startDate) gilt, wenn er in
 * der Zukunft liegt. Ohne bekannte Stufe wird in 30 Minuten erneut geprüft.
 */
function nextAttemptAt(rating, nowMs, providedAt = null) {
  const provided = providedAt ? Date.parse(providedAt) : NaN;
  if (Number.isFinite(provided) && provided > nowMs + MIN_LEAD_MS) return new Date(provided).toISOString();
  const start = windowStartHour(rating);
  if (!start) return new Date(nowMs + 2 * REPEAT_MS).toISOString();
  const now = berlinParts(nowMs);
  const inWindow = now.hour >= start || now.hour < WINDOW_END_HOUR;
  if (inWindow) return new Date(nowMs + REPEAT_MS).toISOString();
  return berlinLocalToIso(now.day, now.month, now.year, start, 0);
}

module.exports = { windowStartHour, nextAttemptAt, WINDOW_END_HOUR };
