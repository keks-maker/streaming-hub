'use strict';

// Anmeldefenster beim Anbieter: eigenes BrowserWindow mit persistenter Partition je Sender, ohne Node, ohne Preload, mit
// Sandbox und Context Isolation. Navigation und neue Fenster nur auf https-Hosts des Anbieters, alle Berechtigungsabfragen
// (Kamera, Standort ...) werden abgelehnt. Passwort, Captcha und Altersnachweis laufen ausschließlich dort; diese App liest
// danach nur die vom Anbieter ausgestellte Sitzung (provider.collect). Electron-Objekte sind injizierbar (Tests).

const { httpsHost } = require('./util.js');
const { hiddenInHook, showInactiveInHook } = require('../../e2e-background.js');

const POLL_MS = 1500;
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * options: BrowserWindow, session (electron.session), getParent() -> Elternfenster|null, logger,
 * setTimer/clearTimer (Tests), pollMs, timeoutMs.
 * Ergebnis: { run(provider) -> Promise<{ ok: true, record } | { ok: false, code: 'cancelled'|'timeout'|'busy'|'error' }> }
 */
function createLoginRunner({ BrowserWindow, session, getParent = () => null, logger = null, setTimer = setInterval, clearTimer = clearInterval, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS }) {
  let active = null;

  function allowed(provider, url) {
    const host = httpsHost(url);
    return Boolean(host) && provider.login.isAllowedHost(host);
  }

  /** Gehärtetes Anbieter-Fenster (siehe Kopfkommentar); Anmeldung. */
  function openProviderWindow(provider, title) {
    const ses = session.fromPartition(provider.partition);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    if (typeof ses.setPermissionCheckHandler === 'function') ses.setPermissionCheckHandler(() => false);
    const parent = getParent();
    const win = new BrowserWindow({
      ...hiddenInHook(process.env),
      width: 520,
      height: 760,
      title,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: provider.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    showInactiveInHook(win, process.env); // Hook-Fall: ohne Fokusübernahme zeigen
    const contents = win.webContents;
    // Neue Fenster nie öffnen; erlaubte Ziele laden im selben Fenster (Anbieter-Links öffnen oft in neuem Tab)
    contents.setWindowOpenHandler(({ url }) => {
      if (allowed(provider, url)) contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    const guard = (event, url) => {
      if (!allowed(provider, url)) event.preventDefault();
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    // Auch Navigationen in Subframes (iframes, z. B. Captcha/Altersnachweis) nur auf Hosts des Anbieters
    contents.on('will-frame-navigate', details => {
      if (!allowed(provider, details.url)) details.preventDefault();
    });
    return { win, contents, ses };
  }

  async function run(provider) {
    if (active) return { ok: false, code: 'busy' };
    const { win, contents } = openProviderWindow(provider, `Anmelden: ${provider.name}`);

    return new Promise(resolve => {
      let finished = false;
      let busyProbe = false;
      const startedAt = Date.now();
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimer(timer);
        active = null;
        if (!win.isDestroyed()) win.destroy();
        resolve(result);
      };
      const probe = async () => {
        if (finished || busyProbe || win.isDestroyed()) return;
        if (Date.now() - startedAt > timeoutMs) return finish({ ok: false, code: 'timeout' });
        const url = contents.getURL();
        const host = httpsHost(url);
        if (!host || !provider.login.isCollectPage(host)) return;
        busyProbe = true;
        try {
          const record = await provider.collect({ url, executeJavaScript: code => contents.executeJavaScript(code, true) });
          if (record) finish({ ok: true, record });
        } catch (error) {
          // Seite noch nicht bereit oder Anbieter lehnte ab: weiter warten (Details nie loggen, nur der Code)
          if (logger) logger.warn(`Mediathek-Anmeldung (${provider.sender}): Sitzung noch nicht lesbar (${(error && error.code) || 'fehler'}${error && error.status ? `, HTTP ${error.status}` : ''}).`);
        } finally {
          busyProbe = false;
        }
      };
      const timer = setTimer(probe, pollMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      win.on('closed', () => finish({ ok: false, code: 'cancelled' }));
      active = { provider };
      contents.loadURL(provider.login.startUrl).catch(error => {
        if (logger) logger.warn(`Mediathek-Anmeldung (${provider.sender}): Seite nicht ladbar (${(error && error.code) || 'fehler'}${error && error.status ? `, HTTP ${error.status}` : ''}).`);
      });
    });
  }

  return { run, openProviderWindow, isBusy: () => active !== null };
}

module.exports = { createLoginRunner };
