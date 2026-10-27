// Klassifizierung von Links in den Content-Webviews (persist:streaming): extern im Standardbrowser oder in der Webview.
//
// Ursache des Fehlers: Das Webview-Ereignis `new-window` gibt es in aktuellen Electron-Versionen nicht mehr, ein
// `preventDefault()` darauf bewirkt nichts; die Gast-webContents hatten keinen setWindowOpenHandler. Links mit
// target=_blank/window.open (Videobeschreibungen) liefen deshalb ins Leere. Nach außen gehen nur http und https.

'use strict';

const { isYouTubeHost } = require('./youtube-adblock.js');

function parseHttp(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch (_) {
    return null;
  }
}

// Zwei Hosts gelten als dieselbe Seite, wenn die letzten zwei Labels übereinstimmen (www.example.com = m.example.com).
function sameSite(hostA, hostB) {
  const lastTwo = host => String(host).toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.');
  return Boolean(hostA && hostB) && lastTwo(hostA) === lastTwo(hostB);
}

// YouTube-Weiterleitung (youtube.com/redirect?q=<Ziel>): liefert das externe Ziel (nur http/https) oder null.
function youtubeRedirectTarget(url) {
  const u = parseHttp(url);
  if (!u || !isYouTubeHost(u.hostname) || u.pathname !== '/redirect') return null;
  const target = parseHttp(u.searchParams.get('q'));
  return target ? target.href : null;
}

// window.open / target=_blank → { action: 'external'|'internal'|'deny', url }
function classifyWindowOpen({ url, pageUrl } = {}) {
  const u = parseHttp(url);
  if (!u) return { action: 'deny', url: '' };
  const redirect = youtubeRedirectTarget(u.href);
  if (redirect) return { action: 'external', url: redirect };
  const page = parseHttp(pageUrl);
  if (page && sameSite(page.hostname, u.hostname)) return { action: 'internal', url: u.href };
  return { action: 'external', url: u.href };
}

// Navigation der Seite selbst: nur YouTube-Weiterleitungen gehen nach außen, alles andere bleibt in der Webview.
function classifyNavigation({ url } = {}) {
  const redirect = youtubeRedirectTarget(url);
  return redirect ? { action: 'external', url: redirect } : { action: 'allow', url: String(url || '') };
}

module.exports = { classifyWindowOpen, classifyNavigation, youtubeRedirectTarget, sameSite };
