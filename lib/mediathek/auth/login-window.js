'use strict';

// Anmeldefenster beim Anbieter: eigenes BrowserWindow, darin die Anbieter-Seite (persistente Partition je Sender, ohne Node, ohne
// Preload, mit Sandbox und Context Isolation) und darüber eine schmale Leiste "Anmeldung übernehmen" (lokale Seite, Preload mit nur
// zwei Ereignissen). Die Sitzung wird automatisch erkannt (Polling), per Klick sofort geprüft und beim Schließen ein letztes Mal. Navigation und neue Fenster nur auf https-Hosts des Anbieters, alle Berechtigungsabfragen
// (Kamera, Standort ...) werden abgelehnt. Passwort, Captcha und Altersnachweis laufen ausschließlich dort; diese App liest
// danach nur die vom Anbieter ausgestellte Sitzung (provider.collect). Electron-Objekte sind injizierbar (Tests).

const path = require('node:path');
const { httpsHost } = require('./util.js');
const { createBarView } = require('./login-bar-view.js');
const { prepareWindowOptions, showInactiveInHook } = require('../../e2e-background.js');

const POLL_MS = 1500;
const TIMEOUT_MS = 15 * 60 * 1000;
const BAR_HEIGHT = 52;
const NAVIGATE_WAIT_MS = 8000;
const CLOSE_DELAY_MS = 700;
const CH_ACCEPT = 'mediathek:login-accept';
const CH_CANCEL = 'mediathek:login-cancel';
const CH_STATUS = 'mediathek:login-status';

const HARDENED_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
};

/**
 * options: BrowserWindow, WebContentsView, ipcMain, session (electron.session), getParent() -> Elternfenster|null, logger,
 * setTimer/clearTimer (Tests), pollMs, timeoutMs, closeDelayMs.
 * Aufbau: Fenster mit zwei Ansichten - oben die Übernehmen-Leiste (eigene Seite, minimaler Preload), darunter die Anbieter-Seite
 * (kein Preload). Ergebnis: { run(provider) -> Promise<{ ok: true, record } | { ok: false, code: 'cancelled'|'timeout'|'busy'|'error' }> }
 */
