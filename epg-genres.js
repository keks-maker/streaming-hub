// Genre-Beschriftungen des Programmführers (Etappe 3.3, M4): die Gruppen kommen aus
// lib/epg/genre.js (normalizeGenre, Main-Cache); Farben stehen als Tokens --g-* in styles.css.
// Rein und DOM-frei. Ein leeres Genre (keine Kategorie) bleibt neutral: kein Balken, Text „–“.

'use strict';

const GENRES = {
  news: 'Nachrichten',
  sport: 'Sport',
  doku: 'Doku',
  kinder: 'Kinder',
  serie: 'Serie',
  film: 'Film',
  show: 'Show',
  musik: 'Musik',
  sonstiges: 'Sonstiges',
};

/** Beschriftung einer Genre-Gruppe; '' bei leerem oder unbekanntem Wert. */
function genreLabel(genre) {
  return typeof genre === 'string' && Object.prototype.hasOwnProperty.call(GENRES, genre) ? GENRES[genre] : '';
}

/** Gruppe aus einem Slot-Wert (nur bekannte Gruppen, sonst ''). */
function cleanGenre(genre) {
  return genreLabel(genre) ? genre : '';
}

module.exports = { GENRES, genreLabel, cleanGenre };
