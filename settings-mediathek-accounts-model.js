'use strict';

// Einstellungen ▸ Mediatheken ▸ Konten: Darstellung der Konten (rein, ohne DOM). Der Zustand kommt aus
// window.mediathek.accounts.status() (nie Token): { sender, name, state, since, experimental }.

const SENDER_HINTS = {
  arte: 'Anmeldung mit deinem MeinARTE-Konto. Die Altersbestätigung (FSK 16 und 18) führst du einmalig bei arte durch.',
  ard: 'Anmeldung mit deinem ARD-Konto. Die Altersbestätigung führst du einmalig bei der ARD durch.',
  zdf: 'Anmeldung mit deinem Mein-ZDF-Konto (auch ARD-Konto). Die Altersfreigabe (nur FSK 16) führst du einmalig bei ZDF auf der Website durch (Mein ZDF ▸ Altersverifikation). Beim Abspielen fragt die App deine ZDF-Jugendschutz-PIN ab; FSK 18 bleibt beim ZDF nur nachts von 23 bis 6 Uhr abrufbar.',
};

const STATE_TEXT = {
  signedOut: 'Nicht angemeldet',
  expired: 'Anmeldung abgelaufen',
  unsupported: 'Noch nicht unterstützt (folgt)',
};

function sinceText(since) {
  if (!Number.isFinite(since) || since <= 0) return 'Angemeldet';
  const date = new Date(since);
  const day = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `Angemeldet seit ${day}, ${time} Uhr`;
}

/** Beschreibung einer Konto-Karte: Texte, Statusart und welche Knöpfe aktiv sind. */
function describeAccount(account, { busy = false } = {}) {
  const state = account.state;
  const supported = state !== 'unsupported';
  return {
    sender: account.sender,
    title: account.name,
    badge: account.experimental ? 'experimentell' : null,
    statusKind: state === 'signedIn' ? 'ok' : state === 'expired' ? 'warn' : 'none',
    statusText: state === 'signedIn' ? sinceText(account.since) : STATE_TEXT[state] || STATE_TEXT.signedOut,
    hint: SENDER_HINTS[account.sender] || '',
    canLogin: supported && state !== 'signedIn' && !busy,
    loginLabel: state === 'expired' ? 'Erneut anmelden' : 'Anmelden',
    canLogout: supported && state !== 'signedOut' && !busy,
    canTest: supported && state === 'signedIn' && !busy,
    supported,
  };
}

const GENERAL_HINT =
  'Das Konto und der Altersnachweis liegen beim Anbieter. Die Anmeldung läuft in einem eigenen Fenster direkt beim Sender; ' +
  'diese App sieht dein Passwort nie. Mit Konto werden Beiträge abrufbar, die der Anbieter für dich freigibt (zum Beispiel FSK 16 oder 18 außerhalb der Sendezeit; beim ZDF nur bis FSK 16). ' +
  'Funktion experimentell: nur mit eigenem Konto testbar.';

const STORAGE_NOTE = {
  persistent: 'Die Anmeldung wird verschlüsselt gespeichert (Schlüsselbund des Systems).',
  memoryOnly: 'Verschlüsselte Ablage nicht verfügbar: Die Anmeldung gilt nur bis zum Beenden der App.',
};

module.exports = { describeAccount, sinceText, GENERAL_HINT, STORAGE_NOTE, SENDER_HINTS };
