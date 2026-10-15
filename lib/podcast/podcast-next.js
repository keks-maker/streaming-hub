'use strict';

// „Nach Ende nächste Episode abspielen“ (Einstellung autoPlayNext): wählt die nächste ungehörte Episode derselben Sendung.
// Reihenfolge: älteste → neueste (Hörreihenfolge einer Sendung). Die Episodenliste des Caches ist neueste zuerst
// (Feed-Reihenfolge bzw. nach Datum, siehe feed-parser.js), also ist die „nächste“ die nächstneuere vor der aktuellen.
// Rein, ohne Zugriff auf Bibliothek oder Netz.

/**
 * episodes: Episoden des Caches, neueste zuerst, je { id, audioUrl, state?: { played } }; listenState(id) liefert { played }
 * (Fallback, wenn die Episode keinen state trägt). Liefert die Episode-ID oder null (aktuelle Episode ist die neueste
 * oder alle neueren sind gehört bzw. ohne Audio-Adresse).
 */
function nextEpisodeId(episodes, currentId, listenState = () => ({ played: false })) {
  if (!Array.isArray(episodes)) return null;
  const index = episodes.findIndex(episode => episode && episode.id === currentId);
  if (index <= 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const episode = episodes[i];
    if (!episode || typeof episode.audioUrl !== 'string' || !episode.audioUrl) continue;
    const listen = episode.state || listenState(episode.id) || {};
    if (listen.played !== true) return episode.id;
  }
  return null;
}

module.exports = { nextEpisodeId };
