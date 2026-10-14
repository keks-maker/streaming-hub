// Ton-Konflikt Radio ↔ Bild (R2, Konzept §2): Startet LiveTV, ein Streamingdienst oder eine Aufnahme-Wiedergabe,
// wird das Radio pausiert (Einstellung pauseOnTv, Standard an). Rein, ohne DOM und IPC. Nur diese Richtung:
// Radio-Start lässt laufende Bilder unberührt; ein automatisches Fortsetzen gibt es nicht.

'use strict';

/**
 * Aktion für das Radio, wenn Bild-Wiedergabe startet:
 * 'pause' (Radio spielt) · 'stop' (Radio verbindet noch: Pause wäre dort wirkungslos, sonst setzt der Ton später ein)
 * · 'none' (Einstellung aus, idle, pausiert, Fehler).
 */
function radioActionForVideoStart(radioState, settings) {
  const pauseOnTv = !settings || settings.pauseOnTv !== false;
  if (!pauseOnTv || !radioState) return 'none';
  if (radioState.status === 'playing') return 'pause';
  if (radioState.status === 'loading') return 'stop';
  return 'none';
}

module.exports = { radioActionForVideoStart };
