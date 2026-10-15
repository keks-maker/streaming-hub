'use strict';

// Stabile IDs für Podcasts (Datenformat, das tvOS/iPad später lesen können, Konzept §8):
//   Abo-ID     = erste 24 Hex-Zeichen von SHA-256 über die normalisierte Feed-URL
//   Episoden-ID = guid des Feeds, sonst "enc-" + Hash der Enclosure-URL (siehe feed-parser.js)
// Normalisierung: Schema und Host kleingeschrieben, Standard-Port und #Fragment entfernt, leerer Pfad = "/".
// Pfad und Query bleiben unverändert (Groß-/Kleinschreibung dort ist signifikant).

const crypto = require('node:crypto');

function normalizeFeedUrl(value) {
  const url = new URL(String(value).trim());
  url.hash = '';
  return url.toString(); // WHATWG-URL: Schema/Host klein, Standard-Port entfernt, leerer Pfad "/"
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24);
}

/** Abo-ID aus einer Feed-URL; wirft bei ungültiger URL. */
function podcastIdFromFeedUrl(feedUrl) {
  return hashText(normalizeFeedUrl(feedUrl));
}

/** Ersatz-ID einer Episode ohne (eindeutige) guid. */
function episodeIdFromEnclosure(enclosureUrl) {
  return `enc-${hashText(String(enclosureUrl).trim())}`;
}

module.exports = { normalizeFeedUrl, hashText, podcastIdFromFeedUrl, episodeIdFromEnclosure };
