'use strict';

// Öffentliche Api-Auth-Token der ZDF-Web-App (nutzerunabhängig, steht im HTML der Startseite, laufen täglich ab). Aus den öffentlichen
// Bundles: Identity-API (api.zdf.de/identity) und Nutzerdienste senden "Api-Auth: Bearer <appToken>" zusätzlich zum Konto-Token
// (useApiToken("content")); der Player holt die Stream-Daten mit dem videoToken. Token landen nie in Logs oder Fehlermeldungen.

const HOME_URL = 'https://www.zdf.de/';
const APP_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const APP_TOKEN_MARGIN_MS = 60 * 1000;
const KINDS = new Set(['appToken', 'videoToken']);

/** Api-Auth-Token der Seite (kind: 'appToken' = Identity/Nutzerdienste, 'videoToken' = Stream-Daten) aus dem Startseiten-HTML: { token, expiresAt } oder null. */
function parseAppToken(html, nowMs, kind = 'videoToken') {
  if (!KINDS.has(kind)) return null;
  const text = String(html);
  const keyed = new RegExp(`${kind}\\\\*"\\s*:\\s*\\{\\s*\\\\*"apiToken\\\\*"\\s*:\\s*\\\\*"([A-Za-z0-9._-]{16,128})\\\\*"(?:\\s*,\\s*\\\\*"expiresAt\\\\*"\\s*:\\s*\\\\*"([^"\\\\]+)\\\\*")?`).exec(text);
  const match = keyed || (kind === 'videoToken' ? /\\*"apiToken\\*"\s*:\s*\\*"([A-Za-z0-9._-]{16,128})\\*"/.exec(text) : null);
  if (!match) return null;
  const parsed = Date.parse(match[2] || '');
  const expiresAt = Number.isFinite(parsed) && parsed > nowMs ? parsed : nowMs + APP_TOKEN_TTL_MS;
  return { token: match[1], expiresAt };
}

/** Holt und merkt die Seiten-Token: get(kind, force) -> Token; Fehler mit code 'invalid-json', wenn die Seite keinen Token enthält. */
function createAppTokenSource({ http, now = Date.now }) {
  const cache = new Map();
  let loading = null;

  async function refresh() {
    if (!loading) {
      loading = (async () => {
        const html = await http.getText(HOME_URL, { accept: 'text/html' });
        for (const kind of KINDS) {
          const found = parseAppToken(html, now(), kind);
          if (found) cache.set(kind, found);
          else cache.delete(kind);
        }
      })().finally(() => {
        loading = null;
      });
    }
    await loading;
  }

  async function get(kind, force = false) {
    const cached = cache.get(kind);
    if (!force && cached && cached.expiresAt - now() > APP_TOKEN_MARGIN_MS) return cached.token;
    await refresh();
    const found = cache.get(kind);
    if (!found) throw Object.assign(new Error('Api-Auth-Token nicht gefunden'), { code: 'invalid-json' });
    return found.token;
  }

  return { get };
}

module.exports = { parseAppToken, createAppTokenSource, HOME_URL };
