'use strict';

// Standby-Schutz während der Podcast-Wiedergabe: powerSaveBlocker 'prevent-app-suspension' (verhindert App-Suspendierung,
// der Bildschirm darf ausgehen), solange eine Episode lädt oder spielt; bei Pause/Ende/Fehler/Stopp freigeben.

function createPlaybackPowerGuard({ powerSaveBlocker, logger = null }) {
  let id = null;
  const held = () => id !== null && powerSaveBlocker.isStarted(id);
  return {
    sync(status) {
      const want = status === 'loading' || status === 'playing';
      try {
        if (want && !held()) id = powerSaveBlocker.start('prevent-app-suspension');
        else if (!want && id !== null) {
          if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
          id = null;
        }
      } catch (error) {
        if (logger) logger.warn('Standby-Schutz (Podcast) fehlgeschlagen:', error.message);
      }
    },
    release() {
      this.sync('idle');
    },
    isHeld: held,
  };
}

module.exports = { createPlaybackPowerGuard };
