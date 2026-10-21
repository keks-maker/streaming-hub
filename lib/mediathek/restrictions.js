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

const SENDER_LABEL = { zdf: 'ZDF', arte: 'arte', ard: 'ARD' };

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
 * gesperrt), 'expired' (Anmeldung abgelaufen), 'rejected' (Anmeldung vom Anbieter abgelehnt, status = HTTP-Status), 'network' (Token-Auffrischung per Netz gescheitert), 'error' (Konto nicht prüfbar);
 * nur ZDF: 'notVerified' (Altersfreigabe fehlt), 'tooHigh' (FSK 18), 'pinCancelled', 'wrongPin', 'pinLocked', 'noStream'; sonst unverändert.
 * sender 'zdf' benennt das ZDF-Konto.
 */
function accountNote(message, account, sender = null, status = null) {
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
      if (sender === 'zdf') return 'ZDF-Anmeldung abgelaufen – bitte neu anmelden (Einstellungen ▸ Mediatheken ▸ Konten).';
      return `Anmeldung abgelaufen – in Einstellungen ▸ Mediatheken ▸ Konten neu anmelden. ${message}`;
    case 'rejected':
      return `${SENDER_LABEL[sender] || 'Der Anbieter'} akzeptiert die Anmeldung nicht${Number.isInteger(status) ? ` (HTTP ${status})` : ''} – bitte in den Konten abmelden und neu anmelden (Einstellungen ▸ Mediatheken ▸ Konten).`;
    case 'network':
      return `Konto konnte nicht aktualisiert werden (Netzwerk${Number.isInteger(status) ? `, HTTP ${status}` : ''}) – später erneut versuchen. ${message}`;
    case 'error':
      return `${message} Das Konto konnte gerade nicht geprüft werden${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`;
    default:
      return message;
  }
}

/** Stunde, ab der eine Freigabe abrufbar ist ("22 bis 6 Uhr" -> "22"); null bei unbekannter Freigabe. */
function fskStartHour(rating) {
  const window = fskWindow(rating);
  return window ? window.split(' ')[0] : null;
}

/**
 * Erklärung für eine leere Folgenliste: FSK-eingestufte Folgen liefert der Sender tagsüber nicht in der Liste.
 * account: 'signedOut' | 'expired' (Konto-Hinweis), 'signedIn' | 'blocked' | 'unlocked' (auch mit Konto leer); sonst (null) kein Konto-Hinweis.
 */
function emptySeriesNote(account) {
  const base = `Keine Folgen verfügbar. Sind die Folgen dieser Serie FSK-eingestuft (FSK 16/18), sind sie erst ab ${fskStartHour('FSK16')} Uhr (FSK 16) bzw. ${fskStartHour('FSK18')} Uhr (FSK 18) abrufbar.`;
  if (account === 'signedOut' || account === 'expired') return `${base} Mit Konto (Einstellungen ▸ Mediatheken ▸ Konten) auch tagsüber.`;
  if (account === 'signedIn' || account === 'blocked' || account === 'unlocked') return `${base} Auch mit Konto liefert der Sender derzeit keine Folgen.`;
  return base;
}

module.exports = { fskWindow, ageRestrictedMessage, accountNote, emptySeriesNote };
