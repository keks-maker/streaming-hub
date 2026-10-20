'use strict';

// Aufbereitung der Download-Vorschau für den Optionen-Dialog (rein): Plan (Spuren, Größe) und verfügbare Optionen der Quelle.
// Enthält nie Adressen.

/** { plan, available } aus Quellinfo (resolveForDownload) und Plan (track-selection). */
function describePlan(info, plan) {
  const heights = [...new Set(info.variants.map(variant => variant.height).filter(Boolean))].sort((a, b) => b - a);
  return {
    plan: {
      mode: plan.mode,
      container: plan.container,
      video: { height: plan.video.height, codec: plan.video.codec, label: plan.video.label },
      audio: plan.audio.map(track => ({ id: track.id, kind: track.kind, language: track.language, label: track.label, disposition: track.disposition })),
      subtitles: plan.subtitles.map(track => ({ id: track.id, kind: track.kind, language: track.language, label: track.label, external: track.external })),
      estimatedBytes: plan.estimatedBytes,
      warnings: plan.warnings,
    },
    available: {
      heights,
      audio: info.audioTracks.map(track => ({ id: track.id, kind: track.kind, language: track.language, label: track.label })),
      subtitles: info.subtitles.map(track => ({ id: track.id, kind: track.kind, language: track.language, label: track.label })),
    },
  };
}

module.exports = { describePlan };