function createLoginRunner({ BrowserWindow, WebContentsView, ipcMain, session, getParent = () => null, logger = null, setTimer = setInterval, clearTimer = clearInterval, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS, closeDelayMs = CLOSE_DELAY_MS }) {
  let active = null; // { provider, barContents, accept, cancel }

  const fromBar = event => active !== null && active.barContents !== null && event.sender === active.barContents;
  if (ipcMain) {
    ipcMain.on(CH_ACCEPT, event => {
      return fromBar(event) ? active.accept() : undefined;
    });
    ipcMain.on(CH_CANCEL, event => {
      if (fromBar(event)) active.cancel();
    });
  }

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
    const win = new BrowserWindow(prepareWindowOptions({
      width: 520,
      height: 760,
      title,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { ...HARDENED_PREFERENCES },
    }, process.env));
    const view = new WebContentsView({ webPreferences: { ...HARDENED_PREFERENCES, partition: provider.partition } });
    const bar = createBarView(WebContentsView, HARDENED_PREFERENCES);
    win.contentView.addChildView(view);
    win.contentView.addChildView(bar);
    const layout = () => {
      const { width, height } = win.getContentBounds();
      bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
      view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) });
    };
    layout();
    win.on('resize', layout);
    showInactiveInHook(win, process.env); // Hook-Fall: ohne Fokusübernahme zeigen
    const contents = view.webContents;
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
    // Die Leiste ist eine feste lokale Seite: keine Navigation, keine neuen Fenster
    const barContents = bar.webContents;
    barContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    barContents.on('will-navigate', event => event.preventDefault());
    barContents.on('will-redirect', event => event.preventDefault());
    return { win, contents, ses, barContents };
  }

  async function run(provider) {
    if (active) return { ok: false, code: 'busy' };
    const { win, contents, barContents, ses } = openProviderWindow(provider, `Anmelden: ${provider.name}`);

    return new Promise(resolve => {
      let finished = false;
      let busyProbe = false;
      let closing = false;
      const startedAt = Date.now();
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimer(timer);
        active = null;
        if (!win.isDestroyed()) win.destroy();
        for (const part of [contents, barContents]) {
          try {
            if (part && typeof part.close === 'function' && !part.isDestroyed()) part.close();
          } catch {
            // schon geschlossen
          }
        }
        resolve(result);
      };
      const setStatus = code => {
        try {
          if (!finished && !barContents.isDestroyed()) barContents.send(CH_STATUS, code);
        } catch {
          // Leiste schon geschlossen
        }
      };
      const logFailure = error => {
        // Seite noch nicht bereit oder Anbieter lehnte ab: weiter warten (Details nie loggen, nur der Code)
        if (logger) logger.warn(`Mediathek-Anmeldung (${provider.sender}): Sitzung noch nicht lesbar (${(error && error.code) || 'fehler'}${error && error.status ? `, HTTP ${error.status}` : ''}).`);
      };
      const pageFor = url => {
        const page = { url, executeJavaScript: code => contents.executeJavaScript(code, true) };
        const domain = provider.login.cookieDomain;
        if (domain && ses && ses.cookies && typeof ses.cookies.get === 'function') {
          const inDomain = cookie => {
            const host = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
            return host === domain || host.endsWith(`.${domain}`);
          };
          page.getCookies = async () => (await ses.cookies.get({})).filter(inDomain);
        }
        return page;
      };
      /** Eine Prüfung der aktuellen Seite: Datensatz oder null; Fehler werden geloggt (Code) und als null gewertet. */
      const attempt = async () => {
        const url = contents.getURL();
        const host = httpsHost(url);
        if (!host || !provider.login.isCollectPage(host)) return null;
        try {
          return await provider.collect(pageFor(url));
        } catch (error) {
          logFailure(error);
          return null;
        }
      };
      const probe = async () => {
        if (finished || busyProbe || win.isDestroyed()) return;
        if (Date.now() - startedAt > timeoutMs) return finish({ ok: false, code: 'timeout' });
        busyProbe = true;
        try {
          const record = await attempt();
          if (record) finish({ ok: true, record });
        } finally {
          busyProbe = false;
        }
      };
      const navigateTo = async url => {
        let timer2 = null;
        try {
          await Promise.race([contents.loadURL(url), new Promise(done => { timer2 = setTimeout(done, NAVIGATE_WAIT_MS); })]);
        } catch {
          // Navigation abgelehnt oder abgebrochen: trotzdem erneut prüfen
        } finally {
          if (timer2) clearTimeout(timer2);
        }
      };
      /** Klick auf "Anmeldung übernehmen": sofortige Prüfung; wenn auf der Seite nichts liegt, einmal zur Konto-Seite wechseln. */
      const accept = async () => {
        if (finished || closing) return;
        setStatus('checking');
        let record = await attempt();
        if (!record && !finished) {
          const host = httpsHost(contents.getURL());
          const onCollectPage = Boolean(host) && provider.login.isCollectPage(host);
          const target = provider.login.collectUrl || (onCollectPage ? null : provider.login.startUrl);
          if (target && contents.getURL() !== target) {
            await navigateTo(target);
            record = finished ? null : await attempt();
          }
        }
        if (finished) return;
        if (!record) return setStatus('none');
        setStatus('found');
        if (closeDelayMs > 0) setTimeout(() => finish({ ok: true, record }), closeDelayMs);
        else finish({ ok: true, record });
      };
      /** Fenster wird vom Nutzer geschlossen: einmaliger letzter Versuch, bevor "abgebrochen" gemeldet wird. */
      const closeWithLastTry = async event => {
        if (finished || closing) return;
        closing = true;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const record = await attempt();
        finish(record ? { ok: true, record } : { ok: false, code: 'cancelled' });
      };
      active = { provider, barContents, accept, cancel: () => finish({ ok: false, code: 'cancelled' }) };
      const timer = setTimer(probe, pollMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      win.on('close', closeWithLastTry);
      win.on('closed', () => finish({ ok: false, code: 'cancelled' }));
      barContents.loadFile(path.join(__dirname, 'login-bar.html')).catch(error => {
        if (logger) logger.warn(`Mediathek-Anmeldung (${provider.sender}): Übernehmen-Leiste nicht ladbar (${(error && error.code) || 'fehler'}).`);
      });
      contents.loadURL(provider.login.startUrl).catch(error => {
        if (logger) logger.warn(`Mediathek-Anmeldung (${provider.sender}): Seite nicht ladbar (${(error && error.code) || 'fehler'}${error && error.status ? `, HTTP ${error.status}` : ''}).`);
      });
    });
  }

  return { run, openProviderWindow, isBusy: () => active !== null };
}

module.exports = { createLoginRunner, BAR_HEIGHT };
