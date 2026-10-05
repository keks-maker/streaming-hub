// Einstellungen des Programmführers (Etappe 3.5, P20): Startansicht — rein, ohne I/O und ohne Electron.
//
// Main (Laden/Speichern/IPC), Renderer (Startmodus beim Öffnen) und Tests nutzen dieselben Werte.
// Persistenz-Format (epg-view-settings.json): { startView: 'auto' | 'list' | 'grid' | 'jng' }.
// Altdaten ohne das Feld (oder mit manipuliertem Wert) laden mit dem Standard 'auto'.
//
// Automatisch (P20): Fensterbreite >= 900 px → Liste, darunter → „Jetzt & Gleich“.

'use strict';

const START_VIEWS = Object.freeze(['auto', 'list', 'grid', 'jng']);
const DEFAULT_START_VIEW = 'auto';
/** Schwelle der Startansicht „Automatisch“ und des schmalen Layouts von „Jetzt & Gleich“ (px Fensterbreite). */
const AUTO_LIST_MIN_WIDTH = 900;

const START_VIEW_LABELS = Object.freeze({
  auto: 'Automatisch',
  list: 'Liste',
  grid: 'Raster',
  jng: 'Jetzt & Gleich',
});

function isStartView(value) {
  return typeof value === 'string' && START_VIEWS.includes(value);
}

/** Gespeicherte (oder fremde) Daten → vollständige, gültige Einstellungen. Unbekannte Werte fallen auf den Standard. */
function normalizeEpgViewSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { startView: isStartView(source.startView) ? source.startView : DEFAULT_START_VIEW };
}

/**
 * Konkreter Modus beim Öffnen des Overlays. 'auto': ab 900 px Breite Liste, sonst Jetzt & Gleich.
 * Ungültige Einstellung → wie 'auto'; ungültige Breite → Liste (breiter Standard).
 */
function resolveStartMode(startView, windowWidth) {
  if (startView === 'list' || startView === 'grid' || startView === 'jng') return startView;
  if (typeof windowWidth === 'number' && Number.isFinite(windowWidth) && windowWidth < AUTO_LIST_MIN_WIDTH) return 'jng';
  return 'list';
}

module.exports = {
  START_VIEWS,
  START_VIEW_LABELS,
  DEFAULT_START_VIEW,
  AUTO_LIST_MIN_WIDTH,
  isStartView,
  normalizeEpgViewSettings,
  resolveStartMode,
};
