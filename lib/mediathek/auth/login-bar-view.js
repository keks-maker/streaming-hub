'use strict';

// Ansicht der Übernehmen-Leiste im Anmeldefenster: eigene lokale Seite in eigener flüchtiger Partition, gleiche Härtung wie die
// Anbieter-Seite, aber mit dem schmalen Preload (login-bar-preload.js: nur accept/cancel hinaus, Status herein).

const path = require('node:path');

function createBarView(WebContentsView, hardened) {
  return new WebContentsView({ webPreferences: { ...hardened, partition: 'mediathek-login-bar', preload: path.join(__dirname, 'login-bar-preload.js') } });
}

module.exports = { createBarView };
