'use strict';

// Jugendschutz-Fenster (JMStV) und Meldungen für gesperrte Beiträge. Gleiche Texte wie auf tvOS/iPad
// (MediathekParser.fskWindow / ageRestrictedMessage), damit beide Plattformen dasselbe anzeigen.

/** Abrufzeitraum nach JMStV als Klartext ("22 bis 6 Uhr"); null bei unbekannter Freigabe. */
function fskWindow(rating) {
  const digits = String(rating || '').replace(/\D/g, '');
  switch (Number(digits)) {
    case 18:
      return '23 bis 6 Uhr';
    case 16:
      return '22 bis 6 Uhr';
    case 12:
      return '20 bis 6 Uhr';
    default:
      return null;
  }
}

/** Meldung für eine Jugendschutz-Sperre. rating z. B. "FSK16" oder "fsk16". */
function ageRestrictedMessage(rating) {
  const text = String(rating || '');
  const label = text.toUpperCase().startsWith('FSK') ? `FSK ${text.replace(/\D/g, '')}` : text;
  const window = fskWindow(text);
  if (window) return `Dieser Beitrag ist ab ${label} eingestuft (Jugendschutz) und nur von ${window} abrufbar.`;
  return `Dieser Beitrag ist ab ${label} eingestuft (Jugendschutz) und derzeit nicht abrufbar.`;
}

module.exports = { fskWindow, ageRestrictedMessage };
