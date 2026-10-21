'use strict';

// PIN-Abfrage für den ZDF-Jugendschutz: kleines, modales Fenster (eigene Seite, Sandbox, kein Netz, kein Node). Die PIN reicht nur
// vom Fenster an den Aufrufer (askPin), sie wird nie geloggt und nie an die Hauptoberfläche gesendet. Der Aufrufer prüft die PIN beim ZDF;
// eine Wiederholung bei falscher PIN gibt es nicht (der Nutzer startet den Vorgang neu). Electron-Objekte sind injizierbar (Tests).

const path = require('node:path');
const { prepareWindowOptions, showInactiveInHook } = require('../../e2e-background.js');

const CH_INIT = 'mediathek:zdf-pin-init';
const CH_SUBMIT = 'mediathek:zdf-pin-submit';
const CH_CANCEL = 'mediathek:zdf-pin-cancel';
const PIN_PATTERN = /^\d{4}$/;

/** Hinweistext zur Freigabestufe ("FSK16", "fsk 12" ...). */
function infoText(rating) {
  const digits = String(rating || '').replace(/\D/g, '');
  return digits ? `Dieser Beitrag ist ab FSK ${digits} eingestuft. Zum Abspielen die vierstellige PIN deines Mein-ZDF-Kontos eingeben.` : 'Dieser Beitrag ist altersbeschränkt. Zum Abspielen die vierstellige PIN deines Mein-ZDF-Kontos eingeben.';
}

/** Prüft die Eingabe des Fensters: genau { pin: 4 Ziffern, remember: boolean }. */
function validateSubmit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'pin' && key !== 'remember')) return null;
  if (typeof value.pin !== 'string' || !PIN_PATTERN.test(value.pin) || typeof value.remember !== 'boolean') return null;
  return { pin: value.pin, remember: value.remember };
}

/**
 * options: BrowserWindow, ipcMain, getParent() -> Elternfenster|null, logger.
 * Ergebnis: { ask({ rating, canRemember }) -> Promise<{ pin, remember } | null> } (null = abgebrochen/Fenster geschlossen).
 */
function createPinPrompt({ BrowserWindow, ipcMain, getParent = () => null, logger = null }) {
  let active = null; // { win, info, finish }

  const fromActive = event => active && !active.win.isDestroyed() && event.sender === active.win.webContents;

  ipcMain.handle(CH_INIT, event => (fromActive(event) ? active.info : null));
  ipcMain.handle(CH_SUBMIT, (event, value) => {
    if (!fromActive(event)) return { ok: false };
    const input = validateSubmit(value);
    if (!input) return { ok: false };
    active.finish(input);
    return { ok: true };
  });
  ipcMain.handle(CH_CANCEL, event => {
    if (fromActive(event)) active.finish(null);
    return { ok: true };
  });

  function ask({ rating = null, canRemember = false } = {}) {
    if (active) return Promise.resolve(null); // es läuft schon eine Abfrage (der Aufrufer teilt sie sich normalerweise)
    const parent = getParent();
    const win = new BrowserWindow(prepareWindowOptions({
      width: 440,
      height: 340,
      title: 'ZDF-Jugendschutz-PIN',
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: Boolean(parent && !parent.isDestroyed()),
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: 'zdf-pin', // nur im Arbeitsspeicher
        preload: path.join(__dirname, 'zdf-pin-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
      },
    }, process.env));
    showInactiveInHook(win, process.env);
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());

    return new Promise(resolve => {
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        active = null;
        if (!win.isDestroyed()) win.destroy();
        resolve(result);
      };
      active = { win, info: { text: infoText(rating), canRemember: canRemember === true }, finish };
      win.on('closed', () => finish(null));
      contents.loadFile(path.join(__dirname, 'zdf-pin.html')).catch(error => {
        if (logger) logger.warn(`ZDF-PIN-Fenster nicht ladbar (${(error && error.code) || 'fehler'}).`);
        finish(null);
      });
    });
  }

  return { ask };
}

module.exports = { createPinPrompt, validateSubmit, infoText };
