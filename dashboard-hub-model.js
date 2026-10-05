// LiveTV-Hub (Etappe 3.6b): Statusmodell der beiden Einstiegskarten „Programmübersicht“ und
// „Aufnahmen“. Reine Funktionen ohne DOM und ohne IPC — die Ansicht (dashboard-hub-view.js)
// rendert das Ergebnis ausschließlich per textContent.

'use strict';

const MSG_NO_RECORDINGS = 'Noch keine Aufnahmen';
const MSG_FFMPEG_MISSING = 'ffmpeg fehlt · Aufnehmen nicht möglich';
const MSG_NO_FAVORITES = 'Favorisiere Sender, um die Programmübersicht zu sehen';
const MSG_UNAVAILABLE = 'Status nicht verfügbar';
const MSG_LOADING = 'Status wird geladen …';

/**
 * Zählt für die Aufnahmen-Karte.
 *  - läuft:   recording:list-Einträge mit status 'recording'
 *  - geplant: schedule:list-Einträge mit state 'scheduled' (ein Planungseintrag, der bereits
 *             aufnimmt, steht dann als Aufnahme in „läuft“ und wird nicht doppelt gezählt)
 *  - fertig:  recording:list-Einträge mit status 'completed'
 */
function countRecordings({ schedules, recordings } = {}) {
  const sched = Array.isArray(schedules) ? schedules : [];
  const recs = Array.isArray(recordings) ? recordings : [];
  let running = 0;
  let completed = 0;
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.status === 'recording') running += 1;
    else if (rec.status === 'completed') completed += 1;
  }
  const planned = sched.filter(entry => entry && entry.state === 'scheduled').length;
  return { running, planned, completed, total: recs.length };
}

/**
 * Modell der Aufnahmen-Karte.
 * Eingabe: { loaded, error, ffmpegOk, schedules, recordings }
 *   ffmpegOk === false  → Hinweis (die Karte bleibt klickbar, bestehende Aufnahmen bleiben erreichbar)
 * Ausgabe: { state, status, hint, tone, running, planned, completed, parts }
 *   state: 'loading' | 'unavailable' | 'ffmpeg-missing' | 'empty' | 'active'
 *   tone:  'normal' | 'dim' | 'warn'
 *   parts: [{ kind: 'running' | 'planned' | 'done', count, text }] (nur Zähler > 0)
 */
function recordingsCardModel(input = {}) {
  const counts = countRecordings(input);
  const base = { running: counts.running, planned: counts.planned, completed: counts.completed, parts: [] };
  if (input.ffmpegOk === false) {
    return {
      ...base,
      state: 'ffmpeg-missing',
      status: MSG_FFMPEG_MISSING,
      hint: 'Bestehende Aufnahmen bleiben erreichbar',
      tone: 'warn',
    };
  }
  if (input.error) {
    return { ...base, state: 'unavailable', status: MSG_UNAVAILABLE, hint: 'Klick öffnet den Aufnahmen-Bereich', tone: 'dim' };
  }
  if (!input.loaded) {
    return { ...base, state: 'loading', status: MSG_LOADING, hint: 'Geplant, laufend und fertig an einem Ort', tone: 'dim' };
  }
  const parts = [];
  if (counts.running > 0) parts.push({ kind: 'running', count: counts.running, text: `${counts.running} läuft` });
  if (counts.planned > 0) parts.push({ kind: 'planned', count: counts.planned, text: `${counts.planned} geplant` });
  if (counts.completed > 0) parts.push({ kind: 'done', count: counts.completed, text: `${counts.completed} fertig` });
  if (parts.length) {
    return {
      ...base,
      parts,
      state: 'active',
      status: parts.map(p => p.text).join(' · '),
      hint: 'Geplant, laufend und fertig an einem Ort',
      tone: 'normal',
    };
  }
  if (counts.total > 0) {
    // Nur beendete/fehlgeschlagene Einträge: weder „läuft“ noch „geplant“ noch „fertig“
    return {
      ...base,
      state: 'active',
      status: counts.total === 1 ? '1 Aufnahme' : `${counts.total} Aufnahmen`,
      hint: 'Geplant, laufend und fertig an einem Ort',
      tone: 'normal',
    };
  }
  return { ...base, state: 'empty', status: MSG_NO_RECORDINGS, hint: 'Plane Aufnahmen in der Programmübersicht', tone: 'dim' };
}

/**
 * Modell der Programmübersicht-Karte (keine Senderliste, nur eine Statuszeile).
 * Eingabe: { favoriteCount, epgStatus } mit epgStatus aus dem Renderer
 *   ('success' | 'loading' | 'idle' | 'error' | 'unavailable').
 * Ausgabe: { state: 'no-favorites' | 'ready', status, hint, tone }
 */
function epgCardModel({ favoriteCount, epgStatus } = {}) {
  const favorites = Number.isFinite(favoriteCount) && favoriteCount > 0 ? Math.floor(favoriteCount) : 0;
  if (favorites === 0) {
    return {
      state: 'no-favorites',
      status: MSG_NO_FAVORITES,
      hint: 'Im Programmführer lassen sich alle Sender anzeigen',
      tone: 'warn',
    };
  }
  const favText = favorites === 1 ? '1 Favorit' : `${favorites} Favoriten`;
  let status = favText;
  if (epgStatus === 'success') status = `EPG aktuell · ${favText}`;
  else if (epgStatus === 'loading' || epgStatus === 'idle') status = `EPG wird geladen · ${favText}`;
  return { state: 'ready', status, hint: 'Sendungen suchen, filtern und Aufnahmen planen', tone: 'normal' };
}

module.exports = {
  MSG_NO_RECORDINGS,
  MSG_FFMPEG_MISSING,
  MSG_NO_FAVORITES,
  countRecordings,
  recordingsCardModel,
  epgCardModel,
};
