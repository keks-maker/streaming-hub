'use strict';

// Lader der Mediathek-Fixtures. Dateien ohne Endung -> .json; "*.m3u8" werden mit Endung angegeben.
// Quelle der JSON-Fixtures: tvOS/iPad-Repo (Tests/StreamingHubCoreTests/MediathekFixtures.swift, ArteFixtures.swift, gekürzte
// reale API-Antworten, Stand 2026-10-20). "dl-*" sind für den Download-Test aus den Spike-Beobachtungen
// (docs/mediathek-spike-ergebnis.md) nachgebildet, mit example.invalid-Adressen.

const fs = require('node:fs');
const path = require('node:path');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, name.includes('.') ? name : `${name}.json`), 'utf8');
}

module.exports = { fixture };
