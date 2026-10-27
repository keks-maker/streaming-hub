// YouTube-Mini-Player: Zustandsmodell der Stufen. Reine Funktionen ohne DOM und IPC; der Controller
// (youtube-mini-controller.js) setzt die Ergebnisse in Webview-Platzierung und Leiste um.
//
// Stufen (klein → groß):
//  idle        kein Video geladen
//  mini        Video läuft klein in der Leiste, in YouTube wird weitergestöbert
//  page        Video auf seiner YouTube-Seite (Beschreibung, Kommentare) im Inhaltsbereich
//  app         nur das Video im ganzen App-Fenster, Steuerung von YouTube bei Mausbewegung
//  fullscreen  Vollbild über den ganzen Bildschirm
// `back` merkt sich die Stufen, aus denen app/fullscreen betreten wurden: Esc geht eine Stufe zurück dorthin.

'use strict';

const STAGES = Object.freeze(['idle', 'mini', 'page', 'app', 'fullscreen']);
const STATUSES = Object.freeze(['loading', 'playing', 'paused', 'ended']);

function initialState() {
  return { stage: 'idle', back: [], videoId: '', status: 'idle' };
}

function isActive(state) {
  return state.stage !== 'idle';
}

/** Läuft das Video (oder lädt es gerade)? Nur dann wird es beim Wegnavigieren klein statt verworfen. */
function isPlaying(state) {
  return state.status === 'playing' || state.status === 'loading';
}

const lastOf = list => (list.length ? list[list.length - 1] : '');

/** Neues Video: ersetzt ein laufendes. stage 'page' (Standard) oder 'mini' (aus der Playlist gestartet). */
function openVideo(state, { videoId, stage = 'page' } = {}) {
  if (typeof videoId !== 'string' || !videoId) return state;
  // Läuft bereits app-füllend/Vollbild und folgt ein Video aus der Playlist, bleibt die Stufe erhalten
  const keep = state.stage === 'app' || state.stage === 'fullscreen';
  return { stage: keep ? state.stage : stage === 'mini' ? 'mini' : 'page', back: keep ? state.back : [], videoId, status: 'loading' };
}

function setStatus(state, status) {
  if (!isActive(state) || !STATUSES.includes(status) || state.status === status) return state;
  return { ...state, status };
}

/** Kennung des Videos nachführen (Wechsel innerhalb der Wiedergabeseite, z. B. Klick auf ein Vorschlagsvideo). */
function setVideoId(state, videoId) {
  if (!isActive(state) || typeof videoId !== 'string' || !videoId || state.videoId === videoId) return state;
  return { ...state, videoId };
}

/** Manuell klein stellen (Knopf am Video, Taste i): aus page oder app. */
function minimize(state) {
  return state.stage === 'page' || state.stage === 'app' ? { ...state, stage: 'mini', back: [] } : state;
}

/** „Zurück zum Video“: die Ursprungsseite. */
function showPage(state) {
  return isActive(state) && state.stage !== 'page' ? { ...state, stage: 'page', back: [] } : state;
}

/** „App-füllend anzeigen“ (Esc kehrt zur vorherigen Stufe zurück). */
function appFill(state) {
  if (!isActive(state) || state.stage === 'app' || state.stage === 'fullscreen') return state;
  return { ...state, stage: 'app', back: [...state.back, state.stage] };
}

/** Vollbild (vom Webview gemeldet oder per Knopf). */
function enterFullscreen(state) {
  if (!isActive(state) || state.stage === 'fullscreen') return state;
  return { ...state, stage: 'fullscreen', back: [...state.back, state.stage] };
}

function leaveFullscreen(state) {
  if (state.stage !== 'fullscreen') return state;
  return { ...state, stage: lastOf(state.back) || 'page', back: state.back.slice(0, -1) };
}

/** Der Vollbildmodus kam nicht zustande (Seite verweigert): app-füllend statt Vollbild, Esc geht wie gewohnt zurück. */
function fullscreenFailed(state) {
  if (state.stage !== 'fullscreen') return state;
  return lastOf(state.back) === 'app' ? leaveFullscreen(state) : { ...state, stage: 'app' };
}

/**
 * Esc: eine Stufe kleiner, nämlich zurück zur Stufe, aus der man kam.
 * Vollbild → Herkunft (app/page/mini) · app-füllend → Herkunft (mini oder Seite). page und mini: nicht behandelt.
 * Rückgabe: { state, handled }.
 */
function escape(state) {
  if (state.stage === 'fullscreen') return { state: leaveFullscreen(state), handled: true };
  if (state.stage === 'app') return { state: { ...state, stage: lastOf(state.back) || 'page', back: state.back.slice(0, -1) }, handled: true };
  return { state, handled: false };
}

/**
 * Der Nutzer verlässt die Wiedergabeseite (Navigation in YouTube, anderer App-Bereich):
 * ein laufendes Video wird klein, ein pausiertes von der Wiedergabeseite verworfen (wie bisher beim Seitenwechsel).
 * Aus „App-füllend“ bleibt auch ein pausiertes Video erhalten und landet pausiert im Mini-Player (wie im Mini-Modus).
 * Ein beendetes Video wird immer verworfen. Rückgabe: { state, drop } – drop: Webview leeren.
 */
function leavePage(state) {
  if (state.stage !== 'page' && state.stage !== 'app') return { state, drop: false };
  const keep = isPlaying(state) || (state.stage === 'app' && state.status !== 'ended');
  return keep ? { state: { ...state, stage: 'mini', back: [] }, drop: false } : { state: initialState(), drop: true };
}

function close() {
  return initialState();
}

/** Wo steht das Player-Webview? 'hidden' | 'slot' (Leiste) | 'content' (Inhaltsbereich) | 'window' (ganzes Fenster). */
function placement(state) {
  switch (state.stage) {
    case 'mini':
      return 'slot';
    case 'page':
      return 'content';
    case 'app':
    case 'fullscreen':
      return 'window';
    default:
      return 'hidden';
  }
}

module.exports = {
  STAGES,
  STATUSES,
  initialState,
  isActive,
  isPlaying,
  openVideo,
  setStatus,
  setVideoId,
  minimize,
  showPage,
  appFill,
  enterFullscreen,
  leaveFullscreen,
  fullscreenFailed,
  escape,
  leavePage,
  close,
  placement,
};
