// Einstellungen des YouTube-Mini-Players: reine Normalisierung ohne I/O.
//  enabled        Mini-Player für YouTube (Standard an; aus = Verhalten wie vor 0.13.0)
//  clickBehavior  Klick auf ein Video, während eines läuft: 'replace' (ersetzen, Standard) | 'playlist' (zur Playlist)

'use strict';

const CLICK_BEHAVIORS = Object.freeze(['replace', 'playlist']);
const DEFAULTS = Object.freeze({ enabled: true, clickBehavior: 'replace' });

function normalizeYoutubeMiniSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled,
    clickBehavior: CLICK_BEHAVIORS.includes(source.clickBehavior) ? source.clickBehavior : DEFAULTS.clickBehavior,
  };
}

module.exports = { CLICK_BEHAVIORS, DEFAULTS, normalizeYoutubeMiniSettings };
