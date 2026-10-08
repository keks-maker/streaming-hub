'use strict';

const DEFAULT_UPDATE_API_BASE = 'https://api.github.com';

function isLocalHttp(url) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

// Basis-URL der Release-API. STREAMING_HUB_UPDATE_URL (Test-Hook) gilt nur, wenn die App nicht
// gepackt ist oder die URL ein lokales http-Ziel ist; sonst bleibt es bei GitHub.
function resolveUpdateApiBase(env = process.env, isPackaged = false) {
  const raw = env.STREAMING_HUB_UPDATE_URL;
  if (!raw) return DEFAULT_UPDATE_API_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_UPDATE_API_BASE;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_UPDATE_API_BASE;
  if (isPackaged && !isLocalHttp(url)) return DEFAULT_UPDATE_API_BASE;
  return raw.replace(/\/+$/, '');
}

module.exports = { DEFAULT_UPDATE_API_BASE, resolveUpdateApiBase };
