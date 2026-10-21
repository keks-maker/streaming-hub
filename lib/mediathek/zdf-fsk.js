'use strict';

// ZDF-Jugendschutz (FSK) für Beiträge, deren Dokument keine Formitäten, aber fskCheck trägt. Ablauf der ZDF-Website (aus den
// öffentlichen Bundles, ohne Konto gelesen): Der Player sperrt zeitlich (FSK 12 ab 20, FSK 16 ab 22, FSK 18 ab 23 Uhr, jeweils bis
// 6 Uhr); außerhalb braucht die Seite ein angemeldetes Konto mit Altersfreigabe (GET api.zdf.de/identity/fsk/verification -> verified,
// gilt für FSK 16; FSK 18 ist nicht freischaltbar) und lässt die vierstellige PIN prüfen (POST /identity/fsk/pin, Status 200). Erst danach
// lädt der Player die Stream-Daten (PTMD, streamApiUrlFsk) - allein mit dem öffentlichen Api-Auth-Token der Seite, ohne Nutzertoken
// und ohne PIN-Nachweis am Abruf. Die Sperre liegt also im Client; diese App bildet sie genauso nach und ruft die Stream-Daten
// erst nach bestandener Prüfung ab. Tokens, PIN und Api-Auth-Token landen nie in Logs oder Fehlermeldungen. Nur mit echtem Konto
// prüfbar (Antwortformat von /fsk/verification und /fsk/pin ungeprüft).

const { dicts, isObject, nonEmpty } = require('./util.js');

const IDENTITY = 'https://api.zdf.de/identity';
const VERIFICATION_URL = `${IDENTITY}/fsk/verification`;
const PIN_URL = `${IDENTITY}/fsk/pin`;
const ZDF_ACCEPT = 'application/vnd.de.zdf.v1.0+json';
const HOME_URL = 'https://www.zdf.de/';
const WINDOW_START = { 12: 20, 16: 22, 18: 23 }; // Beginn des Abrufzeitraums bis 6 Uhr (JMStV)
const APP_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const APP_TOKEN_MARGIN_MS = 60 * 1000;
const PIN_PATTERN = /^\d{4}$/;
const PTMD_PATH = /^\/(?:tmd\/2\/[A-Za-z0-9_./-]+|content\/documents\/[A-Za-z0-9._-]+\.json)$/;

/** Stream-Daten-Adresse nur, wenn sie https://api.zdf.de/(tmd/2|content/documents)/... mit höchstens profile=<name> ist; sonst null. */
function validPtmdUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.hostname !== 'api.zdf.de' || url.port || url.username || url.password || url.hash) return null;
    if (!PTMD_PATH.test(url.pathname) || url.pathname.includes('..')) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => key !== 'profile') || !/^[A-Za-z0-9_-]*$/.test(url.searchParams.get('profile') || '')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Jugendschutz-Angaben eines Dokuments (mediathekV2/document): { rating, required (16|18), ptmdUrl|null, doc } oder null ohne fskCheck. */
function fskContext(root) {
  const doc = isObject(root) && isObject(root.document) ? root.document : null;
  if (!doc || doc.fskCheck !== true) return null;
  const rating = nonEmpty(doc.fsk) || 'FSK';
  const ptmdUrl = [doc.streamApiUrlFsk, doc.streamApiUrlIOS, doc.streamApiUrlAndroid].map(validPtmdUrl).find(Boolean) || null;
  return { rating, required: rating.includes('18') ? 18 : 16, ptmdUrl, doc };
}

function berlinHour(ms) {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return Number.parseInt(hour, 10);
}

/** true, wenn die Freigabe jetzt im gesetzlichen Abrufzeitraum liegt (die Website verlangt dann kein Konto). Unbekannte Stufe: false. */
function windowOpen(rating, ms) {
  const start = WINDOW_START[Number(String(rating).replace(/\D/g, ''))];
  if (!start) return false;
  const hour = berlinHour(ms);
  return hour >= start || hour < 6;
}

