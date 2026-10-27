// YouTube-Mini-Player: Verlauf des Stöberns und Zurück-Verhalten. Reine Funktionen ohne DOM und IPC.
//
// Das Stöbern läuft in der Inhalts-Webview, das Video in der Player-Webview. Der Verlauf hier spiegelt die
// Einträge der Inhalts-Webview ({ url, from }); `from` merkt sich, von welchem Video aus eine Seite erreicht wurde
// (Klick aus der Wiedergabeseite). So führt „Zurück“ von dieser Seite wieder auf die Seite des laufenden Videos.

'use strict';

function createTrail() {
  return { entries: [], pendingBack: false };
}

function resetTrail(url) {
  return { entries: url ? [{ url, from: '' }] : [], pendingBack: false };
}

/**
 * Die Inhalts-Webview hat eine Seite geladen (did-navigate). Wiederholte Meldungen derselben Adresse zählen nicht;
 * nach unserem eigenen Zurück (pendingBack) wird der Eintrag entfernt statt ergänzt.
 */
function visit(trail, url, from = '') {
  if (typeof url !== 'string' || !url) return trail;
  if (trail.pendingBack) {
    const entries = trail.entries.slice(0, -1);
    const top = entries[entries.length - 1];
    // Landet das Zurück auf einer anderen Adresse als erwartet (verlorener Verlauf), gilt sie als neuer Stand
    return { entries: top && top.url === url ? entries : [...entries, { url, from: '' }].slice(-50), pendingBack: false };
  }
  const top = trail.entries[trail.entries.length - 1];
  if (top && top.url === url) return from && !top.from ? { ...trail, entries: [...trail.entries.slice(0, -1), { url, from }] } : trail;
  return { entries: [...trail.entries, { url, from }].slice(-50), pendingBack: false };
}

/** Der Aufrufer ruft goBack() der Inhalts-Webview auf; das folgende Ereignis entfernt den obersten Eintrag. */
function markBack(trail) {
  return { ...trail, pendingBack: true };
}

/**
 * Zurück-Taste im YouTube-Bereich.
 *   stage 'page'  → 'show-browse': Inhalts-Webview wieder zeigen (Video wird klein oder verworfen); ohne Eintrag 'none'
 *   Seite wurde aus dem laufenden Video erreicht (from === videoId, Player lebt) → 'show-player': Inhalts-Webview geht
 *     einen Schritt zurück, dann wird die Wiedergabeseite gezeigt
 *   sonst, mit mehr als einem Eintrag → 'webview-back'; sonst 'none' (die App geht ihren eigenen Weg zurück)
 */
function backAction(trail, { stage, videoId, playerAlive }) {
  if (stage === 'page') return trail.entries.length ? { kind: 'show-browse' } : { kind: 'none' };
  const top = trail.entries[trail.entries.length - 1];
  if (top && top.from && playerAlive && top.from === videoId && trail.entries.length > 1) return { kind: 'show-player' };
  return trail.entries.length > 1 ? { kind: 'webview-back' } : { kind: 'none' };
}

module.exports = { createTrail, resetTrail, visit, markBack, backAction };
