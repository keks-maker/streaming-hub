'use strict';

// Gemeinsame Hilfen der Konten-Module (rein).

/** true, wenn host dem Suffix entspricht (exakt oder Subdomain mit Punkt davor). */
function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Hostname einer https-Adresse (ohne Zugangsdaten); sonst null. */
function httpsHost(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Ablaufzeit (ms) aus "expires_in" in Sekunden; Standard 5 Minuten bei unlesbarem Wert. */
function expiryFromSeconds(seconds, nowMs) {
  const value = Number(seconds);
  return nowMs + (Number.isFinite(value) && value > 0 ? value : 300) * 1000;
}

module.exports = { hostMatches, httpsHost, expiryFromSeconds };
