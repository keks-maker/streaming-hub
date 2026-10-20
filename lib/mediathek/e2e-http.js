'use strict';

// Nur für isolierte E2E-Läufe: ersetzt den Netzabruf der Mediathek durch feste Antworten aus einer JSON-Datei
// ({ "<Teil der Adresse>": "<Antworttext>" }, längster passender Schlüssel gewinnt). Nicht aufgeführte Adressen
// scheitern wie ein Netzfehler. Aktiv nur mit STREAMING_HUB_E2E_MEDIATHEK_ROUTES in einem Testlauf (siehe main.js).

const fs = require('node:fs');

function createRoutedHttp(routesFile) {
  const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return {
    async getText(url) {
      const key = keys.find(candidate => String(url).includes(candidate));
      if (key === undefined) throw Object.assign(new Error('Server nicht gefunden'), { code: 'network' });
      const body = routes[key];
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

module.exports = { createRoutedHttp };
