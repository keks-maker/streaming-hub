'use strict';

// Weiterschauen-Regeln für Mediathek-Wiedergabe (Port von ResumeLogic in Models.swift; gleiche Schwellen wie tvOS/iPad).

/** Ab diesem Anteil gilt ein Beitrag als gesehen (Position wird zurückgesetzt). */
const WATCHED_FRACTION = 0.95;
/** Unter dieser Position (Sekunden) lohnt kein Fortsetzen. */
const MINIMUM_POSITION = 15;
/** Kleiner Rücksprung (Sekunden) beim Fortsetzen. */
const REWIND = 5;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Fortschritt 0..1 für den Balken; null ohne Position/Dauer. */
function progressFraction(entry) {
  const position = entry && entry.positionSeconds;
  const duration = entry && entry.durationSeconds;
  if (!finite(position) || !finite(duration) || duration <= 0 || position <= 0) return null;
  return Math.min(1, position / duration);
}

/** Gehört der Verlaufseintrag in die Weiterschauen-Reihe? Nur begonnene, nicht beendete Beiträge mit Adresse. */
function isResumable(entry) {
  if (!entry || !entry.url) return false;
  const fraction = progressFraction(entry);
  return fraction !== null && fraction < WATCHED_FRACTION;
}

/** Schlüssel, unter dem die Reihe dedupliziert wird: die Serie (alle Folgen zusammen) bzw. Quelle + Titel. */
function shelfKey(entry) {
  if (entry.series) return `series:${entry.series.sourceId}:${entry.series.id}`;
  const sourceId = entry.sourceId || String(entry.serviceKey || '').replace(/^mediathek:/, '');
  return `title:${sourceId}:${entry.title}`;
}

/** Zu speichernde Position: null bei Dauer unbekannt/ungültig, kaum begonnen oder (fast) fertig. */
function storedPosition(position, duration) {
  if (!finite(position) || !finite(duration) || duration <= 0 || position < MINIMUM_POSITION) return null;
  return position / duration >= WATCHED_FRACTION ? null : position;
}

/** Startposition beim erneuten Abspielen; null = von vorn. */
function resumeStart(position, duration) {
  if (!finite(position) || position < MINIMUM_POSITION) return null;
  if (finite(duration) && duration > 0 && position / duration >= WATCHED_FRACTION) return null;
  return Math.max(0, position - REWIND);
}

module.exports = { WATCHED_FRACTION, MINIMUM_POSITION, REWIND, progressFraction, isResumable, shelfKey, storedPosition, resumeStart };
