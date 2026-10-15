'use strict';

// Exklusivität der Audio-Wiedergabe (Konzept §2): Radio und Podcast teilen sich einen Ton. Startet eines von beiden
// (Status loading/playing), wird das andere gestoppt (Podcast sichert dabei seine Position, Radio ist Live und wird beendet).
// Rein bis auf das Anhängen an die Controller; beide müssen isActive() und stop() sowie das Event 'state' liefern.

/** Was beim Zustandswechsel von `source` ('radio' | 'podcast') mit dem anderen Controller geschieht: 'stop-other' oder 'none'. */
function exclusivityAction(source, sourceState, otherActive) {
  const status = sourceState && sourceState.status;
  if ((source !== 'radio' && source !== 'podcast') || !otherActive) return 'none';
  return status === 'loading' || status === 'playing' ? 'stop-other' : 'none';
}

/** Belegt = nicht idle (auch ended/error): sonst bliebe die Leiste im alten Modus stehen. Ohne getState: isActive(). */
function isOccupied(controller) {
  if (typeof controller.getState === 'function') {
    const state = controller.getState();
    return Boolean(state && state.status && state.status !== 'idle');
  }
  return controller.isActive();
}

/** Hängt die Regel an beide Controller. Rückgabe: Funktion zum Lösen. */
function attachExclusivity({ radio, podcast, logger = null }) {
  const onRadio = state => {
    if (exclusivityAction('radio', state, isOccupied(podcast)) === 'stop-other') {
      if (logger) logger.info('Podcast gestoppt: Radio startet');
      podcast.stop();
    }
  };
  const onPodcast = state => {
    if (exclusivityAction('podcast', state, isOccupied(radio)) === 'stop-other') {
      if (logger) logger.info('Radio gestoppt: Podcast startet');
      radio.stop();
    }
  };
  radio.on('state', onRadio);
  podcast.on('state', onPodcast);
  return () => {
    radio.removeListener('state', onRadio);
    podcast.removeListener('state', onPodcast);
  };
}

module.exports = { exclusivityAction, attachExclusivity };
