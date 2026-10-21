'use strict';

// Diagnose-Aufzeichnung (ARD): öffnet das Anbieter-Fenster (gleiche Partition und Sicherheitsvorgaben wie die Anmeldung) und
// schreibt den Ablauf der Anfragen an die Anbieter-Hosts in eine lokale Datei. Aufgezeichnet wird nur die Form (siehe
// diagnose-redact.js): Zeit, Methode, Host+Pfad, Namen von Query-Parametern und Headern, Statuscode; bei Item-Antworten des
// Page-Gateways Schlüsselnamen und wenige Jugendschutz-Felder. Keine Token, PIN, Cookies, Bodies. Endet mit dem Schließen des Fensters.

const fs = require('node:fs');
const path = require('node:path');
const { isRecordedHost, redactUrl, headerNames, summarizeJsonText, isItemUrl } = require('./diagnose-redact.js');

const MAX_ENTRIES = 3000;
const MAX_BODY_CHARS = 4 * 1024 * 1024;

/**
 * options: openProviderWindow(provider, title) -> { win, contents, ses } (login-window.js), file (Zielpfad), now (ms), logger,
 * writeFile (Tests), setTimer/clearTimer unnötig. Ergebnis: run(provider) -> { ok: true, file, entries } | { ok: false, code, message }.
 */
function createDiagnoseRecorder({ openProviderWindow, file, now = Date.now, logger = null, fsImpl = fs }) {
  let active = false;

  function write(provider, entries, items) {
    const document = { version: 1, sender: provider.sender, recordedAt: new Date(now()).toISOString(), requests: entries, items };
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fsImpl.writeFileSync(temp, JSON.stringify(document, null, 2), { mode: 0o600 });
    fsImpl.renameSync(temp, file);
  }

  async function run(provider) {
    if (active) return { ok: false, code: 'busy', message: 'Es läuft bereits eine Aufzeichnung.' };
    if (!provider || !provider.diagnose) return { ok: false, code: 'unsupported', message: 'Für diesen Sender gibt es keine Diagnose-Aufzeichnung.' };
    active = true;
    const hosts = provider.diagnose.hosts;
    const entries = [];
    const items = [];
    const pending = new Map(); // webRequest-Id -> Teil-Eintrag
    let opened;
    try {
      opened = openProviderWindow(provider, `Diagnose-Aufzeichnung: ${provider.name}`);
    } catch (error) {
      active = false;
      return { ok: false, code: 'error', message: 'Das Fenster konnte nicht geöffnet werden.' };
    }
    const { win, contents, ses } = opened;
    const wr = ses.webRequest;

    wr.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
      callback({ requestHeaders: details.requestHeaders });
      const parsed = redactUrl(details.url);
      if (!parsed || !isRecordedHost(parsed.host, hosts) || entries.length >= MAX_ENTRIES) return;
      pending.set(details.id, { t: new Date(now()).toISOString(), method: String(details.method || '').toUpperCase(), host: parsed.host, path: parsed.path, query: parsed.query, requestHeaders: headerNames(details.requestHeaders) });
    });
    wr.onCompleted({ urls: ['https://*/*'] }, details => {
      const entry = pending.get(details.id);
      if (!entry) return;
      pending.delete(details.id);
      entries.push({ ...entry, status: Number.isInteger(details.statusCode) ? details.statusCode : null, responseHeaders: headerNames(details.responseHeaders) });
    });
    wr.onErrorOccurred({ urls: ['https://*/*'] }, details => {
      const entry = pending.get(details.id);
      if (!entry) return;
      pending.delete(details.id);
      entries.push({ ...entry, status: null, error: typeof details.error === 'string' ? details.error.slice(0, 60) : 'error' });
    });

    // Antworttext nur für Item-Antworten des Page-Gateways, nur im Speicher; übernommen wird die Summary
    const itemRequests = new Map();
    let attached = false;
    try {
      contents.debugger.attach('1.3');
      attached = true;
      await contents.debugger.sendCommand('Network.enable');
      contents.debugger.on('message', async (_event, method, params) => {
        try {
          if (method === 'Network.responseReceived' && params && params.response && isItemUrl(params.response.url) && /json/i.test(params.response.mimeType || '')) {
            itemRequests.set(params.requestId, redactUrl(params.response.url));
          } else if (method === 'Network.loadingFinished' && itemRequests.has(params.requestId)) {
            const target = itemRequests.get(params.requestId);
            itemRequests.delete(params.requestId);
            const body = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
            const text = body && typeof body.body === 'string' && !body.base64Encoded && body.body.length < MAX_BODY_CHARS ? body.body : null;
            const summary = text ? summarizeJsonText(text) : null;
            if (summary && items.length < 200) items.push({ t: new Date(now()).toISOString(), host: target.host, path: target.path, query: target.query, ...summary });
          }
        } catch {
          // Antworttext nicht lesbar: Eintrag entfällt
        }
      });
    } catch {
      if (logger) logger.warn('Diagnose-Aufzeichnung: Antwortstruktur nicht verfügbar (Debugger).');
    }

    return new Promise(resolve => {
      let finished = false;
      win.on('closed', () => {
        if (finished) return;
        finished = true;
        try {
          wr.onBeforeSendHeaders(null);
          wr.onCompleted(null);
          wr.onErrorOccurred(null);
          if (attached && contents.debugger.isAttached()) contents.debugger.detach();
        } catch {
          // Fenster/Debugger schon abgebaut
        }
        active = false;
        try {
          write(provider, entries, items);
          resolve({ ok: true, file, entries: entries.length, items: items.length });
        } catch (error) {
          if (logger) logger.warn(`Diagnose-Aufzeichnung: Datei nicht schreibbar (${(error && error.code) || 'fehler'}).`);
          resolve({ ok: false, code: 'write', message: 'Die Aufzeichnung konnte nicht gespeichert werden.' });
        }
      });
      contents.loadURL(provider.login.startUrl).catch(() => {});
    });
  }

  return { run, isBusy: () => active };
}

module.exports = { createDiagnoseRecorder };
