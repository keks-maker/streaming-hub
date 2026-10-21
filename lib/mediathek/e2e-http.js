'use strict';

// Nur für isolierte E2E-Läufe: ersetzt den Netzabruf der Mediathek durch feste Antworten aus einer JSON-Datei
// ({ "<Teil der Adresse>": "<Antworttext>" }, längster passender Schlüssel gewinnt). Nicht aufgeführte Adressen
// scheitern wie ein Netzfehler. Schlüssel mit Präfix "auth:" gelten nur für Abrufe mit Konto-Token (getText(url, { auth })) und
// haben dann Vorrang (z. B. "auth:/item/fsk-1": freigeschaltete Antwort). Aktiv nur mit STREAMING_HUB_E2E_MEDIATHEK_ROUTES in
// einem Testlauf (siehe main.js).

const fs = require('node:fs');

function createRoutedHttp(routesFile) {
  const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return {
    async getText(url, options = {}) {
      const withAccount = options && options.auth ? keys.find(candidate => candidate.startsWith('auth:') && String(url).includes(candidate.slice(5))) : undefined;
      const key = withAccount !== undefined ? withAccount : keys.find(candidate => !candidate.startsWith('auth:') && String(url).includes(candidate));
      if (key === undefined) throw Object.assign(new Error('Server nicht gefunden'), { code: 'network', permanent: true }); // permanent: keine Wiederholung im Service
      const body = routes[key];
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

module.exports = { createRoutedHttp };
