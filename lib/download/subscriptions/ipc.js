'use strict';

// IPC der Serien-Abos (Muster lib/download/ipc.js): alle subscriptions:*-Kanäle nur für das Hauptfenster (requireMainRenderer) mit
// Schema-Prüfung (validation.js). Fachliche Fehler kommen als { ok: false, code, message } zurück, ungültige Eingaben werfen.
//
// Kanäle (Eingabe -> Ergebnis):
//   subscriptions:list        -                                  -> { ok, items, checking, enabled, intervalHours, nextCheckAt }
//   subscriptions:add         { series, mode?, overrides? }      -> { ok, item } | { ok: false, code: 'exists'|'limit'|'network'|..., message }
//   subscriptions:update      { id, enabled?, overrides? }       -> { ok, item } | { ok: false, code, message }
//   subscriptions:remove      { id }                             -> { ok } | { ok: false, code, message }
//   subscriptions:check-now   { id? }                            -> { ok, checked, added } | { ok: false, code: 'disabled'|'busy'|'unknown', message }
//   Event subscriptions:changed  (Inhalt wie list)

const { validateNoPayload } = require('../../ipc-validation.js');
const v = require('./validation.js');

function registerSubscriptionIpc({ ipcMain, service, requireMainRenderer, sendToMain }) {
  const main = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event);
      return handler(...args);
    });
  };

  service.on('changed', payload => sendToMain('subscriptions:changed', payload));

  main('subscriptions:list', (...rest) => {
    validateNoPayload(rest);
    return service.list();
  });
  main('subscriptions:add', value => service.add(v.validateAdd(value)));
  main('subscriptions:update', value => {
    const { id, ...patch } = v.validateUpdate(value);
    return service.update(id, patch);
  });
  main('subscriptions:remove', value => service.remove(v.validateId(value).id));
  main('subscriptions:check-now', value => service.checkNow(v.validateCheck(value).id));
}

module.exports = { registerSubscriptionIpc };
