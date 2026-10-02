'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Darf diese lokale M3U-Datei gelesen werden? Ja, wenn sie in dieser Sitzung über
 * den Dateiauswahldialog gewählt wurde ODER als Datei-Quelle bereits persistiert
 * ist (sonst brechen gespeicherte Datei-Quellen nach jedem App-Neustart).
 * Rückgabe: aufgelöster realer Pfad oder null.
 */
function resolveAllowedM3uPath(input, selectedFiles, sources, realpath = fs.realpathSync.native) {
  let real;
  try {
    real = realpath(path.resolve(input));
  } catch (_) {
    return null;
  }
  if (selectedFiles.has(real)) return real;
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || source.type !== 'file' || typeof source.url !== 'string') continue;
    let sourceReal;
    try {
      sourceReal = realpath(path.resolve(source.url));
    } catch (_) {
      continue;
    }
    if (sourceReal === real) return real;
  }
  return null;
}

module.exports = { resolveAllowedM3uPath };
