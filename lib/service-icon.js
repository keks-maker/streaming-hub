'use strict';

// Automatisches Dienst-Logo beim Hinzufügen ohne Icon-Angabe. Nutzt die Radio-Logo-Suche
// (lib/radio/radio-logo-finder.js): Icon der Dienstseite (link rel=icon / apple-touch-icon / /apple-touch-icon.png /
// /favicon.ico), danach /web/favicon.ico (Plex), danach - nur bei öffentlichen Hosts - das Google-Favicon.
// Private/lokale Hosts gehen nie an Google. Das Ergebnis wird als data:-URI abgelegt, weil die CSP des Hauptfensters
// img-src auf self/data:/https: beschränkt (http-Icons aus dem LAN wären sonst unsichtbar).
// Fehlschlag ist kein Fehler: resolveServiceIcon liefert dann null.

const { findLogo, checkImage, googlePlaceholderHash, hostOf, MIN_WEAK } = require('./radio/radio-logo-finder.js');
const { isPrivateHostname } = require('./input-validation.js');

const MAX_ICON_BYTES = 64 * 1024;
const DEFAULT_ICON = 'icons/default.svg';
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };

async function toDataUri(url, net) {
  const reply = await net.get(url, { maxBytes: MAX_ICON_BYTES });
  if (reply.status !== 200 || reply.truncated) return null;
  const checked = await checkImage(url, { get: async () => reply }, { allowHttp: true });
  if (!checked.ok || !MIME[checked.info.type]) return null;
  return `data:${MIME[checked.info.type]};base64,${reply.buffer.toString('base64')}`;
}

/** Sucht das Logo einer Dienst-URL; liefert eine data:-URI oder null. */
async function resolveServiceIcon(serviceUrl, { net, deadlineMs = 20000 } = {}) {
  const host = hostOf(serviceUrl);
  if (!host) return null;
  const isPrivate = isPrivateHostname(host);
  let timer;
  const limit = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  const work = (async () => {
    const placeholder = isPrivate ? null : await googlePlaceholderHash(net).catch(() => null);
    let found = (await findLogo({ homepage: serviceUrl, net, placeholder, allowHttp: true, httpFallback: true })).logo;
    if (!found) {
      const plex = `${new URL(serviceUrl).origin}/web/favicon.ico`;
      const result = await checkImage(plex, net, { allowHttp: true });
      if (result.ok) found = plex;
    }
    return found ? toDataUri(found, net) : null;
  })().catch(() => null);
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trägt das Logo nachträglich ein, wenn der Dienst weiterhin das Standard-Icon hat (manuell gesetztes Icon
 * hat Vorrang, auch wenn es zwischenzeitlich geändert wurde). Liefert true, wenn gespeichert wurde.
 */
async function applyServiceIcon({ id, url, net, load, save, notify, resolve = resolveServiceIcon }) {
  const icon = await resolve(url, { net });
  if (!icon) return false;
  const services = load();
  const index = services.findIndex(s => s.id === id);
  if (index === -1 || services[index].icon !== DEFAULT_ICON || services[index].url !== url) return false;
  const next = services.slice();
  next[index] = { ...services[index], icon };
  save(next);
  notify();
  return true;
}

module.exports = { DEFAULT_ICON, MAX_ICON_BYTES, MIN_WEAK, resolveServiceIcon, applyServiceIcon, toDataUri };