/** Api-Auth-Token der Web-App (öffentlich, nutzerunabhängig, täglich neu) aus dem Startseiten-HTML: { token, expiresAt } oder null. */
function parseAppToken(html, nowMs) {
  const text = String(html);
  const match = /videoToken\\*"\s*:\s*\{\s*\\*"apiToken\\*"\s*:\s*\\*"([A-Za-z0-9._-]{16,128})\\*"(?:\s*,\s*\\*"expiresAt\\*"\s*:\s*\\*"([^"\\]+)\\*")?/.exec(text) || /\\*"apiToken\\*"\s*:\s*\\*"([A-Za-z0-9._-]{16,128})\\*"/.exec(text);
  if (!match) return null;
  const parsed = Date.parse(match[2] || '');
  const expiresAt = Number.isFinite(parsed) && parsed > nowMs ? parsed : nowMs + APP_TOKEN_TTL_MS;
  return { token: match[1], expiresAt };
}

/** Formitäten/Untertitel der Stream-Daten (PTMD) im Format des Dokuments, damit Parser und Download-Info unverändert gelten. */
function ptmdToRoot(ptmd, doc) {
  const formitaeten = [];
  for (const item of dicts(ptmd.priorityList)) {
    for (const formitaet of dicts(item.formitaeten)) {
      for (const quality of dicts(formitaet.qualities)) {
        for (const track of dicts(isObject(quality.audio) ? quality.audio.tracks : [])) {
          if (typeof track.uri !== 'string' || !track.uri.startsWith('http')) continue;
          formitaeten.push({ url: track.uri, type: formitaet.type, mimeType: formitaet.mimeType, quality: quality.quality, class: track.class, language: track.language });
        }
      }
    }
  }
  return { document: { ...doc, formitaeten, captions: dicts(ptmd.captions) } };
}

const fail = account => ({ ok: false, account });

/**
 * options: http (Mediathek-HTTP: getText(url, { accept, auth, hostHeaders })), auth (Konten-Modul: accountState, ensureFresh, tokenUsable,
 * getAuthHeaders, getPin/setPin/clearPin/canRememberPin), net (createAuthNet: request), askPin({ rating, canRemember }) ->
 * Promise<{ pin, remember } | null> (Dialog), now, logger.
 * unlock(root) -> { ok: true, root } | { ok: false, account } mit account: null (nicht zuständig) | 'signedOut' | 'expired' | 'notVerified' |
 * 'tooHigh' (FSK 18) | 'pinCancelled' | 'wrongPin' | 'pinLocked' | 'network' | 'noStream' | 'error'.
 */
function createZdfFsk({ http, auth, net, askPin = null, now = Date.now, logger = null }) {
  let appToken = null;
  const pinChecks = new Map(); // laufende PIN-Prüfungen je PIN
  let prompt = null; // laufende PIN-Abfrage: gleichzeitige Aufrufe teilen sich einen Dialog

  const log = message => {
    if (logger) logger.warn(message);
  };

  async function loadAppToken(force) {
    if (!force && appToken && appToken.expiresAt - now() > APP_TOKEN_MARGIN_MS) return appToken.token;
    const found = parseAppToken(await http.getText(HOME_URL, { accept: 'text/html' }), now());
    if (!found) throw Object.assign(new Error('Api-Auth-Token nicht gefunden'), { code: 'invalid-json' });
    appToken = found;
    return found.token;
  }

  async function fetchStreamData(ptmdUrl, retry = true) {
    const token = await loadAppToken(!retry);
    try {
      return JSON.parse(await http.getText(ptmdUrl, { accept: ZDF_ACCEPT, hostHeaders: { 'api.zdf.de': { 'Api-Auth': `Bearer ${token}` } } }));
    } catch (error) {
      if (retry && error && error.status === 403) return fetchStreamData(ptmdUrl, false); // Token der Seite abgelaufen: einmal neu holen
      throw error;
    }
  }

  async function streams(context) {
    if (!context.ptmdUrl) return fail('noStream');
    let ptmd;
    try {
      ptmd = await fetchStreamData(context.ptmdUrl);
    } catch (error) {
      log(`ZDF-Jugendschutz: Stream-Daten nicht abrufbar (${(error && error.code) || 'fehler'}${error && error.status ? `, HTTP ${error.status}` : ''}).`);
      return fail(error && error.code === 'network' ? 'network' : 'error');
    }
    const root = ptmdToRoot(isObject(ptmd) ? ptmd : {}, context.doc);
    return root.document.formitaeten.length ? { ok: true, root } : fail('noStream');
  }

  /** Altersfreigabe des Kontos: true | false | Fehlercode ('expired' | 'network' | 'error'). */
  async function verified() {
    let body;
    try {
      body = JSON.parse(await http.getText(VERIFICATION_URL, { auth: 'zdf', accept: ZDF_ACCEPT }));
    } catch (error) {
      if (error && error.status === 401) return 'expired';
      log(`ZDF-Jugendschutz: Altersfreigabe nicht prüfbar (${(error && error.code) || 'fehler'}${error && error.status ? `, HTTP ${error.status}` : ''}).`);
      return error && error.code === 'network' ? 'network' : 'error';
    }
    return isObject(body) && body.verified === true;
  }

  function ask(context) {
    if (!askPin) return Promise.resolve(null);
    if (!prompt) {
      prompt = Promise.resolve(askPin({ rating: context.rating, canRemember: auth.canRememberPin() }))
        .catch(() => null)
        .finally(() => {
          prompt = null;
        });
    }
    return prompt;
  }

  /** PIN prüfen lassen (nie wiederholen): null = gültig, sonst Fehlercode. */
  function checkPin(pin) {
    if (!pinChecks.has(pin)) pinChecks.set(pin, requestPin(pin).finally(() => pinChecks.delete(pin))); // gleichzeitige Aufrufe: eine Anfrage ans ZDF
    return pinChecks.get(pin);
  }

  async function requestPin(pin) {
    const url = PIN_URL;
    let answer;
    try {
      answer = await net.request('POST', url, { fields: { pin }, headers: auth.getAuthHeaders('zdf', url) });
    } catch (error) {
      log(`ZDF-Jugendschutz: PIN nicht prüfbar (${(error && error.code) || 'fehler'}).`);
      return error && error.code === 'network' ? 'network' : 'error';
    }
    if (answer.status === 200) return null;
    if (answer.status === 401 || answer.status === 403) return 'expired'; // Sitzung abgelaufen, nicht die PIN
    if (answer.status === 429) return 'pinLocked';
    if (answer.status >= 400 && answer.status < 500) return 'wrongPin';
    return 'error';
  }

  async function unlock(root) {
    const context = fskContext(root);
    if (!context) return fail(null);
    if (windowOpen(context.rating, now())) return streams(context); // im Abrufzeitraum verlangt die Website kein Konto
    const state = auth.accountState('zdf');
    if (state === 'unsupported') return fail(null);
    if (state === 'signedOut' || state === 'expired') return fail(state);
    await auth.ensureFresh('zdf');
    if (auth.accountState('zdf') === 'expired') return fail('expired');
    if (!auth.tokenUsable('zdf')) return fail('network');
    if (context.required >= 18) return fail('tooHigh'); // FSK 18 lässt sich beim ZDF nicht per Konto freischalten
    const age = await verified();
    if (typeof age === 'string') return fail(age);
    if (!age) return fail('notVerified');

    const saved = auth.getPin('zdf');
    let pin = saved;
    let remember = false;
    if (!saved) {
      const answer = await ask(context);
      pin = answer && typeof answer.pin === 'string' && PIN_PATTERN.test(answer.pin) ? answer.pin : null;
      remember = Boolean(answer) && answer.remember === true;
      if (!pin) return fail('pinCancelled');
    }
    const problem = await checkPin(pin);
    if (problem) {
      if (saved && problem === 'wrongPin') auth.clearPin('zdf'); // gemerkte PIN stimmt nicht mehr (zum Beispiel auf der Website geändert)
      return fail(problem);
    }
    if (remember) auth.setPin('zdf', pin);
    return streams(context);
  }

  return { unlock };
}

module.exports = { createZdfFsk, fskContext, validPtmdUrl, windowOpen, parseAppToken, ptmdToRoot, PIN_URL, VERIFICATION_URL };
