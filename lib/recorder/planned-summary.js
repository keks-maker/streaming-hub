// Gemeinsame, reine Hilfen für „anstehende Planungen“ (Etappe 2b; Konzept §3.5):
// Auswahl der nächsten Planung(en) und die Kurz-Beschriftung („Das Erste —
// Tagesschau, heute 20:15“). Genutzt vom Beenden-Dialog (quit-guard.js) und vom
// Tray-Menü (tray-menu-model.js).
//
// Sender und Titel sind Fremdtext (EPG): für native Oberflächen bereinigt
// (Steuerzeichen raus, Länge gekürzt, surrogatsicher; sanitizeLabel).
// Keine Electron-/I/O-Abhängigkeit; „jetzt“ wird hereingereicht. Uhrzeiten und
// „heute/morgen“ in lokaler Zeit des Rechners.

'use strict';

const { parseIsoWithOffset } = require('./schedule-logic.js');
const { sanitizeLabel } = require('./schedule-ui-model.js');

const HOUR_MS = 60 * 60 * 1000;
const PLAN_HORIZON_MS = 24 * HOUR_MS;
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const CHANNEL_MAX = 40;
const TITLE_MAX = 60;

/**
 * Anstehende Planungen: state `scheduled`, Sendungsende liegt noch in der Zukunft
 * (abgesagte/erledigte/verpasste/fehlgeschlagene und laufende Einträge zählen
 * nicht). Nach Sendungsbeginn sortiert.
 */
function pendingPlans(entries, nowMs) {
  return (entries || [])
    .filter(e => e && e.state === 'scheduled')
    .map(entry => ({ entry, startMs: parseIsoWithOffset(entry.epgStart), stopMs: parseIsoWithOffset(entry.epgStop) }))
    .filter(x => Number.isFinite(x.startMs) && Number.isFinite(x.stopMs) && x.stopMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs || a.stopMs - b.stopMs);
}

/**
 * Planungen, deren Sendungsbeginn in den nächsten `horizonMs` liegt (Grenze
 * inklusiv: genau jetzt + 24 h zählt noch). Bereits begonnene, noch nicht
 * gestartete Planungen (Ende in der Zukunft) zählen mit.
 */
function plansWithinHorizon(entries, nowMs, horizonMs = PLAN_HORIZON_MS) {
  return pendingPlans(entries, nowMs).filter(x => x.startMs <= nowMs + horizonMs);
}

function localDayNumber(ms) {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (24 * HOUR_MS));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** „heute 20:15“, „morgen 06:00“, sonst „Mo 05.10. 20:15“ (lokale Zeit). */
function formatPlannedTime(startMs, nowMs) {
  const d = new Date(startMs);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const diff = localDayNumber(startMs) - localDayNumber(nowMs);
  if (diff === 0) return `heute ${clock}`;
  if (diff === 1) return `morgen ${clock}`;
  return `${WEEKDAYS[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}. ${clock}`;
}

/** „Das Erste — Tagesschau“ (bereinigt, gekürzt). */
function plannedName(entry) {
  const channel = sanitizeLabel(entry.channelName || entry.channelId || 'Sender', CHANNEL_MAX) || 'Sender';
  const title = sanitizeLabel(entry.title, TITLE_MAX);
  return title ? `${channel} — ${title}` : channel;
}

module.exports = {
  PLAN_HORIZON_MS,
  pendingPlans,
  plansWithinHorizon,
  formatPlannedTime,
  plannedName,
};
