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

/**
 * Ergänzt die Sperr-Meldung um den Konto-Hinweis. account: 'signedOut' (mit Konto freischaltbar), 'blocked' (auch mit Konto
 * gesperrt), 'expired' (Anmeldung abgelaufen), 'network' (Token-Auffrischung per Netz gescheitert), 'error' (Konto nicht prüfbar);
 * nur ZDF: 'notVerified' (Altersfreigabe fehlt), 'tooHigh' (FSK 18), 'pinCancelled', 'wrongPin', 'pinLocked', 'noStream'; sonst unverändert.
 * sender 'zdf' benennt das ZDF-Konto.
 */
function accountNote(message, account, sender = null) {
  switch (account) {
    case 'signedOut':
      return sender === 'zdf' ? `${message} Mit ZDF-Konto freischaltbar – in Einstellungen ▸ Mediatheken ▸ Konten anmelden.` : `${message} Mit Konto freischaltbar – in Einstellungen ▸ Mediatheken ▸ Konten anmelden.`;
    case 'notVerified':
      return `${message} Die Altersfreigabe fehlt: einmalig bei ZDF auf der Website durchführen (Mein ZDF ▸ Altersverifikation), danach hier erneut versuchen.`;
    case 'tooHigh':
      return `${message} FSK 18 lässt sich beim ZDF nicht per Konto freischalten und bleibt nur nachts von 23 bis 6 Uhr abrufbar.`;
    case 'pinCancelled':
      return `Die ZDF-Jugendschutz-PIN wurde nicht eingegeben. ${message}`;
    case 'wrongPin':
      return 'Falsche ZDF-Jugendschutz-PIN. Bitte erneut abspielen und die PIN noch einmal eingeben.';
    case 'pinLocked':
      return 'Zu viele falsche PIN-Eingaben beim ZDF. Bitte später erneut versuchen.';
    case 'noStream':
      return `Das ZDF liefert für diesen Beitrag gerade keinen Stream. ${message}`;
    case 'blocked':
      return `Auch mit Konto gesperrt: ${message}`;
    case 'expired':
      return `Anmeldung abgelaufen – in Einstellungen ▸ Mediatheken ▸ Konten neu anmelden. ${message}`;
    case 'network':
      return `Konto konnte nicht aktualisiert werden (Netzwerk) – später erneut versuchen. ${message}`;
    case 'error':
      return `${message} Das Konto konnte gerade nicht geprüft werden.`;
    default:
      return message;
  }
}

module.exports = { fskWindow, ageRestrictedMessage, accountNote };
