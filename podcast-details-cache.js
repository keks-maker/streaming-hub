// Podcast-Oberfläche: Episodendetails (Shownotes, Kapitel) aus dem Main (podcast:episode-details), im Renderer kurz
// zwischengespeichert, damit Overlay und Mini-Player dieselbe Antwort teilen. Fehlschläge werden nicht gemerkt (nächster
// Aufruf versucht es erneut). Kein DOM.

'use strict';

const MAX_ENTRIES = 40;

/** options: { podcasts (window.podcasts) }. get(podcastId, episodeId) -> Promise<{ ok, notes, chapters, chaptersError }>; chapters(podcastId, episodeId) -> Promise<[{start,title}]> */
function createPodcastDetailsCache({ podcasts } = {}) {
  const cache = new Map(); // key -> Promise

  function get(podcastId, episodeId) {
    const key = `${podcastId}\u0000${episodeId}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key); // LRU
      cache.set(key, hit);
      return hit;
    }
    const promise = Promise.resolve()
      .then(() => podcasts.episodeDetails({ podcastId, episodeId }))
      .then(reply => {
        if (!reply || reply.ok !== true) throw new Error('Details nicht verfügbar');
        return {
          ok: true,
          notes: typeof reply.notes === 'string' ? reply.notes : '',
          chapters: Array.isArray(reply.chapters) ? reply.chapters : [],
          chaptersError: typeof reply.chaptersError === 'string' ? reply.chaptersError : '',
        };
      })
      .catch(error => {
        cache.delete(key);
        throw error;
      });
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, promise);
    return promise;
  }

  async function chapters(podcastId, episodeId) {
    try {
      return (await get(podcastId, episodeId)).chapters;
    } catch {
      return [];
    }
  }

  /** Nach einer Feed-Aktualisierung können Kapitel/Shownotes neu sein. */
  function clear() {
    cache.clear();
  }

  return { get, chapters, clear };
}

module.exports = { createPodcastDetailsCache };
