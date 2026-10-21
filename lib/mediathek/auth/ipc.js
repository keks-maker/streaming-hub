'use strict';

// IPC der Mediathek-Konten (nur Hauptfenster, requireMainRenderer; Schema-Prüfung). Antworten enthalten nie Token,
// nur Zustände. Kanäle (Eingabe -> Ergebnis):
//   mediathek:accounts-status          -                     -> { ok, persistent, accounts: [{ sender, name, state, since }] }
//   mediathek:accounts-login           { sender }            -> { ok, status } | { ok: false, code, message }   (öffnet das Anbieter-Fenster)
//   mediathek:accounts-logout          { sender }            -> { ok, status }
//   mediathek:accounts-test            { sender }            -> { ok, code, message }
//   Event mediathek:accounts-changed   status

const { validateNoPayload } = require('../../ipc-validation.js');

const SENDERS = ['arte', 'ard', 'zdf'];

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} ist ungültig`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) throw new Error(`Unbekanntes Feld: ${extra[0]}`);
}

function validateSender(value) {
  exactKeys(value, ['sender'], 'Eingabe');
  if (!SENDERS.includes(value.sender)) throw new Error('Mediathek ist ungültig');
  return value.sender;
}

/** options: ipcMain, auth (createMediathekAuth), requireMainRenderer(event), sendToMain(channel, payload), logger. */
function registerAccountsIpc({ ipcMain, auth, requireMainRenderer, sendToMain }) {
  const main = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event);
      return handler(...args);
    });
  };

  main('mediathek:accounts-status', (...rest) => {
    validateNoPayload(rest);
    return { ok: true, ...auth.status() };
  });
  main('mediathek:accounts-login', value => auth.login(validateSender(value)));
  main('mediathek:accounts-logout', value => auth.logout(validateSender(value)));
  main('mediathek:accounts-test', value => auth.test(validateSender(value)));

  auth.on('changed', status => sendToMain('mediathek:accounts-changed', status));
}

module.exports = { registerAccountsIpc, validateSender };
